/**
 * HyperFrames renderer adapter (WP-05).
 *
 * First concrete `RendererAdapter` for com.ikenga.studio. Spawns the
 * `hyperframes` CLI (`npx hyperframes render`) against the project root,
 * pointing at the cell's HTML composition via `--composition=…`.
 *
 * G24 — Chrome version pin. We thread the resolved binary (from `./chrome.ts`)
 * onto the spawned child so HF picks up our pinned browser instead of using
 * its own cache. The Excalidraw adapter (WP-05b) shares the same resolver.
 *
 * ─── WP-32 live-found fixes (g61, 2026-09-12) ─────────────────────────────
 *
 * Three separate defects made 8/8 live HF renders fail with an error row that
 * said nothing at all (`[hyperframes] render failed (exit 1):` + empty tail):
 *
 * 1. **Wrong env var.** We passed the path as `PUPPETEER_EXECUTABLE_PATH`,
 *    which the HF CLI never reads (`grep -o 'PUPPETEER_[A-Z_]*' dist/cli.js`
 *    on hyperframes 0.8.35 yields only PUPPETEER_CACHE_DIR / the protocol
 *    timeouts). Its browser resolution is `ensureBrowser()` →
 *    `findFromEnv()`, which reads **`HYPERFRAMES_BROWSER_PATH`** (or
 *    `PRODUCER_HEADLESS_SHELL_PATH`) first and otherwise falls back to its own
 *    `~/.cache/hyperframes/chrome/…` install — which on the live box was a
 *    broken extraction (`STATUS_DLL_NOT_FOUND`, 0xC0000135). Hence exit 1.
 *    There is no `--browser-path` flag on `render` (that flag exists only on
 *    `preview`/`open`/`studio`), so the env var is the only seam.
 * 2. **Wrong binary for the env var.** HF preflights whatever path it is given
 *    with `<exe> --version` under a 5s timeout. Full Chrome on Windows never
 *    answers that on stdout, so pointing HF at `chrome.exe` swaps one failure
 *    ("Browser: cache" → DLL error) for another ("Browser: env" → signal
 *    SIGKILL, ETIMEDOUT). We therefore prefer puppeteer's
 *    `chrome-headless-shell` build (which answers `--version` instantly), and
 *    on win32 we REFUSE the full-Chrome fallback: handing Chrome to HF there
 *    *is* the g61 failure, so a missing shell build throws fast with an
 *    install hint for the right browser. POSIX, where the preflight passes,
 *    keeps the fallback. Hand-verified: the same argv + `HYPERFRAMES_BROWSER_PATH=<headless
 *    shell>` renders the live fixture cell to a 375 KB / 90-frame MP4, exit 0.
 * 3. **A blind error row.** `detached: true` + piped stdio loses BOTH pipes
 *    under Bun on Windows (measured: `spawn('npx', …, {detached:true})`
 *    captures zero bytes and reports exit 0; the identical spawn with
 *    `detached:false` captures `0.8.35`), so no HF output ever reached the
 *    queue row. `detached` was only ever there for `process.kill(-pid)`, which
 *    is POSIX-only and always threw on win32 anyway — so we detach on POSIX
 *    only and reap the Windows tree with `taskkill /T /F`. The failure message
 *    now also carries stdout AND stderr tails separately, and says so
 *    explicitly when a child produced no output at all.
 *
 * G1 — aspect-ratio threading. HF's `--resolution` flag is preset-based
 * (landscape/portrait/square), not arbitrary W×H. We map the project's
 * resolved aspect ratio (RenderOptions.aspect_ratio ?? ctx.aspectRatio)
 * to the corresponding preset. The resulting MP4 dimensions match
 * DEFAULT_RESOLUTION for each aspect. (HF's `--resolution` cannot honour
 * a non-default override of `{w,h}` for the same aspect — see deviations
 * below.)
 *
 * G14 — output path. Lands at
 * `<rendersDir>/hyperframes/<rungDir(cell.rung)>/<uid>.mp4`. We call the
 * `rungDir()` schema helper rather than slicing the enum.
 *
 * G3 — engine_version. Cached from `npx hyperframes --version` on first
 * use; written into every emitted RenderRecord.
 *
 * ─── Deviations from the WP-05 brief ──────────────────────────────────
 *
 * 1. HF takes a composition-project DIR (verified against hyperframes
 *    0.6.36) and HARD-REQUIRES an `index.html` entry inside it — it refuses
 *    to start ("No index.html file found") otherwise. It does NOT accept a
 *    direct path to an arbitrary HTML file. So we point HF's DIR at the
 *    *cell's own directory* (`dirname(content_path)`, i.e.
 *    `cells/<rungDir>/<uid>/`) and rely on the cell entry being
 *    `index.html`. If the cell's entry has a non-index basename we still
 *    pass `-c <basename>`, but HF needs an `index.html` present regardless;
 *    the studio cell scaffolding (WP-07/WP-11) writes the cell HTML as
 *    `index.html`. The brief's `npx hyperframes render
 *    <projectRoot>/<cell.content_path>` form is not how the CLI works.
 *
 * 2. HF has no `--duration` flag. Composition duration is baked into the
 *    HTML via `data-composition-duration` (or computed from the longest
 *    animation). We DO NOT pass `--duration` (it would be ignored or
 *    rejected). `cell.duration_ms` is recorded on the RenderRecord
 *    metadata for traceability; the adapter does NOT attempt to override
 *    composition duration from outside the HTML.
 *
 * 3. HF has no `--width`/`--height` flags. Output framing is set via
 *    `--resolution=<preset>` (landscape, portrait, square, plus 4k
 *    variants). We map `16:9 → landscape`, `9:16 → portrait`,
 *    `1:1 → square`. An arbitrary `opts.resolution: {w:1280,h:720}` for
 *    aspect `16:9` can only land at the preset's 1920×1080 — we record
 *    the requested vs actual resolution on the RenderRecord metadata so
 *    consumers can detect the clamp. A future deviation might shell out
 *    to FFmpeg for a post-render scale.
 *
 * ─── Progress parsing ─────────────────────────────────────────────────
 *
 * HF (0.6.36) emits `Capturing frame N/M (W workers)` lines plus an
 * ANSI percent bar (`██░░  25%  Starting frame capture`) on stdout/stderr.
 * The bar updates via `\r`, not `\n`, so we split the byte stream on EITHER
 * and strip ANSI escapes before parsing. `Capturing frame N/M` gives an
 * exact total (preferred); the percent bar is a coarse fallback. We compute
 * `progress = currentFrame / total`, falling back to
 * `total = floor(cell.duration_ms / 1000 * fps)` (fps=30, HF's default)
 * when the capture line hasn't appeared yet. If `cell.duration_ms === 0`
 * AND no `N/M` line has arrived, `progress` is emitted as `null`
 * (indeterminate). We also accept FFmpeg-style `frame=NNN` lines if HF
 * surfaces the encoder output. NOTE: we deliberately do NOT pass `--quiet`,
 * which would suppress these progress lines.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  rungDir,
  DEFAULT_RESOLUTION,
  type AspectRatio,
  type Cell,
  type RenderRecord,
} from '@ikenga/studio-schema';

import {
  buildIdFromInstallPath,
  HEADLESS_SHELL_INSTALL_HINT,
  headlessShellCacheDir,
  resolveChromeExecutable,
  resolveHeadlessShellExecutable,
} from './chrome.js';
import { clearRenderPid, recordRenderPid } from '../queue.js';
import type {
  Diagnostic,
  PreviewURL,
  RenderContext,
  RenderOptions,
  RendererAdapter,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const HF_DEFAULT_FPS = 30;

const ASPECT_TO_HF_PRESET: Record<AspectRatio, 'landscape' | 'portrait' | 'square'> = {
  '16:9': 'landscape',
  '9:16': 'portrait',
  '1:1': 'square',
};

// Children we've spawned, keyed by recordId, so cancel(recordId) can find them.
const activeChildren = new Map<string, ChildProcess>();

// engine_version is cached after first lookup — `npx hyperframes --version`
// costs ~500ms cold and shouldn't run per-render.
let cachedEngineVersion: string | null = null;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Terminate a child and its entire process tree.
 *
 * POSIX: the child is spawned `detached`, so it leads its own process group
 * and killing the *negative* PID reaps the whole group (npx + hyperframes +
 * chrome + ffmpeg) — SIGTERM first, then SIGKILL after a short grace window
 * so a wedged HF/chrome can't linger. A plain `child.kill()` would not reach
 * the grandchildren.
 *
 * win32: there are no process groups to signal — `process.kill(-pid, …)` has
 * always thrown here and silently degraded to killing only the `npx` wrapper,
 * orphaning chrome/ffmpeg. `taskkill /T /F` is the platform's actual
 * whole-tree kill, so we use it (and the child is NOT spawned detached on
 * win32 — see the file header, defect 3).
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (process.platform === 'win32') {
    if (pid !== undefined) {
      try {
        // Fire-and-forget: `/T` includes descendants, `/F` is force.
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        }).on('error', () => {
          /* taskkill missing (unlikely) — fall through to the handle kill */
        });
      } catch {
        // fall through
      }
    }
    try {
      if (!child.killed) child.kill();
    } catch {
      // already exited
    }
    return;
  }
  const signalGroup = (sig: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, sig); // negative pid → process group
    } catch {
      // group already gone, or we're not the group leader — fall back to the
      // direct child handle.
      try {
        if (!child.killed) child.kill(sig);
      } catch {
        // already exited
      }
    }
  };
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), 1200);
}

/** Spawn `npx hyperframes --version` once; cache the trimmed output. */
async function detectEngineVersion(): Promise<string> {
  if (cachedEngineVersion !== null) return cachedEngineVersion;
  return new Promise<string>((resolveExit) => {
    const child = spawn('npx', ['--yes', 'hyperframes', '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('error', () => {
      cachedEngineVersion = 'unknown';
      resolveExit('unknown');
    });
    child.on('close', () => {
      // Output may be just "0.6.36\n" or "hyperframes v0.6.36 …"; extract the
      // first semver-shaped token.
      const m = out.match(/(\d+\.\d+\.\d+[\w.-]*)/);
      cachedEngineVersion = m ? m[1] : out.trim() || 'unknown';
      resolveExit(cachedEngineVersion);
    });
  });
}

/** Resolve a unique output path under `rendersDir/hyperframes/<rungDir>/`. */
function resolveOutputPath(cell: Cell, ctx: RenderContext): string {
  const dir = join(ctx.rendersDir, 'hyperframes', rungDir(cell.rung));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const base = join(dir, `${cell.uid}.mp4`);
  if (!existsSync(base)) return base;
  // Collision — append a short UUID suffix.
  const suffix = randomUUID().slice(0, 8);
  return join(dir, `${cell.uid}.${suffix}.mp4`);
}

function resolveAspect(opts: RenderOptions, ctx: RenderContext): AspectRatio {
  return opts.aspect_ratio ?? ctx.aspectRatio;
}

/** Aspect declared by the composition HTML itself (`data-width`/`data-height`
 *  per the HF 0.6.36 contract). A portrait-authored cell in a 16:9 project
 *  must render portrait or HF aborts with a framing error — the schema has no
 *  per-cell aspect, so the content is the only authority. An explicit
 *  `opts.aspect_ratio` per-call override still wins. */
function contentDeclaredAspect(contentPath: string): AspectRatio | undefined {
  try {
    const html = readFileSync(contentPath, 'utf8');
    const w = Number(/data-width="(\d+)"/.exec(html)?.[1]);
    const h = Number(/data-height="(\d+)"/.exec(html)?.[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
    if (w === h) return '1:1';
    return h > w ? '9:16' : '16:9';
  } catch {
    return undefined;
  }
}

function resolveResolution(
  opts: RenderOptions,
  ctx: RenderContext,
  aspect: AspectRatio,
): { w: number; h: number } {
  return opts.resolution ?? ctx.resolution ?? DEFAULT_RESOLUTION[aspect];
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Resolve a cell's absolute content path. `cell.content_path` is relative
 * to `ctx.projectRoot` per the schema convention.
 */
function absContentPath(cell: Cell, ctx: RenderContext): string {
  return isAbsolute(cell.content_path)
    ? cell.content_path
    : resolve(ctx.projectRoot, cell.content_path);
}

/**
 * Parse HF stderr/stdout lines for progress. Returns `null` if the line
 * carries no progress signal.
 *
 * HF (0.6.x) emits, in order of usefulness:
 *   • `Capturing frame 30/90 (3 workers)` — frame N of M (most reliable;
 *     gives us an exact total independent of cell.duration_ms).
 *   • a percent bar: `██████░░░  25%  Starting frame capture` — coarse
 *     fallback, expressed as a normalized 0..1.
 *   • FFmpeg-style `frame=  123` lines if HF surfaces the encoder output.
 *
 * Returns either `{ frame, total }` (frame-count form), or `{ pct }`
 * (percent-bar form), so the caller can prefer the precise signal.
 */
function parseProgressLine(
  line: string,
): { frame: number; total: number | null } | { pct: number } | null {
  // "Capturing frame 30/90 (…)" — HF's canonical capture-phase line.
  const cap = line.match(/Capturing\s+frame\s+(\d+)\s*\/\s*(\d+)/i);
  if (cap) return { frame: Number(cap[1]), total: Number(cap[2]) };
  // Generic "Rendering frame 12/300".
  const m1 = line.match(/Rendering\s+frame\s+(\d+)\s*\/\s*(\d+)/i);
  if (m1) return { frame: Number(m1[1]), total: Number(m1[2]) };
  // FFmpeg-style "frame=  123".
  const m2 = line.match(/(?:^|\s)frame\s*=\s*(\d+)/);
  if (m2) return { frame: Number(m2[1]), total: null };
  // Percent bar: "…  25%  Starting frame capture".
  const pct = line.match(/(\d{1,3})%\s/);
  if (pct) {
    const v = Number(pct[1]);
    if (v >= 0 && v <= 100) return { pct: v / 100 };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Spawn shape — extracted so the argv / env / failure-message construction
// is testable without a HyperFrames install (same pattern as blender.ts's
// buildRenderArgs). See the WP-32 notes in the file header for why each of
// these looks the way it does.
// ─────────────────────────────────────────────────────────────────────────

/** Which binary we handed HF, and how we chose it (for diagnostics). */
export interface HyperframesBrowser {
  path: string;
  source: 'env' | 'headless-shell' | 'chrome';
}

/**
 * Pick the browser to hand HyperFrames.
 *
 * Order: an operator-set `HYPERFRAMES_BROWSER_PATH` that exists on disk wins
 * (never override a deliberate override), then puppeteer's pinned
 * `chrome-headless-shell`, then — on POSIX only — puppeteer's pinned full
 * Chrome.
 *
 * On **win32 there is no Chrome fallback**: full Chrome cannot answer HF's
 * `<exe> --version` preflight there, so returning it would hand back a binary
 * that is *known* to reproduce the g61 failure (exit 1, "Chrome cannot start …
 * signal SIGKILL, ETIMEDOUT") after a ~15 s wait, with an install hint
 * pointing at the wrong browser. A fail-fast throw naming
 * `chrome-headless-shell` is strictly more useful than a render that cannot
 * work. On POSIX the preflight passes and the fallback is real, so it stays.
 *
 * `env`/`exists`/`platform` are injectable so tests can drive every branch
 * from one box without touching the real cache.
 */
export function resolveHyperframesBrowser(deps: {
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  headlessShell?: () => string | null;
  chrome?: () => string;
  platform?: NodeJS.Platform;
} = {}): HyperframesBrowser {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const headlessShell = deps.headlessShell ?? resolveHeadlessShellExecutable;
  const chrome = deps.chrome ?? resolveChromeExecutable;
  const platform = deps.platform ?? process.platform;

  const override = env.HYPERFRAMES_BROWSER_PATH;
  if (override && exists(override)) return { path: override, source: 'env' };

  const shell = headlessShell();
  if (shell) return { path: shell, source: 'headless-shell' };

  if (platform === 'win32') {
    throw new Error(
      'chrome-headless-shell not found in ' +
        `${headlessShellCacheDir()}. ${HEADLESS_SHELL_INSTALL_HINT} ` +
        '(Installing full Chrome does NOT fix this: HyperFrames preflights the ' +
        'binary with `<exe> --version` under a 5s timeout and Chrome on Windows ' +
        'never answers, so the render dies with ETIMEDOUT — live-found g61.)',
    );
  }

  return { path: chrome(), source: 'chrome' };
}

/** The `npx …` argv for one render. */
export function buildHyperframesArgv(args: {
  projectDir: string;
  compositionFile?: string;
  outPath: string;
  preset: 'landscape' | 'portrait' | 'square';
  fps?: number;
}): string[] {
  return [
    '--yes',
    'hyperframes',
    'render',
    args.projectDir,
    ...(args.compositionFile ? ['-c', args.compositionFile] : []),
    '-o',
    args.outPath,
    '--resolution',
    args.preset,
    '--fps',
    String(args.fps ?? HF_DEFAULT_FPS),
    // NOTE: HF has no `--duration`/`--width`/`--height` flags — duration is
    // declared inside the composition HTML (data-duration) and framing is
    // set via the `--resolution` preset (see deviations #2/#3). We do NOT
    // pass `--quiet`: it suppresses the `Capturing frame N/M` progress
    // lines our progress parser depends on. There is no `--browser-path` on
    // `render` either — the browser goes through the env (below).
  ];
}

/**
 * The child env. `HYPERFRAMES_BROWSER_PATH` is the variable the HF CLI
 * actually reads; `PUPPETEER_EXECUTABLE_PATH` is kept pointed at the same
 * binary for any puppeteer-based dep further down the tree (HF itself ignores
 * it — that was live-found defect 1).
 *
 * `PRODUCER_HEADLESS_SHELL_PATH` is deliberately **deleted**, not left to
 * inherit: hyperframes 0.8.35 has two browser resolvers and they disagree on
 * precedence — `findFromEnv` reads `HYPERFRAMES_BROWSER_PATH ??
 * PRODUCER_HEADLESS_SHELL_PATH` (ours wins) while `BrowserManager` checks
 * `PRODUCER_HEADLESS_SHELL_PATH` FIRST and hard-throws "[BrowserManager]
 * Chrome binary not found at PRODUCER_HEADLESS_SHELL_PATH=…" when it points
 * at a moved binary. An inherited leftover (another tool, a CI profile, an
 * operator experiment) would therefore decide the browser for some HF code
 * paths. Clearing it makes the adapter's choice the only voice, which is what
 * the resolver above is for.
 */
export function buildHyperframesEnv(
  base: NodeJS.ProcessEnv,
  browser: HyperframesBrowser,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    HYPERFRAMES_BROWSER_PATH: browser.path,
    PUPPETEER_EXECUTABLE_PATH: browser.path,
    // Prevent puppeteer-deep deps from trying to download Chrome on the fly.
    PUPPETEER_SKIP_DOWNLOAD: 'true',
  };
  delete env.PRODUCER_HEADLESS_SHELL_PATH;
  return env;
}

/**
 * Spawn options. `detached` is POSIX-only on purpose: it exists so killTree
 * can signal the process group, which win32 has no equivalent for, and under
 * Bun on Windows it additionally costs us every byte of the child's piped
 * stdout/stderr (live-found defect 3).
 */
export function buildHyperframesSpawnOptions(
  platform: NodeJS.Platform = process.platform,
): { detached: boolean; windowsHide: boolean } {
  return { detached: platform !== 'win32', windowsHide: true };
}

const FAILURE_TAIL_LINES = 20;
const FAILURE_MESSAGE_MAX_CHARS = 4000;

/**
 * Assemble the message that becomes the `render_queue.error` row.
 *
 * HF writes its failures to **stdout** (the "✗ Chrome cannot start" box), so a
 * message built from stderr alone is empty for the most common failure class —
 * which is exactly what the live round saw. Both tails are included and
 * labelled, and a child that produced nothing at all says so, with the command
 * and the browser we chose, so the row is never a dead end.
 *
 * Layout matters for the same reason: the diagnostic context (command +
 * browser) goes BEFORE the output tails, because the whole message is capped
 * and truncated from the tail end. With the context last, a chatty failure —
 * 40 tail lines is already over the 4000-char cap — cut exactly the two fields
 * g61 added, and the queue row ended "…(truncated)" with no record of which
 * binary HF was handed.
 */
export function buildRenderFailureMessage(args: {
  exitCode: number | null;
  stdoutTail: string[];
  stderrTail: string[];
  argv: string[];
  browser?: HyperframesBrowser;
  /** Overrides the leading clause (used by the exit-0-no-output case). */
  headline?: string;
}): string {
  const { exitCode, stdoutTail, stderrTail, argv, browser } = args;
  const headline =
    args.headline ?? `[hyperframes] render failed (exit ${exitCode ?? 'spawn-error'}):`;
  const context =
    `command: npx ${argv.join(' ')}` +
    (browser ? `\nbrowser: ${browser.source} ${browser.path}` : '');

  const sections: string[] = [];
  const push = (label: string, lines: string[]): void => {
    const tail = lines.slice(-FAILURE_TAIL_LINES);
    if (tail.length === 0) return;
    sections.push(`--- ${label} (last ${tail.length} line${tail.length === 1 ? '' : 's'}) ---\n${tail.join('\n')}`);
  };
  push('stdout', stdoutTail);
  push('stderr', stderrTail);

  // headline + context first (never truncated away), tails after.
  const head = `${headline}\n${context}`;
  const body =
    sections.length > 0 ? sections.join('\n') : 'no output captured on stdout or stderr';

  const message = `${head}\n${body}`;
  return message.length > FAILURE_MESSAGE_MAX_CHARS
    ? `${message.slice(0, FAILURE_MESSAGE_MAX_CHARS)}\n…(truncated)`
    : message;
}

// ─────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────

export const hyperframesAdapter: RendererAdapter = {
  id: 'hyperframes',

  capabilities: {
    still: false,
    video: true,
    interactive: false,
    range: true,
    combine: false,
    aspect_ratios: ['16:9', '9:16', '1:1'],
    max_duration_ms: null,
    supported_codecs: ['h264'],
    requires_network: false,
  },

  async validate(cell, ctx) {
    const diags: Diagnostic[] = [];
    const abs = absContentPath(cell, ctx);

    // 1. Existence.
    if (!existsSync(abs)) {
      diags.push({
        severity: 'error',
        code: 'content-missing',
        message: `Cell content not found on disk: ${abs}`,
        path: 'content_path',
      });
      return diags; // no point checking type if missing
    }

    // 2. Extension.
    if (!abs.toLowerCase().endsWith('.html')) {
      diags.push({
        severity: 'error',
        code: 'unsupported-content-type',
        message: 'HyperFrames requires .html cell content',
        path: 'content_path',
      });
    }

    // 3. Non-empty.
    let bytes = 0;
    try {
      bytes = statSync(abs).size;
    } catch {
      // already caught by existence check above
    }
    if (bytes === 0) {
      diags.push({
        severity: 'error',
        code: 'content-empty',
        message: 'Cell HTML file is empty',
        path: 'content_path',
      });
    }

    // 4. Regex-light HTML sanity (don't pull in a full parser for P1).
    if (bytes > 0 && abs.toLowerCase().endsWith('.html')) {
      try {
        const body = readFileSync(abs, 'utf8');
        if (!/<html|<body|<div|<section|<main|<svg|<canvas/i.test(body)) {
          diags.push({
            severity: 'warning',
            code: 'html-no-renderable-root',
            message:
              "HTML appears to have no renderable root element (no <html>/<body>/<div>/<svg>/<canvas>). HyperFrames may render a blank frame.",
            path: 'content_path',
          });
        }
      } catch {
        // unreadable — surface as an error
        diags.push({
          severity: 'error',
          code: 'content-unreadable',
          message: `Could not read HTML file at ${abs}`,
          path: 'content_path',
        });
      }
    }

    // 5. Capability cross-check (G1/G2) — defensive; the dispatcher (WP-06)
    //    is supposed to gate this, but a direct adapter caller could skip.
    //    `validate()` is a fine place for a second line of defence.
    const aspect = ctx.aspectRatio;
    if (!hyperframesAdapter.capabilities.aspect_ratios.includes(aspect)) {
      diags.push({
        severity: 'error',
        code: 'aspect-not-supported',
        message: `HyperFrames does not support aspect ratio ${aspect}`,
      });
    }

    return diags;
  },

  async preview(cell, ctx) {
    const abs = absContentPath(cell, ctx);
    // The iframe's <hyperframes-player> loads the file directly. file:// URI
    // is the cheapest representation — no copy, no encode.
    const url: PreviewURL = `file://${abs}`;
    return url;
  },

  async render(cell, opts, ctx) {
    const recordId = randomUUID();
    const startedAt = nowIso();
    const startedAtMs = Date.now();

    const aspect =
      opts.aspect_ratio
      ?? contentDeclaredAspect(absContentPath(cell, ctx))
      ?? resolveAspect(opts, ctx);
    const requestedResolution = resolveResolution(opts, ctx, aspect);
    const preset = ASPECT_TO_HF_PRESET[aspect];

    // HF treats its positional DIR argument as a *composition project* and
    // hard-requires an `index.html` entry inside it (it refuses to start
    // otherwise — see deviation #1). The cell's HTML lives in its own
    // directory (`cells/<rungDir>/<uid>/<file>`), so we point HF's DIR at
    // that directory. When the cell's entry file is already `index.html`
    // we pass no `-c`; for any other basename we pass `-c <basename>` (HF
    // still needs an index.html present alongside, which the studio's cell
    // scaffolding guarantees).
    const cellHtmlAbs = absContentPath(cell, ctx);
    const cellHtmlDir = dirname(cellHtmlAbs);
    const cellHtmlBase = cellHtmlAbs.slice(cellHtmlDir.length + 1);
    const projectDir = cellHtmlDir;
    const needsComposition = cellHtmlBase.toLowerCase() !== 'index.html';

    const outPath = resolveOutputPath(cell, ctx);
    // Ensure the parent dir for `out` exists (resolveOutputPath already does
    // this, but the user could swap rendersDir mid-call — be defensive).
    const outDir = dirname(outPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    // Resolve the browser to hand HF — fail fast if no usable one is installed
    // so the caller gets a clear error rather than HF reaching for its own
    // (possibly broken) cache, or a Windows Chrome that cannot pass HF's
    // preflight. Prefers chrome-headless-shell; see the header.
    let browser: HyperframesBrowser;
    try {
      browser = resolveHyperframesBrowser();
    } catch (e) {
      throw new Error(
        `[hyperframes] no usable browser: ${(e as Error).message}`,
      );
    }
    const chromePath = browser.path;

    const engineVersion = await detectEngineVersion();

    const argv = buildHyperframesArgv({
      projectDir,
      compositionFile: needsComposition ? cellHtmlBase : undefined,
      outPath,
      preset,
    });

    const env = buildHyperframesEnv(process.env, browser);

    // On POSIX `detached: true` puts the child (npx) in its own process group,
    // so killing the *group* (negative PID) reaps the whole npx → hyperframes
    // → chrome → ffmpeg tree. On win32 detaching buys nothing (no groups to
    // signal) and loses the child's piped output under Bun, so we don't —
    // killTree uses `taskkill /T` there instead.
    const child = spawn('npx', argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      ...buildHyperframesSpawnOptions(),
    });
    activeChildren.set(recordId, child);
    // Persist the child's PID so a fresh sidecar (after a crash) can reap the
    // leftover tree before re-queuing the render — otherwise two writers would
    // race the same output file. On POSIX that PID is the group leader; on
    // win32 it is the `npx` process and `taskkill /T` walks its descendants.
    // Cleared on close below.
    if (child.pid !== undefined) recordRenderPid(recordId, child.pid);

    // Wire cancellation via the host signal.
    const onAbort = () => {
      killTree(child);
    };
    if (ctx.signal.aborted) {
      onAbort();
    } else {
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Compute total frames if we can (G1 — cell.duration_ms is ms).
    const totalFramesFromDuration =
      cell.duration_ms > 0
        ? Math.max(1, Math.floor((cell.duration_ms / 1000) * HF_DEFAULT_FPS))
        : null;

    // Line-buffered stdout AND stderr → progress events. The two tails are
    // kept separate so the failure message can say which stream said what:
    // HF prints progress on stdout and prints its *failures* there too (the
    // "✗ Chrome cannot start" box), which is why a stderr-only error row read
    // blank for all 8 live failures.
    const stdoutTail: string[] = [];
    const stderrTail: string[] = [];
    let lastProgress = -1;
    let lastFrame = 0;
    let knownTotal: number | null = totalFramesFromDuration;

    const emitProgress = (progress: number | null, frame: number): void => {
      // De-dupe on rounded percent (or raw frame when total is unknown).
      const bucket = progress === null ? frame : Math.floor(progress * 100);
      if (bucket === lastProgress) return;
      lastProgress = bucket;
      ctx.emit({
        type: 'render.progress',
        payload: {
          recordId,
          cellId: cell.uid,
          engine: 'hyperframes',
          progress,
          frame,
        },
      });
    };

    const handleLine = (tail: string[], raw: string): void => {
      // Strip ANSI escape sequences (HF uses `\x1b[2K` etc. on the progress bar).
      // eslint-disable-next-line no-control-regex
      const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
      if (line.length === 0) return;
      tail.push(line);
      if (tail.length > 200) tail.shift();
      const p = parseProgressLine(line);
      if (!p) return;
      if ('frame' in p) {
        lastFrame = p.frame;
        if (p.total !== null) knownTotal = p.total;
        const total = knownTotal;
        const progress = total && total > 0 ? Math.min(1, p.frame / total) : null;
        emitProgress(progress, p.frame);
      } else {
        // Percent-bar fallback — derive a frame estimate from the known total.
        const total = knownTotal;
        const frame = total ? Math.round(p.pct * total) : Math.round(p.pct * 100);
        if (frame > lastFrame) lastFrame = frame;
        emitProgress(p.pct, frame);
      }
    };

    const bufferLines = (stream: NodeJS.ReadableStream, tail: string[]): void => {
      let pending = '';
      stream.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        // HF updates the progress bar with `\r`; capture-frame lines use `\n`.
        // Split on either so the bar updates surface as discrete lines.
        let idx: number;
        while ((idx = pending.search(/[\r\n]/)) >= 0) {
          const line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          if (line.length > 0) handleLine(tail, line);
        }
      });
      stream.on('end', () => {
        if (pending.length > 0) handleLine(tail, pending);
      });
    };

    if (child.stderr) bufferLines(child.stderr, stderrTail);
    if (child.stdout) bufferLines(child.stdout, stdoutTail);

    // Wait for completion / failure / abort.
    const exitCode: number | null = await new Promise<number | null>((resolveExit) => {
      child.once('error', () => resolveExit(null));
      child.once('close', (code) => resolveExit(code));
    });
    activeChildren.delete(recordId);
    clearRenderPid(recordId);

    const finishedAt = nowIso();
    const finishedAtMs = Date.now();

    if (ctx.signal.aborted) {
      // Cancellation is not a failure; throw a distinct error the queue can
      // tag as 'cancelled' rather than 'failed'.
      const err = new Error('[hyperframes] render aborted via ctx.signal');
      (err as Error & { cancelled?: boolean }).cancelled = true;
      throw err;
    }

    if (exitCode !== 0) {
      throw new Error(
        buildRenderFailureMessage({ exitCode, stdoutTail, stderrTail, argv, browser }),
      );
    }

    if (!existsSync(outPath)) {
      throw new Error(
        buildRenderFailureMessage({
          exitCode,
          stdoutTail,
          stderrTail,
          argv,
          browser,
          headline: `[hyperframes] render exited 0 but output not found at ${outPath}`,
        }),
      );
    }

    const record: RenderRecord = {
      id: recordId,
      cell_uid: cell.uid,
      engine: 'hyperframes',
      engine_version: engineVersion,
      variant: opts.variant ?? 'default',
      status: 'done',
      output: {
        uri: outPath,
        mime: 'video/mp4',
      },
      cost_estimate: 0,
      cost_actual: 0,
      started_at: startedAt,
      finished_at: finishedAt,
      metadata: {
        aspect_ratio: aspect,
        resolution_requested: requestedResolution,
        resolution_actual: DEFAULT_RESOLUTION[aspect],
        hf_resolution_preset: preset,
        fps: HF_DEFAULT_FPS,
        duration_ms: cell.duration_ms,
        frames_observed: lastFrame,
        elapsed_ms: finishedAtMs - startedAtMs,
        chrome_executable: chromePath,
        // How that path was chosen (env override / headless shell / full
        // Chrome) — the live round could not tell which binary HF used.
        browser_source: browser.source,
        // …and WHICH puppeteer build it was. `browser_source` alone cannot
        // distinguish a shell build pinned to the Chrome the Excalidraw
        // adapter uses (G24) from a mismatched one, and an HF fast-capture
        // path is itself build-gated — so the record carries the buildId.
        browser_build_id: buildIdFromInstallPath(browser.path) ?? null,
      },
    };
    return record;
  },

  async cancel(recordId) {
    const child = activeChildren.get(recordId);
    if (!child) return;
    killTree(child);
  },
};

export default hyperframesAdapter;
