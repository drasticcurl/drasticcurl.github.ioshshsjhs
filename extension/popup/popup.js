// popup.js — UI orchestration. Talks to the content script via the
// background "popup-relay" messages.

const $ = (sel) => document.querySelector(sel);
const status = $("#status");
const folderInput = $("#folderName");
const qualitySelect = $("#quality");
const btnScan = $("#btnScan");
const btnWalker = $("#btnWalker");
const btnCurrent = $("#btnCurrent");
const btnAbort = $("#btnAbort");
const tree = $("#tree");
const treeBody = $("#treeBody");
const progress = $("#progress");
const barFill = $("#barFill");
const log = $("#log");

// Restore last-used folder name from storage so the user doesn't retype it.
chrome.storage.local
  .get(["folderName", "quality"])
  .then(({ folderName, quality }) => {
    if (folderName) folderInput.value = folderName;
    if (quality) qualitySelect.value = quality;
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
  if (!tab?.url || !/^https?:\/\/[^\/]*\.skool\.com\//.test(tab.url)) {
    status.textContent = "Open a Skool classroom tab and reopen this popup.";
    btnScan.disabled = true;
    btnCurrent.disabled = true;
    return;
  }
  // ping content script
  try {
    const r = await relay({ type: "ping" });
    if (r?.reply?.classroom) {
      status.textContent = `Detected: ${r.reply.classroom}`;
      if (!folderInput.value)
        folderInput.value = sanitize(r.reply.classroom).slice(0, 60);
    }
  } catch {
    status.textContent =
      "Couldn't reach the page. Reload the Skool tab and try again.";
  }
})();

// --- Buttons ----------------------------------------------------------

btnScan.addEventListener("click", async () => {
  btnScan.disabled = true;
  status.textContent = "Scanning classroom…";
  try {
    const { reply } = await relay({ type: "scan" });
    if (!reply?.ok) throw new Error(reply?.error || "scan failed");
    renderTree(reply.tree);
    btnWalker.disabled = false;
    btnWalker.dataset.ready = "1";
    if (!folderInput.value)
      folderInput.value = sanitize(reply.tree.classroomName).slice(0, 60);
    status.textContent = `Found ${countLessons(reply.tree)} lessons in ${
      reply.tree.sections.length
    } sections.`;
  } catch (e) {
    status.textContent = "Scan error: " + e.message;
  } finally {
    btnScan.disabled = false;
  }
});

btnWalker.addEventListener("click", async () => {
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
    if (!reply?.ok) throw new Error(reply?.error || "walker failed");
    appendLog("All done.", "ok");
    status.textContent = "Done.";
  } catch (e) {
    appendLog("Error: " + e.message, "err");
    status.textContent = "Failed: " + e.message;
  } finally {
    setBusy(false);
  }
});

btnCurrent.addEventListener("click", async () => {
  const folderName = (folderInput.value || "Skool").trim();
  setBusy(true);
  showProgress();
  try {
    const { reply } = await relay({
      type: "capture-current",
      folderName,
      quality: qualitySelect.value,
    });
    if (!reply?.ok) throw new Error(reply?.error || "capture failed");
    appendLog("Current lesson saved.", "ok");
    status.textContent = "Done.";
  } catch (e) {
    appendLog("Error: " + e.message, "err");
    status.textContent = "Failed: " + e.message;
  } finally {
    setBusy(false);
  }
});

btnAbort.addEventListener("click", async () => {
  await relay({ type: "abort-walker" });
  appendLog("Stopping after current lesson…");
});

// --- Live progress ----------------------------------------------------

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
  log.textContent = "";
  barFill.style.width = "0%";
}

function appendLog(line, cls) {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.textContent = line;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
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
