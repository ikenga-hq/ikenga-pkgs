// HyperFrames engine wrapper (WP-11): lint, check, snapshot and render by spawning the
// HyperFrames CLI and parsing what it prints. Nothing here renders in tests: the spawn
// function is injected, and tests pass a fake.
//
// Rules this wrapper keeps (plan Round 5):
//   - previews come from HyperFrames' own seek path (`snapshot`), never a hand-rolled seek (R5-3);
//   - on Windows HYPERFRAMES_BROWSER_PATH is passed through, and its absence is reported (R5-6, R-9);
//   - a render-time estimate is available before any full render (R5-7, R-10).

import { spawn as nodeSpawn } from 'node:child_process';
import { HYPERFRAMES_BROWSER_ENV } from '../../setup/setup.ts';

/** HyperFrames version this wrapper was built and G-01-tested against (engines/hyperframes/G-01.md). */
export const HYPERFRAMES_VERSION = '0.9.19';

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Wall-clock milliseconds. */
  ms: number;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; cwd?: string; shell: boolean },
) => Promise<SpawnResult>;

export interface EngineOptions {
  /**
   * The HyperFrames CLI to run: a path to `hyperframes.mjs` (run with this Node) or to an
   * executable. Default: `npx --yes hyperframes@<version>`.
   */
  bin?: string;
  /** Version for the npx default. Default HYPERFRAMES_VERSION. */
  version?: string;
  /** Overrides HYPERFRAMES_BROWSER_PATH for this call. */
  browserPath?: string;
  /** Base environment. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Default process.platform; tests set it. */
  platform?: NodeJS.Platform;
  cwd?: string;
  /** Injected in tests. Default: node:child_process spawn. */
  spawn?: SpawnFn;
}

export class HyperframesError extends Error {
  readonly code: number;
  readonly stderr: string;
  constructor(message: string, code: number, stderr: string) {
    super(message);
    this.name = 'HyperframesError';
    this.code = code;
    this.stderr = stderr;
  }
}

// ------------------------------------------------------------------ invocation

export interface Invocation {
  command: string;
  prefix: string[];
  /** Only for Windows .cmd/.bat shims, which Node will not spawn without a shell. */
  shell: boolean;
}

export function resolveInvocation(opts: Pick<EngineOptions, 'bin' | 'version' | 'platform'> = {}): Invocation {
  const win = (opts.platform ?? process.platform) === 'win32';
  if (opts.bin) {
    if (/\.(mjs|cjs|js)$/i.test(opts.bin)) return { command: process.execPath, prefix: [opts.bin], shell: false };
    return { command: opts.bin, prefix: [], shell: win && /\.(cmd|bat)$/i.test(opts.bin) };
  }
  const pkg = `hyperframes@${opts.version ?? HYPERFRAMES_VERSION}`;
  return win ? { command: 'npx.cmd', prefix: ['--yes', pkg], shell: true } : { command: 'npx', prefix: ['--yes', pkg], shell: false };
}

/** Quote one argument for cmd.exe (used only when spawning a .cmd shim through the shell). */
export function quoteForCmd(arg: string): string {
  if (arg !== '' && !/[\s"&|<>^%(),;!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface EngineEnv {
  env: Record<string, string | undefined>;
  warnings: string[];
}

/** The environment a HyperFrames process gets: HYPERFRAMES_BROWSER_PATH passed through (or set from browserPath). */
export function engineEnv(opts: Pick<EngineOptions, 'env' | 'browserPath' | 'platform'> = {}): EngineEnv {
  const env = { ...(opts.env ?? process.env) };
  const warnings: string[] = [];
  if (opts.browserPath) env[HYPERFRAMES_BROWSER_ENV] = opts.browserPath;
  if ((opts.platform ?? process.platform) === 'win32' && !env[HYPERFRAMES_BROWSER_ENV]) {
    warnings.push(
      `${HYPERFRAMES_BROWSER_ENV} is not set. HyperFrames' bundled headless shell can crash on Windows; ` +
        'point it at your Chrome (akuko setup shows how).',
    );
  }
  return { env, warnings };
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const child = nodeSpawn(command, args, {
      env: options.env as NodeJS.ProcessEnv,
      cwd: options.cwd,
      shell: options.shell,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: performance.now() - started,
      }),
    );
  });

interface Ran extends SpawnResult {
  warnings: string[];
  args: string[];
}

async function runHf(args: string[], opts: EngineOptions): Promise<Ran> {
  const inv = resolveInvocation(opts);
  const { env, warnings } = engineEnv(opts);
  const full = [...inv.prefix, ...args];
  const r = await (opts.spawn ?? defaultSpawn)(inv.command, inv.shell ? full.map(quoteForCmd) : full, {
    env,
    cwd: opts.cwd,
    shell: inv.shell,
  });
  return { ...r, warnings, args };
}

/** The JSON document in a CLI's stdout (HyperFrames may print notices around it). */
export function extractJson(stdout: string): unknown {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new SyntaxError('no JSON object in output');
  return JSON.parse(stdout.slice(start, end + 1));
}

function tail(s: string, n = 1200): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

function parsedOrThrow<T>(r: Ran, what: string): T {
  try {
    return extractJson(r.stdout) as T;
  } catch {
    throw new HyperframesError(`hyperframes ${what} exited ${r.code} without a JSON result`, r.code, tail(r.stderr || r.stdout));
  }
}

// ------------------------------------------------------------------ lint / check

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  selector?: string;
  file?: string;
  fixHint?: string;
}

export interface FindingSet {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  findings: Finding[];
}

export interface LintResult extends FindingSet {
  filesScanned: number;
  warnings: string[];
}

interface RawFindingSet {
  ok?: boolean;
  errorCount?: number;
  warningCount?: number;
  infoCount?: number;
  findings?: Array<Record<string, unknown>>;
}

export function toFindingSet(raw: RawFindingSet | undefined): FindingSet {
  const findings: Finding[] = (raw?.findings ?? []).map((f) => {
    const out: Finding = {
      code: String(f.code ?? ''),
      severity: f.severity === 'error' || f.severity === 'warning' ? f.severity : 'info',
      message: String(f.message ?? ''),
    };
    if (typeof f.selector === 'string') out.selector = f.selector;
    const file = f.file ?? f.sourceFile;
    if (typeof file === 'string') out.file = file;
    if (typeof f.fixHint === 'string') out.fixHint = f.fixHint;
    return out;
  });
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const errorCount = raw?.errorCount ?? count('error');
  return {
    ok: raw?.ok ?? errorCount === 0,
    errorCount,
    warningCount: raw?.warningCount ?? count('warning'),
    infoCount: raw?.infoCount ?? count('info'),
    findings,
  };
}

/** `hyperframes lint --json <target>` (a composition file or a project directory). */
export async function lint(target: string, opts: EngineOptions = {}): Promise<LintResult> {
  const r = await runHf(['lint', '--json', target], opts);
  const raw = parsedOrThrow<RawFindingSet & { filesScanned?: number }>(r, 'lint');
  return { ...toFindingSet(raw), filesScanned: raw.filesScanned ?? 0, warnings: r.warnings };
}

export interface CheckResult {
  ok: boolean;
  /** lint, runtime, layout, motion, contrast, craft, … as HyperFrames reports them. */
  sections: Record<string, FindingSet>;
  warnings: string[];
}

/** `hyperframes check --json <dir>`: lint plus in-browser runtime, layout, contrast and craft checks. */
export async function check(dir: string, opts: EngineOptions = {}): Promise<CheckResult> {
  const r = await runHf(['check', '--json', dir], opts);
  const raw = parsedOrThrow<Record<string, unknown>>(r, 'check');
  const sections: Record<string, FindingSet> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === 'object' && Array.isArray((v as RawFindingSet).findings)) sections[k] = toFindingSet(v as RawFindingSet);
  }
  const ok = typeof raw.ok === 'boolean' ? raw.ok : Object.values(sections).every((s) => s.ok);
  return { ok, sections, warnings: r.warnings };
}

// ------------------------------------------------------------------ snapshot (preview)

export interface SnapshotOptions {
  /** Exact timeline times in seconds. */
  at?: number[];
  /** Evenly spaced frames when `at` is not given. */
  frames?: number;
  outDir?: string;
  /** Add HyperFrames' end-of-timeline frame. Default false (only what was asked for). */
  end?: boolean;
}

export interface SnapshotResult {
  outputDir: string;
  frames: { path: string; time: number }[];
  contactSheets: string[];
  warnings: string[];
}

export function snapshotArgs(dir: string, o: SnapshotOptions = {}): string[] {
  const args = ['snapshot', dir, '--json'];
  if (o.at && o.at.length > 0) {
    for (const t of o.at) if (!Number.isFinite(t) || t < 0) throw new RangeError(`snapshot time must be ≥ 0, got ${t}`);
    args.push('--at', o.at.join(','));
  } else if (o.frames !== undefined) {
    args.push('--frames', String(o.frames));
  }
  if (o.outDir) args.push('-o', o.outDir);
  args.push(o.end ? '--end' : '--no-end');
  return args;
}

/**
 * Preview stills through HyperFrames' own seek path (the runtime's renderSeek, the call its
 * renderer makes). This is the only preview path G-01 proved equal to the render.
 */
export async function snapshot(dir: string, o: SnapshotOptions = {}, opts: EngineOptions = {}): Promise<SnapshotResult> {
  const r = await runHf(snapshotArgs(dir, o), opts);
  const raw = parsedOrThrow<{ ok?: boolean; outputDir?: string; frames?: { path: string; time: number }[]; contactSheets?: string[] }>(r, 'snapshot');
  if (r.code !== 0 || raw.ok === false) throw new HyperframesError(`hyperframes snapshot failed (${r.code})`, r.code, tail(r.stderr));
  return { outputDir: raw.outputDir ?? o.outDir ?? '', frames: raw.frames ?? [], contactSheets: raw.contactSheets ?? [], warnings: r.warnings };
}

// ------------------------------------------------------------------ render

/**
 * draft: fast encode at half the frame rate (15 fps) for a quick look.
 * final: HyperFrames' `delivery` quality at the composition's own frame rate.
 * HyperFrames 0.9.19 cannot render below the composition's size (--resolution only scales up),
 * and capture dominates render time (R-10), so draft saves time by halving the frames.
 */
export type RenderProfile = 'draft' | 'final';

export interface RenderOptions {
  output: string;
  profile?: RenderProfile;
  format?: 'mp4' | 'webm' | 'mov' | 'png-sequence';
  /** Overrides the profile's frame rate. */
  fps?: number;
  workers?: number | 'auto';
  /** A composition file other than index.html. */
  composition?: string;
  /** Fail on lint errors. Default true. */
  strict?: boolean;
}

export interface RenderResult {
  output: string;
  /** Wall clock of the whole CLI call. */
  ms: number;
  /** What HyperFrames reports on its summary line, when it prints one. */
  frames: number | null;
  renderedInSeconds: number | null;
  /** e.g. "screenshot capture · hardware gpu · …" */
  pipeline: string | null;
  warnings: string[];
}

export const DRAFT_FPS = 15;

export function renderArgs(dir: string, o: RenderOptions): string[] {
  const profile = o.profile ?? 'final';
  const args = ['render', dir, '-o', o.output, '--format', o.format ?? 'mp4'];
  if (o.composition) args.push('-c', o.composition);
  args.push('--quality', profile === 'draft' ? 'draft' : 'delivery');
  const fps = o.fps ?? (profile === 'draft' ? DRAFT_FPS : undefined);
  if (fps !== undefined) args.push('--fps', String(fps));
  if (o.workers !== undefined) args.push('--workers', String(o.workers));
  if (o.strict ?? true) args.push('--strict');
  return args;
}

/** "rendered in 1m 22.9s" / "rendered in 48.2s" → seconds. */
export function parseDuration(text: string): number | null {
  const m = /(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+(?:\.\d+)?)s\b/.exec(text);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3]);
}

/** Pull frames, render time and pipeline from HyperFrames' summary lines. */
export function parseRenderSummary(log: string): Pick<RenderResult, 'frames' | 'renderedInSeconds' | 'pipeline'> {
  const lines = log.split(/\r?\n/);
  const summary = lines.find((l) => /rendered in/.test(l));
  const frames = summary ? /(\d+)\s+frames/.exec(summary)?.[1] : undefined;
  const after = summary ? summary.slice(summary.indexOf('rendered in') + 'rendered in'.length) : '';
  const pipeline = lines.find((l) => /\bcapture\b.*·/.test(l) && !/rendered in/.test(l))?.trim() ?? null;
  return {
    frames: frames ? Number(frames) : null,
    renderedInSeconds: summary ? parseDuration(after) : null,
    pipeline,
  };
}

/** Render a composition directory. Spawns HyperFrames; never called by tests with a real spawn. */
export async function render(dir: string, o: RenderOptions, opts: EngineOptions = {}): Promise<RenderResult> {
  const r = await runHf(renderArgs(dir, o), opts);
  const log = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) throw new HyperframesError(`hyperframes render failed (${r.code})`, r.code, tail(log));
  return { output: o.output, ms: r.ms, ...parseRenderSummary(log), warnings: r.warnings };
}

// ------------------------------------------------------------------ render-time estimate (R-10)

/**
 * Measured on one Windows dev laptop (Intel UHD 630, system Chrome, 6 workers, HyperFrames
 * 0.9.19), 6 s 1920x1080 compositions at 30 fps: see engines/hyperframes/G-01.md §Render time.
 * Rough by design: real time varies with the machine, the composition and what else runs.
 */
export const MEASURED = {
  secondsPerFrame: 0.3,
  setupSeconds: 30,
} as const;

export interface EstimateInput {
  durationSeconds: number;
  fps?: number;
  profile?: RenderProfile;
  secondsPerFrame?: number;
  setupSeconds?: number;
}

export interface RenderEstimate {
  frames: number;
  seconds: number;
  /** Plain words, e.g. "about 2 min (180 frames)". */
  text: string;
}

/** Rough render time: frames × seconds per frame + fixed setup. Show it before a full render. */
export function estimateRender(i: EstimateInput): RenderEstimate {
  if (!(i.durationSeconds > 0)) throw new RangeError('durationSeconds must be > 0');
  const fps = i.fps ?? (i.profile === 'draft' ? DRAFT_FPS : 30);
  const frames = Math.ceil(i.durationSeconds * fps);
  const seconds = frames * (i.secondsPerFrame ?? MEASURED.secondsPerFrame) + (i.setupSeconds ?? MEASURED.setupSeconds);
  const text = seconds < 90 ? `about ${Math.round(seconds)} s (${frames} frames)` : `about ${Math.round(seconds / 60)} min (${frames} frames)`;
  return { frames, seconds, text };
}

/** Seconds per frame from a finished render, to calibrate the estimate on this machine. */
export function secondsPerFrameFrom(r: Pick<RenderResult, 'frames' | 'renderedInSeconds'>, setupSeconds: number = MEASURED.setupSeconds): number | null {
  if (!r.frames || r.renderedInSeconds === null) return null;
  return Math.max(0, r.renderedInSeconds - setupSeconds) / r.frames;
}
