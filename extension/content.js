// content.js — runs in the page context of *.skool.com.
//
// v0.3 — Skool's player is a lazy-mounted Mux fMP4/CMAF player with
// SEPARATE audio + video tracks. The new download pipeline:
//
//   1. Walker enters a lesson and asks bg for the most recent master
//      .m3u8 URL captured on this tab.
//   2. If that URL is fresh (less than 5 min old) AND was captured after
//      we started this lesson \u2014 use it directly. No need to nudge.
//   3. Otherwise, navigate (or stay) on the lesson, nudge the player
//      (click center of poster, scrollIntoView, fire mux-player.play()),
//      wait up to 45s for a fresh master capture.
//   4. Parse the master, pick a video variant by quality + the matching
//      audio rendition.
//   5. Download both tracks (init + segments) in parallel, save as
//      <lesson>.video.mp4 and <lesson>.audio.mp4.
//   6. After the walker finishes, drop a _remux.sh that merges every
//      pair into a single <lesson>.mp4 with ffmpeg -c copy.

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
  // Classroom DOM scanner
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
    lg().info("scan: classroom name", { name: out.classroomName });

    const allLinks = document.querySelectorAll('a[href*="md="]');
    lg().info("scan: anchor[href*=md=] count", { count: allLinks.length });

    const seen = new Set();
    const lessons = [];
    allLinks.forEach((a) => {
      const m = /[?&]md=([a-f0-9]{32})/i.exec(a.href);
      if (!m) return;
      const md = m[1];
      if (seen.has(md)) return;
      seen.add(md);
      const title = cleanText(a.textContent) || `Lesson ${md.slice(0, 6)}`;
      lessons.push({ md, title, url: absUrl(a.href), sectionTitle: null });
    });
    lg().info("scan: unique lessons", {
      count: lessons.length,
      sample: lessons.slice(0, 3).map((l) => ({ md: l.md, title: l.title })),
    });

    let sectionsMap = new Map();
    if (
      lessons.length > 1 &&
      lessons.every((l) => /^\d+\.\d+\b/.test(l.title))
    ) {
      lg().info("scan: grouping by N.X numeric prefix");
      lessons.forEach((l) => {
        const m = /^(\d+)\.(\d+)/.exec(l.title);
        const k = `Module ${m[1]}`;
        (sectionsMap.get(k) ?? sectionsMap.set(k, []).get(k)).push(l);
      });
    } else {
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
    lg().info("scan: tree built", {
      sections: out.sections.length,
      totalLessons: lessons.length,
      sectionTitles: out.sections.map((s) => s.title),
    });
    return out;
  }

  function detectClassroomName() {
    const t = document.title || "";
    const norm = t.replace(/[\u00b7|]/g, "|"); // treat · and | the same
    const parts = norm.split("|").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      // "Classroom · Acelerador 10k" → take "Acelerador 10k"
      // "Lesson - Course | Community | Skool" → take "Course"
      const left = parts[0];
      const dashSplit = left.split(" - ");
      if (dashSplit.length >= 2) return dashSplit[dashSplit.length - 1];
      // If first segment is the literal word "Classroom", prefer the next.
      if (/^classroom$/i.test(left) && parts[1]) return parts[1];
      return left;
    }
    const h1 = document.querySelector("h1");
    if (h1) return cleanText(h1.textContent);
    return "Classroom";
  }

  function detectCommunityName() {
    const m = /^\/([^\/]+)\/classroom/.exec(location.pathname);
    return m ? m[1] : "skool";
  }

  // ===================================================================
  // Player DOM inspection — diagnostic dump
  // ===================================================================

  function inspectPlayerDom() {
    const iframes = Array.from(document.querySelectorAll("iframe")).map((f) => {
      const r = f.getBoundingClientRect();
      return {
        src: (f.src || "").slice(0, 200),
        title: f.title || null,
        name: f.name || null,
        w: Math.round(r.width),
        h: Math.round(r.height),
        sameOrigin: (() => {
          try { return !!f.contentDocument; } catch { return false; }
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

    // Anything class-named like a player
    const playerLike = Array.from(
      document.querySelectorAll(
        '[class*="MuxPlayer" i], [class*="VideoPlayer" i], [class*="Video" i], [class*="Player" i], [class*="Poster" i], [class*="Thumbnail" i], [class*="Preview" i]'
      )
    )
      .slice(0, 30)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          tag: e.tagName,
          cls: (e.className || "").toString().slice(0, 80),
          w: Math.round(r.width),
          h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0,
        };
      });

    // Walk shadow roots (open ones — mux-player, media-chrome use these).
    const shadowRoots = [];
    const visited = new WeakSet();
    function visit(root, depth, hostLabel) {
      if (!root || visited.has(root) || depth > 6) return;
      visited.add(root);
      const kids = Array.from(root.children || []).map((c) =>
        c.tagName.toLowerCase()
      );
      const hasVideo = !!root.querySelector?.("video");
      shadowRoots.push({
        host: hostLabel,
        childTags: kids.slice(0, 12),
        hasVideo,
        depth,
      });
      Array.from(root.querySelectorAll?.("*") || []).forEach((el) => {
        if (el.shadowRoot) {
          visit(el.shadowRoot, depth + 1, el.tagName.toLowerCase());
        }
      });
    }
    document.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) {
        visit(el.shadowRoot, 0, el.tagName.toLowerCase());
      }
    });

    // The deep video, if any.
    const deepVideo = findDeepVideo();
    const deepVideoInfo = deepVideo
      ? {
          src: deepVideo.currentSrc || deepVideo.src || null,
          readyState: deepVideo.readyState,
          paused: deepVideo.paused,
          duration: deepVideo.duration,
        }
      : null;

    const summary = {
      url: location.href,
      iframes,
      videos,
      deepVideo: deepVideoInfo,
      customElCount: customEls.length,
      customElTypes: customElTypes.slice(0, 30),
      muxLike: customElTypes.filter((t) => /mux|player|video|hls/i.test(t)),
      playerLike,
      shadowRoots,
    };
    lg().info("inspectPlayerDom", summary);
    return summary;
  }

  /**
   * The playback ID Skool uses for the lesson we are currently trying to
   * capture. Set by obtainMasterUrl so the m3u8-captured handler only
   * resolves on the matching master (prevents reusing a previous lesson's
   * video when the walker moves fast).
   */
  let expectedPlaybackId = null;

  /** Extract the Mux playback ID from a master URL, or null. */
  function playbackIdFromMaster(url) {
    const m = /stream\.video\.skool\.com\/([^\/.?]+)\.m3u8/i.exec(url || "");
    return m ? m[1] : null;
  }

  /**
   * Determine the playback ID for the lesson currently shown, by reading
   * the DOM (mux-player attribute, or the thumbnail image URL which embeds
   * the same ID). Returns null if it can't be found.
   */
  function getExpectedPlaybackId() {
    // 1) thumbnail/poster background-image reflects the CURRENTLY shown
    //    lesson (present right after SPA navigation, before the player
    //    mounts) — image.video.skool.com/<ID>/thumbnail...
    const thumb = document.querySelector('[class*="ThumbnailImage" i]');
    if (thumb) {
      const bg =
        thumb.style?.backgroundImage ||
        getComputedStyle(thumb).backgroundImage ||
        "";
      const m = /image\.video\.skool\.com\/([^\/]+)\/(?:thumbnail|storyboard)/i.exec(
        bg
      );
      if (m) return m[1];
    }

    // 2) a mounted mux-player exposes it directly (lesson currently playing)
    const mp = document.querySelector("mux-player, mux-video");
    const attr = mp?.getAttribute?.("playback-id");
    if (attr) return attr;

    // 3) anywhere in the player wrapper's markup
    const wrap = document.querySelector(
      '[class*="MuxThumbnail" i], [class*="MuxPlayer" i]'
    );
    if (wrap) {
      const m = /image\.video\.skool\.com\/([^\/"'&]+)\/(?:thumbnail|storyboard)/i.exec(
        wrap.outerHTML || ""
      );
      if (m) return m[1];
    }
    return null;
  }

  /** Mute + pause every <video>, including ones inside open shadow DOM. */
  function pauseAllVideos() {
    const stop = (v) => {
      try {
        v.muted = true;
        v.pause();
      } catch {}
    };
    document.querySelectorAll("video").forEach(stop);
    const dv = findDeepVideo();
    if (dv) stop(dv);
    // Also try to pause the mux-player host directly.
    const mp = document.querySelector("mux-player, mux-video");
    if (mp) {
      try {
        mp.muted = true;
        mp.pause?.();
      } catch {}
    }
  }

  /**
   * Recursively walk shadow roots looking for a <video> element. Returns
   * the first one found, or null. mux-player wraps several layers of
   * shadow DOM so the native <video> is several levels deep once mounted.
   */
  function findDeepVideo(root = document) {
    const direct = root.querySelector?.("video");
    if (direct) return direct;
    const all = root.querySelectorAll?.("*") || [];
    for (const el of all) {
      if (el.shadowRoot) {
        const found = findDeepVideo(el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Recursively look for a play button inside open shadow DOMs. Returns
   * the first matching element. mux-player exposes its play button via
   * shadow DOM with [part="play"] or as <media-play-button>.
   */
  function findDeepPlayButton(root = document) {
    const sels = [
      '[part~="play"]',
      'media-play-button',
      'button[aria-label*="play" i]',
      'button[aria-label*="reproducir" i]',
      'button[title*="play" i]',
    ];
    for (const sel of sels) {
      const el = root.querySelector?.(sel);
      if (el) return el;
    }
    const all = root.querySelectorAll?.("*") || [];
    for (const el of all) {
      if (el.shadowRoot) {
        const found = findDeepPlayButton(el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  // ===================================================================
  // SPA navigation
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
      lg().debug("nav: clicking sidebar link");
      link.scrollIntoView({ block: "nearest" });
      link.click();
    } else {
      lg().warn("nav: no sidebar link match; using history.pushState");
      history.pushState({}, "", target.pathname + target.search);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    const ok = await waitFor(() => location.search === target.search, 5000);
    lg().info("nav: URL changed", { ok: !!ok, now: location.href });
    await sleep(500);
  }

  // ===================================================================
  // Player nudging — make the player initialize / fetch its manifest
  // ===================================================================

  function nudgePlayer() {
    const tried = [];

    // ---- A) <mux-player> mounted: this is the easy path
    const mp = document.querySelector("mux-player, mux-video");
    if (mp) {
      try {
        // Force muted BEFORE play so Chrome's autoplay policy doesn't block.
        mp.muted = true;
        mp.setAttribute("muted", "");
        mp.setAttribute("autoplay", "");
        const p = mp.play?.();
        if (p && typeof p.catch === "function") p.catch(() => {});
        tried.push("mux-player.muted+play()");
      } catch (e) {
        tried.push("mux-player.play()→threw:" + String(e?.message || e));
      }

      // Click the deep play button inside shadow DOM.
      const playBtn = findDeepPlayButton(mp);
      if (playBtn) {
        try {
          playBtn.click();
          tried.push("deepPlayBtn.click:" + (playBtn.tagName || "?"));
        } catch {}
      }

      // If a real <video> is mounted somewhere deep, mute+play it directly.
      const deepV = findDeepVideo(mp);
      if (deepV) {
        try {
          deepV.muted = true;
          const pp = deepV.play();
          if (pp && pp.catch) pp.catch(() => {});
          tried.push("deepVideo.play()");
        } catch {}
      }
    }

    // ---- B) <video> already in main doc (rare but cheap to try)
    const directV = document.querySelector("video");
    if (directV) {
      try {
        directV.muted = true;
        directV.play()?.catch?.(() => {});
        tried.push("video.play()");
      } catch {}
    }

    // ---- C) Same-origin iframes (also rare)
    document.querySelectorAll("iframe").forEach((f, i) => {
      try {
        const doc = f.contentDocument;
        if (!doc) return;
        const innerV = findDeepVideo(doc);
        if (innerV) {
          innerV.muted = true;
          innerV.play()?.catch?.(() => {});
          tried.push(`iframe[${i}]:video.play()`);
        }
      } catch {}
    });

    // ---- D) Poster mode: mux-player not mounted yet. Click the poster
    //         area to make Skool mount the player. We restrict button
    //         hunting to within the player wrapper so we don't click
    //         something unrelated (community switcher, etc.).
    const wrapper = findPlayerWrapper();
    if (wrapper) {
      wrapper.scrollIntoView({ block: "center", behavior: "instant" });
      tried.push(
        "scrollIntoView:" + (wrapper.className || "").toString().slice(0, 30)
      );

      // Inside the wrapper, find a button or just dispatch a click at
      // the wrapper's center via elementFromPoint.
      const btnInside = wrapper.querySelector(
        'button, [role="button"], [aria-label*="play" i], [data-testid*="play" i]'
      );
      if (btnInside) {
        try {
          btnInside.click();
          tried.push(
            "wrapper.btn.click:" +
              (btnInside.getAttribute("aria-label") || btnInside.tagName)
          );
        } catch {}
      }

      const r = wrapper.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const target = document.elementFromPoint(cx, cy);
      if (target && target !== wrapper) {
        for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
          try {
            target.dispatchEvent(
              new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: cx,
                clientY: cy,
                button: 0,
              })
            );
          } catch {}
        }
        tried.push(
          "elementFromPoint.click:" +
            target.tagName +
            "." +
            ((target.className || "").toString().slice(0, 30) || "-")
        );
      }
    } else {
      tried.push("no-player-wrapper-found");
    }

    lg().info("nudgePlayer: tried", { tried });
    return tried;
  }

  function findPlayerWrapper() {
    // Strategy 1: any <mux-player>/<mux-video> wrapper or its parent chain.
    const mp = document.querySelector("mux-player, mux-video");
    if (mp) {
      // Use the closest reasonably-sized ancestor (or mp itself).
      let cur = mp;
      while (cur) {
        const r = cur.getBoundingClientRect();
        if (r.width >= 200 && r.height >= 100) return cur;
        cur = cur.parentElement;
      }
      return mp;
    }

    // Strategy 2: poster mode. Find any element with a Video*-looking
    // class and walk up to a sizable ancestor.
    const all = Array.from(
      document.querySelectorAll(
        '[class*="MuxThumbnail" i], [class*="ThumbnailImage" i], ' +
          '[class*="MuxPlayer" i], [class*="VideoPlayer" i], [class*="VideoPoster" i], ' +
          '[class*="VideoThumb" i], [class*="VideoPreview" i], ' +
          '[class*="VideoContainer" i], [class*="VideoFrame" i], ' +
          '[class*="VideoWrapper" i], [class*="VideoDuration" i]'
      )
    );
    let seed = null;
    let seedArea = 0;
    for (const el of all) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width >= 50 && r.height >= 30 && area > seedArea) {
        seed = el;
        seedArea = area;
      }
    }
    if (!seed) return null;

    // Walk up until we find an ancestor that is video-shaped (16:9-ish,
    // wide and tall enough). Stop if we'd exceed ~95% of the viewport.
    let best = seed;
    let cur = seed;
    while (cur && cur.parentElement) {
      const pr = cur.parentElement.getBoundingClientRect();
      if (
        pr.width <= window.innerWidth * 0.95 &&
        pr.height <= window.innerHeight * 0.9 &&
        pr.width >= 300 &&
        pr.height >= 150
      ) {
        // Prefer 16:9-ish containers
        const ratio = pr.width / Math.max(1, pr.height);
        if (ratio >= 1.2 && ratio <= 2.5 && pr.width * pr.height > best.getBoundingClientRect().width * best.getBoundingClientRect().height) {
          best = cur.parentElement;
        }
      }
      const r = cur.parentElement.getBoundingClientRect();
      if (r.width > window.innerWidth * 0.95) break;
      cur = cur.parentElement;
    }
    return best;
  }

  // ===================================================================
  // Per-lesson download pipeline (video + audio, fMP4)
  // ===================================================================

  async function downloadLessonTracks({
    masterUrl,
    quality,
    targetDir,
    targetBase,
    onProgress,
  }) {
    const { hlsMod } = await loadModules();
    lg().info("dl: start", {
      masterUrlPrefix: String(masterUrl).slice(0, 80),
      targetDir,
      targetBase,
      quality,
    });

    onProgress?.({ phase: "playlist" });
    const masterText = await hlsMod.fetchPlaylist(masterUrl);
    lg().info("dl: master fetched", { bytes: masterText.length });

    const master = hlsMod.parseMaster(masterText, masterUrl);
    if (!master.variants.length) {
      throw new Error("master has no variants");
    }
    const videoVariant = hlsMod.pickVariant(master.variants, quality);
    if (!videoVariant) throw new Error("no video variant could be picked");
    const audioRendition = hlsMod.pickAudio(master.audioGroups, videoVariant);
    lg().info("dl: chosen", {
      video: videoVariant
        ? {
            bw: videoVariant.bandwidth,
            res: videoVariant.resolution
              ? videoVariant.resolution.join("x")
              : null,
          }
        : null,
      audio: audioRendition
        ? { name: audioRendition.name, lang: audioRendition.language }
        : null,
    });

    onProgress?.({ phase: "rendition", variant: videoVariant });

    // Fetch both rendition playlists.
    const [videoText, audioText] = await Promise.all([
      hlsMod.fetchPlaylist(videoVariant.url),
      audioRendition ? hlsMod.fetchPlaylist(audioRendition.url) : null,
    ]);
    const videoTrack = hlsMod.parseRendition(videoText, videoVariant.url);
    const audioTrack = audioText
      ? hlsMod.parseRendition(audioText, audioRendition.url)
      : null;
    lg().info("dl: tracks parsed", {
      videoSegments: videoTrack.segments.length,
      videoHasInit: !!videoTrack.initSegment,
      audioSegments: audioTrack?.segments?.length ?? 0,
      audioHasInit: !!audioTrack?.initSegment,
      durationSec: videoTrack.totalDuration,
    });

    const totalSegments =
      videoTrack.segments.length +
      (videoTrack.initSegment ? 1 : 0) +
      (audioTrack ? audioTrack.segments.length + (audioTrack.initSegment ? 1 : 0) : 0);
    onProgress?.({
      phase: "segments",
      total: totalSegments,
      done: 0,
      durationSec: videoTrack.totalDuration,
    });

    // Download video + audio in parallel. Each callback updates a shared
    // counter for combined progress reporting.
    let combinedDone = 0;
    let lastReportedAt = 0;
    function bumpProgress() {
      combinedDone++;
      const now = Date.now();
      if (combinedDone === totalSegments || now - lastReportedAt > 800) {
        onProgress?.({ phase: "segments", total: totalSegments, done: combinedDone });
        lastReportedAt = now;
      }
    }

    const [videoBytes, audioBytes] = await Promise.all([
      hlsMod.downloadTrack(videoTrack, () => bumpProgress(), undefined, 6),
      audioTrack
        ? hlsMod.downloadTrack(audioTrack, () => bumpProgress(), undefined, 6)
        : Promise.resolve(null),
    ]);
    lg().info("dl: tracks fetched", {
      videoBytes: videoBytes.byteLength,
      audioBytes: audioBytes?.byteLength ?? 0,
    });

    onProgress?.({ phase: "saving" });

    const videoFilename = `${targetDir}/${targetBase}.video.mp4`;
    const audioFilename = audioBytes
      ? `${targetDir}/${targetBase}.audio.mp4`
      : null;

    await sendDownload(videoBytes, "video/mp4", videoFilename);
    if (audioBytes) {
      await sendDownload(audioBytes, "video/mp4", audioFilename);
    }

    return {
      videoFilename,
      audioFilename,
      videoBytes: videoBytes.byteLength,
      audioBytes: audioBytes?.byteLength ?? 0,
      totalBytes:
        videoBytes.byteLength + (audioBytes?.byteLength ?? 0),
      durationSec: videoTrack.totalDuration,
      resolution: videoVariant.resolution
        ? videoVariant.resolution.join("x")
        : null,
    };
  }

  async function sendDownload(bytes, mime, filename) {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "download",
        url,
        filename,
      });
      if (!resp?.ok) {
        lg().error("dl: chrome.downloads failed", {
          filename,
          error: resp?.error,
        });
        throw new Error(resp?.error || "download failed");
      }
      lg().info("dl: download dispatched", {
        downloadId: resp.downloadId,
        filename,
      });
      await sleep(1500);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ===================================================================
  // Get-or-wait master URL for the current lesson
  // ===================================================================

  /**
   * After a navigation, obtain a master m3u8 URL that belongs to THIS
   * lesson, identified by playback ID read from the DOM.
   *
   * Returns { url, source, pid }.
   *
   * - We never reuse a capture whose playback ID doesn't match the lesson
   *   currently shown — that was the v0.4 bug where the walker reused the
   *   previous lesson's master (same URL for lessons 3..10).
   * - If the bg already holds a master for the expected playback ID, use it.
   * - Otherwise nudge the player to mount + play so Skool fires the
   *   manifest, and await a capture whose playback ID matches.
   */
  async function obtainMasterUrl(navStartedAt) {
    const expectedId = getExpectedPlaybackId();
    expectedPlaybackId = expectedId;
    lg().info("obtainMaster: expected playback id", { expectedId });

    // Strategy A: reuse only if the stored master matches the expected ID.
    const cap = await chrome.runtime.sendMessage({ type: "get-capture" });
    if (cap?.masterUrl) {
      const pid = playbackIdFromMaster(cap.masterUrl);
      const fresh = cap.masterAt && Date.now() - cap.masterAt < 5 * 60 * 1000;
      if (fresh && expectedId && pid === expectedId) {
        lg().info("obtainMaster: reusing matching capture", {
          pid,
          ageMs: Date.now() - cap.masterAt,
        });
        expectedPlaybackId = null;
        return { url: cap.masterUrl, source: "reused", pid };
      }
      // If we don't know the expected ID, fall back to the old time-based
      // reuse (only when captured at/after this nav).
      if (fresh && !expectedId && cap.masterAt >= navStartedAt - 1000) {
        lg().warn("obtainMaster: reusing by timing (no expected id)", {
          pid,
        });
        return { url: cap.masterUrl, source: "reused-timing", pid };
      }
      lg().debug("obtainMaster: stored capture not usable", {
        storedPid: pid,
        expectedId,
      });
    }

    // Strategy B: nudge + await a capture whose pid matches expectedId.
    const promise = awaitNextCapture(45000);
    nudgePlayer();
    const t1 = setTimeout(() => {
      lg().info("obtainMaster: 5s elapsed, nudge again");
      nudgePlayer();
    }, 5000);
    const t2 = setTimeout(() => {
      lg().warn("obtainMaster: 15s elapsed, nudge third time");
      nudgePlayer();
    }, 15000);
    let cap2;
    try {
      cap2 = await promise;
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      expectedPlaybackId = null;
    }
    return {
      url: cap2.url,
      source: "fresh",
      pid: playbackIdFromMaster(cap2.url),
    };
  }

  // ===================================================================
  // Auto-walker
  // ===================================================================

  let walkerRunning = false;
  let walkerAbort = false;

  async function runAutoWalker({ folderName, quality, onUpdate }) {
    if (walkerRunning) {
      lg().warn("walker: refused, already running");
      throw new Error("walker is already running in this tab");
    }
    walkerRunning = true;
    walkerAbort = false;
    try {
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

      if (total === 0) {
        lg().error("walker: 0 lessons; aborting");
        onUpdate?.({ type: "lesson-error", error: "0 lessons found" });
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

        for (const lesson of section.lessons) {
          if (walkerAbort) {
            lg().warn("walker: abort requested, exiting");
            onUpdate?.({ type: "aborted" });
            return manifest;
          }
          processed++;
          const lessonBase = `${pad(lesson.index)} - ${sanitizeForPath(
            lesson.title
          )}`;
          const targetDir = `${safeFolder}/${safeClassroom}/${sectionDir}`;
          const targetBase = lessonBase;
          lg().info("walker: lesson begin", {
            progress: `${processed}/${total}`,
            title: lesson.title,
            md: lesson.md,
            targetDir,
            targetBase,
          });
          onUpdate?.({
            type: "lesson-start",
            processed,
            total,
            section: section.title,
            title: lesson.title,
            file: `${targetDir}/${targetBase}`,
          });

          try {
            await chrome.runtime.sendMessage({
              type: "set-pending-lesson",
              lessonId: lesson.md,
            });

            const navStartedAt = Date.now();
            await navigateToLesson(lesson.url);
            await sleep(800);
            inspectPlayerDom();

            const { url: masterUrl, source } = await obtainMasterUrl(
              navStartedAt
            );
            lg().info("walker: master obtained", { source, processed });

            // Stop playback (mute + pause, including deep shadow-DOM video)
            // so we don't end up with every lesson blaring at once.
            pauseAllVideos();

            const result = await downloadLessonTracks({
              masterUrl,
              quality,
              targetDir,
              targetBase,
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
              videoFile: result.videoFilename,
              audioFile: result.audioFilename,
              durationSec: result.durationSec,
              resolution: result.resolution,
              status: "ok",
            });
            lg().info("walker: lesson done", {
              title: lesson.title,
              totalBytes: result.totalBytes,
            });
            onUpdate?.({
              type: "lesson-done",
              processed,
              total,
              title: lesson.title,
              sizeBytes: result.totalBytes,
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
          await sleep(800);
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
    } finally {
      walkerRunning = false;
    }
  }

  function abortWalker() {
    walkerAbort = true;
    lg().warn("walker: abort flagged");
  }

  // ===================================================================
  // Manual: capture & download current lesson only
  // ===================================================================

  async function captureCurrent({ folderName, quality, onUpdate }) {
    if (walkerRunning) throw new Error("walker is currently running");
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

    const targetDir = `${safeFolder}/${safeClassroom}/${pad(
      section.index
    )} - ${sanitizeForPath(section.title)}`;
    const targetBase = `${pad(lesson.index || 1)} - ${sanitizeForPath(
      lesson.title
    )}`;

    onUpdate?.({
      type: "lesson-start",
      processed: 1,
      total: 1,
      title: lesson.title,
      file: `${targetDir}/${targetBase}`,
    });

    await chrome.runtime.sendMessage({
      type: "set-pending-lesson",
      lessonId: lesson.md,
    });
    const navStartedAt = Date.now();
    inspectPlayerDom();
    const { url: masterUrl } = await obtainMasterUrl(navStartedAt);

    const result = await downloadLessonTracks({
      masterUrl,
      quality,
      targetDir,
      targetBase,
      onProgress: (p) => onUpdate?.({ type: "lesson-progress", ...p }),
    });

    // Drop a tiny remux script just for this single lesson.
    await saveSidecarFiles({
      folderName: safeFolder,
      classroomName: safeClassroom,
      manifest: null, // skip writing _manifest.json for single lessons
    });

    onUpdate?.({
      type: "lesson-done",
      processed: 1,
      total: 1,
      title: lesson.title,
      sizeBytes: result.totalBytes,
    });
    onUpdate?.({ type: "all-done" });
    return { ok: true };
  }

  // ===================================================================
  // Sidecar files: _manifest.json and _remux.sh
  // ===================================================================

  async function saveSidecarFiles({ folderName, classroomName, manifest }) {
    const base = `${folderName}/${classroomName}`;

    if (manifest) {
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
    }

    const sh = `#!/usr/bin/env bash
# _remux.sh — merges every <lesson>.video.mp4 + <lesson>.audio.mp4 pair
# into a single <lesson>.mp4 using ffmpeg stream copy (lossless, ~instant).
# Generated by Skool Classroom Downloader.

set -euo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Install it first (brew install ffmpeg on macOS)." >&2
  exit 1
fi

shopt -s globstar nullglob
merged=0
videoonly=0
for video in **/*.video.mp4; do
  base="\${video%.video.mp4}"
  audio="\${base}.audio.mp4"
  out="\${base}.mp4"
  if [ -f "$out" ]; then
    echo "skip (exists): $out"
    continue
  fi
  if [ -f "$audio" ]; then
    echo "merging: $base.{video,audio}.mp4 -> $out"
    ffmpeg -hide_banner -loglevel error -y -i "$video" -i "$audio" -c copy -movflags +faststart "$out"
    merged=$((merged+1))
  else
    echo "video-only (no audio file): $video -> $out"
    ffmpeg -hide_banner -loglevel error -y -i "$video" -c copy -movflags +faststart "$out"
    videoonly=$((videoonly+1))
  fi
done

# Also remux any plain .ts artifacts from previous versions (safe no-op if absent).
for ts in **/*.ts; do
  out="\${ts%.ts}.mp4"
  [ -f "$out" ] && continue
  echo "remuxing legacy .ts: $ts -> $out"
  ffmpeg -hide_banner -loglevel error -y -i "$ts" -c copy -bsf:a aac_adtstoasc "$out"
done

echo
echo "Done. merged=$merged  videoonly=$videoonly"
echo "Originals kept; delete .video.mp4 / .audio.mp4 / .ts manually when satisfied."
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
  // Message handler
  // ===================================================================

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

          case "inspect-player": {
            const summary = inspectPlayerDom();
            sendResponse({ ok: true, summary });
            return;
          }

          case "nudge-player": {
            const tried = nudgePlayer();
            sendResponse({ ok: true, tried });
            return;
          }

          case "start-walker": {
            lg().info("recv: start-walker", {
              folderName: msg.folderName,
              quality: msg.quality,
              alreadyRunning: walkerRunning,
            });
            if (walkerRunning) {
              sendResponse({
                ok: false,
                error: "walker is already running in this tab",
              });
              return;
            }
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

          case "get-content-logs": {
            const m = await loadModules();
            sendResponse({ ok: true, entries: m.log.getEntries() });
            return;
          }

          case "m3u8-captured":
            lg().info("recv: m3u8-captured", { url: msg.url });
            if (pendingCapture) {
              const pid = playbackIdFromMaster(msg.url);
              if (!expectedPlaybackId || pid === expectedPlaybackId) {
                pendingCapture.resolve(msg);
              } else {
                lg().debug("ignoring captured master: pid mismatch", {
                  capturedPid: pid,
                  expected: expectedPlaybackId,
                });
              }
            }
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
