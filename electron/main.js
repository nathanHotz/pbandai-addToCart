"use strict";

const { app, BrowserWindow, WebContentsView, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, ".."); // project root — where preorder-watcher.mjs lives
const HOME_URL = "https://p-bandai.com/us/";
const PARTITION = "persist:pbandai"; // login/cookies survive between runs
const WATCH_TOP_H = 96; // watch-mode top strip: status row (52) + browser nav row (44)
const LOG_H = 140; // bottom log strip height (px)

// Full config shape + defaults. The setup screen only collects itemUrl, areaItemNo,
// openIso, and endIso — everything below the blank line is a fixed default (not shown,
// not read from env vars). Missing fields (older config files) fall back to these.
const DEFAULTS = {
  itemUrl: "https://p-bandai.com/us/item/",
  areaItemNo: "",
  openIso: "", // "drop time" — start polling at this instant. Blank = poll immediately.
  endIso: "", // "end time" — stop polling at this instant. Blank = giveUpMinutes after open.

  qty: 1,
  pollMs: 1500,
  pollJitterMs: 250,
  tightWindowSec: 45,
  refreshLeadSec: 60,
  giveUpMinutes: 60, // fallback stop window when endIso is blank
  preallocRetries: 20,
};

let win = null;
let siteView = null;
let latestToken = null;
let child = null; // the Playwright watcher subprocess (preorder-watcher.mjs), or null
let currentMode = "setup"; // 'setup' hides the embedded browser; 'watch' shows it

function configPath() {
  return path.join(app.getPath("userData"), "watcher-config.json");
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  const merged = { ...DEFAULTS, ...(cfg || {}) };
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2));
  return merged;
}

function createWindow() {
  // Electron's default UA advertises "Electron" + the app name, which P-Bandai's Akamai bot
  // wall blocks (500 / "PAGE NOT AVAILABLE") on a direct product hit. Present as plain Chrome —
  // same trick the CLI uses. Must be set before any page loads.
  app.userAgentFallback = app.userAgentFallback
    .replace(/ Electron\/[^ ]+/, "")
    .replace(new RegExp(` ${app.getName()}\\/[^ ]+`, "i"), "");

  win = new BrowserWindow({
    width: 1180,
    height: 900,
    title: "P-Bandai Pre-order Watcher",
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  siteView = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      // Patch the page's main-world navigator to hide Electron from Akamai's sensor. This
      // requires the preload to share the page context (contextIsolation:false, unsandboxed).
      // The preload uses no Node, and nodeIntegration stays off, so the page gets no Node access.
      preload: path.join(__dirname, "site-preload.js"),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(siteView);
  siteView.webContents.loadURL(HOME_URL); // warm the browser/login while the user fills the form
  layoutSiteView(); // starts hidden — we launch on the setup screen

  // P-Bandai opens many product links in a new window/tab; without a handler the embedded
  // view drops them and the click looks dead. Keep them inside the same view instead.
  siteView.webContents.setWindowOpenHandler(({ url }) => {
    siteView.webContents.loadURL(url);
    return { action: "deny" };
  });

  // Mirror the embedded browser's URL + back/forward state up to the renderer toolbar.
  const pushNav = () => {
    const wc = siteView.webContents;
    send("nav-state", {
      url: wc.getURL(),
      canBack: wc.canGoBack(),
      canForward: wc.canGoForward(),
    });
  };
  siteView.webContents.on("did-navigate", pushNav);
  siteView.webContents.on("did-navigate-in-page", pushNav);

  // The CSRF token lives only on the site's own outgoing request headers — sniff every one.
  siteView.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["https://p-bandai.com/*"] },
    (details, cb) => {
      const h = details.requestHeaders;
      const t = h["X-CSRF-Token"] || h["x-csrf-token"];
      if (t) latestToken = t;
      if (!h["Accept-Language"]) h["Accept-Language"] = "en-US,en;q=0.9";
      // Strip the "Electron" brand from the UA client hint — another bot-wall giveaway.
      for (const k of Object.keys(h)) {
        if (/^sec-ch-ua$/i.test(k) && typeof h[k] === "string") {
          h[k] = h[k].replace(/,?\s*"[^"]*Electron[^"]*";v="[^"]*"/i, "");
        }
      }
      cb({ requestHeaders: h });
    },
  );

  win.on("resize", layoutSiteView);
}

function layoutSiteView() {
  if (!win || !siteView) return;
  const { width, height } = win.getContentBounds();
  if (currentMode !== "watch") {
    // Setup screen: keep the native browser view out of the way so the form owns the window.
    if (siteView.setVisible) siteView.setVisible(false);
    siteView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    return;
  }
  if (siteView.setVisible) siteView.setVisible(true);
  siteView.setBounds({
    x: 0,
    y: WATCH_TOP_H,
    width,
    height: Math.max(0, height - WATCH_TOP_H - LOG_H),
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const log = (msg) => send("log", `${new Date().toLocaleTimeString()}  ${msg}`);
const status = (s) => send("status", s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalInSite(code) {
  try {
    return await siteView.webContents.executeJavaScript(code, true);
  } catch (e) {
    return { status: -1, body: "eval error: " + String(e) };
  }
}

// Scrape the currently-loaded page for the SKU, schedule text, and ISO timestamps.
function runInspect() {
  return evalInSite(`(() => {
    const html = document.documentElement.innerHTML
    const skus = [...new Set(html.match(/[A-Z]{3}\\d{6,}US/g) || [])]
    const body = (document.body.innerText || '').split('\\n').map(l => l.trim()).filter(Boolean)
    const schedule = body.filter(l => /(PRE-?ORDER|SALES?|OPEN|CLOSE|SHIP|START|END)/i.test(l)).slice(0, 12)
    const iso = [...new Set(html.match(/\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z/g) || [])]
    return {title: document.title, skus, schedule, iso, tokenReady: ${JSON.stringify(!!latestToken)}}
  })()`);
}

const SAME_SITE = { no_restriction: "None", strict: "Strict", lax: "Lax" };

// Pull the login/session cookies out of the embedded browser so the Playwright watcher can
// inherit them and skip a second login. We deliberately DROP Akamai's bot-manager cookies
// (_abck, bm_*, ak_bmsc) — those are bound to this browser's fingerprint; Playwright must mint
// its own by browsing. Shaped for Playwright's context.addCookies().
async function collectAuthCookies() {
  try {
    const all = await siteView.webContents.session.cookies.get({});
    return all
      .filter((c) => /bandai/i.test(c.domain))
      .filter((c) => !/^(_abck|bm_|ak_bmsc)/i.test(c.name))
      .filter((c) => c.name && c.value)
      .map((c) => {
        const sameSite = SAME_SITE[c.sameSite] || "Lax";
        return {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
          httpOnly: !!c.httpOnly,
          secure: sameSite === "None" ? true : !!c.secure, // None requires Secure
          sameSite,
          ...(c.expirationDate ? { expires: Math.round(c.expirationDate) } : {}),
        };
      });
  } catch {
    return [];
  }
}

ipcMain.handle("config:load", () => loadConfig());
ipcMain.handle("config:save", (_e, cfg) => saveConfig(cfg));

ipcMain.on("set-mode", (_e, mode) => {
  currentMode = mode === "watch" ? "watch" : "setup";
  layoutSiteView();
});

// Browser toolbar controls for the embedded view.
ipcMain.on("nav:back", () => {
  if (siteView.webContents.canGoBack()) siteView.webContents.goBack();
});
ipcMain.on("nav:forward", () => {
  if (siteView.webContents.canGoForward()) siteView.webContents.goForward();
});
ipcMain.on("nav:reload", () => siteView.webContents.reload());
ipcMain.on("nav:home", () => siteView.webContents.loadURL(HOME_URL));
ipcMain.on("nav:go", (_e, url) => {
  if (!url) return;
  siteView.webContents.loadURL(/^[a-z]+:\/\//i.test(url) ? url : "https://" + url);
});
ipcMain.handle("get-url", () => siteView.webContents.getURL());

// Look up the real areaItemNo (+ schedule timestamps) from the server: the browser is
// hidden on the setup screen, so load the item page in the background, then scrape it.
ipcMain.handle("lookup-item", async (_e, url) => {
  try {
    if (url) {
      await siteView.webContents.loadURL(url);
      await sleep(3200);
    }
  } catch (e) {
    return { status: -1, body: "navigation failed: " + String(e) };
  }
  return runInspect();
});

ipcMain.on("stop", () => {
  if (child) {
    child.kill(); // SIGTERM → Playwright closes its browser and exits
    log("■ stopping watcher…");
  } else {
    log("■ nothing to stop");
    status({ state: "stopped" });
  }
});

// "Arm" now delegates the watch to the proven Playwright engine (preorder-watcher.mjs) as a
// subprocess. It opens its own Chromium window (where you log in and watch); we just write its
// config, stream its log into our log strip, and reflect key states on the status chip.
ipcMain.on("arm", async (_e, cfg) => {
  if (child) {
    log("already watching — stop first");
    return;
  }
  if (!cfg || !cfg.areaItemNo) {
    log("need an item number — set it in Setup first");
    return;
  }

  const cookies = await collectAuthCookies();
  const cliCfg = {
    itemUrl: cfg.itemUrl,
    areaItemNo: cfg.areaItemNo,
    qty: Number(cfg.qty) || 1,
    openIso: cfg.openIso || "",
    endIso: cfg.endIso || "",
    userDataDir: path.join(ROOT, "profile"), // Playwright's persistent login lives here
    headless: false,
    cookies, // login session inherited from the app (empty ⇒ log in in the watcher window)
    pollMs: Number(cfg.pollMs) || DEFAULTS.pollMs,
    pollJitterMs: Number(cfg.pollJitterMs) || DEFAULTS.pollJitterMs,
    tightWindowSec: Number(cfg.tightWindowSec) || DEFAULTS.tightWindowSec,
    preallocRetries: Number(cfg.preallocRetries) || DEFAULTS.preallocRetries,
  };
  const cfgFile = path.join(app.getPath("userData"), "cli-config.json");
  try {
    fs.writeFileSync(cfgFile, JSON.stringify(cliCfg, null, 2));
  } catch (e) {
    log("could not write watcher config: " + String(e));
    return;
  }

  log(
    cookies.length
      ? `passing ${cookies.length} session cookie(s) from the app — the watcher window should already be logged in.`
      : "no app login detected — log in in the watcher's Chromium window when it opens.",
  );
  log("starting the Playwright watcher — a separate Chromium window will open.");
  status({ state: "polling" });

  child = spawn("node", ["preorder-watcher.mjs", "watch", cfgFile], {
    cwd: ROOT,
    env: process.env,
  });
  const pipe = (buf) =>
    String(buf)
      .split(/\r?\n/)
      .forEach((line) => {
        if (!line.trim()) return;
        log(line);
        if (/SUCCESS|added to cart|already in your cart/i.test(line))
          status({ state: "success" });
        else if (/sold out/i.test(line)) status({ state: "sold_out" });
        else if (/OPEN — polling|polling addToCart/i.test(line))
          status({ state: "polling" });
        else if (/waiting…|arming…/i.test(line)) status({ state: "waiting" });
      });
  child.stdout.on("data", pipe);
  child.stderr.on("data", pipe);
  child.on("error", (e) => {
    log(`failed to start watcher: ${e.message}. Is Node on your PATH?`);
    status({ state: "gaveup" });
    child = null;
  });
  child.on("exit", (code) => {
    log(`watcher exited (code ${code ?? "?"}).`);
    status({ state: code === 0 ? "stopped" : "gaveup" });
    child = null;
  });
});

app.whenReady().then(createWindow);
app.on("before-quit", () => {
  if (child) child.kill();
});
app.on("window-all-closed", () => app.quit());
