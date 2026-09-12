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
 * (`<cacheDir>/chrome/<platform>-<buildId>/<relative-executable-path>`,
 * where the platform-dir prefix — `linux`, `linux_arm`, `mac`, `mac_arm`,
 * `win32`, `win64` — is @puppeteer/browsers' own `Cache.installationDir()`
 * naming) and picking the newest installed build *for the host platform*.
 * The authoritative async resolver (`resolveChromeExecutableAsync()`)
 * delegates to puppeteer directly and is available for callers that can
 * await; the sync function exists because WP-05b imports it without an
 * await and the HF adapter wants a fail-fast path before spawning.
 *
 * Both resolvers are constrained to the host platform (the async one because
 * puppeteer only ever reports its own platform's build, the sync one because
 * of the `HOST_PLATFORM_PREFIXES` gate below), so on a single-platform cache
 * they return the same binary. They can still disagree when the cache holds
 * several host-platform builds and puppeteer is pinned to an older one —
 * prefer the async resolver wherever you can await.
 *
 * ─── WP-32 live-found fix ──────────────────────────────────────────────────
 *
 * The scan used to hardcode the Linux layout (`chrome-linux64/chrome`) and
 * filter build dirs with `/^[a-z]+-\d+\.\d+\.\d+/` — a pattern that can
 * never match a `win64-*`/`win32-*`/`mac_arm-*`/`linux_arm-*` dir name
 * because the platform prefix itself contains digits/underscores that
 * `[a-z]+` rejects. On Windows this meant every cached build was filtered
 * out before the (also wrong) Linux path was even tried, so
 * `resolveChromeExecutable()` always threw "Pinned Chrome not found" even
 * with a valid `win64-*` build sitting in the cache. Fixed by deriving both
 * the version key AND the relative executable path from each build dir's
 * own platform prefix (mirrors `@puppeteer/browsers`' `folder()` +
 * `relativeExecutablePath()` in `browser-data/chrome.js`) instead of
 * assuming Linux.
 *
 * Two follow-ups from the review of that fix:
 *
 *  - Accepting every platform prefix without also *filtering* by the host
 *    platform made a mixed-OS cache (a `PUPPETEER_CACHE_DIR` shared across
 *    WSL/Windows, a container volume, a repo-local cache) hand back a
 *    foreign binary — e.g. the `mac_arm` app bundle on win32 — which dies
 *    with an opaque exec error instead of the actionable INSTALL_HINT, and
 *    diverges from what `resolveChromeExecutableAsync()` returns. The scan
 *    now only considers prefixes the host can actually execute
 *    (`HOST_PLATFORM_PREFIXES`).
 *  - The build-dir regex demanded exactly four numeric version components,
 *    so hand-extracted / channel-aliased / future-shaped build ids became
 *    invisible. `@puppeteer/browsers`' `Cache.parseFolderPath()` puts no
 *    constraint on buildId shape, so neither do we: any `<prefix>-<buildId>`
 *    dir is a candidate, and a buildId that isn't dot-separated digits just
 *    sorts last instead of being discarded.
 *
 * Two follow-ups from the review of the headless-shell addition:
 *
 *  - The shell scan used to pick the newest shell build independently of the
 *    Chrome build `resolveChromeExecutable()` hands the Excalidraw adapter,
 *    which breaks the G24 "one Chrome, one version" pin the moment the two
 *    trees hold different newest builds (a pruned/interrupted shell install
 *    is enough: HF would render on 148 while Excalidraw captures on 152, with
 *    nothing in the render record to say so). The shell scan now takes a
 *    `preferBuildId` and returns the shell build that MATCHES the resolved
 *    Chrome's buildId when one is installed, falling back to newest only when
 *    that build is absent.
 *  - `resolveHeadlessShellExecutable()` used to memoize its *negative* result,
 *    so an operator who installed `chrome-headless-shell` after the first
 *    failed render kept getting the old answer until the sidecar restarted.
 *    Only successes are memoized now (same policy as
 *    `resolveChromeExecutable()`, which throws without caching and therefore
 *    re-scans).
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

let cachedSync: string | null = null;
let cachedAsync: string | null = null;
// Successes only — a miss is NOT memoized, so installing the shell build takes
// effect on the next render rather than after a sidecar restart.
let cachedShell: string | null = null;

function cacheDir(): string {
  return (
    process.env.PUPPETEER_CACHE_DIR ||
    join(homedir(), '.cache', 'puppeteer')
  );
}

/**
 * Hint for "the headless shell is missing". Exported because the HyperFrames
 * adapter has to throw the same actionable text: `browsers install chrome`
 * does NOT bring the shell build, so an operator told only about Chrome fixes
 * one error and lands straight back on the ETIMEDOUT preflight failure.
 */
export const HEADLESS_SHELL_INSTALL_HINT =
  'Run `npx puppeteer browsers install chrome-headless-shell` to download it. ' +
  'The HyperFrames adapter REQUIRES that build on Windows — full Chrome never ' +
  "answers HyperFrames' `<exe> --version` preflight there (g61).";

const INSTALL_HINT =
  'Run `npx puppeteer browsers install chrome` (or `pnpm rebuild puppeteer`) ' +
  'to download the pinned Chrome. This is the single Chrome shared by the ' +
  'HyperFrames + Excalidraw renderer adapters (G24). ' +
  HEADLESS_SHELL_INSTALL_HINT;

/** `<cacheDir>/chrome-headless-shell` — the tree the shell scan walks. */
export function headlessShellCacheDir(): string {
  return join(cacheDir(), 'chrome-headless-shell');
}

/**
 * The platform-dir prefixes puppeteer's cache uses (`Cache.installationDir()`
 * in `@puppeteer/browsers`: `<platform>-<buildId>`), mapped to the relative
 * path of the executable *inside* that build dir (`relativeExecutablePath()`
 * in `@puppeteer/browsers/lib/browser-data/chrome.js`).
 */
const RELATIVE_EXECUTABLE_PATH: Record<string, string> = {
  linux: join('chrome-linux64', 'chrome'),
  linux_arm: join('chrome-linux64', 'chrome'),
  mac: join('chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  mac_arm: join('chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  win32: join('chrome-win32', 'chrome.exe'),
  win64: join('chrome-win64', 'chrome.exe'),
};

/**
 * The same table for puppeteer's OTHER managed browser, `chrome-headless-shell`
 * (`<cacheDir>/chrome-headless-shell/<platform>-<buildId>/…`).
 *
 * WP-32 live-found (g61): the HyperFrames CLI preflights whatever binary it is
 * given with `<exe> --version` under a 5s timeout, and **full Chrome on Windows
 * never answers `--version` on stdout** — the probe times out and HF aborts
 * with "Chrome cannot start … (signal SIGKILL, ETIMEDOUT)" even though the
 * binary is perfectly good (hand-reproduced 2026-09-12; the headless shell
 * answers the same probe in milliseconds). So HF is pointed at the headless
 * shell when one is installed; on win32 a miss is a hard error (see
 * `resolveHyperframesBrowser()` in hyperframes.ts — the Chrome fallback there
 * reproduces the g61 failure), on POSIX it falls back to full Chrome.
 * The Excalidraw adapter keeps using full Chrome — it drives puppeteer
 * in-process and never runs that probe.
 *
 * There is no `linux_arm` headless-shell build in puppeteer's catalogue, so
 * that prefix is deliberately absent: the scan returns null on Linux ARM and
 * the caller falls back to Chrome rather than pointing at a path that cannot
 * exist.
 */
const RELATIVE_HEADLESS_SHELL_PATH: Record<string, string> = {
  linux: join('chrome-headless-shell-linux64', 'chrome-headless-shell'),
  mac: join('chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
  mac_arm: join('chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
  win32: join('chrome-headless-shell-win32', 'chrome-headless-shell.exe'),
  win64: join('chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
};

/** Every prefix we know how to turn into an executable path. */
const ALL_PLATFORM_PREFIXES = Object.keys(RELATIVE_EXECUTABLE_PATH);

/**
 * Which cache-dir platform prefixes the *host* can actually execute, most
 * preferred first. A cache dir can legitimately hold builds for several
 * operating systems (a `PUPPETEER_CACHE_DIR` shared between WSL and Windows,
 * a mounted container volume, a repo-local cache committed by CI), and
 * handing a foreign binary to `PUPPETEER_EXECUTABLE_PATH` produces an opaque
 * exec failure instead of our actionable "not installed" error.
 *
 * Cross-arch entries are only listed where the host really can run the other
 * arch's build: Windows x64/arm64 runs 32-bit Chrome (WOW64 / emulation),
 * Apple Silicon runs the Intel bundle under Rosetta 2. A Linux x64 box cannot
 * run a `linux_arm` build (and vice-versa), and 32-bit Windows cannot run
 * `win64`, so those combinations are omitted rather than offered as a
 * fallback that would fail at launch.
 *
 * Unknown platforms (puppeteer supports none of them, but be permissive
 * rather than hard-failing) fall back to every prefix, i.e. the pre-gate
 * behaviour.
 */
function hostPlatformPrefixes(platform: NodeJS.Platform, arch: string): string[] {
  switch (platform) {
    case 'win32':
      return arch === 'ia32' ? ['win32'] : ['win64', 'win32'];
    case 'darwin':
      return arch === 'arm64' ? ['mac_arm', 'mac'] : ['mac'];
    case 'linux':
      return arch === 'arm64' || arch === 'arm' ? ['linux_arm'] : ['linux'];
    default:
      return [...ALL_PLATFORM_PREFIXES];
  }
}

/**
 * `<platform>-<buildId>`, e.g. `win64-152.0.7977.54`, `linux-148.0.7778.167`.
 * The prefix alternation must cover every key in RELATIVE_EXECUTABLE_PATH
 * above, longest-first so `linux_arm`/`mac_arm` win over `linux`/`mac`. The
 * buildId is deliberately unconstrained — see the header note.
 */
const BUILD_DIR_RE = /^(linux_arm|linux|mac_arm|mac|win32|win64)-(.+)$/;

/**
 * Sort key for a buildId, comparable as a plain string.
 *
 * Dot-separated numeric build ids get each component zero-padded to a fixed
 * width so the comparison is numeric, not lexical (`100.0.1.1` must beat
 * `99.0.1.1`). A buildId of any other shape — a channel alias, a
 * hand-extracted dir, some future naming — yields the empty string, which
 * sorts below every real key, so such a build stays a last-resort candidate
 * instead of disappearing from the scan.
 */
function versionKey(buildId: string): string {
  const parts = buildId.split('.');
  if (!parts.every((p) => /^\d+$/.test(p))) return '';
  return parts.map((p) => p.replace(/^0+(?=\d)/, '').padStart(8, '0')).join('.');
}

/**
 * Scan puppeteer's chrome cache for installed builds and return the path to
 * the newest one's executable. Pure-sync; no puppeteer call. Handles every
 * platform's on-disk layout (Linux, Windows 32/64-bit, mac Intel/Apple
 * Silicon) by deriving the relative executable path from each build dir's
 * own platform prefix, and considers only builds the host can execute.
 *
 * `platform`/`arch` default to the host's and exist so tests can drive every
 * platform's layout (and mixed-platform caches) from one box — same
 * injection pattern as `resolveDaVinciEnv()` in `../export/davinci.ts`.
 *
 * Exported (only) so tests can drive it directly against a fake cache tree
 * without needing to reset the module-level memoization in
 * `resolveChromeExecutable()`/`resolveChromeExecutableAsync()`.
 */
export function scanCacheForChrome(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  return scanCacheForBrowser('chrome', RELATIVE_EXECUTABLE_PATH, platform, arch)?.path ?? null;
}

/**
 * The same scan against puppeteer's `chrome-headless-shell` cache tree.
 * Returns null when no host-runnable build is installed (including every
 * Linux-ARM box, which has no such build) — callers fall back to full Chrome.
 *
 * `preferBuildId` keeps the G24 one-version pin honest: when the cache holds
 * a shell build with the same buildId as the Chrome the Excalidraw adapter
 * will launch, that build wins over a newer one, so the two renderer adapters
 * never end up on two different Chrome engines. Newest-wins is the fallback
 * for when the matching build simply is not installed.
 *
 * Exported for the same reason as `scanCacheForChrome`: so tests can drive it
 * against a fake cache tree per platform.
 */
export function scanCacheForHeadlessShell(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  preferBuildId?: string,
): string | null {
  return (
    scanCacheForBrowser(
      'chrome-headless-shell',
      RELATIVE_HEADLESS_SHELL_PATH,
      platform,
      arch,
      preferBuildId,
    )?.path ?? null
  );
}

/** One installed browser build: the executable plus the buildId it came from. */
interface BrowserInstall {
  path: string;
  buildId: string;
}

function scanCacheForBrowser(
  browserDir: string,
  relativeExecutablePath: Record<string, string>,
  platform: NodeJS.Platform,
  arch: string,
  preferBuildId?: string,
): BrowserInstall | null {
  const chromeRoot = join(cacheDir(), browserDir);
  if (!existsSync(chromeRoot)) return null;
  let entries: string[];
  try {
    entries = readdirSync(chromeRoot);
  } catch {
    return null;
  }
  const prefixes = hostPlatformPrefixes(platform, arch);
  // Sort by an explicitly-pinned buildId first (the G24 cross-adapter pin),
  // then by host-arch preference (a native build beats a newer emulated one),
  // then by the embedded version descending so we pick the newest installed
  // build (numerically, not lexically — see versionKey()).
  const builds = entries
    .map((e) => {
      const m = e.match(BUILD_DIR_RE);
      if (!m) return null;
      const [, platformPrefix, buildId] = m;
      const rank = prefixes.indexOf(platformPrefix!);
      if (rank === -1) return null; // build for another OS/arch — unrunnable here
      const relExe = relativeExecutablePath[platformPrefix!];
      if (!relExe) return null;
      return {
        dir: e,
        relExe,
        buildId: buildId!,
        rank,
        key: versionKey(buildId!),
        pinned: preferBuildId !== undefined && buildId === preferBuildId,
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
    });

  for (const b of builds) {
    const candidate = join(chromeRoot, b.dir, b.relExe);
    if (existsSync(candidate)) return { path: candidate, buildId: b.buildId };
  }
  return null;
}

/**
 * The buildId embedded in an installed-browser path
 * (`…/chrome/win64-152.0.7977.54/chrome-win64/chrome.exe` → `152.0.7977.54`),
 * or undefined when the path has no `<platform>-<buildId>` segment. Scanned
 * back-to-front so a cache ROOT that happens to look like a build dir cannot
 * shadow the real one.
 */
export function buildIdFromInstallPath(p: string | null | undefined): string | undefined {
  if (!p) return undefined;
  const segments = p.split(/[\\/]/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const m = segments[i]!.match(BUILD_DIR_RE);
    if (m) return m[2];
  }
  return undefined;
}

/**
 * The buildId of the Chrome the renderers will actually use — the memoized
 * one when `resolveChromeExecutable()` has already answered (that is the exact
 * binary `excalidraw.ts` launches), else whatever the scan would return now.
 * Undefined when no Chrome is installed, which simply disables the pin.
 */
function resolvedChromeBuildId(): string | undefined {
  return buildIdFromInstallPath(cachedSync ?? scanCacheForChrome());
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
 * Resolve the installed `chrome-headless-shell` for the host — preferring the
 * build that matches the resolved Chrome's buildId (G24: one Chrome, one
 * version across both renderer adapters), else the newest installed — or null
 * when none is installed. Unlike `resolveChromeExecutable()` this does NOT
 * throw: the caller (the HyperFrames adapter) decides what a miss means.
 *
 * Only a HIT is memoized. Memoizing the miss meant an operator who installed
 * the shell build after a failed render kept getting the stale "not installed"
 * answer for the life of a supervised, long-running sidecar.
 */
export function resolveHeadlessShellExecutable(): string | null {
  if (cachedShell) return cachedShell;
  const found = scanCacheForHeadlessShell(
    process.platform,
    process.arch,
    resolvedChromeBuildId(),
  );
  if (found) cachedShell = found;
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
