/**
 * Desktop shell: starts the web UI server (../server.mjs) on a private localhost port and shows it
 * in an app window. Everything the watcher needs ships inside the app — Electron doubles as the
 * Node runtime for the watcher subprocess, and the packaged build bundles Playwright's Chromium.
 */

import { app, BrowserWindow, dialog, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!app.requestSingleInstanceLock()) app.quit();

// Must be set before Playwright is imported (server.mjs pulls it in below).
if (app.isPackaged) {
  // Chromium bundled via electron-builder extraResources (see scripts/fetch-browsers.mjs).
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, "browsers");
}
// Packaged: the app bundle is read-only, so config + login profile go in the per-user data dir.
// Dev (`npm start`): the repo root, shared with the CLI and `npm run web`.
process.env.PBW_DATA_DIR = app.isPackaged ? app.getPath("userData") : ROOT;

let win = null;
let server = null;
let quitting = false;

async function createWindow() {
  server = await import(pathToFileURL(path.join(ROOT, "server.mjs")).href);
  const url = await server.startServer(0); // any free port

  win = new BrowserWindow({
    width: 820,
    height: 920,
    minWidth: 420,
    title: "P-Bandai Watcher",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(url);

  // Any link the page opens goes to the real browser, not a new app window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  // Closing the window quits the app; route it through before-quit so there's one confirm path.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    app.quit();
  });
}

function confirmStopWatching() {
  return (
    dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Quit and stop watching", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "The watcher is still running.",
      detail: "Quitting stops it — you could miss the drop.",
    }) === 0
  );
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// Confirm if a watch is live, then stop it and close any login window before exiting, so no
// Chromium is left behind.
app.on("before-quit", (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  if (server.isWatching() && !confirmStopWatching()) return;
  quitting = true;
  server.shutdown().finally(() => app.quit());
});

app.on("window-all-closed", () => app.quit());

app.whenReady().then(createWindow).catch((e) => {
  dialog.showErrorBox("P-Bandai Watcher failed to start", String(e?.stack || e));
  app.exit(1);
});
