// background.js — Service worker for Skool Classroom Downloader (MV3).

import { createLogger, formatEntries } from "./lib/logger.js";

const log = createLogger("bg");

log.info("service worker booted", {
  version: chrome.runtime.getManifest().version,
  ts: new Date().toISOString(),
});

const captures = new Map(); // tabId -> { masterUrl, capturedAt, lessonId }

/**
 * Watch every request on every URL. We filter inside the listener for
 * anything that looks like an HLS playlist or video manifest. This
 * intentionally broad scope was added in v0.2 because Skool's native player
 * may be served from hosts other than *.video.skool.com (e.g. Mux directly).
 */
function isVideoManifestUrl(u) {
  return /\.m3u8(\?|$)/i.test(u) || /\/manifest[^?]*\.(m3u8|mpd)/i.test(u);
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!isVideoManifestUrl(details.url)) return;

    const prev = captures.get(details.tabId) ?? {};
    captures.set(details.tabId, {
      masterUrl: details.url,
      capturedAt: Date.now(),
      lessonId: prev.lessonId ?? null,
    });

    log.info("manifest captured via webRequest", {
      tabId: details.tabId,
      lessonId: prev.lessonId,
      method: details.method,
      type: details.type,
      url: details.url,
    });

    chrome.tabs
      .sendMessage(details.tabId, {
        type: "m3u8-captured",
        url: details.url,
        capturedAt: Date.now(),
      })
      .catch((e) =>
        log.debug("could not notify content of capture", { e: String(e) })
      );
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

// Also log every fetched URL that contains "video" or "stream" or "media"
// for diagnostic purposes — many video CDN endpoints have those tokens.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const u = details.url;
    if (!/(video|stream|media|mux|hls|playback)/i.test(u)) return;
    if (isVideoManifestUrl(u)) return; // already logged above
    log.debug("video-ish request seen", {
      tabId: details.tabId,
      type: details.type,
      method: details.method,
      url: u.length > 200 ? u.slice(0, 200) + "…" : u,
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  log.debug("onMessage", { type: msg?.type, fromTab: tabId });

  switch (msg?.type) {
    case "set-pending-lesson": {
      if (tabId == null) {
        sendResponse({ ok: false, error: "no tabId" });
        break;
      }
      const cur = captures.get(tabId) ?? {};
      captures.set(tabId, {
        ...cur,
        lessonId: msg.lessonId,
        masterUrl: null,
        capturedAt: null,
      });
      log.info("set-pending-lesson", { tabId, lessonId: msg.lessonId });
      sendResponse({ ok: true });
      break;
    }

    case "get-capture": {
      const targetTabId = msg.tabId ?? tabId;
      const cap = captures.get(targetTabId) ?? null;
      log.debug("get-capture", { tabId: targetTabId, hasCapture: !!cap });
      sendResponse(cap);
      break;
    }

    case "clear-capture": {
      if (tabId != null) {
        captures.delete(tabId);
        log.info("clear-capture", { tabId });
      }
      sendResponse({ ok: true });
      break;
    }

    case "download": {
      log.info("download requested", {
        filename: msg.filename,
        urlPrefix: String(msg.url).slice(0, 30),
        conflictAction: msg.conflictAction,
      });
      chrome.downloads
        .download({
          url: msg.url,
          filename: msg.filename,
          conflictAction: msg.conflictAction ?? "uniquify",
          saveAs: false,
        })
        .then(
          (id) => {
            log.info("download started", {
              downloadId: id,
              filename: msg.filename,
            });
            sendResponse({ ok: true, downloadId: id });
          },
          (err) => {
            log.error("download failed", {
              filename: msg.filename,
              error: String(err),
            });
            sendResponse({ ok: false, error: String(err) });
          }
        );
      return true;
    }

    case "get-bg-logs": {
      sendResponse({ ok: true, entries: log.getEntries() });
      break;
    }

    case "popup-relay": {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab) {
            log.warn("popup-relay: no active tab");
            sendResponse({ ok: false, error: "no active tab" });
            return;
          }
          log.debug("popup-relay -> content", {
            tabId: tab.id,
            inner: msg.payload?.type,
          });
          const reply = await chrome.tabs.sendMessage(tab.id, msg.payload);
          sendResponse({ ok: true, reply, tabId: tab.id });
        } catch (e) {
          log.error("popup-relay error", { error: String(e) });
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (captures.delete(tabId))
    log.info("tab closed, capture cleared", { tabId });
});

self.addEventListener("error", (e) => {
  log.error("sw error event", {
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
  });
});
self.addEventListener("unhandledrejection", (e) => {
  log.error("sw unhandledrejection", { reason: String(e.reason) });
});

self.__skoolDLDumpLogs = () => formatEntries(log.getEntries());
