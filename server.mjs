#!/usr/bin/env node
/**
 * Local web UI for the P-Bandai pre-order watcher.
 *
 *   npm run web          # then open http://localhost:3131 (it opens automatically)
 *
 * The desktop app (electron/main.js) imports startServer() and shows the same page in its window.
 *
 * Settings are edited in the browser and saved to config.json in the data dir — the same file the
 * CLI reads — and "Start" runs `preorder-watcher.mjs watch config.json` as a subprocess whose
 * output streams back to the page. Listens on 127.0.0.1 only; nothing is exposed to your network.
 *
 * PBW_DATA_DIR sets where config.json and the browser profiles live (default: this folder).
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULTS,
  launch,
  warmUpAndCaptureToken,
  scrapeItem,
} from "./preorder-watcher.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // code (read-only inside the packaged app)
const DATA_DIR = process.env.PBW_DATA_DIR || ROOT; // writable: config + browser profiles
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const PROFILE_DIR = path.join(DATA_DIR, "profile"); // login lives here; shared with the watcher
const LOOKUP_PROFILE_DIR = path.join(DATA_DIR, "profile-lookup"); // throwaway, so lookups never lock the login profile
const INDEX_HTML = path.join(ROOT, "web", "index.html");
const HOST = "127.0.0.1";

// The settings the page edits. Everything else keeps the engine's DEFAULTS.
const EDITABLE = ["itemUrl", "areaItemNo", "openIso", "endIso", "pollMs", "giveUpMinutes"];

let child = null; // the watcher subprocess, or null
let stopRequested = false;
let loginContext = null; // Playwright window opened for signing in, or null
let lookupBusy = false;
let status = "idle";
const logLines = []; // backlog so a page refresh shows history
const clients = new Set(); // open SSE responses

// ── config ──────────────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(input) {
  const cfg = loadConfig(); // keep any hand-added fields (userDataDir, cookies, …)
  for (const k of EDITABLE) {
    if (input[k] === undefined) continue;
    cfg[k] = typeof DEFAULTS[k] === "number" ? Number(input[k]) || DEFAULTS[k] : String(input[k]).trim();
  }
  cfg.userDataDir ??= "./profile"; // relative to DATA_DIR — the watcher runs with it as cwd
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  return cfg;
}

// ── live updates ────────────────────────────────────────────────
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function log(line) {
  logLines.push(line);
  if (logLines.length > 1000) logLines.shift();
  broadcast("log", line);
}
const note = (msg) => log(`${new Date().toISOString()} [web] ${msg}`);

function setStatus(s) {
  status = s;
  broadcast("status", snapshot());
}

function snapshot() {
  return { status, running: !!child, loginOpen: !!loginContext, lookupBusy };
}

// ── actions ─────────────────────────────────────────────────────
async function closeLogin() {
  if (!loginContext) return;
  const ctx = loginContext;
  loginContext = null;
  await ctx.close().catch(() => {});
}

async function openLogin() {
  if (child) throw new Error("the watcher is running — log in in its window instead");
  if (loginContext) return;
  const cfg = { ...DEFAULTS, ...loadConfig(), userDataDir: PROFILE_DIR };
  const { context } = await launch(cfg);
  loginContext = context;
  context.on("close", () => {
    if (loginContext === context) loginContext = null;
    note("login window closed — your session is saved in ./profile");
    broadcast("status", snapshot());
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(cfg.homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  note("login window opened — sign in there, then close it (or just hit Start)");
  broadcast("status", snapshot());
}

async function lookupItem(itemUrl) {
  if (lookupBusy) throw new Error("a lookup is already running");
  lookupBusy = true;
  broadcast("status", snapshot());
  note(`looking up ${itemUrl} — a Chromium window will open briefly`);
  const cfg = { ...DEFAULTS, itemUrl, userDataDir: LOOKUP_PROFILE_DIR };
  let context;
  try {
    const launched = await launch(cfg);
    context = launched.context;
    const page = context.pages()[0] || (await context.newPage());
    await warmUpAndCaptureToken(page, cfg, launched.state);
    const found = await scrapeItem(page);
    note(`lookup: ${found.skus.length ? found.skus.join(", ") : "no item number found"}`);
    return found;
  } finally {
    await context?.close().catch(() => {});
    lookupBusy = false;
    broadcast("status", snapshot());
  }
}

async function startWatcher(input) {
  if (child) throw new Error("already running — stop it first");
  const cfg = saveConfig(input);
  if (!cfg.areaItemNo) throw new Error("an item number (areaItemNo) is required");
  await closeLogin(); // the watcher needs the profile the login window has locked

  note("config saved — starting the watcher (a Chromium window will open)");
  // process.execPath is node — or, in the desktop app, Electron, which ELECTRON_RUN_AS_NODE turns
  // into a plain node runtime. Either way no separate Node install is needed.
  child = spawn(process.execPath, [path.join(ROOT, "preorder-watcher.mjs"), "watch", CONFIG_PATH], {
    cwd: DATA_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"], // ipc: lets stopWatcher() ask for a clean exit
  });
  stopRequested = false;
  setStatus("starting");

  let buf = "";
  const onData = (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      log(line);
      if (/SUCCESS|already in your cart/i.test(line)) setStatus("success");
      else if (/sold out/i.test(line)) setStatus("sold_out");
      else if (/OPEN — polling/i.test(line)) setStatus("polling");
      else if (/waiting…|arming…/i.test(line) && status !== "waiting") setStatus("waiting");
    }
  };
  child.stdout.setEncoding("utf8").on("data", onData);
  child.stderr.setEncoding("utf8").on("data", onData);
  child.on("exit", (code, signal) => {
    note(`watcher exited (${signal || `code ${code}`})`);
    child = null;
    if (["success", "sold_out"].includes(status)) setStatus(status);
    else setStatus(stopRequested || signal ? "stopped" : code === 0 ? "finished" : "error");
  });
}

/** Ask the watcher to close its browser and exit; force-kill if it hasn't within 10s. */
function stopWatcher() {
  if (!child) return Promise.resolve();
  const proc = child;
  if (!stopRequested) {
    stopRequested = true;
    note("stopping watcher…");
    try {
      proc.send("stop");
    } catch {
      proc.kill();
    }
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ── http ────────────────────────────────────────────────────────
function sendJson(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const routes = {
  "GET /": (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(INDEX_HTML));
  },
  "GET /api/config": (req, res) => sendJson(res, 200, { ...pick(DEFAULTS), ...loadConfig() }),
  "POST /api/config": async (req, res) => sendJson(res, 200, saveConfig(await readJson(req))),
  "POST /api/lookup": async (req, res) => {
    const { itemUrl } = await readJson(req);
    if (!itemUrl) return sendJson(res, 400, { error: "itemUrl is required" });
    sendJson(res, 200, await lookupItem(itemUrl));
  },
  "POST /api/login": async (req, res) => {
    await openLogin();
    sendJson(res, 200, snapshot());
  },
  "POST /api/start": async (req, res) => {
    await startWatcher(await readJson(req));
    sendJson(res, 200, snapshot());
  },
  "POST /api/stop": (req, res) => {
    stopWatcher();
    sendJson(res, 200, snapshot());
  },
  "GET /api/events": (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: status\ndata: ${JSON.stringify(snapshot())}\n\n`);
    for (const line of logLines) res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  },
};

function pick(obj) {
  return Object.fromEntries(EDITABLE.map((k) => [k, obj[k]]));
}

const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to this machine (blocks DNS-rebinding from other sites).
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1"].includes(host)) return sendJson(res, 403, { error: "forbidden" });
  // State-changing calls must be JSON, which a cross-site form post can't send without CORS.
  if (req.method === "POST" && !/application\/json/.test(req.headers["content-type"] || "")) {
    return sendJson(res, 415, { error: "expected application/json" });
  }

  const route = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
  if (!route) return sendJson(res, 404, { error: "not found" });
  try {
    await route(req, res);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 400, { error: e.message || String(e) });
  }
});

/** Start listening on 127.0.0.1:port (0 = any free port). Resolves to the page URL. */
export function startServer(port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve(`http://localhost:${server.address().port}`));
  });
}

/** True while a watcher subprocess is running. */
export const isWatching = () => !!child;

/** Stop the watcher and close any login window — call before the process exits. */
export async function shutdown() {
  await Promise.all([stopWatcher(), closeLogin()]);
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

// Standalone `node server.mjs`: listen on a fixed port and open the default browser.
const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const url = await startServer(Number(process.env.PORT) || 3131);
  console.log(`P-Bandai watcher UI running at ${url}  (Ctrl+C to quit)`);
  if (!process.env.NO_OPEN) openBrowser(url);
  const quit = () => shutdown().then(() => process.exit(0));
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}
