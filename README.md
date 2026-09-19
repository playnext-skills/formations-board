# The Playbook Caller

American football formation reference for the Atlantis University Athletics Sports
Information Department. One self-contained HTML file plus the small set of files that make
it an installable, offline-capable Progressive Web App.

| File | What it is |
| --- | --- |
| `index.html` | **The application** and the source of truth. All data lives in its first `<script>` block; the header comment documents the schema and how to add formations, case studies, glossary terms and matrix rows. |
| `manifest.webmanifest` | Web app manifest: name, icons, colours, `standalone` display, scope `./`. |
| `sw.js` | Service worker. Pre-caches the app shell on install, serves it when offline, drops stale caches on activate. |
| `supabase/schema.sql` | Table and row-level-security policies for the optional accounts + sync feature. Run once in the Supabase SQL editor. |
| `icons/` | `icon-192.png`, `icon-512.png` (any), `icon-512-maskable.png` (Android adaptive), `apple-touch-icon.png` (iOS home screen), `favicon-64.png`. Navy and red play-call mark (O, route arrow, X) matching the brand mark in the top bar. |

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

## Accounts and sync (Supabase)

Optional. With accounts off (the default) the board is open to everyone and keeps custom
formations and plays in the browser only. With accounts on, the board is gated behind
email + password sign-in and each user's custom formations and plays are stored in their own
row of a Supabase table, so they follow the user across devices. The browser keeps a working
copy either way, so the board still works offline and syncs when the network is back.

The client is hand-written inside `index.html` (banner "ACCOUNTS" near the end of the script):
GoTrue for auth, PostgREST for the data row, no SDK. Nothing but the two public config values
ships in the page.

### One-time setup (about ten minutes)

1. **Create the project.** Sign in at https://supabase.com, *New project*, any name, pick the
   nearest region, set a database password (you will not need it in the app). Free tier is fine.
2. **Create the table.** Left menu *SQL Editor* → *New query*, paste the whole of
   [`supabase/schema.sql`](supabase/schema.sql), *Run*. It creates `user_data` with row-level
   security so a user can only ever read or write their own row.
3. **Point auth at the site.** *Authentication → URL Configuration*: set **Site URL** to
   `https://playnext-skills.github.io/formations-board/` and add the same URL under
   **Redirect URLs**. Confirmation and password-reset emails link back here; without this they
   land on localhost and fail.
4. **Decide on email confirmation.** *Authentication → Providers → Email*. Leave
   *Confirm email* on for a public sign-up (the app tells new users to check their inbox), or turn
   it off for a closed group where you create the accounts yourself under *Authentication → Users*.
5. **Copy the two values** from *Project Settings → API*: the **Project URL** and the
   **anon public** key. Paste them into the `ACCOUNTS` block at the top of the script in
   `index.html`:

   ```js
   var ACCOUNTS = { url: 'https://xxxxxxxxxxxxxxxx.supabase.co', anonKey: 'eyJ...' };
   ```

   The anon key is designed to be public; the row-level security from step 2 is what keeps data
   private. Never paste the `service_role` key anywhere in the page.
6. Bump `VERSION` in `sw.js`, commit, push both branches. Reload the site: the sign-in gate
   appears.

### How it behaves

- **Gate.** The board is blurred and inert until there is a session. Escape does not close the
  dialog and the board's keyboard shortcuts are blocked behind it.
- **Create account** asks for name, email and password (8+ characters). If confirmation is on,
  the user gets a link; opening it signs them in on that device.
- **Forgot password** emails a link that opens the app in a *New password* view.
- **Sessions** persist in the browser and refresh themselves. A device that is offline keeps
  working with its stored session; an expired session that cannot be refreshed reopens the gate.
- **Sync.** Every local change to custom formations or plays is pushed about 1.5 s later.
  Signing in pulls the account's data. When the app returns to the foreground after five minutes
  it reconciles again. Same account as the last sync on the device: the newer side wins.
  A different or unknown account: the account's data is kept and anything the browser had that
  the account lacks is added to it, then pushed.
- **Sign out** pushes pending changes first, then clears the account's data from this browser so
  the next person on a shared device does not see it.
- The **Account** button in the top bar shows who is signed in, the sync state, *Sync now* and
  *Sign out*.

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
4. Open the deployed page: the console logs `The Playbook Caller: service worker registered`,
   and DevTools → Application → Manifest shows no errors.

## Verifying

- DevTools → Application → Service Workers: status *activated and is running*.
- Tick *Offline* in the same panel and reload: the board still renders.
- Lighthouse → Progressive Web App audit passes installability.
