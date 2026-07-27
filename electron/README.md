# P-Bandai Pre-order Watcher — desktop app

An Electron GUI for the [P-Bandai pre-order watcher](../README.md). You fill in a setup form,
log in, and hit **Save & Start Watching**; the app then runs the proven **Playwright watch
engine** (`../preorder-watcher.mjs`) as a background process that grabs the item the instant the
pre-order opens.

The app has its own embedded p-bandai.com browser for **browsing to an item and logging in**, but
the actual drop-time polling happens in a **separate Playwright Chromium window**. We split it
this way because Playwright's clean Chromium gets past P-Bandai's Cloudflare/Akamai bot wall,
while the embedded Electron browser kept hitting `501 / PAGE NOT AVAILABLE` on the `addToCart`
POST. It does **not** bypass any server rule — the sale window, stock, and per-cart limit are all
enforced by P-Bandai's backend; the app only removes client-render lag.

## Run

The app launches the watch engine from the repo root, so install dependencies in both places
(and make sure `node` is on your `PATH`):

```bash
npm install     # in the repo root — Playwright + Chromium (postinstall)
cd electron
npm install     # Electron
npm start
```

## Use

The app opens on a **Setup screen** — a form, not a config file, and nothing is read from env
vars. You fill in a few things; everything else (poll interval, jitter, retries) is a fixed
sensible default, and it always adds **one unit**. The form is saved for next time (to
`watcher-config.json` in the app's user-data dir), so you never edit JSON by hand.

1. **Paste the item URL.** When you tab/click away, the app loads the page in the background and
   reads the real **item number** (`areaItemNo`) straight off it — this differs from the code in
   the URL, so it can't be guessed from the URL alone. Click **Look up** to re-run it, or type the
   item number in by hand. The page's own drop time is shown for reference.
2. **Set the drop time and end time** — local time pickers, today's date assumed. They default to
   now / now + 1 hour and are yours to adjust.
3. **Log in** (optional but recommended). Click **Log in…** (or **Browse site…**) to sign in in
   the app's embedded browser. On start, the app hands that login session to the watcher, so its
   window comes up already signed in. Skip this and you can log in the watcher window instead.
4. **Save & Start Watching.** This persists the config, passes your session (if any), and launches
   the watcher.

A **separate Playwright Chromium window opens** — that's the watcher. If your app session
transferred, it's already signed in; otherwise log in there (front tab; leave the poll tab alone).
Its login also persists in `../profile`.

The app's own window becomes a **live log** of the watcher's output; the status chip reflects
waiting / polling / success / sold out. **Stop** kills the watcher; **⚙ Setup** returns to the form.

## Status meanings

| chip | meaning |
|---|---|
| `waiting` | counting down to open |
| `polling` | hammering addToCart |
| `success` | added / already in cart — check out |
| `sold out` | stock or pre-order allocation exhausted |
| `stopped` / `gaveup` | you stopped it, or the time limit passed |

## How it works

- **Main process** (`main.js`) owns the embedded `WebContentsView` (used for Browse / Log in /
  Look up) and persists config to `watcher-config.json` in `app.getPath('userData')`. On **Arm**
  it collects your login cookies from the embedded session — **excluding** Akamai bot-manager
  cookies (`_abck`, `bm_*`, `ak_bmsc`), which are fingerprint-bound and can't transfer — writes a
  `cli-config.json`, and spawns `node ../preorder-watcher.mjs watch <cli-config.json>`. It streams
  the subprocess's output into the log strip and maps key lines to the status chip.
- **Playwright engine** (`../preorder-watcher.mjs`) does the real work: injects the passed-in
  cookies, warms up past the bot wall, captures the CSRF token, and tight-polls a single-unit
  `addToCart` — the same code the standalone CLI runs.
- **Renderer** (`renderer/`) is the two screens — Setup form and Watch view (top bar + log); it
  talks to main over IPC through the `preload.js` bridge.
- **`site-preload.js`** runs in the embedded browser's page to hide Electron fingerprints so
  Browse / Log in / Look up work; the real watching happens in Playwright's own Chromium.

## Please be reasonable

You must be signed in to hold/checkout a pre-order. The default poll interval is deliberately
modest — don't run many instances at once, since a tight loop across many items looks like attack
traffic and risks a rate-limit or ban. Arm it shortly before the announced open, not hours early.
