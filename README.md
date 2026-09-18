# Formations Board

American football formation reference for the Atlantis University Athletics Sports
Information Department. One self-contained HTML file plus the small set of files that make
it an installable, offline-capable Progressive Web App.

| File | What it is |
| --- | --- |
| `index.html` | **The application** and the source of truth. All data lives in its first `<script>` block; the header comment documents the schema and how to add formations, case studies, glossary terms and matrix rows. |
| `manifest.webmanifest` | Web app manifest: name, icons, colours, `standalone` display, scope `./`. |
| `sw.js` | Service worker. Pre-caches the app shell on install, serves it when offline, drops stale caches on activate. |
| `icons/` | `icon-192.png`, `icon-512.png` (any), `icon-512-maskable.png` (Android adaptive), `apple-touch-icon.png` (iOS home screen), `favicon-64.png`. Generated from the brand mark in the top bar. |

## Running it locally

A service worker only registers on `https://` or on `http://localhost` / `127.0.0.1`, and it
never registers from `file://`. Serve the folder (or its parent) over http:

```bash
python -m http.server 8099
```

then open `http://127.0.0.1:8099/formations-board/`. Opening `index.html` by double-click
still works as a plain page; only install and offline are unavailable there.

## What the PWA layer does

- **Install.** Chrome, Edge and Android surface an install prompt. When they do, an
  **Install app** button appears in the top bar next to the theme toggle. On iOS use
  Share → *Add to Home Screen* (Safari does not fire the prompt event).
- **Offline.** After the first visit the whole board opens with no network. Custom
  formations, plays and the theme live in `localStorage`, which the service worker does not
  touch, so nothing about saving changed.
- **Updates.** Navigations go network-first with a four-second timeout, so a new deploy is
  picked up on the next open. When a new service worker takes over, the page shows a toast
  asking for a reload; it never reloads on its own, so an unsaved editor draft is never lost.
- **External links** (glossary and case-study sources) are not intercepted or cached.

## Live site

Deployed on GitHub Pages from the `gh-pages` branch of `playnext-skills/formations-board`:
**https://playnext-skills.github.io/formations-board/**

## Deploying and shipping a change

1. Edit `index.html` as usual. Run `FormationsBoard.validate()` in the console after any data
   change; it must return `[]`.
2. Bump `VERSION` at the top of `sw.js` (for example `formations-board-v2`). Without the bump,
   installed copies keep serving the cached shell until the browser's own 24-hour service
   worker check runs.
3. Commit, then push to both branches (`main` is the working branch, `gh-pages` is what Pages
   serves): `git push origin main && git push origin main:gh-pages`. The site refreshes within
   about a minute.
   To host it anywhere else, upload `index.html`, `manifest.webmanifest`, `sw.js` and `icons/` to the same directory on
   an **https** host. The manifest `scope` and `start_url` are relative, so any directory works,
   but `sw.js` must be served as JavaScript from that directory (a CMS that wraps uploaded
   files in page chrome, as PrestoSports does with HTML, will break registration; check the
   console on first load).
4. Open the deployed page: the console logs `Formations Board: service worker registered`,
   and DevTools → Application → Manifest shows no errors.

## Verifying

- DevTools → Application → Service Workers: status *activated and is running*.
- Tick *Offline* in the same panel and reload: the board still renders.
- Lighthouse → Progressive Web App audit passes installability.
