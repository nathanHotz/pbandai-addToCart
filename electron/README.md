# P-Bandai Pre-order Watcher — desktop app

An Electron app that embeds p-bandai.com in a real in-app browser, waits for a pre-order to
open, and adds the item to your cart the instant the server allows it — so you're not beaten
by the overloaded page being slow to re-enable its button at drop time.

Because Electron *is* Chromium, the embedded view passes P-Bandai's Cloudflare/Akamai bot
check natively (no Playwright, no separate browser download). It does **not** bypass any
server rule — the sale window, stock, and per-cart limit are all enforced by P-Bandai's
backend. The app only removes client-render lag.

## Run

```bash
cd electron
npm install     # downloads Electron
npm start
```

## Use

The app opens on a **Setup screen** — a form, not a config file, and nothing is read from env
vars. You fill in four things; everything else (poll interval, jitter, retries, quantity) is a
fixed sensible default. The form is saved for next time (to `watcher-config.json` in the app's
user-data dir), so you never edit JSON by hand.

1. **Paste the item URL.** When you tab/click away, the app loads the page in the background and
   reads the real **item number** (`areaItemNo`) straight off it — this differs from the code in
   the URL, so it can't be guessed from the URL alone. It also suggests drop-time candidates from
   the page's timestamps. Click **Look up** to re-run it, or type the item number in by hand.
2. **Set the drop time and end time** (local time pickers; today's date is assumed): when the
   pre-order opens (polling starts) and when to stop. Both default to now / now + 1 hour.
3. **Save & Start Watching.** This persists the config and launches the watcher.

The actual watch/poll runs in the proven **Playwright engine** (`../preorder-watcher.mjs`), which
the app starts as a **subprocess**. A **separate Chromium window opens** — that's where you log in
and where the cart is grabbed at drop time. We do it this way because Playwright's clean Chromium
gets past P-Bandai's Akamai bot wall, which the embedded Electron browser could not (it kept
hitting `501 / PAGE NOT AVAILABLE` on the `addToCart` POST).

4. **Log in** in that Chromium window's front tab; leave the poll tab alone. The login persists
   between runs in the `../profile` directory.

The app's own window becomes a **live log** of the watcher's output; the status chip reflects
waiting / polling / success / sold out. **Stop** kills the watcher; **⚙ Setup** returns to the
form. The embedded browser in the app is still handy for **Browse site… / Look up** to find an
item URL and its `areaItemNo` before you start.

## Status meanings

| chip | meaning |
|---|---|
| `waiting` | counting down to open |
| `polling` | hammering addToCart |
| `success` | added / already in cart — check out |
| `sold out` | stock or pre-order allocation exhausted |
| `stopped` / `gaveup` | you stopped it, or the time limit passed |

## How it works

- **Main process** (`main.js`) owns the embedded `WebContentsView` (used only for Browse / Look
  up), persists config to `watcher-config.json` in `app.getPath('userData')`, and on **Arm**
  writes a `cli-config.json` and spawns `node ../preorder-watcher.mjs watch <cli-config.json>`.
  It streams the subprocess's stdout/stderr into the log strip and maps key lines to the status
  chip. The actual browser automation, CSRF-token capture, warm-up, and `addToCart` polling all
  live in the Playwright engine — the same code the standalone CLI uses.
- **Renderer** (`renderer/`) is the two screens — Setup form and Watch view (top bar + log); it
  talks to main over IPC through the `preload.js` bridge.
- **`site-preload.js`** runs in the embedded browser's page to hide Electron fingerprints (used
  for Browse / Look up); the real watching happens in Playwright's own Chromium.

## Please be reasonable

You must be signed in to hold/checkout a pre-order. Keep the poll interval modest and don't run
many instances at once — a tight loop across many items looks like attack traffic and risks a
rate-limit or ban. Arm it shortly before the announced open, not hours early.
