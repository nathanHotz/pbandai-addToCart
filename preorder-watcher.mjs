#!/usr/bin/env node
/**
 * P-Bandai pre-order watcher.
 *
 * Drives a real Chromium (so it passes the Cloudflare/Akamai fingerprint check that
 * blocks plain curl/fetch), lets you log in yourself, waits for a pre-order to open,
 * then tight-polls the addToCart API and grabs the item the instant the server drops
 * the "suspended" flag — without waiting for the overloaded UI to re-render its button.
 *
 * This does NOT bypass any server-side rule: the sale window, stock, and per-cart
 * quantity are all enforced by P-Bandai's backend. It only removes client-render lag
 * so you're not beaten by the page being slow to update during the traffic rush.
 *
 * Usage:
 *   node preorder-watcher.mjs inspect   [config.json]   # detect SKU + schedule for a new item
 *   node preorder-watcher.mjs watch     [config.json]   # arm and grab at open time
 *
 * Config resolution: defaults <- config.json (path arg or ./config.json).
 */

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const DEFAULTS = {
  itemUrl: "https://p-bandai.com/us/item/CHANGE_ME",
  areaItemNo: "", // e.g. NAI0859145US — leave blank and use `inspect` to detect it
  qty: 1,
  openIso: "", // ISO8601, e.g. 2026-07-27T03:00:00Z. Blank in `watch` = start polling immediately.
  endIso: "", // ISO8601 stop time. Overrides giveUpMinutes when set. Blank = giveUpMinutes after open.
  homeUrl: "https://p-bandai.com/us/",
  userDataDir: "./profile", // persistent Chromium profile; your login is kept here between runs
  headless: false,

  pollMs: 500, // base interval between addToCart attempts once open
  pollJitterMs: 150, // random 0..N added to each interval (avoids robotic cadence)
  tightWindowSec: 45, // switch from idle countdown to 1s "arming" ticks this long before open
  preOpenRefreshSec: 120, // while idle, reload the POLL tab this often to keep token/cookies fresh
  giveUpMinutes: 20, // stop polling this long after open if never resolved
  preallocRetries: 8, // treat Preallocation as maybe-transient: retry this many times before quitting
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

// Server responses we've observed, mapped to what the watcher should do.
const OUTCOME = {
  SUCCESS: "success", // 200 — added to cart
  IN_CART: "in_cart", // MaxPurchaseQty — already in cart at its limit (you have it)
  SOLD_OUT: "sold_out", // OutOfStock / Preallocation exhausted
  NOT_OPEN: "not_open", // SuspendedItem — sale window not open yet
  TRANSIENT: "transient", // bot wall / 5xx gateway / unknown — retry (reload if wall)
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [, , cmd, configPath] = process.argv;
  const cfg = loadConfig(configPath);

  if (cmd === "inspect") return inspect(cfg);
  if (cmd === "watch") return watch(cfg);

  console.error(
    "Usage: node preorder-watcher.mjs <inspect|watch> [config.json]",
  );
  process.exit(1);
}

function loadConfig(configPath) {
  let fileCfg = {};
  const path = configPath || "./config.json";
  try {
    fileCfg = JSON.parse(readFileSync(path, "utf8"));
    log(`loaded config from ${path}`);
  } catch {
    if (configPath) throw new Error(`could not read config file: ${path}`);
  }
  return { ...DEFAULTS, ...fileCfg };
}

async function launch(cfg) {
  const context = await chromium.launchPersistentContext(cfg.userDataDir, {
    headless: cfg.headless,
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: { width: 1440, height: 900 },
    userAgent: USER_AGENT,
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  await context.addInitScript(() =>
    Object.defineProperty(navigator, "webdriver", { get: () => undefined }),
  );

  // Inherit the login session captured by the Electron app (if any) so we skip a second login.
  // Akamai bot-manager cookies are intentionally NOT included — we mint our own by browsing.
  if (Array.isArray(cfg.cookies) && cfg.cookies.length) {
    try {
      await context.addCookies(cfg.cookies);
      log(`injected ${cfg.cookies.length} session cookie(s) from the app`);
    } catch (e) {
      log("could not inject app cookies:", String(e));
    }
  }

  // The CSRF token isn't in a cookie/meta/localStorage — the site only reveals it on its
  // own outgoing XHRs. Sniff every request and keep the latest one we see.
  const state = { token: null };
  context.on("request", (req) => {
    const t = req.headers()["x-csrf-token"];
    if (t) state.token = t;
  });
  return { context, state };
}

/**
 * Cold profiles get the "PAGE NOT AVAILABLE" bot wall on a direct item hit — warm up via the
 * homepage first to seed cookies, then load the item and scroll to trigger the token-bearing XHR.
 */
async function warmUpAndCaptureToken(page, cfg, state) {
  await page
    .goto(cfg.homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
    .catch(() => {});
  await sleep(2500);
  await page.goto(cfg.itemUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(3500);
  for (let i = 0; i < 5 && !state.token; i++) {
    await page.mouse.wheel(0, 1600).catch(() => {});
    await sleep(1200);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  return state.token;
}

async function inspect(cfg) {
  const { context, state } = await launch(cfg);
  const page = context.pages()[0] || (await context.newPage());
  await warmUpAndCaptureToken(page, cfg, state);

  const found = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const skus = [...new Set(html.match(/[A-Z]{3}\d{6,}US/g) || [])];
    const body = (document.body.innerText || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const schedule = body
      .filter((l) => /(PRE-?ORDER|SALES?|OPEN|CLOSE|SHIP|START|END)/i.test(l))
      .slice(0, 12);
    const iso = [
      ...new Set(
        document.documentElement.innerHTML.match(
          /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g,
        ) || [],
      ),
    ];
    return { title: document.title, skus, schedule, iso };
  });

  log("Title:", found.title);
  log(
    "CSRF token captured:",
    state.token ? `yes (len ${state.token.length})` : "NO — try re-running",
  );
  log("Candidate areaItemNo values:", found.skus);
  log("Schedule text:");
  for (const l of found.schedule) log("   ", l);
  log("ISO timestamps in page (open time is usually one of these):", found.iso);
  log(
    "\nFill config.json with itemUrl, the correct areaItemNo, and openIso, then run: watch",
  );
  await context.close();
}

async function watch(cfg) {
  if (!cfg.areaItemNo)
    throw new Error(
      "config.areaItemNo is required for watch — run `inspect` to find it",
    );
  const openMs = cfg.openIso ? Date.parse(cfg.openIso) : Date.now();
  const endMs = cfg.endIso ? Date.parse(cfg.endIso) : NaN;
  const giveUpMs = Number.isNaN(endMs)
    ? openMs + cfg.giveUpMinutes * 60 * 1000
    : endMs;

  const { context, state } = await launch(cfg);
  const pollPage = context.pages()[0] || (await context.newPage());

  log("=== P-BANDAI PRE-ORDER WATCHER ===");
  log("Item:", cfg.itemUrl, "| SKU:", cfg.areaItemNo, "| qty: 1 (single add)");
  log("Opens:", cfg.openIso || "now (no openIso set)");

  await warmUpAndCaptureToken(pollPage, cfg, state);
  log(
    "token:",
    state.token
      ? `captured (len ${state.token.length})`
      : "NONE (will keep trying)",
  );

  // Separate login tab so your sign-in flow is never interrupted by the poller.
  const loginPage = await context.newPage();
  await loginPage
    .goto(cfg.homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
    .catch(() => {});
  await loginPage.bringToFront().catch(() => {});
  log(
    cfg.cookies && cfg.cookies.length
      ? ">>> Session imported from the app. If the front tab isn't already signed in, log in there. Leave the poll tab alone. <<<"
      : ">>> LOG IN in the front tab now. Leave the other (poll) tab alone. <<<",
  );

  await waitUntilOpen(pollPage, cfg, state, openMs);

  log("*** OPEN — polling addToCart ***");
  let attempt = 0;
  let preallocSeen = 0;
  while (Date.now() < giveUpMs) {
    attempt++;
    const res = await tryAdd(pollPage, cfg, state);
    const outcome = classify(res);
    log(
      `attempt ${attempt}: HTTP ${res.status} [${outcome}] ${res.body.replace(/\s+/g, " ").slice(0, 140)}`,
    );

    if (outcome === OUTCOME.SUCCESS) {
      log("🎉 SUCCESS — item added to cart. Body:", res.body);
      log("Browser stays open — go check out in the front tab.");
      await sleep(30 * 60 * 1000);
      break;
    }
    if (outcome === OUTCOME.IN_CART) {
      log(
        "✅ Already in your cart (purchase limit reached) — you have it. Go check out.",
      );
      await sleep(30 * 60 * 1000);
      break;
    }
    if (outcome === OUTCOME.SOLD_OUT) {
      if (
        /Preallocation/i.test(res.body) &&
        preallocSeen++ < cfg.preallocRetries
      ) {
        log(
          `   preallocation conflict (${preallocSeen}/${cfg.preallocRetries}) — could be transient, retrying`,
        );
        await sleep(cfg.pollMs);
        continue;
      }
      log("❌ Sold out — stopping.");
      break;
    }
    if (outcome === OUTCOME.TRANSIENT) {
      if (
        /PAGE NOT AVAILABLE|<!doctype/i.test(res.body) ||
        res.status === 501
      ) {
        log("   bot wall / stale token — reloading to refresh session");
        await warmUpAndCaptureToken(pollPage, cfg, state).catch(() => {});
        continue;
      }
      await sleep(cfg.pollMs);
      continue;
    }
    // NOT_OPEN (SuspendedItem) or anything else — keep polling.
    await sleep(cfg.pollMs + Math.floor(Math.random() * cfg.pollJitterMs));
  }

  log("Watcher finished.");
  await context.close();
}

async function waitUntilOpen(pollPage, cfg, state, openMs) {
  let lastRefresh = Date.now();
  while (Date.now() < openMs - 2000) {
    const remaining = openMs - Date.now();
    if (remaining > cfg.tightWindowSec * 1000) {
      if (remaining % 15000 < 6000)
        log(
          `waiting… ${Math.round(remaining / 1000)}s to open (token ${state.token ? "ok" : "MISSING"})`,
        );
      if (Date.now() - lastRefresh > cfg.preOpenRefreshSec * 1000) {
        await warmUpAndCaptureToken(pollPage, cfg, state).catch(() => {});
        lastRefresh = Date.now();
      }
      await sleep(5000);
    } else {
      log(`arming… ${Math.round(remaining / 1000)}s to open`);
      await sleep(1000);
    }
  }
}

async function tryAdd(pollPage, cfg, state) {
  try {
    return await pollPage.evaluate(
      async ([item, tok]) => {
        const res = await fetch("/api/cart/addToCart", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-Token": tok || "",
          },
          // Always a single unit — one good add-to-cart, never chase the max purchase qty.
          body: JSON.stringify([{ areaItemNo: item, qty: 1 }]),
        });
        return { status: res.status, body: (await res.text()).slice(0, 500) };
      },
      [cfg.areaItemNo, state.token],
    );
  } catch (e) {
    return { status: -1, body: "evaluate error: " + String(e) };
  }
}

function classify(res) {
  if (res.status === 200) return OUTCOME.SUCCESS;
  const b = res.body || "";
  if (/CouldNotAddToCartByMaxPurchaseQty/i.test(b)) return OUTCOME.IN_CART;
  if (/CouldNotAddToCartByOutOfStock|CouldNotAddToCartByPreallocation/i.test(b))
    return OUTCOME.SOLD_OUT;
  if (/CouldNotAddToCartBySuspendedItem/i.test(b)) return OUTCOME.NOT_OPEN;
  if (
    res.status === 501 ||
    res.status === 502 ||
    res.status === 503 ||
    /PAGE NOT AVAILABLE|<!doctype/i.test(b)
  )
    return OUTCOME.TRANSIENT;
  return OUTCOME.TRANSIENT;
}

main().catch((e) => {
  log("FATAL", e);
  process.exit(1);
});
