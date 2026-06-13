// lib/hls.js — Minimal HLS / fMP4 parser + segment downloader.
//
// Skool's native player (Mux) serves HLS-version-7 with:
//   * A master playlist that lists video variants (#EXT-X-STREAM-INF) AND
//     a separate audio rendition (#EXT-X-MEDIA:TYPE=AUDIO,URI=...).
//   * Each rendition is a fragmented-MP4 (CMAF) playlist: every segment
//     is .m4s, and the playlist begins with an #EXT-X-MAP:URI=...
//     pointing at the init segment that contains ftyp+moov boxes.
//   * No encryption.
//
// To produce a playable file we concatenate `init + segments` per track
// (video + audio). The concatenated bytes are a valid fMP4 file that
// VLC / ffmpeg / mpv all play. Joining audio + video into a single .mp4
// is done outside the browser via the bundled `_remux.sh` (one ffmpeg
// `-c copy` command, lossless and ~instant).
//
// All fetches are issued from the caller's origin (the content script
// runs on www.skool.com) so Origin/Referer headers are correct.

import { createLogger } from "./logger.js";
const log = createLogger("hls");

/**
 * Parse a master playlist.
 * @returns {{
 *   variants: Array<{bandwidth, resolution, codecs, url, audioGroup}>,
 *   audioGroups: Record<string, Array<{name, language, default, url}>>,
 *   subtitleGroups: Record<string, Array<{name, language, default, url}>>,
 * }}
 */
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const audioGroups = {};
  const subtitleGroups = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("#EXT-X-MEDIA")) {
      const attrs = parseAttrList(line.substring(line.indexOf(":") + 1));
      const item = {
        name: attrs.NAME || null,
        language: attrs.LANGUAGE || null,
        default: attrs.DEFAULT === "YES",
        autoSelect: attrs.AUTOSELECT === "YES",
        url: attrs.URI ? new URL(attrs.URI, baseUrl).toString() : null,
      };
      const groupId = attrs["GROUP-ID"];
      if (!groupId || !item.url) continue;
      if (attrs.TYPE === "AUDIO") {
        (audioGroups[groupId] ||= []).push(item);
      } else if (attrs.TYPE === "SUBTITLES") {
        (subtitleGroups[groupId] ||= []).push(item);
      }
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attrs = parseAttrList(line.substring(line.indexOf(":") + 1));
      // Skip lines until we get a non-comment URL line.
      let url = null;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) continue;
        if (next.startsWith("#")) continue;
        url = next;
        i = j;
        break;
      }
      if (!url) continue;
      variants.push({
        bandwidth: Number(attrs.BANDWIDTH || 0),
        averageBandwidth: Number(attrs["AVERAGE-BANDWIDTH"] || 0),
        resolution: attrs.RESOLUTION
          ? attrs.RESOLUTION.split("x").map(Number)
          : null,
        codecs: attrs.CODECS || null,
        audioGroup: attrs.AUDIO || null,
        subtitleGroup: attrs.SUBTITLES || null,
        url: new URL(url, baseUrl).toString(),
      });
    }
  }

  log.info("parseMaster: parsed", {
    variantCount: variants.length,
    variants: variants.map((v) => ({
      bw: v.bandwidth,
      res: v.resolution ? v.resolution.join("x") : null,
      audio: v.audioGroup,
    })),
    audioGroupKeys: Object.keys(audioGroups),
    subtitleGroupKeys: Object.keys(subtitleGroups),
  });
  return { variants, audioGroups, subtitleGroups };
}

/**
 * Parse a media (rendition) playlist.
 * Handles fragmented-MP4 with #EXT-X-MAP and classic TS streams.
 * @returns {{ initSegment: string|null, segments: string[], totalDuration: number }}
 */
export function parseRendition(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let initSegment = null;
  let totalDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("#EXT-X-MAP")) {
      const attrs = parseAttrList(line.substring(line.indexOf(":") + 1));
      if (attrs.URI) {
        initSegment = new URL(attrs.URI, baseUrl).toString();
      }
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      const dur = parseFloat(line.substring(8));
      if (!Number.isNaN(dur)) totalDuration += dur;
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

  log.info("parseRendition: parsed", {
    hasInit: !!initSegment,
    segments: segments.length,
    totalDuration,
  });
  return { initSegment, segments, totalDuration };
}

/**
 * Pick the variant closest to the desired height. Heights: "max", "720", "1080".
 */
export function pickVariant(variants, pref) {
  if (!variants.length) return null;
  if (pref === "max" || pref == null) {
    return variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
  }
  const targetH = typeof pref === "number" ? pref : parseInt(pref, 10);
  const exact = variants.find((v) => v.resolution && v.resolution[1] === targetH);
  if (exact) return exact;
  const below = variants
    .filter((v) => v.resolution && v.resolution[1] <= targetH)
    .sort((a, b) => b.resolution[1] - a.resolution[1]);
  if (below.length) return below[0];
  const above = variants
    .filter((v) => v.resolution && v.resolution[1] > targetH)
    .sort((a, b) => a.resolution[1] - b.resolution[1]);
  if (above.length) return above[0];
  return variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
}

/**
 * Pick the audio rendition matching the variant's AUDIO group. Prefers the
 * default item; falls back to the first.
 */
export function pickAudio(audioGroups, variant) {
  if (!variant?.audioGroup) return null;
  const group = audioGroups[variant.audioGroup];
  if (!group || !group.length) return null;
  return group.find((g) => g.default) || group[0];
}

/**
 * Fetch every segment + the init segment, return a single Uint8Array of the
 * concatenated bytes (init first).
 *
 * @param {{initSegment: string|null, segments: string[]}} track
 * @param {(done:number, total:number)=>void} onProgress
 * @param {AbortSignal} signal
 * @param {number} concurrency
 */
export async function downloadTrack(track, onProgress, signal, concurrency = 6) {
  const allUrls = [];
  if (track.initSegment) allUrls.push(track.initSegment);
  allUrls.push(...track.segments);
  const total = allUrls.length;
  const chunks = new Array(total);
  let done = 0;

  async function worker(startIdx) {
    for (let i = startIdx; i < total; i += concurrency) {
      if (signal?.aborted) throw new Error("aborted");
      const url = allUrls[i];
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
          chunks[i] = new Uint8Array(await resp.arrayBuffer());
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

/** Fetch a playlist (master or rendition) and return its text. */
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

// ---- helpers ----
function parseAttrList(s) {
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

export const _log = log;
