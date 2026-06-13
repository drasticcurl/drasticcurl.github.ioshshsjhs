// background.js — Service worker for Skool Classroom Downloader (MV3)
//
// Responsibilities:
//   1. Listen via chrome.webRequest for HLS master playlist URLs (.m3u8) on
//      stream.video.skool.com so the moment a Skool video starts playing we
//      capture its short-lived signed URL.
//   2. Relay messages between the popup and the content script.
//   3. Trigger downloads via chrome.downloads.download when the content
//      script hands us blob URLs of the concatenated .ts files.
//
// State is per-tab because the user may have several Skool tabs open.

const captures = new Map(); // tabId -> { masterUrl, capturedAt, lessonId }

/**
 * webRequest fires for every network request. We watch only the Skool video
 * CDN host(s). The first .m3u8 we see on a tab after a "play" event is the
 * master playlist with a fresh JWT token. We stash it keyed by tab.
 */
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!/\.m3u8(\?|$)/i.test(details.url)) return;

    // We only care about the master / rendition playlists, not segment .ts.
    captures.set(details.tabId, {
      masterUrl: details.url,
      capturedAt: Date.now(),
      // lessonId is set later when the content script tells us which md= it
      // was navigating to.
      lessonId: captures.get(details.tabId)?.lessonId ?? null,
    });

    // Notify content script (it may be awaiting capture in the auto-walker).
    chrome.tabs
      .sendMessage(details.tabId, {
        type: "m3u8-captured",
        url: details.url,
        capturedAt: Date.now(),
      })
      .catch(() => {});
  },
  {
    urls: [
      "*://stream.video.skool.com/*.m3u8*",
      "*://*.video.skool.com/*.m3u8*",
      "*://*.fastly.video.skool.com/*.m3u8*",
    ],
  },
  ["requestHeaders"]
);

/**
 * Message router.
 *  - "set-pending-lesson"  (content -> bg): tell us which lesson we're about
 *                                            to navigate to so the next m3u8
 *                                            is associated correctly.
 *  - "get-capture"         (content/popup -> bg): return current capture for
 *                                                  the tab.
 *  - "download"            (content -> bg): { url, filename } -> trigger
 *                                            chrome.downloads.download.
 *  - "clear-capture"       (content -> bg): wipe stored capture for a tab.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (msg?.type) {
    case "set-pending-lesson": {
      if (tabId == null) break;
      const cur = captures.get(tabId) ?? {};
      captures.set(tabId, {
        ...cur,
        lessonId: msg.lessonId,
        masterUrl: null, // reset so we know the next m3u8 is for this lesson
        capturedAt: null,
      });
      sendResponse({ ok: true });
      break;
    }

    case "get-capture": {
      const targetTabId = msg.tabId ?? tabId;
      sendResponse(captures.get(targetTabId) ?? null);
      break;
    }

    case "clear-capture": {
      if (tabId != null) captures.delete(tabId);
      sendResponse({ ok: true });
      break;
    }

    case "download": {
      // msg = { url, filename, conflictAction? }
      chrome.downloads
        .download({
          url: msg.url,
          filename: msg.filename,
          conflictAction: msg.conflictAction ?? "uniquify",
          saveAs: false,
        })
        .then(
          (id) => sendResponse({ ok: true, downloadId: id }),
          (err) => sendResponse({ ok: false, error: String(err) })
        );
      return true; // keep the channel open for async response
    }

    case "popup-relay": {
      // popup -> bg -> content of active tab
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab) {
            sendResponse({ ok: false, error: "no active tab" });
            return;
          }
          const reply = await chrome.tabs.sendMessage(tab.id, msg.payload);
          sendResponse({ ok: true, reply, tabId: tab.id });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
  }
});

// Clean up captures when tabs close.
chrome.tabs.onRemoved.addListener((tabId) => captures.delete(tabId));
