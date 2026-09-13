// com.ikenga.studio project sidecar · chrome.ts pinned-Chrome resolver (WP-32)
//
//   bun run src/renderers/chrome.test.ts   (from sidecars/project/)
//   bun run test                            (package script — runs this + the others)
//
// Plain assert-based script (no bun:test / node:test import) — same rationale
// as blender.test.ts / registry.test.ts / session.test.ts / etc: typechecks
// under the shared `tsc -p ../../tsconfig.json` project (no Bun types) while
// running for real under the bun runtime.
//
// Live-found gap (WP-32): scanCacheForChrome() only ever looked for
// `<build>/chrome-linux64/chrome`, and its build-dir filter regex
// (`/^[a-z]+-\d+\.\d+\.\d+/`) can never match a `win64-*`/`win32-*`/
// `mac_arm-*`/`linux_arm-*` directory name because the platform prefix
// itself contains digits/underscores that `[a-z]+` rejects. On Windows this
// meant every cached build was filtered out before the (also wrong) Linux
// path was even tried, so resolveChromeExecutable() always threw "Pinned
// Chrome not found" even with a valid win64-* build on disk.
//
// Review follow-ups covered here too:
//  - a cache holding builds for more than one OS must still hand back a
//    binary the *host* can execute (mixed-cache cases below), and the arch
//    ranking must beat version ordering;
//  - the newest-build preference must be numeric, not lexical — the cases
//    below use differing-width components (99 vs 100) so a plain string
//    sort fails them;
//  - build dirs whose buildId isn't a 4-part version are a low-priority
//    fallback, not invisible;
//  - the two exported (memoized) resolvers that hyperframes.ts/excalidraw.ts
//    actually call are exercised, not just the inner scan;
//  - the headless-shell scan must honour the G24 one-version pin: the shell
//    build matching the resolved Chrome's buildId beats a newer one, so HF and
//    Excalidraw cannot end up on two Chrome engines (newest-wins stays the
//    fallback when the matching build is absent);
//  - resolveHeadlessShellExecutable() must NOT memoize a miss — installing the
//    shell build has to take effect on the next render, not after a sidecar
//    restart.
//
// Everything runs against a fake `chrome/` cache tree (mirroring
// @puppeteer/browsers' `<platform>-<buildId>/<relative-exe-path>` layout) —
// no real Chrome, no puppeteer network calls. scanCacheForChrome() takes
// explicit platform/arch args so every platform's layout is testable from
// one box; the memoized resolvers read the real host platform, so their
// cases seed a build for whatever host is running the suite.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildIdFromInstallPath,
  resolveChromeExecutable,
  resolveChromeExecutableAsync,
  resolveHeadlessShellExecutable,
  scanCacheForChrome,
  scanCacheForHeadlessShell,
} from './chrome.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}
async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

/** Normalise a found path for endsWith/includes assertions. */
function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

const WIN64_EXE = join('chrome-win64', 'chrome.exe');
const WIN32_EXE = join('chrome-win32', 'chrome.exe');
const LINUX_EXE = join('chrome-linux64', 'chrome');
const MAC_ARM_EXE = join(
  'chrome-mac-arm64',
  'Google Chrome for Testing.app',
  'Contents',
  'MacOS',
  'Google Chrome for Testing',
);
const MAC_X64_EXE = join(
  'chrome-mac-x64',
  'Google Chrome for Testing.app',
  'Contents',
  'MacOS',
  'Google Chrome for Testing',
);

/** Create `<root>/chrome/<dirName>/<relExePath>` as a (non-empty) file. */
function makeBuild(root: string, dirName: string, relExePath: string): void {
  const full = join(root, 'chrome', dirName, relExePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'fake-binary');
}

const SHELL_WIN64_EXE = join('chrome-headless-shell-win64', 'chrome-headless-shell.exe');
const SHELL_WIN32_EXE = join('chrome-headless-shell-win32', 'chrome-headless-shell.exe');
const SHELL_LINUX_EXE = join('chrome-headless-shell-linux64', 'chrome-headless-shell');
const SHELL_MAC_ARM_EXE = join('chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
const SHELL_MAC_X64_EXE = join('chrome-headless-shell-mac-x64', 'chrome-headless-shell');

/** Create `<root>/chrome-headless-shell/<dirName>/<relExePath>` as a file. */
function makeShellBuild(root: string, dirName: string, relExePath: string): void {
  const full = join(root, 'chrome-headless-shell', dirName, relExePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'fake-binary');
}

/** Run `fn` with PUPPETEER_CACHE_DIR pointed at a fresh temp dir, then clean up. */
function withFakeCache(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'chrome-cache-test-'));
  const prev = process.env.PUPPETEER_CACHE_DIR;
  process.env.PUPPETEER_CACHE_DIR = root;
  try {
    fn(root);
  } finally {
    if (prev === undefined) delete process.env.PUPPETEER_CACHE_DIR;
    else process.env.PUPPETEER_CACHE_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The build dir + relative executable path the *running host* would install,
 * for the cases that exercise the memoized resolvers (which read
 * process.platform / process.arch directly and take no override).
 */
function hostBuild(): { dir: string; relExe: string } {
  const version = '152.0.7977.54';
  switch (process.platform) {
    case 'win32':
      return process.arch === 'ia32'
        ? { dir: `win32-${version}`, relExe: WIN32_EXE }
        : { dir: `win64-${version}`, relExe: WIN64_EXE };
    case 'darwin':
      return process.arch === 'arm64'
        ? { dir: `mac_arm-${version}`, relExe: MAC_ARM_EXE }
        : { dir: `mac-${version}`, relExe: MAC_X64_EXE };
    case 'linux':
      return process.arch === 'arm64' || process.arch === 'arm'
        ? { dir: `linux_arm-${version}`, relExe: LINUX_EXE }
        : { dir: `linux-${version}`, relExe: LINUX_EXE };
    default:
      // hostPlatformPrefixes() falls back to every prefix on an unknown
      // platform, so any layout works.
      return { dir: `linux-${version}`, relExe: LINUX_EXE };
  }
}

async function main(): Promise<number> {
  // ── no cache dir at all ─────────────────────────────────────────────────
  test('scanCacheForChrome: returns null when PUPPETEER_CACHE_DIR/chrome does not exist', () => {
    withFakeCache((root) => {
      // withFakeCache creates `root` but not `root/chrome`.
      assert.equal(scanCacheForChrome('win32', 'x64'), null);
      void root;
    });
  });

  // ── empty chrome/ dir ────────────────────────────────────────────────────
  test('scanCacheForChrome: returns null when chrome/ exists but has no build dirs', () => {
    withFakeCache((root) => {
      mkdirSync(join(root, 'chrome'), { recursive: true });
      assert.equal(scanCacheForChrome('win32', 'x64'), null);
    });
  });

  // ── the live-found Windows gap: win64-* build ───────────────────────────
  test('scanCacheForChrome: finds a win64-* build at chrome-win64/chrome.exe (the live-found gap)', () => {
    withFakeCache((root) => {
      makeBuild(root, 'win64-152.0.7977.54', WIN64_EXE);
      const found = scanCacheForChrome('win32', 'x64');
      assert.ok(found, 'expected a match for a win64-* build dir');
      assert.ok(slash(found!).endsWith('win64-152.0.7977.54/chrome-win64/chrome.exe'));
    });
  });

  test('scanCacheForChrome: finds a win32-* build at chrome-win32/chrome.exe', () => {
    withFakeCache((root) => {
      makeBuild(root, 'win32-148.0.7778.167', WIN32_EXE);
      const found = scanCacheForChrome('win32', 'ia32');
      assert.ok(found);
      assert.ok(slash(found!).endsWith('win32-148.0.7778.167/chrome-win32/chrome.exe'));
    });
  });

  // ── linux (still works — pre-existing supported layout) ────────────────
  test('scanCacheForChrome: finds a linux-* build at chrome-linux64/chrome', () => {
    withFakeCache((root) => {
      makeBuild(root, 'linux-148.0.7778.167', LINUX_EXE);
      const found = scanCacheForChrome('linux', 'x64');
      assert.ok(found);
      assert.ok(slash(found!).endsWith('linux-148.0.7778.167/chrome-linux64/chrome'));
    });
  });

  test('scanCacheForChrome: finds a linux_arm-* build at chrome-linux64/chrome', () => {
    withFakeCache((root) => {
      makeBuild(root, 'linux_arm-148.0.7778.167', LINUX_EXE);
      const found = scanCacheForChrome('linux', 'arm64');
      assert.ok(found);
      assert.ok(slash(found!).endsWith('linux_arm-148.0.7778.167/chrome-linux64/chrome'));
    });
  });

  // ── mac (Apple Silicon vs Intel app-bundle path) ────────────────────────
  test('scanCacheForChrome: finds a mac_arm-* build at the mac-arm64 app-bundle path', () => {
    withFakeCache((root) => {
      makeBuild(root, 'mac_arm-148.0.7778.167', MAC_ARM_EXE);
      const found = scanCacheForChrome('darwin', 'arm64');
      assert.ok(found);
      assert.ok(
        slash(found!).endsWith(
          'mac_arm-148.0.7778.167/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ),
      );
    });
  });

  test('scanCacheForChrome: finds a mac-* (Intel) build at the mac-x64 app-bundle path', () => {
    withFakeCache((root) => {
      makeBuild(root, 'mac-148.0.7778.167', MAC_X64_EXE);
      const found = scanCacheForChrome('darwin', 'x64');
      assert.ok(found);
      assert.ok(
        slash(found!).endsWith(
          'mac-148.0.7778.167/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ),
      );
    });
  });

  // ── host-platform filtering on a mixed-OS cache ─────────────────────────
  //
  // A PUPPETEER_CACHE_DIR shared across an OS boundary (WSL + Windows on one
  // home dir, a container volume, a repo-local cache) holds builds for
  // several platforms at once. Each host must get its own, regardless of
  // which foreign build happens to be newest.
  function seedMixedCache(root: string): void {
    makeBuild(root, 'win64-152.0.7977.54', WIN64_EXE);
    makeBuild(root, 'linux-153.0.8000.10', LINUX_EXE);
    makeBuild(root, 'mac_arm-154.0.8100.1', MAC_ARM_EXE); // newest of the three
  }

  test('scanCacheForChrome: on a mixed-OS cache, win32 host gets the win64 build (not the newer mac_arm)', () => {
    withFakeCache((root) => {
      seedMixedCache(root);
      const found = scanCacheForChrome('win32', 'x64');
      assert.ok(found);
      assert.ok(slash(found!).endsWith('win64-152.0.7977.54/chrome-win64/chrome.exe'), found!);
    });
  });

  test('scanCacheForChrome: on a mixed-OS cache, linux host gets the linux build', () => {
    withFakeCache((root) => {
      seedMixedCache(root);
      const found = scanCacheForChrome('linux', 'x64');
      assert.ok(found);
      assert.ok(slash(found!).endsWith('linux-153.0.8000.10/chrome-linux64/chrome'), found!);
    });
  });

  test('scanCacheForChrome: on a mixed-OS cache, darwin/arm64 host gets the mac_arm build', () => {
    withFakeCache((root) => {
      seedMixedCache(root);
      const found = scanCacheForChrome('darwin', 'arm64');
      assert.ok(found);
      assert.ok(slash(found!).includes('mac_arm-154.0.8100.1/'), found!);
    });
  });

  test('scanCacheForChrome: returns null (→ actionable install error) when the cache holds only foreign-OS builds', () => {
    withFakeCache((root) => {
      makeBuild(root, 'mac_arm-154.0.8100.1', MAC_ARM_EXE);
      makeBuild(root, 'linux-153.0.8000.10', LINUX_EXE);
      assert.equal(scanCacheForChrome('win32', 'x64'), null);
    });
  });

  test('scanCacheForChrome: linux/x64 will not fall back to a linux_arm build (unrunnable)', () => {
    withFakeCache((root) => {
      makeBuild(root, 'linux_arm-152.0.7977.54', LINUX_EXE);
      assert.equal(scanCacheForChrome('linux', 'x64'), null);
    });
  });

  test('scanCacheForChrome: 32-bit Windows will not fall back to a win64 build (unrunnable)', () => {
    withFakeCache((root) => {
      makeBuild(root, 'win64-152.0.7977.54', WIN64_EXE);
      assert.equal(scanCacheForChrome('win32', 'ia32'), null);
    });
  });

  // ── arch preference outranks version ────────────────────────────────────
  test('scanCacheForChrome: darwin/arm64 prefers the native mac_arm build over a newer Intel one', () => {
    withFakeCache((root) => {
      makeBuild(root, 'mac_arm-140.0.7000.1', MAC_ARM_EXE);
      makeBuild(root, 'mac-152.0.7977.54', MAC_X64_EXE);
      const found = scanCacheForChrome('darwin', 'arm64');
      assert.ok(found);
      assert.ok(slash(found!).includes('mac_arm-140.0.7000.1/'), found!);
    });
  });

  test('scanCacheForChrome: darwin/arm64 falls back to the Intel build (Rosetta) when no mac_arm is cached', () => {
    withFakeCache((root) => {
      makeBuild(root, 'mac-152.0.7977.54', MAC_X64_EXE);
      const found = scanCacheForChrome('darwin', 'arm64');
      assert.ok(found);
      assert.ok(slash(found!).includes('mac-152.0.7977.54/'), found!);
    });
  });

  test('scanCacheForChrome: win32/x64 prefers win64 but falls back to a win32 build', () => {
    withFakeCache((root) => {
      makeBuild(root, 'win32-152.0.7977.54', WIN32_EXE);
      const found = scanCacheForChrome('win32', 'x64');
      assert.ok(found);
      assert.ok(slash(found!).endsWith('win32-152.0.7977.54/chrome-win32/chrome.exe'), found!);
    });
  });

  // ── newest-build preference, numerically not lexically ──────────────────
  test('scanCacheForChrome: prefers the numerically newest build when several are cached', () => {
    withFakeCache((root) => {
      // Differing component widths on purpose: a plain lexical sort puts
      // "99..." above "100..." and "9..." above both, so these cases fail
      // without the zero-padding in versionKey().
      makeBuild(root, 'win64-9.0.1.1', WIN64_EXE);
      makeBuild(root, 'win64-99.0.1.1', WIN64_EXE);
      makeBuild(root, 'win64-100.0.1.1', WIN64_EXE);
      const found = scanCacheForChrome('win32', 'x64');
      assert.ok(found);
      assert.ok(slash(found!).includes('win64-100.0.1.1/'), found!);
    });
  });

  test('scanCacheForChrome: numeric ordering also holds on the later version components', () => {
    withFakeCache((root) => {
      makeBuild(root, 'win64-152.0.7977.9', WIN64_EXE);
      makeBuild(root, 'win64-152.0.7977.54', WIN64_EXE);
      makeBuild(root, 'win64-152.0.999.99', WIN64_EXE);
      const found = scanCacheForChrome('win32', 'x64');
      assert.ok(found);
      assert.ok(slash(found!).includes('win64-152.0.7977.54/'), found!);
    });
  });

  test('scanCacheForChrome: skips a newer build dir whose executable is missing on disk', () => {
    withFakeCache((root) => {
      makeBuild(root, 'win64-148.0.7778.167', WIN64_EXE);
      // Newer-looking dir exists but its executable was never extracted
      // (e.g. an interrupted install) — must fall through to the older one.
      mkdirSync(join(root, 'chrome', 'win64-152.0.7977.54', 'chrome-win64'), { recursive: true });
      const found = scanCacheForChrome('win32', 'x64');
      assert.ok(found);
      assert.ok(slash(found!).includes('win64-148.0.7778.167/'));
    });
  });

  // ── buildId shapes @puppeteer/browsers permits but that aren't 4-part ───
  test('scanCacheForChrome: finds a build whose buildId has fewer than four components', () => {
    withFakeCache((root) => {
      makeBuild(root, 'win64-152.0.7977', WIN64_EXE);
      const found = scanCacheForChrome('win32', 'x64');
      assert.ok(found, 'a 3-part buildId must stay a candidate, not be filtered out');
      assert.ok(slash(found!).includes('win64-152.0.7977/'), found!);
    });
  });

  test('scanCacheForChrome: finds a build whose buildId is not a version at all (last-resort fallback)', () => {
    withFakeCache((root) => {
      makeBuild(root, 'win64-stable', WIN64_EXE);
      const found = scanCacheForChrome('win32', 'x64');
      assert.ok(found, 'a channel-aliased/hand-extracted build dir must remain usable');
      assert.ok(slash(found!).includes('win64-stable/'), found!);
    });
  });

  test('scanCacheForChrome: a non-version buildId sorts below every real version', () => {
    withFakeCache((root) => {
      makeBuild(root, 'win64-stable', WIN64_EXE);
      makeBuild(root, 'win64-100.0.1.1', WIN64_EXE);
      const found = scanCacheForChrome('win32', 'x64');
      assert.ok(found);
      assert.ok(slash(found!).includes('win64-100.0.1.1/'), found!);
    });
  });

  // ── non-build dirs and malformed names are ignored, not thrown on ──────
  test('scanCacheForChrome: ignores non-matching directory names alongside a valid build', () => {
    withFakeCache((root) => {
      mkdirSync(join(root, 'chrome', '.DS_Store'), { recursive: true });
      mkdirSync(join(root, 'chrome', 'not-a-build-dir'), { recursive: true });
      makeBuild(root, 'win64-148.0.7778.167', WIN64_EXE);
      const found = scanCacheForChrome('win32', 'x64');
      assert.ok(found);
      assert.ok(slash(found!).includes('win64-148.0.7778.167/'));
    });
  });

  test('scanCacheForChrome: defaults to the running host platform when called with no args', () => {
    withFakeCache((root) => {
      const { dir, relExe } = hostBuild();
      makeBuild(root, dir, relExe);
      const found = scanCacheForChrome();
      assert.ok(found, `expected the host build ${dir} to be found with default args`);
      assert.ok(slash(found!).includes(`${dir}/`), found!);
    });
  });

  // ── the exported, memoized resolvers the renderers actually call ────────
  //
  // Order matters: resolveChromeExecutable() memoizes its first success for
  // the life of the process, so the failure case has to run before the
  // success case, and no later case may depend on a different cache dir.
  test('resolveChromeExecutable: throws with the install hint when nothing is cached', () => {
    withFakeCache((root) => {
      mkdirSync(join(root, 'chrome'), { recursive: true });
      assert.throws(
        () => resolveChromeExecutable(),
        (err: unknown) => {
          const msg = (err as Error).message;
          assert.match(msg, /Pinned Chrome not found in /);
          assert.match(msg, /npx puppeteer browsers install chrome/);
          // …and it names the OTHER managed browser too: `install chrome`
          // does not bring the headless shell, which the HF adapter needs
          // (and on Windows cannot work without).
          assert.match(msg, /npx puppeteer browsers install chrome-headless-shell/);
          return true;
        },
      );
    });
  });

  test('resolveChromeExecutable: returns the host build from the cache, then memoizes it', () => {
    let first = '';
    withFakeCache((root) => {
      const { dir, relExe } = hostBuild();
      makeBuild(root, dir, relExe);
      first = resolveChromeExecutable();
      assert.ok(slash(first).includes(`${dir}/`), first);
      assert.ok(existsSync(first));
    });
    // withFakeCache has now deleted the tree and restored the env; the
    // memoized value must still come back (hyperframes.ts:403 and
    // excalidraw.ts:580 call this repeatedly per render).
    assert.equal(resolveChromeExecutable(), first);
  });

  await testAsync(
    'resolveChromeExecutableAsync: resolves an on-disk binary or throws the documented error',
    async () => {
      // Runs against the real host cache (no PUPPETEER_CACHE_DIR override):
      // puppeteer.executablePath() reads its configuration at import time, so
      // a fake cache dir would not steer it. Either outcome is legitimate on
      // a box that may or may not have Chrome installed — what must hold is
      // that a returned path really exists (so puppeteer.launch() gets
      // something runnable) and that the failure carries the install hint.
      let resolved: string | null = null;
      let err: Error | null = null;
      try {
        resolved = await resolveChromeExecutableAsync();
      } catch (e) {
        err = e as Error;
      }
      if (resolved !== null) {
        assert.ok(existsSync(resolved), `async resolver returned a non-existent path: ${resolved}`);
      } else {
        assert.match(err!.message, /Pinned Chrome not available/);
        assert.match(err!.message, /npx puppeteer browsers install chrome/);
      }
    },
  );

  // ── chrome-headless-shell scan (WP-32 / g61) ────────────────────────────
  //
  // Why this exists at all: the HyperFrames CLI preflights the binary it is
  // handed with `<exe> --version` under a 5s timeout, and full Chrome on
  // Windows never answers that — hand-measured on the live box, the probe
  // dies with "signal SIGKILL, ETIMEDOUT" while the headless shell answers in
  // milliseconds. So the HF adapter needs the shell build, which lives in a
  // sibling cache tree with its own per-platform layout.
  test('scanCacheForHeadlessShell: finds a win64-* build at chrome-headless-shell-win64/chrome-headless-shell.exe', () => {
    withFakeCache((root) => {
      makeShellBuild(root, 'win64-152.0.7977.54', SHELL_WIN64_EXE);
      const found = scanCacheForHeadlessShell('win32', 'x64');
      assert.ok(found, 'expected a match for a win64-* headless-shell build');
      assert.ok(
        slash(found!).endsWith(
          'win64-152.0.7977.54/chrome-headless-shell-win64/chrome-headless-shell.exe',
        ),
        found!,
      );
    });
  });

  test('scanCacheForHeadlessShell: covers the win32 / linux / mac layouts too', () => {
    withFakeCache((root) => {
      makeShellBuild(root, 'win32-148.0.7778.167', SHELL_WIN32_EXE);
      assert.ok(slash(scanCacheForHeadlessShell('win32', 'ia32')!).endsWith(
        'chrome-headless-shell-win32/chrome-headless-shell.exe',
      ));
    });
    withFakeCache((root) => {
      makeShellBuild(root, 'linux-148.0.7778.167', SHELL_LINUX_EXE);
      assert.ok(slash(scanCacheForHeadlessShell('linux', 'x64')!).endsWith(
        'chrome-headless-shell-linux64/chrome-headless-shell',
      ));
    });
    withFakeCache((root) => {
      makeShellBuild(root, 'mac_arm-148.0.7778.167', SHELL_MAC_ARM_EXE);
      assert.ok(slash(scanCacheForHeadlessShell('darwin', 'arm64')!).endsWith(
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      ));
    });
    withFakeCache((root) => {
      makeShellBuild(root, 'mac-148.0.7778.167', SHELL_MAC_X64_EXE);
      assert.ok(slash(scanCacheForHeadlessShell('darwin', 'x64')!).endsWith(
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
      ));
    });
  });

  test('scanCacheForHeadlessShell: picks the newest build numerically (99 vs 100), like the chrome scan', () => {
    withFakeCache((root) => {
      makeShellBuild(root, 'win64-99.0.1.1', SHELL_WIN64_EXE);
      makeShellBuild(root, 'win64-100.0.1.1', SHELL_WIN64_EXE);
      assert.ok(slash(scanCacheForHeadlessShell('win32', 'x64')!).includes('win64-100.0.1.1/'));
    });
  });

  test('scanCacheForHeadlessShell: ignores a build for another OS (mac_arm tree on a win32 host)', () => {
    withFakeCache((root) => {
      makeShellBuild(root, 'mac_arm-152.0.7977.54', SHELL_MAC_ARM_EXE);
      assert.equal(scanCacheForHeadlessShell('win32', 'x64'), null);
    });
  });

  test('scanCacheForHeadlessShell: returns null on Linux ARM (puppeteer ships no shell build there) so the caller falls back to Chrome', () => {
    withFakeCache((root) => {
      // Even with a linux_arm-shaped dir present, that prefix is not in the
      // headless-shell table — there is no such build to install.
      makeShellBuild(root, 'linux_arm-152.0.7977.54', SHELL_LINUX_EXE);
      assert.equal(scanCacheForHeadlessShell('linux', 'arm64'), null);
    });
  });

  test('scanCacheForHeadlessShell: returns null when the chrome-headless-shell tree does not exist', () => {
    withFakeCache((root) => {
      makeBuild(root, 'win64-152.0.7977.54', WIN64_EXE); // only full Chrome installed
      assert.equal(scanCacheForHeadlessShell('win32', 'x64'), null);
    });
  });

  // ── the G24 one-version pin across the two renderer adapters ─────────────
  //
  // HF renders on the headless shell, Excalidraw captures on full Chrome. If
  // the shell scan just takes "newest", a cache whose newest shell build was
  // pruned (or whose install was interrupted) silently puts the two adapters
  // on two Chrome engines — and nothing in the render record says which.
  test('scanCacheForHeadlessShell: prefers the shell build matching the resolved Chrome buildId over a newer one', () => {
    withFakeCache((root) => {
      makeShellBuild(root, 'win64-148.0.7778.167', SHELL_WIN64_EXE);
      makeShellBuild(root, 'win64-152.0.7977.54', SHELL_WIN64_EXE); // newer
      const found = scanCacheForHeadlessShell('win32', 'x64', '148.0.7778.167');
      assert.ok(found);
      assert.ok(slash(found!).includes('win64-148.0.7778.167/'), found!);
    });
  });

  test('scanCacheForHeadlessShell: falls back to the newest shell build when the pinned buildId is not installed', () => {
    withFakeCache((root) => {
      makeShellBuild(root, 'win64-148.0.7778.167', SHELL_WIN64_EXE);
      makeShellBuild(root, 'win64-152.0.7977.54', SHELL_WIN64_EXE);
      const found = scanCacheForHeadlessShell('win32', 'x64', '999.0.0.1');
      assert.ok(found);
      assert.ok(slash(found!).includes('win64-152.0.7977.54/'), found!);
    });
  });

  test('scanCacheForHeadlessShell: the pin never outranks host-runnability (a foreign-OS match is still skipped)', () => {
    withFakeCache((root) => {
      makeShellBuild(root, 'mac_arm-148.0.7778.167', SHELL_MAC_ARM_EXE);
      assert.equal(scanCacheForHeadlessShell('win32', 'x64', '148.0.7778.167'), null);
    });
  });

  test('scanCacheForHeadlessShell: a pinned build dir whose executable is missing falls through to a real one', () => {
    withFakeCache((root) => {
      mkdirSync(join(root, 'chrome-headless-shell', 'win64-148.0.7778.167'), { recursive: true });
      makeShellBuild(root, 'win64-152.0.7977.54', SHELL_WIN64_EXE);
      const found = scanCacheForHeadlessShell('win32', 'x64', '148.0.7778.167');
      assert.ok(found);
      assert.ok(slash(found!).includes('win64-152.0.7977.54/'), found!);
    });
  });

  test('buildIdFromInstallPath: reads the buildId out of an installed-browser path, or undefined', () => {
    assert.equal(
      buildIdFromInstallPath('/home/u/.cache/puppeteer/chrome/linux-152.0.7977.54/chrome-linux64/chrome'),
      '152.0.7977.54',
    );
    assert.equal(
      buildIdFromInstallPath(
        'C:\\c\\puppeteer\\chrome-headless-shell\\win64-148.0.7778.167\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
      ),
      '148.0.7778.167',
    );
    // A cache root that itself looks like a build dir must not shadow the real
    // one (scanned back-to-front).
    assert.equal(
      buildIdFromInstallPath('/builds/win64-1.2.3.4/cache/chrome/win64-152.0.7977.54/chrome-win64/chrome.exe'),
      '152.0.7977.54',
    );
    assert.equal(buildIdFromInstallPath('/usr/bin/chromium'), undefined);
    assert.equal(buildIdFromInstallPath(null), undefined);
  });

  test('resolveHeadlessShellExecutable: a miss is not memoized, the chrome buildId is pinned, a hit is memoized', () => {
    // This resolver reads the real host platform, so seed the host's own
    // layout. On Linux ARM there is no shell build by construction — null is
    // the correct, non-throwing answer there.
    const linuxArm =
      process.platform === 'linux' && (process.arch === 'arm64' || process.arch === 'arm');
    /** The host's shell-build dir prefix + relative exe, or null on Linux ARM. */
    const hostShell = (version: string): { dir: string; relExe: string } | null => {
      switch (process.platform) {
        case 'win32':
          return process.arch === 'ia32'
            ? { dir: `win32-${version}`, relExe: SHELL_WIN32_EXE }
            : { dir: `win64-${version}`, relExe: SHELL_WIN64_EXE };
        case 'darwin':
          return process.arch === 'arm64'
            ? { dir: `mac_arm-${version}`, relExe: SHELL_MAC_ARM_EXE }
            : { dir: `mac-${version}`, relExe: SHELL_MAC_X64_EXE };
        case 'linux':
          return linuxArm ? null : { dir: `linux-${version}`, relExe: SHELL_LINUX_EXE };
        default:
          return { dir: `linux-${version}`, relExe: SHELL_LINUX_EXE };
      }
    };

    // ── 1. nothing installed → null, and that null must NOT stick ──────────
    // The old code memoized the miss, so an operator who ran
    // `npx puppeteer browsers install chrome-headless-shell` after a failed
    // render kept getting the stale answer until the sidecar restarted.
    withFakeCache(() => {
      assert.equal(resolveHeadlessShellExecutable(), null, 'expected a miss on an empty cache');
    });

    // ── 2. now installed → picked up with no restart, and pinned to the
    //       buildId resolveChromeExecutable() already memoized above
    //       (hostBuild()'s 152.0.7977.54), not merely the newest shell build.
    let first: string | null = null;
    withFakeCache((root) => {
      const pinned = hostShell('152.0.7977.54');
      const newer = hostShell('999.0.0.1');
      if (pinned) makeShellBuild(root, pinned.dir, pinned.relExe);
      if (newer) makeShellBuild(root, newer.dir, newer.relExe);
      first = resolveHeadlessShellExecutable();
      if (pinned) {
        assert.ok(first, 'a shell build installed after the first miss must be found');
        assert.ok(existsSync(first!));
        assert.ok(
          slash(first!).includes(`${pinned.dir}/`),
          `expected the Chrome-matching build ${pinned.dir}, got ${first}`,
        );
      } else {
        assert.equal(first, null);
      }
    });
    // ── 3. a HIT is memoized (the adapter calls this once per render) ───────
    assert.equal(resolveHeadlessShellExecutable(), first);
  });

  console.log(`\n${passed} passed`);
  return 0;
}

process.exit(await main());
