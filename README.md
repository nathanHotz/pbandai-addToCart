# P-Bandai pre-order watcher

Waits for a P-Bandai pre-order to open and adds the item to your cart the instant the
server allows it — so you're not beaten by the page being slow to re-render its button
during the traffic rush at drop time.

There are two front-ends over the same watch engine:

- **Desktop app** (`electron/`) — a point-and-click GUI. **Recommended.** See
  [`electron/README.md`](electron/README.md).
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

```bash
npm install       # repo root — Playwright + Chromium (via the postinstall hook)
cd electron
npm install       # Electron
npm start
```

Full walkthrough in [`electron/README.md`](electron/README.md). In short: fill the setup form
(item URL, item number, drop/end time), log in (in the app or the watcher window), and
**Save & Start Watching** — no config file to edit. The app runs the CLI engine below as a
background process.

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
