# Skool Classroom Downloader

Chrome extension (Manifest V3) that scans a [Skool](https://www.skool.com)
classroom you have legitimate access to and bulk-downloads every native-player
lesson video into ordered folders, ready for offline viewing.

> **Important — personal use only.** This extension only works with content
> your account can already watch in the Skool web player. It does **not**
> bypass paywalls, DRM, or access controls. Do not redistribute the videos
> you download. Always respect the creator's terms.

## What it does

- Scans the classroom sidebar and builds a tree of `Section -> Lesson`.
- Drives the SPA through every lesson, plays the video for a moment to
  trigger the player, and captures the freshly-signed HLS master URL.
- Streams every segment from the Skool / Mux CDN, concatenates them into a
  single `.ts` file, and saves it under
  `~/Downloads/<your-folder>/<Classroom>/NN - <Section>/NN - <Lesson>.ts`.
- Drops a `_manifest.json` and a `_remux.sh` next to the videos so you can
  losslessly turn every `.ts` into `.mp4` with one ffmpeg pass.

## What it intentionally does NOT do

- It does not download Vimeo / Loom / Wistia / YouTube embeds. Skool
  classrooms can use those, but this v0.1 focuses on the Skool **native**
  HLS player (`stream.video.skool.com`), which is the most common case and
  has no DRM.
- It does not pick up subtitles.
- It does not write to arbitrary locations on disk — Chrome extensions can
  only write under your default `Downloads` directory. You provide a
  subfolder name in the popup.

## Install (unpacked extension)

1. Clone or download this repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode** (top right toggle).
4. Click **Load unpacked** and select the `extension/` folder of this repo.
5. Pin the extension's icon to the toolbar (optional, makes it easier to
   click).

## Use

1. Log in to Skool and navigate to the classroom you want to back up. The URL
   should look like
   `https://www.skool.com/<community>/classroom/<id>?md=<lesson-id>`.
2. Click the extension icon. The popup detects the classroom name.
3. Type a **subfolder name** (e.g. `MyCourse`) — videos will go into
   `~/Downloads/MyCourse/...`.
4. Choose a **quality**: Max / 1080p / 720p.
5. Click **Scan classroom**. The extension lists every section and lesson it
   found.
6. Click **Auto-download all**. The extension will:
   - navigate to each lesson,
   - play it briefly to trigger the HLS master,
   - download every segment,
   - concatenate them into a `.ts`,
   - save the file into the right folder.
7. When the run finishes, open Terminal, `cd` into the classroom folder and
   run:

   ```sh
   bash _remux.sh
   ```

   Each `.ts` becomes a `.mp4` (lossless, instant — `ffmpeg -c copy`). The
   `.ts` originals are kept; delete them yourself when you're happy.

### Manual mode

If the auto-walker can't find a particular lesson (Skool occasionally tweaks
the sidebar markup), click the lesson manually, press play once, then click
**Download current lesson** in the popup.

### Stopping mid-run

Click **Stop** during a run. The current lesson finishes downloading, then
the walker exits cleanly. Re-run later — already-downloaded files will be
kept (Chrome will append a numeric suffix if a name collision happens, but
in practice the same lesson resolves to the same filename so a duplicate
becomes `name (1).ts`; just delete the old one before re-running, or change
the subfolder name).

## How it works (technical)

- `extension/manifest.json` — MV3 declaration, `webRequest` (observe-only),
  `downloads`, `tabs`, `scripting` permissions; host permissions on
  `*.skool.com` and `*.video.skool.com`.
- `background.js` — service worker. `chrome.webRequest.onSendHeaders` watches
  for `*.m3u8` requests on the Skool video CDN and stashes the most-recent
  URL per tab. Routes messages between popup and content script. Performs
  the actual `chrome.downloads.download` calls (only background can).
- `content.js` — runs in the page context of `*.skool.com`. Scans the
  sidebar, drives SPA navigation, calls `video.play()` to wake up the
  player, awaits the captured master URL, fetches every segment from inside
  the page's origin (so `Origin`/`Referer` are correct), concatenates the
  bytes, and hands a `blob:` URL to background to be saved.
- `lib/hls.js` — small M3U8 parser (master variants + rendition segments)
  and a parallel segment downloader with retries.
- `popup/` — the UI (folder name, quality selector, buttons, live progress
  log). Talks to the content script via a `popup-relay` message in
  `background.js`.

### Why `.ts` and not `.mp4` directly?

HLS streams are MPEG-TS segments. Producing a real `.mp4` in-browser
requires a muxer like `mp4-muxer` or `mp4box.js` (~200 KB extra code) or
ffmpeg.wasm (~30 MB). Concatenating the raw segments is bit-perfect and
free. The bundled `_remux.sh` then does a one-liner stream copy with the
ffmpeg you already have:

```sh
ffmpeg -i lesson.ts -c copy -bsf:a aac_adtstoasc lesson.mp4
```

No re-encoding, no quality loss, takes a fraction of a second per video.

### Token expiry

Skool issues short-lived JWT tokens (~10–15 min) embedded in the m3u8 URL.
The extension always captures a fresh token immediately before downloading
each lesson, so a long classroom won't run into 403s mid-run.

## Layout produced

```
~/Downloads/MyCourse/
└── My Awesome Course/
    ├── 01 - Welcome/
    │   ├── 01 - Intro.ts
    │   └── 02 - Overview.ts
    ├── 02 - Foundations/
    │   ├── 01 - First lesson.ts
    │   └── 02 - Second lesson.ts
    ├── _manifest.json
    └── _remux.sh
```

## Known limitations / roadmap

- v0.1 is single-tab — keep the Skool tab visible while the walker runs.
  Switching tabs may pause the player and stall capture.
- No retry queue across runs (yet). If a lesson fails, re-run with the
  walker stopped at that point or use **Download current lesson**.
- Embeds (Vimeo, Loom, etc.) are listed in the scan but not downloaded.
- Subtitles are not extracted.

PRs welcome.

## License

MIT — see `LICENSE`.
