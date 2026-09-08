/**
 * Shared Chrome-executable resolver.
 *
 * G24 (Round 8) — the entire studio renderer surface is pinned to a single
 * Puppeteer-managed Chrome. HyperFrames (WP-05) spawns it via the `npx
 * hyperframes` CLI by setting `PUPPETEER_EXECUTABLE_PATH` on the child; the
 * Excalidraw capture adapter (WP-05b) imports `resolveChromeExecutable()`
 * from this file and launches `puppeteer.launch({ executablePath })` against
 * the same binary. One Chrome, one version, one source of truth.
 *
 * ─── Deviation from the WP-05 brief ───────────────────────────────────────
 *
 * The brief specified `resolveChromeExecutable(): string` backed by
 * `puppeteer.executablePath()`. In puppeteer ^25 `executablePath()` is
 * ASYNC (returns `Promise<string>`), so a purely-synchronous resolver
 * cannot delegate to it. We keep the mandated sync signature by resolving
 * the path deterministically from puppeteer's on-disk cache layout
 * (`<cacheDir>/chrome/linux-<buildId>/chrome-linux64/chrome`) and picking
 * the newest installed build. The authoritative async resolver
 * (`resolveChromeExecutableAsync()`) delegates to puppeteer directly and is
 * available for callers that can await; the sync function exists because
 * WP-05b imports it without an await and the HF adapter wants a fail-fast
 * path before spawning. Both return the same binary in practice.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

let cachedSync: string | null = null;
let cachedAsync: string | null = null;

function cacheDir(): string {
  return (
    process.env.PUPPETEER_CACHE_DIR ||
    join(homedir(), '.cache', 'puppeteer')
  );
}

const INSTALL_HINT =
  'Run `npx puppeteer browsers install chrome` (or `pnpm rebuild puppeteer`) ' +
  'to download the pinned Chrome. This is the single Chrome shared by the ' +
  'HyperFrames + Excalidraw renderer adapters (G24).';

/**
 * Scan puppeteer's chrome cache for installed builds and return the path to
 * the newest one's executable. Pure-sync; no puppeteer call.
 */
function scanCacheForChrome(): string | null {
  const chromeRoot = join(cacheDir(), 'chrome');
  if (!existsSync(chromeRoot)) return null;
  let entries: string[];
  try {
    entries = readdirSync(chromeRoot);
  } catch {
    return null;
  }
  // Directory names look like `linux-148.0.7778.167`. Sort by the embedded
  // version descending so we pick the newest installed build.
  const builds = entries
    .filter((e) => /^[a-z0-9_]+-\d+\.\d+\.\d+/i.test(e))
    .map((e) => {
      const verMatch = e.match(/-(\d+)\.(\d+)\.(\d+)\.(\d+)/);
      const key = verMatch
        ? verMatch.slice(1).map((n) => Number(n).toString().padStart(6, '0')).join('.')
        : '0';
      return { dir: e, key };
    })
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

  for (const b of builds) {
    const candidates = [
      // Windows layout: <build>/chrome-win64/chrome.exe
      join(chromeRoot, b.dir, 'chrome-win64', 'chrome.exe'),
      join(chromeRoot, b.dir, 'chrome-win32', 'chrome.exe'),
      // Linux layout: <build>/chrome-linux64/chrome
      join(chromeRoot, b.dir, 'chrome-linux64', 'chrome'),
      // macOS layout
      join(chromeRoot, b.dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(chromeRoot, b.dir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the absolute path to the pinned Chrome executable (synchronous).
 * Throws with a descriptive message if Chrome isn't installed on disk.
 *
 * Callers (HF adapter, Excalidraw adapter) MUST use this rather than
 * touching the puppeteer cache directly — centralising the resolution here
 * is the durable G24 deliverable.
 */
export function resolveChromeExecutable(): string {
  if (cachedSync) return cachedSync;
  const found = scanCacheForChrome();
  if (!found) {
    throw new Error(`Pinned Chrome not found in ${join(cacheDir(), 'chrome')}. ${INSTALL_HINT}`);
  }
  cachedSync = found;
  return found;
}

/**
 * Authoritative async resolver — delegates to puppeteer's own
 * `executablePath()` (the exact build puppeteer would launch). Use this when
 * you can await; falls back to the sync scan if puppeteer returns a path
 * that isn't on disk yet.
 */
export async function resolveChromeExecutableAsync(): Promise<string> {
  if (cachedAsync) return cachedAsync;
  let p: string | undefined;
  try {
    p = await puppeteer.executablePath();
  } catch {
    p = undefined;
  }
  if (p && existsSync(p)) {
    cachedAsync = p;
    return p;
  }
  // puppeteer pointed at a not-yet-extracted build — fall back to the scan.
  const scan = scanCacheForChrome();
  if (scan) {
    cachedAsync = scan;
    return scan;
  }
  throw new Error(
    `Pinned Chrome not available (puppeteer.executablePath()=${p ?? 'none'}). ${INSTALL_HINT}`,
  );
}
