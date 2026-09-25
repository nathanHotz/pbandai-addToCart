# P-Bandai pre-order watcher

Waits for a P-Bandai pre-order to open and adds the item to your cart the instant the
server allows it — so you're not beaten by the page being slow to re-render its button
during the traffic rush at drop time.

It ships as a **self-contained desktop app** (Electron + a bundled Chromium, nothing else to
install). The same settings page also runs as a plain local web UI, and the engine underneath is
a command-line script:

- **Desktop app** — download/build it, double-click, configure in the window. **Recommended.**
- **Web UI** (`npm run web`) — the same page in your normal browser at `http://localhost:3131`.
- **Command line** (`preorder-watcher.mjs`) — a terminal script driven by a `config.json`.

## What it does (and doesn't) do

- Drives a **real Chromium** (via Playwright) so requests pass P-Bandai's Cloudflare/Akamai bot
  check. A plain `curl`/`fetch` replay of the API gets a `501` "PAGE NOT AVAILABLE" wall even with
  valid cookies, because the protection binds to the browser's TLS/HTTP fingerprint.
- **You log in yourself** — in the desktop app or in the watcher's browser window; the tool never
  sees your password.
- It captures the rotating **`X-CSRF-Token`** off the site's own outgoing requests (it's not in
  any cookie / localStorage / meta tag).
- At the open time it **tight-polls `POST /api/cart/addToCart`** with **a single unit (qty 1)** and
  stops on the first definitive server response.

It does **not** bypass anything. The sale window, stock, and per-cart quantity limit are all
enforced by P-Bandai's backend — the tool just removes client-side render lag. If the pre-order
isn't open, the server returns `CouldNotAddToCartBySuspendedItem` and the tool keeps waiting.

## Desktop app (recommended)

### Install

Grab the build for your OS (from the repo's **Actions → Build app** run artifacts, or build it
yourself below) and install it:

- **macOS** — open the `.dmg` and drag *P-Bandai Watcher* to Applications. It isn't code-signed,
  so the first time: right-click the app → **Open** → **Open** (or run
  `xattr -cr "/Applications/P-Bandai Watcher.app"`).
- **Windows** — run the `Setup` `.exe`, or use the `portable` `.exe` with no install. SmartScreen
  may warn about an unknown publisher: **More info → Run anyway**.
- **Linux** — `chmod +x` the `.AppImage` and run it. On distros that restrict unprivileged user
  namespaces (e.g. Ubuntu 24.04+), launch it with `--no-sandbox` if it won't start.

### Use

Everything is set in the app window:

1. **Item URL** → click **Look up** to read the real item number (`areaItemNo`) off the page
   (a Chromium window opens briefly to load it). The page's own timestamps are shown for reference.
2. **Drop time / End time** — date + time pickers in your local time zone.
3. **Log in…** opens a Chromium window on p-bandai.com. Sign in there; the login is saved and
   reused by the watcher. (You can also just log in in the watcher's window.)
4. **Save & Start** saves your settings and launches the watcher in its own Chromium window. Its
   log streams into the app, with a status chip and a countdown. **Stop** ends it.

Quitting the app stops the watcher (it asks first if one is running). Settings and your login
live in the per-user app data folder — `~/Library/Application Support/P-Bandai Watcher` on
macOS, `%APPDATA%\P-Bandai Watcher` on Windows, `~/.config/P-Bandai Watcher` on Linux.

### Build it

```bash
npm install       # Electron, electron-builder, Playwright
npm start         # run the app from source (settings/login go in the repo: ./config.json, ./profile)
npm run dist      # bundle Chromium + package → dist/ (.dmg / .exe / .AppImage)
```

`npm run dist` builds for the OS you run it on only — Playwright downloads the Chromium for the
current platform, so each platform's app must be built on that platform. The
[`Build app`](.github/workflows/build.yml) GitHub Actions workflow does all three: run it from
the Actions tab (or push a `v*` tag) and download the installers from the run's artifacts.

### How it fits together

- `electron/main.mjs` starts the web server (`server.mjs`) on a random localhost port and shows
  it in the app window. In the packaged app it points Playwright at the bundled Chromium.
- `server.mjs` serves the settings page (`web/index.html`), runs **Look up** / **Log in** with
  Playwright, and runs `preorder-watcher.mjs watch` as a subprocess, streaming its log to the page.
  The subprocess runs on Electron's built-in Node (`ELECTRON_RUN_AS_NODE`), so no Node install is
  needed.

## Web UI

The same page without Electron, in your normal browser (needs Node):

```bash
npm install
npm run web       # opens http://localhost:3131
```

It uses `./config.json` and `./profile` in the repo. The server listens on `127.0.0.1` only. Set
`PORT` to change the port, or `NO_OPEN=1` to skip opening the browser. Closing the tab doesn't stop
the watcher — hit **Stop** or quit the server (Ctrl+C).

## Command line

```bash
npm install       # also downloads Chromium via the postinstall hook
```

The script reads `./config.json` (or a path passed as the last argument). Nothing is read from
environment variables. A minimal `config.json`:

```json
{
  "itemUrl": "https://p-bandai.com/us/item/N2890904001",
  "areaItemNo": "NAI0859145US",
  "openIso": "2026-07-27T03:00:00-05:00",
  "endIso": "2026-07-27T04:00:00-05:00"
}
```

### 1. Inspect a new item

Point `itemUrl` at the product, then:

```bash
npm run inspect              # or: node preorder-watcher.mjs inspect [config.json]
```

It prints the page title, the candidate **`areaItemNo`** (the SKU the cart API wants — note this
differs from the code in the URL), the schedule text, and the ISO timestamps on the page. The
**"PRE-ORDERS OPEN"** time is almost always one of those timestamps — copy it into `openIso`.

### 2. Fill config.json

| field | meaning |
|---|---|
| `itemUrl` | product page URL |
| `areaItemNo` | SKU from `inspect` (e.g. `NAI0859145US`) — **required** |
| `openIso` | open time, ISO8601 (UTC `…Z` or with an offset, e.g. `2026-07-27T03:00:00-05:00`). Blank = start polling immediately |
| `endIso` | stop time, ISO8601. Overrides `giveUpMinutes` when set; blank = `giveUpMinutes` after open |
| `userDataDir` | Chromium profile dir; your login persists here between runs (default `./profile`) |
| `pollMs` / `pollJitterMs` | base + random poll interval once open |
| `tightWindowSec` | seconds before open to switch to 1s "arming" ticks |
| `preOpenRefreshSec` | how often to refresh the token/cookies while waiting |
| `giveUpMinutes` | fallback stop window (used only when `endIso` is blank) |
| `preallocRetries` | retries for `Preallocation` (sometimes a transient reservation conflict) |

> The tool always adds **one unit** — any `qty` in the config is ignored.

### 3. Watch the drop

```bash
npm run watch                # or: node preorder-watcher.mjs watch [config.json]
```

Two tabs open: **log in the front tab**, leave the poll tab alone. The tool counts down,
then hammers the cart API at open. On success it leaves the browser open so you can check out.

## Server responses it recognizes

| response | meaning | action |
|---|---|---|
| `200` | added to cart | ✅ stop, go check out |
| `CouldNotAddToCartBySuspendedItem` | sale not open yet | keep polling |
| `CouldNotAddToCartByMaxPurchaseQty` | already in your cart (limit hit) | ✅ stop, you have it |
| `CouldNotAddToCartByOutOfStock` | sold out | ❌ stop |
| `CouldNotAddToCartByPreallocation` | allocation exhausted (usually sold out) | retry a few times, then ❌ stop |
| `501/502/503` or "PAGE NOT AVAILABLE" | overloaded / bot wall at peak | reload + retry |

## Please be reasonable

- You must be **signed in** to hold/checkout a pre-order cart.
- Keep `pollMs` modest and **don't run many instances in parallel** — a tight loop across many
  items looks like attack traffic and can get your account/IP rate-limited or banned.
- Start it a short time before the announced open, not hours early.
