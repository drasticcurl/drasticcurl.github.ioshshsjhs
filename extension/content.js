// content.js — runs in the page context of *.skool.com.
//
// Three jobs:
//   1) Scan the classroom DOM and return a tree of { sections -> lessons }.
//   2) Auto-walker: navigate through every lesson, click play, wait for the
//      master .m3u8 to be captured by background.js, then download the video
//      to the user's chosen Downloads subfolder.
//   3) Manual mode: capture + download the currently-playing lesson only.
//
// All file fetches happen here (in skool.com origin) so Origin/Referer
// headers are correct for the CDN. We then hand a blob: URL to background.js
// which calls chrome.downloads.download.

(() => {
  // Idempotent install: if the script reloads (e.g. on SPA navigation) we
  // don't want to re-attach listeners.
  if (window.__skoolDLInstalled) return;
  window.__skoolDLInstalled = true;

  let hlsModulePromise = null;
  function loadHls() {
    if (!hlsModulePromise) {
      hlsModulePromise = import(chrome.runtime.getURL("lib/hls.js"));
    }
    return hlsModulePromise;
  }

  // --- Pending m3u8 capture: a one-shot promise resolved by background's
  //     "m3u8-captured" message. Used by the walker / manual capture.
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
          rej(new Error("timeout waiting for m3u8 capture"));
        }
      }, timeoutMs);
    });
    pendingCapture = {
      promise: p,
      resolve: (v) => {
        clearTimeout(timer);
        pendingCapture = null;
        resolveFn(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        pendingCapture = null;
        rejectFn(e);
      },
    };
    return p;
  }

  // ---------------------------------------------------------------------
  // 1. Classroom DOM scanner
  // ---------------------------------------------------------------------

  /**
   * Best-effort scan of the classroom sidebar.
   * Strategy:
   *  - Find every <a> whose href contains "md=<32-hex>". That's a lesson.
   *  - For each lesson, walk up the DOM to find the nearest "section" —
   *    a heading-like element or container with a label.
   *  - Group lessons by section in the order they appear in the DOM.
   *
   * Skool's React UI changes class names often, so we rely on structural
   * cues, not class names.
   */
  function scanClassroom() {
    const out = {
      classroomName: detectClassroomName(),
      communityName: detectCommunityName(),
      sections: [],
      flatLessons: [],
      scannedAt: new Date().toISOString(),
      pageUrl: location.href,
    };

    const seen = new Set();
    const lessons = [];
    const allLinks = document.querySelectorAll('a[href*="md="]');
    allLinks.forEach((a) => {
      const m = /[?&]md=([a-f0-9]{32})/i.exec(a.href);
      if (!m) return;
      const md = m[1];
      if (seen.has(md)) return;
      seen.add(md);

      const title = cleanText(a.textContent) || `Lesson ${md.slice(0, 6)}`;
      const sectionTitle = findSectionTitle(a) || "Sin sección";
      lessons.push({
        md,
        title,
        url: absUrl(a.href),
        sectionTitle,
      });
    });

    // Preserve DOM order.
    const sectionMap = new Map();
    lessons.forEach((l) => {
      if (!sectionMap.has(l.sectionTitle)) {
        sectionMap.set(l.sectionTitle, []);
      }
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
    return out;
  }

  function detectClassroomName() {
    // Try the document title first. Skool titles look like:
    //   "Lesson Title - Course Name | Community Name | Skool"
    // We want "Course Name" if present.
    const t = document.title || "";
    const parts = t.split("|").map((s) => s.trim());
    if (parts.length >= 2) {
      const left = parts[0];
      const dashSplit = left.split(" - ");
      if (dashSplit.length >= 2) return dashSplit[dashSplit.length - 1];
      return left;
    }
    // Fallback: <h1>
    const h1 = document.querySelector("h1");
    if (h1) return cleanText(h1.textContent);
    return "Classroom";
  }

  function detectCommunityName() {
    // URL pattern is /<community-slug>/classroom/<id>?md=...
    const m = /^\/([^\/]+)\/classroom/.exec(location.pathname);
    if (m) return m[1];
    return "skool";
  }

  /**
   * Walk up from a lesson <a> to find the nearest text node that looks like
   * a section title. Skool typically renders sections as a sibling header
   * above the list of lessons.
   */
  function findSectionTitle(a) {
    let node = a;
    for (let i = 0; i < 8 && node; i++) {
      // look at previous siblings for a heading-ish element
      let prev = node.previousElementSibling;
      while (prev) {
        const txt = cleanText(prev.textContent);
        if (looksLikeSectionTitle(prev, txt)) return txt;
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    // Fallback: the first ancestor that has a button-like element
    // ("expandable section" pattern).
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
    if (/^[a-z]/i.test(txt) === false && !/[A-Za-z0-9]/.test(txt)) return false;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) return true;
    const role = el.getAttribute("role");
    if (role === "heading") return true;
    // Heuristic: bold/heavy text in an aside/sidebar
    const style = getComputedStyle(el);
    if (parseInt(style.fontWeight, 10) >= 600 && el.children.length <= 3) {
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // 2. SPA navigation + auto-play helpers
  // ---------------------------------------------------------------------

  /**
   * Navigate the SPA to a particular md= without a full page reload.
   * Returns when the URL has changed and the React tree has settled.
   */
  async function navigateToLesson(lessonUrl) {
    const target = new URL(lessonUrl, location.origin);
    if (location.href === target.href) return;

    // Click the matching sidebar link if we can find it (most reliable for
    // React Router / Next.js apps because it goes through their <Link>).
    const link = Array.from(document.querySelectorAll('a[href*="md="]')).find(
      (a) => a.href === target.href
    );
    if (link) {
      link.scrollIntoView({ block: "nearest" });
      link.click();
    } else {
      history.pushState({}, "", target.pathname + target.search);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    // Wait for the URL to update + a frame to render.
    await waitFor(() => location.search === target.search, 5000);
    await sleep(500);
  }

  /**
   * Find the <video> element on the page and click play. Skool wraps Mux's
   * player in a custom container; the actual <video> exists once the player
   * has hydrated.
   */
  async function startPlayback() {
    const video = await waitFor(
      () => document.querySelector("video"),
      10000
    );
    if (!video) throw new Error("video element not found");
    try {
      // Mute first so autoplay policies don't block us.
      video.muted = true;
      const p = video.play();
      if (p && typeof p.then === "function") await p;
    } catch {
      // If programmatic play fails, try clicking the visible play button.
      const btn =
        document.querySelector('button[aria-label*="lay" i]') ||
        document.querySelector('[data-testid*="play" i]');
      if (btn) btn.click();
    }
    return video;
  }

  // ---------------------------------------------------------------------
  // 3. Download pipeline (per lesson)
  // ---------------------------------------------------------------------

  async function downloadLesson({
    masterUrl,
    quality,
    targetFilename,
    onProgress,
  }) {
    const hls = await loadHls();
    onProgress?.({ phase: "playlist" });
    const masterText = await hls.fetchPlaylist(masterUrl);

    let renditionUrl;
    let chosenVariant = null;
    if (/#EXT-X-STREAM-INF/.test(masterText)) {
      const variants = hls.parseMaster(masterText, masterUrl);
      chosenVariant = hls.pickVariant(variants, quality);
      if (!chosenVariant) throw new Error("no variant found in master");
      renditionUrl = chosenVariant.url;
    } else {
      // Some Skool m3u8 URLs already point straight at a rendition.
      renditionUrl = masterUrl;
    }

    onProgress?.({ phase: "rendition", variant: chosenVariant });
    const renditionText = await hls.fetchPlaylist(renditionUrl);
    const { segments, totalDuration } = hls.parseRendition(
      renditionText,
      renditionUrl
    );
    if (!segments.length) throw new Error("no segments in rendition");

    onProgress?.({
      phase: "segments",
      total: segments.length,
      done: 0,
      durationSec: totalDuration,
    });

    const ts = await hls.downloadSegments(
      segments,
      (done, total) => onProgress?.({ phase: "segments", total, done }),
      undefined,
      6
    );

    onProgress?.({ phase: "saving" });
    const blob = new Blob([ts], { type: "video/mp2t" });
    const blobUrl = URL.createObjectURL(blob);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "download",
        url: blobUrl,
        filename: targetFilename,
      });
      if (!resp?.ok) throw new Error(resp?.error || "download failed");
      // Give Chrome a moment to start the download before we revoke.
      await sleep(2000);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    return { sizeBytes: ts.byteLength, segments: segments.length };
  }

  // ---------------------------------------------------------------------
  // 4. Auto-walker
  // ---------------------------------------------------------------------

  let walkerAbort = false;

  async function runAutoWalker({ folderName, quality, onUpdate }) {
    walkerAbort = false;
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

    for (const section of tree.sections) {
      const sectionDir = `${pad(section.index)} - ${sanitizeForPath(
        section.title
      )}`;
      const sectionEntry = {
        index: section.index,
        title: section.title,
        lessons: [],
      };

      for (const lesson of section.lessons) {
        if (walkerAbort) {
          onUpdate?.({ type: "aborted" });
          return manifest;
        }
        processed++;
        const lessonFile = `${pad(lesson.index)} - ${sanitizeForPath(
          lesson.title
        )}.ts`;
        const targetFilename = `${safeFolder}/${safeClassroom}/${sectionDir}/${lessonFile}`;

        onUpdate?.({
          type: "lesson-start",
          processed,
          total,
          section: section.title,
          title: lesson.title,
          file: targetFilename,
        });

        try {
          // Tell background which lesson we're navigating to so subsequent
          // m3u8 captures are associated with it (and any previous one is
          // cleared so we wait for a *fresh* token).
          await chrome.runtime.sendMessage({
            type: "set-pending-lesson",
            lessonId: lesson.md,
          });

          await navigateToLesson(lesson.url);
          await sleep(800);
          await startPlayback();

          const cap = await awaitNextCapture(25000);

          // Pause to be polite to Skool.
          const video = document.querySelector("video");
          if (video) video.pause();

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
          onUpdate?.({
            type: "lesson-done",
            processed,
            total,
            title: lesson.title,
            sizeBytes: result.sizeBytes,
          });
        } catch (e) {
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

        // Brief pause between lessons.
        await sleep(600);
      }

      manifest.sections.push(sectionEntry);
    }

    // Save the manifest + remux script alongside the videos.
    await saveSidecarFiles({
      folderName: safeFolder,
      classroomName: safeClassroom,
      manifest,
    });

    onUpdate?.({ type: "all-done", manifest });
    return manifest;
  }

  function abortWalker() {
    walkerAbort = true;
  }

  // ---------------------------------------------------------------------
  // 5. Manual capture (current lesson only)
  // ---------------------------------------------------------------------

  async function captureCurrent({ folderName, quality, onUpdate }) {
    const tree = scanClassroom();
    const safeFolder = sanitizeForPath(folderName) || "Skool";
    const safeClassroom = sanitizeForPath(tree.classroomName) || "Classroom";

    const md = (/[?&]md=([a-f0-9]{32})/i.exec(location.search) || [])[1];
    const lesson = tree.flatLessons.find((l) => l.md === md) || {
      title: document.title.split("|")[0].trim() || "lesson",
      md: md || "manual",
      url: location.href,
      sectionTitle: "Manual",
      index: 1,
    };
    const section = tree.sections.find((s) =>
      s.lessons.some((l) => l.md === lesson.md)
    ) || { index: 1, title: lesson.sectionTitle || "Manual" };

    const targetFilename = `${safeFolder}/${safeClassroom}/${pad(
      section.index
    )} - ${sanitizeForPath(section.title)}/${pad(
      lesson.index || 1
    )} - ${sanitizeForPath(lesson.title)}.ts`;

    onUpdate?.({
      type: "lesson-start",
      processed: 1,
      total: 1,
      title: lesson.title,
      file: targetFilename,
    });

    // Try to use any capture we already have; otherwise start playback and
    // wait for a fresh one.
    let cap = await chrome.runtime.sendMessage({ type: "get-capture" });
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
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // 6. Sidecar files: _manifest.json and _remux.sh
  // ---------------------------------------------------------------------

  async function saveSidecarFiles({ folderName, classroomName, manifest }) {
    const base = `${folderName}/${classroomName}`;

    // _manifest.json
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

    // _remux.sh — reads every .ts under this folder and converts to .mp4
    // with ffmpeg using stream copy (no re-encoding, ~instant).
    const sh = `#!/usr/bin/env bash
# _remux.sh — converts every .ts file under this directory to .mp4 (lossless)
# using ffmpeg stream copy. Generated by Skool Classroom Downloader.
#
# Usage:  cd to the folder containing this script and run:
#           bash _remux.sh
# Requires: ffmpeg in PATH.
#
# Original .ts files are kept; .mp4 files are written next to them.

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

  // ---------------------------------------------------------------------
  // 7. Message handler (called by background after popup-relay)
  // ---------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg?.type) {
          case "ping":
            sendResponse({ ok: true, classroom: detectClassroomName() });
            return;

          case "scan":
            sendResponse({ ok: true, tree: scanClassroom() });
            return;

          case "start-walker": {
            // We use chrome.runtime.sendMessage to broadcast progress events
            // back to the popup if it is open; popup listens for them.
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

          case "m3u8-captured":
            // forwarded by background — resolve any pending wait
            if (pendingCapture) pendingCapture.resolve(msg);
            return;
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // async
  });

  // ---------------------------------------------------------------------
  // utils
  // ---------------------------------------------------------------------

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
