#!/usr/bin/env node
/**
 * Download Playwright's Chromium into ./.browsers so electron-builder can bundle it into the app
 * (extraResources → <app resources>/browsers). Playwright only downloads the build for the
 * machine it runs on, so each platform's app has to be built on that platform (see
 * .github/workflows/build.yml).
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// cli.js isn't in playwright's "exports", so locate it next to its package.json.
const pkg = createRequire(import.meta.url).resolve("playwright/package.json");
const cli = path.join(path.dirname(pkg), "cli.js");

// --no-shell: the watcher always runs headed, so skip the separate headless-shell download.
const { status } = spawnSync(process.execPath, [cli, "install", "chromium", "--no-shell"], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(ROOT, ".browsers") },
});
process.exit(status ?? 1);
