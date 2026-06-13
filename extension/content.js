// content.js — runs in the page context of *.skool.com.
//
// v0.2 — decouples capture from finding a <video> element. The new flow is:
//
//   navigate → snapshot the player DOM → start awaitNextCapture → in
//   parallel try multiple "nudge" strategies (scrollIntoView, focus
//   iframe, click play button, etc.) → on m3u8 fire, download.
//
// All file fetches happen here (in skool.com origin) so Origin/Referer
// are correct for the CDN. We then hand a blob: URL to background.js
// which calls chrome.downloads.download.

(() => {
  if (window.__skoolDLInstalled) return;
  window.__skoolDLInstalled = true;

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
        window.__skoolDLDumpLogs = () =>
          loggerMod.formatEntries(log.getEntries());
        return { loggerMod, hlsMod, log };
      });
    }
    return _modulesPromise;
  }
  loadModules().catch((e) =>
    console.error("[skool-dl:content] module load failed", e)
  );

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

  // ===================================================================
  // Pending m3u8 capture (one-shot promise)
  // ===================================================================

  let pendingCapture = null;
  function awaitNextCapture(timeoutMs = 45000) {
    if (pendingCapture) return pendingCapture.promise;
    let resolveFn, rejectFn, timer;
    const p = new Promise((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
      timer = setTimeout(() => {
        if (pendingCapture) {
          pendingCapture = null;
          lg().error("awaitNextCapture: TIMEOUT", { timeoutMs });
          rej(new Error("timeout waiting for video manifest"));
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
        lg().debug("scan: skipping anchor (no 32-hex md)", {
          idx,
          href: a.href,
        });
        return;
      }
      const md = m[1];
      if (seen.has(md)) return;
      seen.add(md);

      const title = cleanText(a.textContent) || `Lesson ${md.slice(0, 6)}`;
      const sectionTitle = findSectionTitle(a) || null;
      lessons.push({ md, title, url: absUrl(a.href), sectionTitle });
    });
    lg().info("scan: unique lessons found", {
      count: lessons.length,
      sample: lessons.slice(0, 3).map((l) => ({ md: l.md, title: l.title })),
    });

    // Group into sections. Strategy:
    //   1) If at least one lesson got a real sectionTitle from the DOM, use
    //      DOM-derived grouping.
    //   2) Otherwise, fall back to numeric-prefix grouping ("1.X", "2.X"…).
    //   3) Otherwise, single "Sin sección" bucket.
    let sectionsMap = new Map();
    const haveDomSection = lessons.some((l) => l.sectionTitle);

    if (haveDomSection) {
      lg().info("scan: grouping by DOM-derived section titles");
      lessons.forEach((l) => {
        const key = l.sectionTitle || "Sin sección";
        if (!sectionsMap.has(key)) sectionsMap.set(key, []);
        sectionsMap.get(key).push(l);
      });
    } else if (
      lessons.length > 1 &&
      lessons.every((l) => /^\d+\.\d+\b/.test(l.title))
    ) {
      lg().info("scan: grouping by numeric prefix (N.X)");
      lessons.forEach((l) => {
        const m = /^(\d+)\.(\d+)/.exec(l.title);
        const k = `Module ${m[1]}`;
        if (!sectionsMap.has(k)) sectionsMap.set(k, []);
        sectionsMap.get(k).push(l);
      });
    } else {
      lg().warn(
        "scan: no DOM section + no numeric prefix; using single bucket"
      );
      sectionsMap.set("Sin sección", lessons.slice());
    }

    let i = 1;
    sectionsMap.forEach((lessonList, sectionTitle) => {
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
  // 2) Player DOM inspection — diagnostic dump
  // ===================================================================

  function inspectPlayerDom() {
    const iframes = Array.from(document.querySelectorAll("iframe")).map((f) => {
      const r = f.getBoundingClientRect();
      return {
        src: (f.src || "").slice(0, 200),
        srcdoc: !!f.srcdoc,
        title: f.title || null,
        name: f.name || null,
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: r.width > 0 && r.height > 0,
        sameOrigin: (() => {
          try {
            return !!f.contentDocument;
          } catch {
            return false;
          }
        })(),
      };
    });
    const videos = Array.from(document.querySelectorAll("video")).map((v) => ({
      src: v.currentSrc || v.src || null,
      readyState: v.readyState,
      paused: v.paused,
      muted: v.muted,
      duration: v.duration,
    }));
    const customEls = Array.from(document.querySelectorAll("*"))
      .filter((e) => e.tagName.includes("-"))
      .map((e) => e.tagName.toLowerCase());
    const customElTypes = [...new Set(customEls)];
    const muxLike = customElTypes.filter((t) =>
      /mux|player|video|hls/i.test(t)
    );
    const playerCandidates = Array.from(
      document.querySelectorAll(
        '[class*="video" i], [class*="player" i], [data-testid*="video" i], [data-testid*="player" i]'
      )
    )
      .slice(0, 10)
      .map((e) => ({
        tag: e.tagName,
        cls: (e.className || "").toString().slice(0, 80),
        testid: e.getAttribute("data-testid"),
      }));
    const summary = {
      iframes,
      videos,
      customElCount: customEls.length,
      customElTypes: customElTypes.slice(0, 30),
      muxLike,
      playerCandidates,
      url: location.href,
    };
    lg().info("inspectPlayerDom", summary);
    return summary;
  }

  // ===================================================================
  // 3) SPA navigation
  // ===================================================================

  async function navigateToLesson(lessonUrl) {
    const target = new URL(lessonUrl, location.origin);
    lg().info("nav: navigateToLesson", {
      from: location.href,
      to: target.href,
    });
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
      lg().warn(
        "nav: no matching <a> in sidebar; falling back to history.pushState"
      );
      history.pushState({}, "", target.pathname + target.search);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    const ok = await waitFor(() => location.search === target.search, 5000);
    lg().info("nav: URL changed", { ok: !!ok, now: location.href });
    await sleep(500);
  }

  // ===================================================================
  // 4) Player nudging — best effort, multiple strategies
  // ===================================================================

  /**
   * Try every strategy we know to make the player initialize and start
   * fetching its manifest. Returns a description of what was tried.
   */
  function nudgePlayer() {
    const tried = [];

    // 1) <video> in main doc
    const v = document.querySelector("video");
    if (v) {
      try {
        v.muted = true;
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
        tried.push("video.play()");
      } catch (e) {
        tried.push("video.play()→threw:" + String(e?.message || e));
      }
    }

    // 2) <mux-player>/<mux-video>
    const mp = document.querySelector("mux-player, mux-video");
    if (mp) {
      try {
        mp.muted = true;
        const p = mp.play?.();
        if (p && typeof p.catch === "function") p.catch(() => {});
        tried.push("mux-player.play()");
      } catch (e) {
        tried.push("mux-player.play()→threw:" + String(e?.message || e));
      }
    }

    // 3) <video> inside same-origin iframes
    document.querySelectorAll("iframe").forEach((f, i) => {
      try {
        const doc = f.contentDocument;
        if (!doc) return;
        const innerV = doc.querySelector("video");
        if (innerV) {
          innerV.muted = true;
          const p = innerV.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
          tried.push(`iframe[${i}]:video.play()`);
        }
      } catch {
        /* cross-origin → ignore */
      }
    });

    // 4) Scroll the largest player-looking element into view (triggers
    //    IntersectionObserver-based lazy loading).
    const candidates = Array.from(
      document.querySelectorAll(
        'iframe, [class*="video" i], [class*="player" i], [data-testid*="video" i], [data-testid*="player" i]'
      )
    )
      .map((e) => ({ el: e, r: e.getBoundingClientRect() }))
      .filter((x) => x.r.width > 100 && x.r.height > 60)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    if (candidates.length) {
      const top = candidates[0].el;
      top.scrollIntoView({ block: "center", behavior: "instant" });
      tried.push("scrollIntoView:" + (top.tagName || ""));
      // 5) Focus the iframe (sometimes triggers cross-origin player init).
      if (top.tagName === "IFRAME") {
        try {
          top.contentWindow?.focus?.();
          tried.push("iframe.focus()");
        } catch {}
      }
    }

    // 6) Click any visible play-looking button.
    const playBtn = Array.from(
      document.querySelectorAll(
        'button, [role="button"], [aria-label*="play" i], [aria-label*="reproducir" i], [data-testid*="play" i]'
      )
    ).find((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 20 && r.height > 20;
    });
    if (playBtn) {
      try {
        playBtn.click();
        tried.push("playBtn.click():" + (playBtn.getAttribute("aria-label") || playBtn.tagName));
      } catch {}
    }

    lg().info("nudgePlayer: tried", { tried });
    return tried;
  }

  // ===================================================================
  // 5) Per-lesson capture-and-download
  // ===================================================================

  async function captureAndDownload({
    masterUrl,
    quality,
    targetFilename,
    onProgress,
  }) {
    const { hlsMod } = await loadModules();
    lg().info("dl: start", {
      targetFilename,
      quality,
      masterUrlPrefix: String(masterUrl).slice(0, 80),
    });

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
        res: chosenVariant.resolution
          ? chosenVariant.resolution.join("x")
          : null,
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
        lg().error("dl: chrome.downloads.download failed", {
          error: resp?.error,
        });
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
  // 6) Single-lesson processing (used by walker AND manual)
  // ===================================================================

  async function processLesson({
    lesson,
    targetFilename,
    quality,
    onUpdate,
  }) {
    // Tell background which lesson we're about to process so the next
    // captured manifest is associated with this one (and any stale capture
    // is cleared).
    await chrome.runtime.sendMessage({
      type: "set-pending-lesson",
      lessonId: lesson.md,
    });

    // Wait a beat for the SPA to render the new lesson.
    await sleep(800);

    // Snapshot the player DOM once for diagnostics.
    inspectPlayerDom();

    // Start the capture wait BEFORE nudging so we never miss a fast capture.
    const capturePromise = awaitNextCapture(45000);

    // Nudge the player. If nothing fires within 5s, nudge again.
    const nudge1 = nudgePlayer();
    let nudge2 = null;
    let nudge3 = null;
    const nudgeTimer1 = setTimeout(() => {
      lg().info("retry-nudge: 5s elapsed, nudging again");
      nudge2 = nudgePlayer();
    }, 5000);
    const nudgeTimer2 = setTimeout(() => {
      lg().warn("retry-nudge: 15s elapsed, third try");
      nudge3 = nudgePlayer();
    }, 15000);

    let cap;
    try {
      cap = await capturePromise;
    } finally {
      clearTimeout(nudgeTimer1);
      clearTimeout(nudgeTimer2);
    }

    // Pause whatever started playing.
    document.querySelectorAll("video").forEach((v) => {
      try { v.pause(); } catch {}
    });

    return captureAndDownload({
      masterUrl: cap.url,
      quality,
      targetFilename,
      onProgress: (p) =>
        onUpdate?.({
          type: "lesson-progress",
          title: lesson.title,
          ...p,
        }),
    });
  }

  // ===================================================================
  // 7) Auto-walker
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
    lg().info("walker: tree summary", {
      sections: tree.sections.length,
      total,
    });

    if (total === 0) {
      lg().error("walker: 0 lessons found, aborting");
      onUpdate?.({ type: "lesson-error", error: "0 lessons found by scanner" });
      onUpdate?.({ type: "all-done", manifest });
      return manifest;
    }

    for (const section of tree.sections) {
      const sectionDir = `${pad(section.index)} - ${sanitizeForPath(
        section.title
      )}`;
      const sectionEntry = {
        index: section.index,
        title: section.title,
        lessons: [],
      };
      lg().info("walker: enter section", {
        idx: section.index,
        title: section.title,
        lessons: section.lessons.length,
      });

      for (const lesson of section.lessons) {
        if (walkerAbort) {
          lg().warn("walker: abort flag set, exiting");
          onUpdate?.({ type: "aborted" });
          return manifest;
        }
        processed++;
        const lessonFile = `${pad(lesson.index)} - ${sanitizeForPath(
          lesson.title
        )}.ts`;
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
          await navigateToLesson(lesson.url);
          const result = await processLesson({
            lesson,
            targetFilename,
            quality,
            onUpdate: (e) =>
              onUpdate?.({
                ...e,
                processed,
                total,
              }),
          });

          sectionEntry.lessons.push({
            index: lesson.index,
            title: lesson.title,
            md: lesson.md,
            url: lesson.url,
            file: targetFilename,
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
            stack: String(e?.stack || "")
              .split("\n")
              .slice(0, 4)
              .join(" | "),
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
      ok: manifest.sections
        .flatMap((s) => s.lessons)
        .filter((l) => l.status === "ok").length,
      errors: manifest.sections
        .flatMap((s) => s.lessons)
        .filter((l) => l.status === "error").length,
    });
    onUpdate?.({ type: "all-done", manifest });
    return manifest;
  }

  function abortWalker() {
    walkerAbort = true;
    lg().warn("walker: abort requested");
  }

  // ===================================================================
  // 8) Manual: capture & download current lesson only
  // ===================================================================

  async function captureCurrent({ folderName, quality, onUpdate }) {
    lg().info("manual: start", {
      folderName,
      quality,
      url: location.href,
    });
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

    const targetFilename = `${safeFolder}/${safeClassroom}/${pad(
      section.index
    )} - ${sanitizeForPath(section.title)}/${pad(
      lesson.index || 1
    )} - ${sanitizeForPath(lesson.title)}.ts`;

    lg().info("manual: target", { targetFilename, lesson, section });
    onUpdate?.({
      type: "lesson-start",
      processed: 1,
      total: 1,
      title: lesson.title,
      file: targetFilename,
    });

    // Use existing capture if we have one, otherwise process from scratch.
    let cap = await chrome.runtime.sendMessage({ type: "get-capture" });
    lg().info("manual: existing capture?", { hasCapture: !!cap?.masterUrl });

    let result;
    if (cap?.masterUrl) {
      result = await captureAndDownload({
        masterUrl: cap.masterUrl,
        quality,
        targetFilename,
        onProgress: (p) => onUpdate?.({ type: "lesson-progress", ...p }),
      });
    } else {
      result = await processLesson({
        lesson,
        targetFilename,
        quality,
        onUpdate,
      });
    }

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
  // 9) Sidecar files
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
  // 10) Message handler
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

          case "inspect-player": {
            lg().info("recv: inspect-player");
            const summary = inspectPlayerDom();
            sendResponse({ ok: true, summary });
            return;
          }

          case "nudge-player": {
            lg().info("recv: nudge-player");
            const tried = nudgePlayer();
            sendResponse({ ok: true, tried });
            return;
          }

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
