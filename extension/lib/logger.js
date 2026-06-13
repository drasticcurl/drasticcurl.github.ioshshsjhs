// lib/logger.js — small logger shared across background, content, popup
// and any sub-module imported by them.
//
// Within one JS execution context (e.g. the content script + lib/hls.js it
// imports) all calls to createLogger() share the same ring buffer. Across
// contexts (background SW vs content) the buffers are independent because
// each context evaluates this module separately.
//
// The popup gathers all three buffers via messages and combines them for
// the user to copy/save.

const RING_SIZE = 1000;

// Module-scoped, shared by every createLogger() call in the same context.
const SHARED_BUFFER = [];

function push(scope, level, msg, data) {
  const entry = {
    t: Date.now(),
    iso: new Date().toISOString(),
    scope,
    level,
    msg: String(msg),
  };
  if (data !== undefined) {
    try {
      entry.data = JSON.parse(JSON.stringify(data, replacer));
    } catch {
      entry.data = String(data);
    }
  }
  SHARED_BUFFER.push(entry);
  if (SHARED_BUFFER.length > RING_SIZE) SHARED_BUFFER.shift();

  const prefix = `[skool-dl:${scope}]`;
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
      ? console.warn
      : level === "debug"
      ? console.debug
      : console.log;
  if (data !== undefined) fn(prefix, msg, data);
  else fn(prefix, msg);
}

export function createLogger(scope) {
  return {
    debug: (m, d) => push(scope, "debug", m, d),
    info: (m, d) => push(scope, "info", m, d),
    warn: (m, d) => push(scope, "warn", m, d),
    error: (m, d) => push(scope, "error", m, d),
    /** Returns a snapshot of every entry logged in this context (all scopes). */
    getEntries: () => SHARED_BUFFER.slice(),
    clear: () => {
      SHARED_BUFFER.length = 0;
    },
  };
}

// JSON-replacer that trims giant URL/token strings so the log stays readable.
function replacer(key, value) {
  if (typeof value === "string" && value.length > 240) {
    return value.slice(0, 200) + `…[+${value.length - 200}ch]`;
  }
  return value;
}

/** Format an array of entries into a human-readable text dump. */
export function formatEntries(entries) {
  return entries
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((e) => {
      const time = e.iso.substring(11, 23); // HH:MM:SS.mmm
      const lvl = e.level.toUpperCase().padEnd(5);
      const scope = e.scope.padEnd(7);
      let line = `${time} ${lvl} [${scope}] ${e.msg}`;
      if (e.data !== undefined) {
        try {
          const json = JSON.stringify(e.data);
          if (json.length > 0 && json !== "{}" && json !== "null") {
            line += "  " + json;
          }
        } catch {}
      }
      return line;
    })
    .join("\n");
}
