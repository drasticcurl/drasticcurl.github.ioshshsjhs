// lib/hls.js — Minimal HLS (M3U8) parser + segment downloader.
//
// We only need to handle the subset of HLS that Skool/Mux uses:
//   * Master playlist with multiple #EXT-X-STREAM-INF variants (one per
//     resolution).
//   * Variant (rendition) playlist with #EXTINF segments.
//   * No encryption (#EXT-X-KEY is absent for Skool native).
//   * Absolute or relative segment URLs.
//
// All fetches are performed from the caller's origin (the content script
// runs on www.skool.com so Origin/Referer are correct automatically).

import { createLogger } from "./logger.js";
const log = createLogger("hls");

/**
 * Parse a master playlist and return the list of variants.
 * @param {string} text raw .m3u8 content
 * @param {string} baseUrl URL of this playlist (for resolving relative URLs)
 * @returns {Array<{bandwidth:number, resolution:[w,h]|null, url:string, codecs?:string}>}
 */
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const attrs = parseAttrList(line.substring(line.indexOf(":") + 1));
    const url = (lines[i + 1] || "").trim();
    if (!url || url.startsWith("#")) continue;
    variants.push({
      bandwidth: Number(attrs.BANDWIDTH || 0),
      resolution: attrs.RESOLUTION
        ? attrs.RESOLUTION.split("x").map(Number)
        : null,
      codecs: attrs.CODECS,
      url: new URL(url, baseUrl).toString(),
    });
  }
  return variants;
}

/**
 * Parse a rendition (variant) playlist and return the list of segment URLs.
 * @returns {{segments: string[], totalDuration: number}}
 */
export function parseRendition(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let totalDuration = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXTINF:")) {
      const dur = parseFloat(line.substring(8));
      if (!Number.isNaN(dur)) totalDuration += dur;
      // segment URL is the next non-comment line
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) continue;
        if (next.startsWith("#")) continue;
        segments.push(new URL(next, baseUrl).toString());
        i = j;
        break;
      }
    }
  }
  return { segments, totalDuration };
}

/**
 * Pick the variant closest to the desired height. "max" returns the one with
 * the highest bandwidth.
 * @param {Array} variants from parseMaster
 * @param {"max"|"720"|"1080"|number} pref
 */
export function pickVariant(variants, pref) {
  if (!variants.length) return null;
  if (pref === "max" || pref == null) {
    return variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
  }
  const targetH = typeof pref === "number" ? pref : parseInt(pref, 10);
  // exact match first
  const exact = variants.find((v) => v.resolution && v.resolution[1] === targetH);
  if (exact) return exact;
  // else closest <= target
  const below = variants
    .filter((v) => v.resolution && v.resolution[1] <= targetH)
    .sort((a, b) => b.resolution[1] - a.resolution[1]);
  if (below.length) return below[0];
  // else lowest above
  const above = variants
    .filter((v) => v.resolution && v.resolution[1] > targetH)
    .sort((a, b) => a.resolution[1] - b.resolution[1]);
  if (above.length) return above[0];
  // fallback: highest bandwidth
  return variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
}

/**
 * Download all segments and return a single Uint8Array of the concatenated
 * MPEG-TS stream.
 *
 * @param {string[]} segmentUrls
 * @param {(done:number, total:number)=>void} onProgress
 * @param {AbortSignal} signal
 * @param {number} concurrency parallel fetches
 */
export async function downloadSegments(
  segmentUrls,
  onProgress,
  signal,
  concurrency = 6
) {
  const total = segmentUrls.length;
  const chunks = new Array(total);
  let done = 0;

  async function worker(startIdx) {
    for (let i = startIdx; i < total; i += concurrency) {
      if (signal?.aborted) throw new Error("aborted");
      const url = segmentUrls[i];
      let attempt = 0;
      while (true) {
        try {
          const resp = await fetch(url, {
            credentials: "include",
            referrer: "https://www.skool.com/",
          });
          if (!resp.ok) {
            log.warn("segment HTTP error", {
              idx: i,
              status: resp.status,
              attempt: attempt + 1,
            });
            throw new Error("HTTP " + resp.status);
          }
          const buf = new Uint8Array(await resp.arrayBuffer());
          chunks[i] = buf;
          break;
        } catch (e) {
          attempt++;
          log.warn("segment fetch failed", {
            idx: i,
            attempt,
            error: String(e?.message || e),
          });
          if (attempt >= 3) {
            log.error("segment giving up", { idx: i, url: url.slice(0, 100) });
            throw e;
          }
          await sleep(500 * attempt);
        }
      }
      done++;
      onProgress?.(done, total);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, (_, k) => worker(k))
  );

  // Compute total length and concatenate
  let totalLen = 0;
  for (const c of chunks) totalLen += c.byteLength;
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Fetch a playlist (master or rendition) and return its text.
 */
export async function fetchPlaylist(url) {
  log.debug("fetchPlaylist", { url: String(url).slice(0, 120) });
  let resp;
  try {
    resp = await fetch(url, {
      credentials: "include",
      referrer: "https://www.skool.com/",
    });
  } catch (e) {
    log.error("fetchPlaylist network error", {
      error: String(e?.message || e),
      url: String(url).slice(0, 120),
    });
    throw e;
  }
  if (!resp.ok) {
    log.error("fetchPlaylist HTTP error", {
      status: resp.status,
      url: String(url).slice(0, 120),
    });
    throw new Error(`Playlist HTTP ${resp.status}`);
  }
  return resp.text();
}

/** Expose the logger so callers can append entries (debug only). */
export const _log = log;

// --- helpers ---

function parseAttrList(s) {
  // Parses the comma-separated attribute list of an EXT-X-STREAM-INF line,
  // honoring quoted values (which may contain commas).
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(s))) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[4];
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
