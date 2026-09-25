// com.ikenga.studio project sidecar · hyperframes.ts adapter (WP-32 / g61)
//
//   bun run src/renderers/hyperframes.test.ts   (from sidecars/project/)
//   bun run test                                 (package script — runs this + the others)
//
// Plain assert-based script (no bun:test / node:test import) — same rationale
// as blender.test.ts / chrome.test.ts / registry.test.ts: typechecks under the
// shared `tsc -p ../../tsconfig.json` project (no Bun types) while running for
// real under the bun runtime.
//
// ── What the live round found (plans/studio/verify/2026-09-12-wp32-live/g61) ──
// 8/8 HyperFrames renders failed with a queue row that said literally nothing:
//   err = "[hyperframes] render failed (exit 1):\n"
// Three separable defects, each covered below, none of which needs a real HF
// install to test because the spawn shape (argv, env, options) and the failure
// message are now built by exported pure functions:
//
//  1. the Chrome path went out as PUPPETEER_EXECUTABLE_PATH, which the HF CLI
//     never reads (verified against the installed hyperframes 0.8.35:
//     `grep -o 'PUPPETEER_[A-Z_]*' dist/cli.js` → only PUPPETEER_CACHE_DIR and
//     the protocol timeouts; its resolver is ensureBrowser() → findFromEnv(),
//     which reads HYPERFRAMES_BROWSER_PATH / PRODUCER_HEADLESS_SHELL_PATH).
//     HF therefore used its own broken ~/.cache/hyperframes install and exited 1.
//  2. even with the right variable, full Chrome on Windows fails HF's
//     `<exe> --version` preflight (hand-run: "Browser: env" then "Chrome
//     cannot start … signal SIGKILL, ETIMEDOUT"), so the adapter must prefer
//     puppeteer's chrome-headless-shell build. Hand-verified: same argv +
//     HYPERFRAMES_BROWSER_PATH=<headless shell> → exit 0, 90 frames, 375 KB MP4.
//  3. the queue row was assembled from the stderr tail alone *and* the child's
//     pipes delivered nothing at all (Bun on Windows drops both pipes when
//     `detached: true`; measured: same spawn with detached:false captures the
//     version string, with detached:true captures zero bytes). So the message
//     now carries stdout AND stderr, and says so explicitly when a child
//     produced no output — a blind row is the one outcome that must not recur.

import assert from 'node:assert/strict';

import {
  buildHyperframesArgv,
  buildHyperframesEnv,
  buildHyperframesSpawnOptions,
  buildRenderFailureMessage,
  resolveHyperframesBrowser,
  type HyperframesBrowser,
} from './hyperframes.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const SHELL = 'C:\\cache\\puppeteer\\chrome-headless-shell\\win64-152\\chrome-headless-shell.exe';
const CHROME = 'C:\\cache\\puppeteer\\chrome\\win64-152\\chrome-win64\\chrome.exe';

function main(): number {
  // ── 1. browser resolution ───────────────────────────────────────────────
  test('resolveHyperframesBrowser: prefers the headless shell over full Chrome', () => {
    const b = resolveHyperframesBrowser({
      env: {},
      exists: () => true,
      headlessShell: () => SHELL,
      chrome: () => CHROME,
    });
    assert.deepEqual(b, { path: SHELL, source: 'headless-shell' });
  });

  test('resolveHyperframesBrowser: falls back to full Chrome on POSIX when no shell build is installed', () => {
    // On Linux/macOS HF's `<exe> --version` preflight passes against full
    // Chrome, so the fallback is a real one.
    for (const platform of ['linux', 'darwin'] as const) {
      const b = resolveHyperframesBrowser({
        env: {},
        exists: () => true,
        headlessShell: () => null,
        chrome: () => CHROME,
        platform,
      });
      assert.deepEqual(b, { path: CHROME, source: 'chrome' }, platform);
    }
  });

  test('resolveHyperframesBrowser: on win32 a missing shell build THROWS instead of returning full Chrome', () => {
    // The g61 failure reproduced by its own fix: full Chrome on Windows never
    // answers HF's `<exe> --version` preflight, so handing it back produces a
    // ~15 s ETIMEDOUT render failure with no diagnostic. Fail fast instead,
    // and name the browser that actually works.
    let called = false;
    assert.throws(
      () =>
        resolveHyperframesBrowser({
          env: {},
          exists: () => true,
          headlessShell: () => null,
          chrome: () => {
            called = true;
            return CHROME;
          },
          platform: 'win32',
        }),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /chrome-headless-shell not found/);
        assert.match(msg, /npx puppeteer browsers install chrome-headless-shell/);
        // …and it must NOT be the "install chrome" hint, which is the wrong
        // browser for this failure.
        assert.equal(
          /browsers install chrome(?![-\w])/.test(msg),
          false,
          `hint points at full Chrome: ${msg}`,
        );
        return true;
      },
    );
    assert.equal(called, false, 'the Chrome resolver must not even be consulted on win32');
  });

  test('resolveHyperframesBrowser: on win32 an installed shell build is still used (no throw)', () => {
    const b = resolveHyperframesBrowser({
      env: {},
      exists: () => true,
      headlessShell: () => SHELL,
      chrome: () => CHROME,
      platform: 'win32',
    });
    assert.deepEqual(b, { path: SHELL, source: 'headless-shell' });
  });

  test('resolveHyperframesBrowser: on win32 an operator override still wins over the throw', () => {
    const b = resolveHyperframesBrowser({
      env: { HYPERFRAMES_BROWSER_PATH: 'C:\\chromium\\chrome.exe' },
      exists: (p) => p === 'C:\\chromium\\chrome.exe',
      headlessShell: () => null,
      chrome: () => CHROME,
      platform: 'win32',
    });
    assert.deepEqual(b, { path: 'C:\\chromium\\chrome.exe', source: 'env' });
  });

  test('resolveHyperframesBrowser: an operator HYPERFRAMES_BROWSER_PATH that exists wins over both', () => {
    const b = resolveHyperframesBrowser({
      env: { HYPERFRAMES_BROWSER_PATH: '/opt/chromium' },
      exists: (p) => p === '/opt/chromium',
      headlessShell: () => SHELL,
      chrome: () => CHROME,
    });
    assert.deepEqual(b, { path: '/opt/chromium', source: 'env' });
  });

  test('resolveHyperframesBrowser: a stale HYPERFRAMES_BROWSER_PATH (not on disk) is ignored, not passed through', () => {
    // HF hard-errors on a non-existent env path ("Chrome binary not found at
    // HYPERFRAMES_BROWSER_PATH=…"), so honouring a dead override would trade a
    // working render for a failure.
    const b = resolveHyperframesBrowser({
      env: { HYPERFRAMES_BROWSER_PATH: '/gone/chromium' },
      exists: () => false,
      headlessShell: () => SHELL,
      chrome: () => CHROME,
    });
    assert.deepEqual(b, { path: SHELL, source: 'headless-shell' });
  });

  test('resolveHyperframesBrowser: propagates the chrome resolver throw when nothing at all is installed (POSIX)', () => {
    assert.throws(
      () =>
        resolveHyperframesBrowser({
          env: {},
          exists: () => false,
          headlessShell: () => null,
          chrome: () => {
            throw new Error('Pinned Chrome not found in /cache/chrome.');
          },
          platform: 'linux',
        }),
      /Pinned Chrome not found/,
    );
  });

  // ── 2. env construction — the actual live-found defect ──────────────────
  test('buildHyperframesEnv: sets HYPERFRAMES_BROWSER_PATH (the variable the HF CLI reads)', () => {
    const env = buildHyperframesEnv({ PATH: '/usr/bin' }, { path: SHELL, source: 'headless-shell' });
    assert.equal(env.HYPERFRAMES_BROWSER_PATH, SHELL);
  });

  test('buildHyperframesEnv: still sets PUPPETEER_EXECUTABLE_PATH to the same binary, and keeps PUPPETEER_SKIP_DOWNLOAD', () => {
    const env = buildHyperframesEnv({ PATH: '/usr/bin' }, { path: SHELL, source: 'headless-shell' });
    assert.equal(env.PUPPETEER_EXECUTABLE_PATH, SHELL);
    assert.equal(env.PUPPETEER_SKIP_DOWNLOAD, 'true');
  });

  test('buildHyperframesEnv: inherits the base env rather than replacing it', () => {
    const env = buildHyperframesEnv(
      { PATH: '/usr/bin', HOME: '/home/x' },
      { path: CHROME, source: 'chrome' },
    );
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/x');
  });

  test('buildHyperframesEnv: DELETES an inherited PRODUCER_HEADLESS_SHELL_PATH (HF\'s other resolver reads it first)', () => {
    // hyperframes 0.8.35's BrowserManager checks PRODUCER_HEADLESS_SHELL_PATH
    // BEFORE HYPERFRAMES_BROWSER_PATH and hard-throws when the path is gone,
    // so an inherited leftover would decide the browser for some HF code
    // paths — or kill the render outright.
    const env = buildHyperframesEnv(
      { PATH: '/usr/bin', PRODUCER_HEADLESS_SHELL_PATH: '/gone/headless-shell' },
      { path: SHELL, source: 'headless-shell' },
    );
    assert.equal('PRODUCER_HEADLESS_SHELL_PATH' in env, false, JSON.stringify(env));
    assert.equal(env.HYPERFRAMES_BROWSER_PATH, SHELL);
    assert.equal(env.PATH, '/usr/bin');
  });

  test('buildHyperframesEnv: does not mutate the base env it was handed', () => {
    const base: NodeJS.ProcessEnv = { PRODUCER_HEADLESS_SHELL_PATH: '/x' };
    buildHyperframesEnv(base, { path: SHELL, source: 'headless-shell' });
    assert.equal(base.PRODUCER_HEADLESS_SHELL_PATH, '/x');
  });

  test('buildHyperframesEnv: overrides a pre-existing HYPERFRAMES_BROWSER_PATH with the resolved one', () => {
    // resolveHyperframesBrowser already decided whether to honour an override;
    // whatever it returned is what the child must see, with no second voice.
    const env = buildHyperframesEnv(
      { HYPERFRAMES_BROWSER_PATH: '/stale/path' },
      { path: SHELL, source: 'headless-shell' },
    );
    assert.equal(env.HYPERFRAMES_BROWSER_PATH, SHELL);
  });

  // ── argv construction ───────────────────────────────────────────────────
  test('buildHyperframesArgv: the canonical form — no -c when the entry is index.html', () => {
    const argv = buildHyperframesArgv({
      projectDir: '/proj/cells/hifi/c1',
      outPath: '/proj/renders/hyperframes/2_hifi/c1.mp4',
      preset: 'landscape',
    });
    assert.deepEqual(argv, [
      '--yes',
      'hyperframes',
      'render',
      '/proj/cells/hifi/c1',
      '-o',
      '/proj/renders/hyperframes/2_hifi/c1.mp4',
      '--resolution',
      'landscape',
      '--fps',
      '30',
    ]);
  });

  test('buildHyperframesArgv: passes -c <basename> for a non-index entry, before -o', () => {
    const argv = buildHyperframesArgv({
      projectDir: '/proj/cells/hifi/c1',
      compositionFile: 'shot.html',
      outPath: '/out.mp4',
      preset: 'portrait',
      fps: 24,
    });
    assert.deepEqual(argv.slice(3, 7), ['/proj/cells/hifi/c1', '-c', 'shot.html', '-o']);
    assert.deepEqual(argv.slice(-4), ['--resolution', 'portrait', '--fps', '24']);
  });

  test('buildHyperframesArgv: never passes --quiet (it would kill the progress lines) or a browser flag', () => {
    const argv = buildHyperframesArgv({
      projectDir: '/d',
      outPath: '/o.mp4',
      preset: 'square',
    });
    assert.equal(argv.includes('--quiet'), false);
    // `render` has no --browser-path / --chrome-path (those exist only on
    // preview/open/studio in hyperframes 0.8.35) — the browser goes via env.
    assert.equal(
      argv.some((a) => a.startsWith('--browser') || a.startsWith('--chrome')),
      false,
    );
  });

  // ── 3. spawn options: detached only where it means something ────────────
  test('buildHyperframesSpawnOptions: detaches on POSIX (killTree signals the process group)', () => {
    assert.deepEqual(buildHyperframesSpawnOptions('linux'), { detached: true, windowsHide: true });
    assert.deepEqual(buildHyperframesSpawnOptions('darwin'), { detached: true, windowsHide: true });
  });

  test('buildHyperframesSpawnOptions: does NOT detach on win32 (no process groups; Bun drops the pipes)', () => {
    assert.deepEqual(buildHyperframesSpawnOptions('win32'), { detached: false, windowsHide: true });
  });

  // ── 3. failure-message assembly ─────────────────────────────────────────
  const ARGV = buildHyperframesArgv({
    projectDir: '/proj/cells/hifi/c1',
    outPath: '/out.mp4',
    preset: 'landscape',
  });
  const BROWSER: HyperframesBrowser = { path: SHELL, source: 'headless-shell' };

  test('buildRenderFailureMessage: includes the stdout tail — the stream HF actually prints failures on', () => {
    const msg = buildRenderFailureMessage({
      exitCode: 1,
      stdoutTail: ['◇  Browser: cache', '✗  Chrome cannot start', 'Failed to run "C:\\...\\chrome-headless-shell.exe" --version (exit code 3221225595).'],
      stderrTail: [],
      argv: ARGV,
      browser: BROWSER,
    });
    assert.match(msg, /^\[hyperframes\] render failed \(exit 1\):/);
    assert.match(msg, /--- stdout \(last 3 lines\) ---/);
    assert.match(msg, /Chrome cannot start/);
    assert.match(msg, /3221225595/);
  });

  test('buildRenderFailureMessage: labels stdout and stderr separately when both spoke', () => {
    const msg = buildRenderFailureMessage({
      exitCode: 2,
      stdoutTail: ['out-line'],
      stderrTail: ['err-line'],
      argv: ARGV,
      browser: BROWSER,
    });
    assert.ok(msg.indexOf('--- stdout') < msg.indexOf('--- stderr'), msg);
    assert.match(msg, /out-line/);
    assert.match(msg, /err-line/);
  });

  test('buildRenderFailureMessage: a silent child says so, and names the command + browser', () => {
    // The exact live symptom: exit 1, both tails empty. The old message ended
    // at the colon and told the operator nothing.
    const msg = buildRenderFailureMessage({
      exitCode: 1,
      stdoutTail: [],
      stderrTail: [],
      argv: ARGV,
      browser: BROWSER,
    });
    assert.match(msg, /no output captured on stdout or stderr/);
    assert.match(msg, /command: npx --yes hyperframes render \/proj\/cells\/hifi\/c1/);
    assert.match(msg, /browser: headless-shell/);
    assert.ok(msg.trim() !== '[hyperframes] render failed (exit 1):', 'must never be the bare headline');
  });

  test('buildRenderFailureMessage: a spawn failure (no exit code) is labelled spawn-error', () => {
    const msg = buildRenderFailureMessage({
      exitCode: null,
      stdoutTail: [],
      stderrTail: [],
      argv: ARGV,
    });
    assert.match(msg, /render failed \(exit spawn-error\):/);
  });

  test('buildRenderFailureMessage: caps each tail at 20 lines', () => {
    const many = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    const msg = buildRenderFailureMessage({
      exitCode: 1,
      stdoutTail: many,
      stderrTail: [],
      argv: ARGV,
    });
    assert.match(msg, /--- stdout \(last 20 lines\) ---/);
    assert.equal(msg.includes('line-39'), false, 'expected only the last 20 lines');
    assert.match(msg, /line-59/);
  });

  test('buildRenderFailureMessage: caps the whole message so a chatty failure cannot bloat the queue row', () => {
    const fat = Array.from({ length: 20 }, () => 'x'.repeat(1000));
    const msg = buildRenderFailureMessage({
      exitCode: 1,
      stdoutTail: fat,
      stderrTail: fat,
      argv: ARGV,
    });
    assert.ok(msg.length <= 4000 + '\n…(truncated)'.length, `message was ${msg.length} chars`);
    assert.match(msg, /…\(truncated\)$/);
  });

  test('buildRenderFailureMessage: the command + browser context SURVIVES truncation (it precedes the tails)', () => {
    // With the context appended after the tails, a chatty failure (40 × ~1000
    // chars here, and 40 × ~100 chars is already over the cap) truncated away
    // exactly the two fields g61 added, leaving a row that still could not say
    // which binary HF was handed.
    const fat = Array.from({ length: 20 }, () => 'x'.repeat(1000));
    const msg = buildRenderFailureMessage({
      exitCode: 1,
      stdoutTail: fat,
      stderrTail: fat,
      argv: ARGV,
      browser: BROWSER,
    });
    assert.match(msg, /…\(truncated\)$/, 'expected this case to actually truncate');
    assert.match(msg, /command: npx --yes hyperframes render \/proj\/cells\/hifi\/c1/);
    assert.match(msg, new RegExp(`browser: headless-shell ${SHELL.replace(/\\/g, '\\\\')}`));
    // …and the headline is still the first line.
    assert.match(msg, /^\[hyperframes\] render failed \(exit 1\):/);
  });

  test('buildRenderFailureMessage: the exit-0-but-no-output case keeps its own headline and still carries the tails', () => {
    const msg = buildRenderFailureMessage({
      exitCode: 0,
      stdoutTail: ['Render complete'],
      stderrTail: [],
      argv: ARGV,
      browser: BROWSER,
      headline: '[hyperframes] render exited 0 but output not found at /out.mp4',
    });
    assert.match(msg, /^\[hyperframes\] render exited 0 but output not found at \/out\.mp4/);
    assert.match(msg, /Render complete/);
  });

  console.log(`\n${passed} passed`);
  return 0;
}

process.exit(main());
