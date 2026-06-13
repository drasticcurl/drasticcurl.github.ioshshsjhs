// popup.js — UI orchestration. Talks to the content script via the
// background "popup-relay" messages.

import { createLogger, formatEntries } from "../lib/logger.js";
const log = createLogger("popup");
log.info("popup opened");

const $ = (sel) => document.querySelector(sel);
const status = $("#status");
const folderInput = $("#folderName");
const qualitySelect = $("#quality");
const btnScan = $("#btnScan");
const btnWalker = $("#btnWalker");
const btnCurrent = $("#btnCurrent");
const btnAbort = $("#btnAbort");
const btnCopyLogs = $("#btnCopyLogs");
const btnSaveLogs = $("#btnSaveLogs");
const copyHint = $("#copyHint");
const tree = $("#tree");
const treeBody = $("#treeBody");
const progress = $("#progress");
const barFill = $("#barFill");
const logBox = $("#log");

// Restore last-used folder name + quality from storage.
chrome.storage.local
  .get(["folderName", "quality"])
  .then(({ folderName, quality }) => {
    if (folderName) folderInput.value = folderName;
    if (quality) qualitySelect.value = quality;
    log.debug("storage loaded", { folderName, quality });
  });
folderInput.addEventListener("input", () => {
  chrome.storage.local.set({ folderName: folderInput.value.trim() });
});
qualitySelect.addEventListener("change", () => {
  chrome.storage.local.set({ quality: qualitySelect.value });
});

// Check whether the active tab is a Skool page on load.
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  log.info("active tab", { id: tab?.id, url: tab?.url });
  if (!tab?.url || !/^https?:\/\/[^\/]*\.skool\.com\//.test(tab.url)) {
    status.textContent = "Open a Skool classroom tab and reopen this popup.";
    btnScan.disabled = true;
    btnCurrent.disabled = true;
    log.warn("not on a skool tab; disabling scan/current buttons");
    return;
  }
  try {
    const r = await relay({ type: "ping" });
    log.info("ping reply", r);
    if (r?.reply?.classroom) {
      status.textContent = `Detected: ${r.reply.classroom}`;
      if (!folderInput.value)
        folderInput.value = sanitize(r.reply.classroom).slice(0, 60);
    }
  } catch (e) {
    log.error("ping failed", { error: String(e) });
    status.textContent =
      "Couldn't reach the page. Reload the Skool tab and try again.";
  }
})();

// --- Buttons ----------------------------------------------------------

btnScan.addEventListener("click", async () => {
  log.info("button: scan clicked");
  btnScan.disabled = true;
  status.textContent = "Scanning classroom…";
  try {
    const { reply } = await relay({ type: "scan" });
    log.info("scan reply", { ok: reply?.ok, sections: reply?.tree?.sections?.length });
    if (!reply?.ok) throw new Error(reply?.error || "scan failed");
    renderTree(reply.tree);
    btnWalker.disabled = false;
    btnWalker.dataset.ready = "1";
    if (!folderInput.value)
      folderInput.value = sanitize(reply.tree.classroomName).slice(0, 60);
    const total = countLessons(reply.tree);
    status.textContent = `Found ${total} lessons in ${reply.tree.sections.length} sections.`;
    if (total === 0) {
      log.warn("scan returned 0 lessons; the sidebar selectors may need adjusting");
      status.textContent =
        "Scan found 0 lessons. Click 'Copy debug log' and check the log.";
    }
  } catch (e) {
    log.error("scan threw", { error: String(e?.message || e) });
    status.textContent = "Scan error: " + e.message;
  } finally {
    btnScan.disabled = false;
  }
});

btnWalker.addEventListener("click", async () => {
  log.info("button: walker clicked");
  const folderName = (folderInput.value || "Skool").trim();
  if (!folderName) {
    status.textContent = "Please enter a folder name.";
    return;
  }
  setBusy(true);
  showProgress();
  try {
    const { reply } = await relay({
      type: "start-walker",
      folderName,
      quality: qualitySelect.value,
    });
    log.info("walker reply", { ok: reply?.ok, sections: reply?.manifest?.sections?.length });
    if (!reply?.ok) throw new Error(reply?.error || "walker failed");
    appendLog("All done.", "ok");
    status.textContent = "Done.";
  } catch (e) {
    log.error("walker threw", { error: String(e?.message || e) });
    appendLog("Error: " + e.message, "err");
    status.textContent = "Failed: " + e.message;
  } finally {
    setBusy(false);
  }
});

btnCurrent.addEventListener("click", async () => {
  log.info("button: capture-current clicked");
  const folderName = (folderInput.value || "Skool").trim();
  setBusy(true);
  showProgress();
  try {
    const { reply } = await relay({
      type: "capture-current",
      folderName,
      quality: qualitySelect.value,
    });
    log.info("capture-current reply", { ok: reply?.ok });
    if (!reply?.ok) throw new Error(reply?.error || "capture failed");
    appendLog("Current lesson saved.", "ok");
    status.textContent = "Done.";
  } catch (e) {
    log.error("capture-current threw", { error: String(e?.message || e) });
    appendLog("Error: " + e.message, "err");
    status.textContent = "Failed: " + e.message;
  } finally {
    setBusy(false);
  }
});

btnAbort.addEventListener("click", async () => {
  log.info("button: abort clicked");
  await relay({ type: "abort-walker" });
  appendLog("Stopping after current lesson…");
});

const btnInspect = $("#btnInspect");
const btnNudge = $("#btnNudge");
btnInspect.addEventListener("click", async () => {
  log.info("button: inspect-player clicked");
  showProgress();
  try {
    const { reply } = await relay({ type: "inspect-player" });
    if (!reply?.ok) throw new Error(reply?.error || "inspect failed");
    const s = reply.summary;
    appendLog(
      `iframes: ${s.iframes.length} | <video>: ${s.videos.length} | mux-like: ${
        s.muxLike.join(", ") || "none"
      }`
    );
    s.iframes.forEach((f, i) => {
      appendLog(
        `  iframe[${i}] ${f.w}x${f.h} sameOrigin=${f.sameOrigin} src=${
          f.src ? f.src.slice(0, 60) : "(empty)"
        }`
      );
    });
    s.videos.forEach((v, i) => {
      appendLog(
        `  video[${i}] readyState=${v.readyState} paused=${v.paused} src=${
          v.src ? v.src.slice(0, 60) : "(none)"
        }`
      );
    });
    s.playerLike.forEach((c, i) => {
      appendLog(
        `  playerLike[${i}] ${c.tag} ${c.w}x${c.h} cls=${
          c.cls ? c.cls.slice(0, 50) : "-"
        }`
      );
    });
    if (s.shadowRoots && s.shadowRoots.length) {
      appendLog(`shadow roots: ${s.shadowRoots.length}`);
      s.shadowRoots.forEach((sh, i) => {
        appendLog(
          `  shadow[${i}] host=${sh.host} kids=${sh.childTags.join(",")}${
            sh.hasVideo ? " HAS_VIDEO" : ""
          }`
        );
      });
    }
    appendLog("Done. Use 'Copy debug log' to send full details.", "ok");
  } catch (e) {
    appendLog("Error: " + e.message, "err");
  }
});

btnNudge.addEventListener("click", async () => {
  log.info("button: nudge clicked");
  showProgress();
  try {
    const { reply } = await relay({ type: "nudge-player" });
    if (!reply?.ok) throw new Error(reply?.error || "nudge failed");
    appendLog("Nudge tried: " + (reply.tried.join(", ") || "(nothing)"));
  } catch (e) {
    appendLog("Error: " + e.message, "err");
  }
});

btnCopyLogs.addEventListener("click", async () => {
  await dumpLogs("copy");
});
btnSaveLogs.addEventListener("click", async () => {
  await dumpLogs("save");
});

// --- Live progress (broadcast messages from content/background) -------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "walker-progress") return;
  const e = msg.evt;
  switch (e.type) {
    case "start":
      appendLog(`Starting: ${e.classroom} (${e.total} lessons)`);
      barFill.style.width = "0%";
      break;
    case "lesson-start":
      appendLog(`[${e.processed}/${e.total}] ${e.title}`);
      break;
    case "lesson-progress":
      if (e.phase === "segments" && e.total) {
        const pct = Math.round((e.done / e.total) * 100);
        const overall =
          ((e.processed - 1) / e.total) * 100 + (pct / 100) * (100 / e.total);
        barFill.style.width = overall + "%";
      }
      break;
    case "lesson-done":
      appendLog(`  ✓ ${humanSize(e.sizeBytes)}`, "ok");
      barFill.style.width = (e.processed / e.total) * 100 + "%";
      break;
    case "lesson-error":
      appendLog(`  ✗ ${e.error}`, "err");
      break;
    case "all-done":
      barFill.style.width = "100%";
      break;
    case "aborted":
      appendLog("Aborted by user.", "err");
      break;
  }
});

// --- Debug log dump ---------------------------------------------------

async function dumpLogs(mode) {
  log.info(`dumpLogs(${mode}) requested`);
  copyHint.textContent = "gathering…";
  copyHint.style.color = "";
  try {
    const all = [];
    // Popup logs
    all.push(...log.getEntries());

    // Background logs
    try {
      const bg = await chrome.runtime.sendMessage({ type: "get-bg-logs" });
      if (bg?.entries) all.push(...bg.entries);
    } catch (e) {
      log.warn("could not get bg logs", { error: String(e) });
    }

    // Content logs (via relay)
    try {
      const c = await relay({ type: "get-content-logs" });
      if (c?.reply?.entries) all.push(...c.reply.entries);
    } catch (e) {
      log.warn("could not get content logs", { error: String(e) });
    }

    const text = formatEntries(all) || "(no entries)";
    const meta = [
      `# Skool Classroom Downloader debug log`,
      `# generated: ${new Date().toISOString()}`,
      `# ext version: ${chrome.runtime.getManifest().version}`,
      `# entries: ${all.length}`,
      ``,
    ].join("\n");
    const full = meta + text + "\n";

    if (mode === "save") {
      const blob = new Blob([full], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const filename = `skool-dl-debug-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.txt`;
      await chrome.runtime.sendMessage({
        type: "download",
        url,
        filename,
        conflictAction: "uniquify",
      });
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      copyHint.textContent = `saved as ${filename}`;
      copyHint.style.color = "var(--ok)";
    } else {
      await navigator.clipboard.writeText(full);
      copyHint.textContent = `copied (${all.length} entries)`;
      copyHint.style.color = "var(--ok)";
    }
    setTimeout(() => (copyHint.textContent = ""), 4000);
  } catch (e) {
    log.error("dumpLogs failed", { error: String(e?.message || e) });
    copyHint.textContent = "failed: " + e.message;
    copyHint.style.color = "var(--danger)";
  }
}

// --- helpers ----------------------------------------------------------

async function relay(payload) {
  return chrome.runtime.sendMessage({ type: "popup-relay", payload });
}

function renderTree(t) {
  tree.hidden = false;
  treeBody.innerHTML = "";
  for (const s of t.sections) {
    const div = document.createElement("div");
    div.className = "section";
    const h = document.createElement("div");
    h.className = "section-title";
    h.textContent = `${s.index}. ${s.title} (${s.lessons.length})`;
    const ul = document.createElement("ul");
    for (const l of s.lessons) {
      const li = document.createElement("li");
      li.textContent = `${l.index}. ${l.title}`;
      ul.appendChild(li);
    }
    div.append(h, ul);
    treeBody.appendChild(div);
  }
}

function countLessons(t) {
  return t.sections.reduce((sum, s) => sum + s.lessons.length, 0);
}

function setBusy(b) {
  btnScan.disabled = b;
  btnWalker.disabled = b || !btnWalker.dataset.ready;
  btnCurrent.disabled = b;
  btnAbort.disabled = !b;
}

function showProgress() {
  progress.hidden = false;
  logBox.textContent = "";
  barFill.style.width = "0%";
}

function appendLog(line, cls) {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.textContent = line;
  logBox.appendChild(d);
  logBox.scrollTop = logBox.scrollHeight;
}

function humanSize(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(n < 10 ? 1 : 0) + " " + u[i];
}

function sanitize(s) {
  return (s || "").replace(/[\/\\:*?"<>|]/g, "-").trim();
}
