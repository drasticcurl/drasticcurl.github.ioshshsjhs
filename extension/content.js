// content.js — runs in the page context of *.skool.com.
//
// Scans the classroom DOM, drives the SPA through every lesson, captures
// the freshly-signed HLS master URL from background.js, fetches all .ts
// segments from inside the page origin, concatenates them into one .ts
// blob and dispatches it to background.js for chrome.downloads.download.

(() => {
  if (window.__skoolDLInstalled) return;
  window.__skoolDLInstalled = true;

  // ---- async module imports (we use dynamic import because content scripts
  //      can't be ES modules directly).
  let _modulesPromise = null;
  function loadModules() {
    if (!_modulesPromise) {
      _modulesPromise = Promise.all([
        import(chrome.runtime.getURL("lib/logger.js")),
        import(chrome.runtime.getURL("lib/hls.js")),
      ]).then(([loggerMod, hlsMod]) => {
        const log = loggerMod.createLogger("content");
        log.info("content script attached", {
          url: location.href,
          ua: navigator.userAgent,
        });
        // Expose for in-page debugging.
        window.__skoolDLDumpLogs = () => loggerMod.formatEntries(log.getEntries());
        return { loggerMod, hlsMod, log };
      });
    }
    return _modulesPromise;
  }
  // Kick it off immediately so logs from the very first events show up.
  loadModules().catch((e) => console.error("[skool-dl:content] module load failed", e));

  // ---- helper: get logger sync once it's loaded
  let _log = null;
  loadModules().then((m) => {
    _log = m.log;
  });
  function lg() {
    return (
      _log ?? {
        debug: (...a) => console.log("[skool-dl:content:pre]", ...a),
        info: (...a) => console.log("[skool-dl:content:pre]", ...a),
        warn: (...a) => console.warn("[skool-dl:content:pre]", ...a),
        error: (...a) => console.error("[skool-dl:content:pre]", ...a),
        getEntries: () => [],
      }
    );
  }

  // ---- Pending m3u8 capture (one-shot promise)
  let pendingCapture = null;
  function awaitNextCapture(timeoutMs = 25000) {
    if (pendingCapture) return pendingCapture.promise;
    let resolveFn, rejectFn, timer;
    const p = new Promise((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
      timer = setTimeout(() => {
        if (pendingCapture) {
          pendingCapture = null;
          lg().error("awaitNextCapture: TIMEOUT", { timeoutMs });
          rej(new Error("timeout waiting for m3u8 capture"));
        }
      }, timeoutMs);
    });
    pendingCapture = {
      promise: p,
      resolve: (v) => {
        clearTimeout(timer);
        pendingCapture = null;
        lg().info("awaitNextCapture: resolved", { url: v?.url });
        resolveFn(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        pendingCapture = null;
        rejectFn(e);
      },
    };
    lg().debug("awaitNextCapture: waiting…", { timeoutMs });
    return p;
  }

  // ===================================================================
  // 1) Classroom DOM scanner
  // ===================================================================

  function scanClassroom() {
    lg().info("scan: starting", { url: location.href });
    const out = {
      classroomName: detectClassroomName(),
      communityName: detectCommunityName(),
      sections: [],
      flatLessons: [],
      scannedAt: new Date().toISOString(),
      pageUrl: location.href,
    };
    lg().info("scan: classroom name detected", { name: out.classroomName });
    lg().info("scan: community detected", { name: out.communityName });

    const allLinks = document.querySelectorAll('a[href*="md="]');
    lg().info("scan: anchor[href*=md=] elements", { count: allLinks.length });

    const seen = new Set();
    const lessons = [];
    allLinks.forEach((a, idx) => {
      const m = /[?&]md=([a-f0-9]{32})/i.exec(a.href);
      if (!m) {
        lg().debug("scan: skipping anchor (no 32-hex md)", { idx, href: a.href });
        return;
      }
      const md = m[1];
      if (seen.has(md)) return;
      seen.add(md);

      const title = cleanText(a.textContent) || `Lesson ${md.slice(0, 6)}`;
      const sectionTitle = findSectionTitle(a) || "Sin sección";
      lessons.push({ md, title, url: absUrl(a.href), sectionTitle });
    });
    lg().info("scan: unique lessons found", {
      count: lessons.length,
      sample: lessons.slice(0, 3).map((l) => ({ md: l.md, title: l.title })),
    });

    const sectionMap = new Map();
    lessons.forEach((l) => {
      if (!sectionMap.has(l.sectionTitle)) sectionMap.set(l.sectionTitle, []);
      sectionMap.get(l.sectionTitle).push(l);
    });
    let i = 1;
    sectionMap.forEach((lessonList, sectionTitle) => {
      out.sections.push({
        index: i++,
        title: sectionTitle,
        lessons: lessonList.map((l, j) => ({ ...l, index: j + 1 })),
      });
    });
    out.flatLessons = lessons;
    lg().info("scan: built tree", {
      sections: out.sections.length,
      totalLessons: lessons.length,
      sectionTitles: out.sections.map((s) => s.title),
    });
    return out;
  }

  function detectClassroomName() {
    const t = document.title || "";
    const parts = t.split("|").map((s) => s.trim());
    if (parts.length >= 2) {
      const left = parts[0];
      const dashSplit = left.split(" - ");
      if (dashSplit.length >= 2) return dashSplit[dashSplit.length - 1];
      return left;
    }
    const h1 = document.querySelector("h1");
    if (h1) return cleanText(h1.textContent);
    return "Classroom";
  }

  function detectCommunityName() {
    const m = /^\/([^\/]+)\/classroom/.exec(location.pathname);
    if (m) return m[1];
    return "skool";
  }

  function findSectionTitle(a) {
    let node = a;
    for (let i = 0; i < 8 && node; i++) {
      let prev = node.previousElementSibling;
      while (prev) {
        const txt = cleanText(prev.textContent);
        if (looksLikeSectionTitle(prev, txt)) return txt;
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    let cur = a.parentElement;
    for (let i = 0; i < 6 && cur; i++) {
      const btn = cur.querySelector(":scope > button, :scope > [role='button']");
      if (btn) {
        const txt = cleanText(btn.textContent);
        if (txt && txt.length < 120) return txt;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function looksLikeSectionTitle(el, txt) {
    if (!txt) return false;
    if (txt.length > 120) return false;
    if (txt.includes("\n")) return false;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) return true;
    if (el.getAttribute("role") === "heading") return true;
    try {
      const style = getComputedStyle(el);
      if (parseInt(style.fontWeight, 10) >= 600 && el.children.length <= 3)
        return true;
    } catch {}
    return false;
  }

  // ===================================================================
  // 2) SPA navigation + auto-play
  // ===================================================================

  async function navigateToLesson(lessonUrl) {
    const target = new URL(lessonUrl, location.origin);
    lg().info("nav: navigateToLesson", { from: location.href, to: target.href });
    if (location.href === target.href) {
      lg().debug("nav: already on target URL");
      return;
    }
    const link = Array.from(document.querySelectorAll('a[href*="md="]')).find(
      (a) => a.href === target.href
    );
    if (link) {
      lg().debug("nav: clicking matching sidebar <a>");
      link.scrollIntoView({ block: "nearest" });
      link.click();
    } else {
      lg().warn("nav: no matching <a> in sidebar; falling back to history.pushState");
      history.pushState({}, "", target.pathname + target.search);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    const ok = await waitFor(() => location.search === target.search, 5000);
    lg().info("nav: URL changed", { ok: !!ok, now: location.href });
    await sleep(500);
  }

  async function startPlayback() {
    lg().info("play: looking for <video> element…");
    const video = await waitFor(() => document.querySelector("video"), 12000);
    if (!video) {
      lg().error("play: no <video> element after 12s");
      throw new Error("video element not found");
    }
    lg().info("play: <video> found", {
      readyState: video.readyState,
      src: video.currentSrc || video.src || null,
      paused: video.paused,
    });
    try {
      video.muted = true;
      const p = video.play();
      if (p && typeof p.then === "function") {
        await p;
        lg().info("play: video.play() resolved");
      } else {
        lg().info("play: video.play() returned non-promise");
      }
    } catch (e) {
      lg().warn("play: video.play() rejected, trying button click", {
        error: String(e),
      });
      const btn =
        document.querySelector('button[aria-label*="lay" i]') ||
        document.querySelector('[data-testid*="play" i]');
      if (btn) {
        lg().info("play: clicked play button", { aria: btn.getAttribute("aria-label") });
        btn.click();
      } else {
        lg().error("play: no fallback play button found");
      }
    }
    return video;
  }

  // ===================================================================
  // 3) Per-lesson download pipeline
  // ===================================================================

  async function downloadLesson({ masterUrl, quality, targetFilename, onProgress }) {
    const { hlsMod } = await loadModules();
    lg().info("dl: start", { targetFilename, quality, masterUrlPrefix: String(masterUrl).slice(0, 80) });

    onProgress?.({ phase: "playlist" });
    lg().debug("dl: fetching master playlist");
    const masterText = await hlsMod.fetchPlaylist(masterUrl);
    lg().info("dl: master playlist fetched", { bytes: masterText.length });

    let renditionUrl;
    let chosenVariant = null;
    if (/#EXT-X-STREAM-INF/.test(masterText)) {
      const variants = hlsMod.parseMaster(masterText, masterUrl);
      lg().info("dl: master has variants", {
        count: variants.length,
        variants: variants.map((v) => ({
          bw: v.bandwidth,
          res: v.resolution ? v.resolution.join("x") : null,
        })),
      });
      chosenVariant = hlsMod.pickVariant(variants, quality);
      if (!chosenVariant) {
        lg().error("dl: no variant could be picked");
        throw new Error("no variant found in master");
      }
      lg().info("dl: variant chosen", {
        wanted: quality,
        bw: chosenVariant.bandwidth,
        res: chosenVariant.resolution ? chosenVariant.resolution.join("x") : null,
      });
      renditionUrl = chosenVariant.url;
    } else {
      lg().warn("dl: master had no STREAM-INF; treating URL as rendition");
      renditionUrl = masterUrl;
    }
    onProgress?.({ phase: "rendition", variant: chosenVariant });

    lg().debug("dl: fetching rendition playlist");
    const renditionText = await hlsMod.fetchPlaylist(renditionUrl);
    lg().info("dl: rendition fetched", { bytes: renditionText.length });
    const { segments, totalDuration } = hlsMod.parseRendition(
      renditionText,
      renditionUrl
    );
    lg().info("dl: rendition parsed", {
      segments: segments.length,
      totalDuration,
      firstSegmentPrefix: segments[0]?.slice(0, 80),
    });
    if (!segments.length) {
      lg().error("dl: rendition has zero segments");
      throw new Error("no segments in rendition");
    }

    onProgress?.({
      phase: "segments",
      total: segments.length,
      done: 0,
      durationSec: totalDuration,
    });

    lg().info("dl: downloading segments…", {
      total: segments.length,
      concurrency: 6,
    });
    let lastReportedAt = 0;
    const ts = await hlsMod.downloadSegments(
      segments,
      (done, total) => {
        onProgress?.({ phase: "segments", total, done });
        const now = Date.now();
        if (done === total || now - lastReportedAt > 1500) {
          lg().debug("dl: segment progress", { done, total });
          lastReportedAt = now;
        }
      },
      undefined,
      6
    );
    lg().info("dl: all segments fetched", { bytes: ts.byteLength });

    onProgress?.({ phase: "saving" });
    const blob = new Blob([ts], { type: "video/mp2t" });
    const blobUrl = URL.createObjectURL(blob);
    lg().info("dl: blob created", { bytes: ts.byteLength });
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "download",
        url: blobUrl,
        filename: targetFilename,
      });
      if (!resp?.ok) {
        lg().error("dl: chrome.downloads.download failed", { error: resp?.error });
        throw new Error(resp?.error || "download failed");
      }
      lg().info("dl: download dispatched", {
        downloadId: resp.downloadId,
        filename: targetFilename,
      });
      await sleep(2000);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    return { sizeBytes: ts.byteLength, segments: segments.length };
  }

  // ===================================================================
  // 4) Auto-walker
  // ===================================================================

  let walkerAbort = false;

  async function runAutoWalker({ folderName, quality, onUpdate }) {
    walkerAbort = false;
    lg().info("walker: start", { folderName, quality });
    const tree = scanClassroom();
    const safeFolder = sanitizeForPath(folderName) || "Skool";
    const safeClassroom = sanitizeForPath(tree.classroomName) || "Classroom";

    const manifest = {
      generatedAt: new Date().toISOString(),
      folderName: safeFolder,
      classroomName: tree.classroomName,
      communityName: tree.communityName,
      pageUrl: tree.pageUrl,
      quality,
      sections: [],
    };

    let total = 0;
    tree.sections.forEach((s) => (total += s.lessons.length));
    let processed = 0;
    onUpdate?.({ type: "start", total, classroom: tree.classroomName });
    lg().info("walker: tree summary", { sections: tree.sections.length, total });

    if (total === 0) {
      lg().error("walker: 0 lessons found, aborting");
      onUpdate?.({ type: "lesson-error", error: "0 lessons found by scanner" });
      onUpdate?.({ type: "all-done", manifest });
      return manifest;
    }

    for (const section of tree.sections) {
      const sectionDir = `${pad(section.index)} - ${sanitizeForPath(section.title)}`;
      const sectionEntry = { index: section.index, title: section.title, lessons: [] };
      lg().info("walker: enter section", { idx: section.index, title: section.title, lessons: section.lessons.length });

      for (const lesson of section.lessons) {
        if (walkerAbort) {
          lg().warn("walker: abort flag set, exiting");
          onUpdate?.({ type: "aborted" });
          return manifest;
        }
        processed++;
        const lessonFile = `${pad(lesson.index)} - ${sanitizeForPath(lesson.title)}.ts`;
        const targetFilename = `${safeFolder}/${safeClassroom}/${sectionDir}/${lessonFile}`;
        lg().info("walker: lesson begin", {
          progress: `${processed}/${total}`,
          title: lesson.title,
          md: lesson.md,
          targetFilename,
        });

        onUpdate?.({
          type: "lesson-start",
          processed,
          total,
          section: section.title,
          title: lesson.title,
          file: targetFilename,
        });

        try {
          await chrome.runtime.sendMessage({
            type: "set-pending-lesson",
            lessonId: lesson.md,
          });

          await navigateToLesson(lesson.url);
          await sleep(800);
          await startPlayback();

          lg().debug("walker: awaiting capture");
          const cap = await awaitNextCapture(25000);

          const video = document.querySelector("video");
          if (video) {
            video.pause();
            lg().debug("walker: video paused after capture");
          }

          const result = await downloadLesson({
            masterUrl: cap.url,
            quality,
            targetFilename,
            onProgress: (p) =>
              onUpdate?.({
                type: "lesson-progress",
                processed,
                total,
                title: lesson.title,
                ...p,
              }),
          });

          sectionEntry.lessons.push({
            index: lesson.index,
            title: lesson.title,
            md: lesson.md,
            url: lesson.url,
            file: targetFilename,
            masterUrl: cap.url,
            sizeBytes: result.sizeBytes,
            status: "ok",
          });
          lg().info("walker: lesson done", {
            title: lesson.title,
            sizeBytes: result.sizeBytes,
          });
          onUpdate?.({
            type: "lesson-done",
            processed,
            total,
            title: lesson.title,
            sizeBytes: result.sizeBytes,
          });
        } catch (e) {
          lg().error("walker: lesson FAILED", {
            title: lesson.title,
            error: String(e?.message || e),
            stack: String(e?.stack || "").split("\n").slice(0, 4).join(" | "),
          });
          sectionEntry.lessons.push({
            index: lesson.index,
            title: lesson.title,
            md: lesson.md,
            url: lesson.url,
            file: targetFilename,
            status: "error",
            error: String(e?.message || e),
          });
          onUpdate?.({
            type: "lesson-error",
            processed,
            total,
            title: lesson.title,
            error: String(e?.message || e),
          });
        }
        await sleep(600);
      }

      manifest.sections.push(sectionEntry);
    }

    await saveSidecarFiles({
      folderName: safeFolder,
      classroomName: safeClassroom,
      manifest,
    });

    lg().info("walker: ALL DONE", {
      sections: manifest.sections.length,
      ok: manifest.sections.flatMap((s) => s.lessons).filter((l) => l.status === "ok")
        .length,
      errors: manifest.sections.flatMap((s) => s.lessons).filter((l) => l.status === "error")
        .length,
    });
    onUpdate?.({ type: "all-done", manifest });
    return manifest;
  }

  function abortWalker() {
    walkerAbort = true;
    lg().warn("walker: abort requested");
  }

  // ===================================================================
  // 5) Manual: capture & download current lesson only
  // ===================================================================

  async function captureCurrent({ folderName, quality, onUpdate }) {
    lg().info("manual: start", { folderName, quality, url: location.href });
    const tree = scanClassroom();
    const safeFolder = sanitizeForPath(folderName) || "Skool";
    const safeClassroom = sanitizeForPath(tree.classroomName) || "Classroom";

    const md = (/[?&]md=([a-f0-9]{32})/i.exec(location.search) || [])[1];
    const lesson =
      tree.flatLessons.find((l) => l.md === md) || {
        title: document.title.split("|")[0].trim() || "lesson",
        md: md || "manual",
        url: location.href,
        sectionTitle: "Manual",
        index: 1,
      };
    const section =
      tree.sections.find((s) => s.lessons.some((l) => l.md === lesson.md)) || {
        index: 1,
        title: lesson.sectionTitle || "Manual",
      };

    const targetFilename = `${safeFolder}/${safeClassroom}/${pad(section.index)} - ${sanitizeForPath(
      section.title
    )}/${pad(lesson.index || 1)} - ${sanitizeForPath(lesson.title)}.ts`;

    lg().info("manual: target", { targetFilename, lesson, section });
    onUpdate?.({
      type: "lesson-start",
      processed: 1,
      total: 1,
      title: lesson.title,
      file: targetFilename,
    });

    let cap = await chrome.runtime.sendMessage({ type: "get-capture" });
    lg().info("manual: existing capture?", { hasCapture: !!cap?.masterUrl });
    if (!cap?.masterUrl) {
      await startPlayback();
      cap = await awaitNextCapture(25000);
    }

    const result = await downloadLesson({
      masterUrl: cap.masterUrl || cap.url,
      quality,
      targetFilename,
      onProgress: (p) => onUpdate?.({ type: "lesson-progress", ...p }),
    });

    onUpdate?.({
      type: "lesson-done",
      processed: 1,
      total: 1,
      title: lesson.title,
      sizeBytes: result.sizeBytes,
    });
    onUpdate?.({ type: "all-done" });
    lg().info("manual: done", { sizeBytes: result.sizeBytes });
    return { ok: true };
  }

  // ===================================================================
  // 6) Sidecar files: _manifest.json and _remux.sh
  // ===================================================================

  async function saveSidecarFiles({ folderName, classroomName, manifest }) {
    const base = `${folderName}/${classroomName}`;
    lg().info("sidecar: writing _manifest.json + _remux.sh", { base });

    const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], {
      type: "application/json",
    });
    const manifestUrl = URL.createObjectURL(manifestBlob);
    await chrome.runtime.sendMessage({
      type: "download",
      url: manifestUrl,
      filename: `${base}/_manifest.json`,
      conflictAction: "overwrite",
    });
    setTimeout(() => URL.revokeObjectURL(manifestUrl), 5000);

    const sh = `#!/usr/bin/env bash
# _remux.sh — converts every .ts file under this directory to .mp4 (lossless)
# using ffmpeg stream copy. Generated by Skool Classroom Downloader.
#
# Usage:  cd to the folder containing this script and run:
#           bash _remux.sh
# Requires: ffmpeg in PATH.

set -euo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Install it first (brew install ffmpeg on macOS)." >&2
  exit 1
fi

shopt -s globstar nullglob
count=0
for ts in **/*.ts; do
  mp4="\${ts%.ts}.mp4"
  if [ -f "$mp4" ]; then
    echo "skip (already exists): $mp4"
    continue
  fi
  echo "remuxing: $ts -> $mp4"
  ffmpeg -hide_banner -loglevel error -y -i "$ts" -c copy -bsf:a aac_adtstoasc "$mp4"
  count=$((count+1))
done

echo "Done. Remuxed $count file(s)."
`;
    const shBlob = new Blob([sh], { type: "text/x-shellscript" });
    const shUrl = URL.createObjectURL(shBlob);
    await chrome.runtime.sendMessage({
      type: "download",
      url: shUrl,
      filename: `${base}/_remux.sh`,
      conflictAction: "overwrite",
    });
    setTimeout(() => URL.revokeObjectURL(shUrl), 5000);
  }

  // ===================================================================
  // 7) Message handler
  // ===================================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg?.type) {
          case "ping":
            lg().debug("recv: ping");
            sendResponse({ ok: true, classroom: detectClassroomName() });
            return;

          case "scan":
            lg().info("recv: scan");
            sendResponse({ ok: true, tree: scanClassroom() });
            return;

          case "start-walker": {
            lg().info("recv: start-walker", {
              folderName: msg.folderName,
              quality: msg.quality,
            });
            const onUpdate = (evt) => {
              chrome.runtime
                .sendMessage({ type: "walker-progress", evt })
                .catch(() => {});
            };
            const manifest = await runAutoWalker({
              folderName: msg.folderName,
              quality: msg.quality,
              onUpdate,
            });
            sendResponse({ ok: true, manifest });
            return;
          }

          case "abort-walker":
            abortWalker();
            sendResponse({ ok: true });
            return;

          case "capture-current": {
            lg().info("recv: capture-current", {
              folderName: msg.folderName,
              quality: msg.quality,
            });
            const onUpdate = (evt) =>
              chrome.runtime
                .sendMessage({ type: "walker-progress", evt })
                .catch(() => {});
            await captureCurrent({
              folderName: msg.folderName,
              quality: msg.quality,
              onUpdate,
            });
            sendResponse({ ok: true });
            return;
          }

          case "get-content-logs": {
            const m = await loadModules();
            sendResponse({ ok: true, entries: m.log.getEntries() });
            return;
          }

          case "m3u8-captured":
            lg().info("recv: m3u8-captured", { url: msg.url });
            if (pendingCapture) pendingCapture.resolve(msg);
            return;
        }
      } catch (e) {
        lg().error("message handler threw", {
          type: msg?.type,
          error: String(e?.message || e),
          stack: String(e?.stack || "").split("\n").slice(0, 4).join(" | "),
        });
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  });

  // Catch unhandled errors so they end up in the log buffer too.
  window.addEventListener("error", (e) => {
    lg().error("window.error", {
      message: e.message,
      filename: e.filename,
      line: e.lineno,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    lg().error("window.unhandledrejection", { reason: String(e.reason) });
  });

  // ---- utils ----
  function cleanText(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }
  function absUrl(u) {
    return new URL(u, location.origin).toString();
  }
  function sanitizeForPath(s) {
    return cleanText(s)
      .replace(/[\/\\:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/\.+$/g, "")
      .slice(0, 100);
  }
  function pad(n) {
    return String(n).padStart(2, "0");
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  async function waitFor(fn, timeoutMs = 10000, intervalMs = 150) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(intervalMs);
    }
    return null;
  }
})();
