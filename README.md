# P-Bandai pre-order watcher

Waits for a P-Bandai pre-order to open and adds the item to your cart the instant the
server allows it — so you're not beaten by the page being slow to re-render its button
during the traffic rush at drop time.

## What it does (and doesn't) do

- Drives a **real Chromium** so requests pass P-Bandai's Cloudflare/Akamai bot check.
  A plain `curl`/`fetch` replay of the API gets a `501` "PAGE NOT AVAILABLE" wall even with
  valid cookies, because the protection binds to the browser's TLS/HTTP fingerprint.
- **You log in yourself** in a visible browser tab; the tool never sees your password.
- It captures the rotating **`X-CSRF-Token`** off the site's own outgoing requests (it's not in
  any cookie / localStorage / meta tag).
- At the configured open time it **tight-polls `POST /api/cart/addToCart`** and stops on the
  first definitive server response.

It does **not** bypass anything. The sale window, stock, and per-cart quantity limit are all
enforced by P-Bandai's backend — the tool just removes client-side render lag. If the pre-order
isn't open, the server returns `CouldNotAddToCartBySuspendedItem` and the tool keeps waiting.

## Setup

```bash
cd pbandai-preorder-watcher
npm install            # also downloads Chromium via the postinstall hook
cp config.example.json config.json
```

## 1. Inspect a new item

Point `itemUrl` in `config.json` at the product, then:

```bash
npm run inspect
```

It prints the page title, the candidate **`areaItemNo`** (the SKU the cart API wants — note this
differs from the code in the URL), the schedule text, and the ISO timestamps on the page. The
**"PRE-ORDERS OPEN"** time is almost always one of those ISO timestamps — copy it into `openIso`.

## 2. Fill config.json

| field | meaning |
|---|---|
| `itemUrl` | product page URL |
| `areaItemNo` | SKU from `inspect` (e.g. `NAI0859145US`) — **required** |
| `qty` | quantity to add (usually 1; most pre-orders cap at 1) |
| `openIso` | pre-order open time, ISO8601 UTC (e.g. `2026-07-27T03:00:00Z`) |
| `userDataDir` | Chromium profile dir; your login persists here between runs |
| `pollMs` / `pollJitterMs` | base + random poll interval once open |
| `tightWindowSec` | seconds before open to switch to 1s "arming" ticks |
| `preOpenRefreshSec` | how often to refresh the token/cookies while waiting |
| `giveUpMinutes` | stop polling this long after open |
| `preallocRetries` | retries for `Preallocation` (sometimes a transient reservation conflict) |

## 3. Watch the drop

```bash
npm run watch
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
