// background.js — Service worker for Skool Classroom Downloader (MV3).

import { createLogger, formatEntries } from "./lib/logger.js";

const log = createLogger("bg");

log.info("service worker booted", {
  version: chrome.runtime.getManifest().version,
  ts: new Date().toISOString(),
});

// captures[tabId] = {
//   masterUrl: string|null,    // most recent MASTER playlist URL seen
//   masterAt: number|null,     // when it was captured
//   pendingLesson: string|null,// the lesson the walker is currently waiting on
//   pendingSetAt: number|null, // when we last set pendingLesson
// }
const captures = new Map();

function isMasterPlaylistUrl(u) {
  if (!/\.m3u8(\?|$)/i.test(u)) return false;
  // Skool's per-track renditions live at /<id>/rendition.m3u8 — skip those.
  if (/\/rendition\.m3u8/i.test(u)) return false;
  return true;
}

function isAnyPlaylistUrl(u) {
  return /\.m3u8(\?|$)/i.test(u);
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!isAnyPlaylistUrl(details.url)) return;

    const isMaster = isMasterPlaylistUrl(details.url);
    log.info(isMaster ? "master m3u8 captured" : "rendition m3u8 seen", {
      tabId: details.tabId,
      method: details.method,
      type: details.type,
      url: details.url,
    });

    if (isMaster) {
      const cur = captures.get(details.tabId) ?? {};
      captures.set(details.tabId, {
        ...cur,
        masterUrl: details.url,
        masterAt: Date.now(),
      });
      // Notify content script so any awaitNextCapture() resolves.
      chrome.tabs
        .sendMessage(details.tabId, {
          type: "m3u8-captured",
          url: details.url,
          capturedAt: Date.now(),
        })
        .catch(() => {});
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

// Diagnostic listener — logs any URL that looks video-related but isn't a
// playlist. Helps see segment fetches in the bg log.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const u = details.url;
    if (!/(video|stream|media|mux|hls|playback)/i.test(u)) return;
    if (isAnyPlaylistUrl(u)) return;
    log.debug("video-ish request seen", {
      tabId: details.tabId,
      type: details.type,
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
      // IMPORTANT v0.3 fix: we do NOT clear masterUrl here. The content
      // script decides whether to reuse it (if recent enough) or wait
      // for a fresh one based on the timestamp.
      if (tabId == null) {
        sendResponse({ ok: false, error: "no tabId" });
        break;
      }
      const cur = captures.get(tabId) ?? {};
      captures.set(tabId, {
        ...cur,
        pendingLesson: msg.lessonId,
        pendingSetAt: Date.now(),
      });
      log.info("set-pending-lesson", {
        tabId,
        lessonId: msg.lessonId,
        keepingExistingMaster: !!cur.masterUrl,
        masterAge: cur.masterAt ? Date.now() - cur.masterAt : null,
      });
      sendResponse({ ok: true, existingMaster: cur.masterUrl ?? null });
      break;
    }

    case "get-capture": {
      const targetTabId = msg.tabId ?? tabId;
      const cap = captures.get(targetTabId) ?? null;
      log.debug("get-capture", { tabId: targetTabId, hasCapture: !!cap?.masterUrl });
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
            log.info("download started", { downloadId: id, filename: msg.filename });
            sendResponse({ ok: true, downloadId: id });
          },
          (err) => {
            log.error("download failed", { filename: msg.filename, error: String(err) });
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
  if (captures.delete(tabId)) log.info("tab closed, capture cleared", { tabId });
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
