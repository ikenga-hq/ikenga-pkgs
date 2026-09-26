/**
 * Blender headless 3D renderer adapter (WP-21, Plan 24).
 *
 * Local deterministic 3D rendering engine for com.ikenga.studio. Spawns
 * Blender in background mode (`blender -b -P script.py`) against on-disk
 * Python/blend compositions, streams frame progress as `render.progress`,
 * and outputs deterministic MP4 / PNG renders.
 *
 * ─── Binary Resolution (G-51) ─────────────────────────────────────────────
 * Cross-platform path resolver checking explicit settings, environment vars,
 * system standard directories, and PATH lookup. Emits `BLENDER_NOT_FOUND`
 * diagnostic if unresolvable.
 *
 * ─── Output Path (G14, G-74 fix) ──────────────────────────────────────────
 * Lands at `<rendersDir>/blender/<rungDir(cell.rung)>/<uid>.mp4`.
 *
 * G-74 chose the **PNG-frames + ffmpeg-assemble** strategy (mirrors
 * excalidraw.ts), not "glob the FFMPEG output dir and rename". Reasons:
 *   1. Blender's built-in `-F FFMPEG` movie encoder substitutes the frame
 *      RANGE into `#` placeholders (`<name>_0001-0090.mp4`), not a single
 *      frame number — there is no output-path incantation that makes it
 *      emit an exact `<uid>.mp4` for an animation render, so renaming is
 *      the only option with that path and it still leaves us dependent on
 *      Blender's FFMPEG muxer (fewer knobs, harder to test without a
 *      binary).
 *   2. Rendering PNG stills is a single, predictable, `#`-padded output
 *      name we control completely (`frame_####.png`), and per-frame
 *      progress falls out of Blender's own `Fra:N` stdout lines with an
 *      exact `frame/total` we already know (we pick `total` up front from
 *      `cell.duration_ms`, unlike HF which has to *discover* it).
 *   3. The ffmpeg-assemble step is byte-for-byte the same `scale+pad →
 *      libx264 → yuv420p` pipeline excalidraw.ts already uses, so the two
 *      local/deterministic adapters share one well-tested encode shape
 *      instead of Blender growing a bespoke muxer path.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

import {
  rungDir,
  type AspectRatio,
  type Cell,
  type RenderRecord,
} from '@ikenga/studio-schema';

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

// Frozen P1 time model is 30fps (src/studio/lib/time.ts DEFAULT_FPS) — do
// NOT reintroduce the old 24fps fallback that this adapter used to assume.
const BLENDER_FPS = 30;

let cachedBlenderPath: string | null = null;
let cachedBlenderVersion: string | undefined;

// Children we've spawned, keyed by recordId, so cancel(recordId) can find
// them — mirrors hyperframes.ts's activeChildren map.
const activeChildren = new Map<string, ChildProcess>();

/**
 * Resolve local Blender executable across Windows, macOS, and Linux.
 */
/** Compare two dotted version strings numerically, newest first. `5.2` must
 *  sort above `4.3`, and `5.10` above `5.9` — which string compare gets
 *  wrong both times. */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** List `Blender <version>` install dirs under `root`, newest first, mapped
 *  through `toBinary`. Returns `[]` when `root` does not exist.
 *
 *  Exists because hardcoding a version list (the original G-51 approach)
 *  silently stops finding Blender the moment a new major ships — which is
 *  exactly what happened with Blender 5.2 against a list ending at 4.3. */
export function discoverVersionedBlender(root: string, toBinary: (dir: string) => string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .map((name) => ({ name, m: name.match(/^Blender\s+(\d+(?:\.\d+)*)(?:\.app)?$/i) }))
      .filter((e): e is { name: string; m: RegExpMatchArray } => e.m !== null)
      .sort((x, y) => compareVersionsDesc(x.m[1]!, y.m[1]!))
      .map((e) => toBinary(join(root, e.name)));
  } catch {
    return [];
  }
}

export async function resolveBlenderPath(
  vault?: { get(key: string): Promise<string | undefined> },
): Promise<string | null> {
  if (cachedBlenderPath && existsSync(cachedBlenderPath)) {
    return cachedBlenderPath;
  }

  // 1. Vault or explicit setting
  if (vault) {
    const fromVault = await vault.get('blender_executable_path');
    if (fromVault && existsSync(fromVault)) {
      cachedBlenderPath = fromVault;
      return fromVault;
    }
  }

  // 2. Environment variable
  if (process.env.BLENDER_PATH && existsSync(process.env.BLENDER_PATH)) {
    cachedBlenderPath = process.env.BLENDER_PATH;
    return process.env.BLENDER_PATH;
  }

  // 3. Platform-specific common paths
  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    // Enumerate installed versions instead of hardcoding them (G-51b). The
    // original list stopped at "Blender 4.3" and so could not see the
    // Blender 5.2 on the reference box — `resolveBlenderPath` returned null
    // and every render failed BLENDER_NOT_FOUND on a host with Blender
    // installed. Newest-first so a box with several versions picks the
    // latest rather than whichever the OS happens to list first.
    candidates.push(
      ...discoverVersionedBlender(join(programFiles, 'Blender Foundation'), (dir) =>
        join(dir, 'blender.exe'),
      ),
      join(programFiles, 'Blender Foundation', 'Blender', 'blender.exe'),
    );
  } else if (platform === 'darwin') {
    candidates.push(
      ...discoverVersionedBlender('/Applications', (dir) => join(dir, 'Contents', 'MacOS', 'Blender')),
      '/Applications/Blender.app/Contents/MacOS/Blender',
    );
  } else {
    candidates.push(
      '/usr/bin/blender',
      '/usr/local/bin/blender',
      '/var/lib/flatpak/exports/bin/org.blender.Blender',
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBlenderPath = candidate;
      return candidate;
    }
  }

  // 4. PATH lookup
  try {
    const lookupCmd = platform === 'win32' ? 'where.exe blender' : 'which blender';
    const found = execSync(lookupCmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split(/\r?\n/)[0];
    if (found && existsSync(found)) {
      cachedBlenderPath = found;
      return found;
    }
  } catch {
    // PATH lookup failed
  }

  return null;
}

export async function getBlenderVersion(blenderBin: string): Promise<string | undefined> {
  if (cachedBlenderVersion) return cachedBlenderVersion;
  try {
    const out = execSync(`"${blenderBin}" --version`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = out.match(/Blender\s+([\d.]+)/i);
    if (match?.[1]) {
      cachedBlenderVersion = match[1];
      return cachedBlenderVersion;
    }
  } catch {
    // Ignore version parse error
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Process-group termination (mirrors hyperframes.ts / excalidraw.ts)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Terminate a detached child and its entire process group. SIGTERM first,
 * then SIGKILL after a short grace window so a wedged Blender can't linger.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  const signalGroup = (sig: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, sig); // negative pid → process group
    } catch {
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

/** Drain a piped stream into a capped tail buffer so the 64KB OS pipe never
 *  fills and blocks the child (a chatty Blender render would otherwise
 *  deadlock the sidecar). Every adapter (preview, render, generateAnchorPlate)
 *  must attach one of these to every piped stdout/stderr. */
function drainToTail(stream: NodeJS.ReadableStream, tail: { text: string }): void {
  stream.on('data', (chunk: Buffer) => {
    tail.text += chunk.toString('utf8');
    if (tail.text.length > 8000) tail.text = tail.text.slice(-8000);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Path / arg helpers
// ─────────────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/** `--python-expr` injected before the render trigger so the declared
 *  aspect_ratios/resolution capability (G1) is actually honoured instead of
 *  whatever the scene happens to have baked in. Exported (pure, no I/O) so
 *  it's directly unit-testable without a Blender binary. */
export function buildResolutionExpr(w: number, h: number): string {
  return (
    `import bpy\n` +
    `bpy.context.scene.render.resolution_x = ${Math.round(w)}\n` +
    `bpy.context.scene.render.resolution_y = ${Math.round(h)}\n` +
    `bpy.context.scene.render.resolution_percentage = 100\n`
  );
}

/** Compute device for Cycles. `undefined` = auto (prefer OPTIX, then CUDA,
 *  else CPU). */
export type BlenderDevice = 'OPTIX' | 'CUDA' | 'CPU';

/** Marker the injected device preamble prints so the adapter can read back
 *  which device Blender actually bound. Must not collide with the `Fra:N`
 *  progress grammar. */
export const DEVICE_MARKER = '[studio] cycles_device=';

/** Marker the one-shot host capability probe prints. */
export const DEVICE_PROBE_MARKER = '[studio] cycles_device_probe=';

/** Printed by the LAST line of the anchor-plate script. Its absence is the
 *  only reliable signal that the script died partway — Blender exits 0 on an
 *  uncaught Python exception, so exit code cannot be trusted alone. */
export const PLATE_OK_SENTINEL = '[studio] plate_ok';

/** Standalone `--python-expr` that determines which Cycles backend this HOST
 *  can actually render with, and prints `DEVICE_PROBE_MARKER<backend>`.
 *
 *  **Why a render probe and not an enumeration check.** Enumeration is not a
 *  capability test. Measured on the RTX 2070 dev box (2026-09-06): OptiX
 *  enumerates perfectly — `compute_device_type='OPTIX'` sets, `get_devices()`
 *  returns the card — and then every render dies at kernel load with
 *  `OPTIX_ERROR_INTERNAL_COMPILER_ERROR` ("New backend is missing
 *  implementation for PTX intrinsic optix.ptx.copysign.f32"), a
 *  driver/OptiX-runtime mismatch against Blender 5.2's shipped PTX. A ladder
 *  that trusts enumeration picks OPTIX and every render fails. CUDA on the
 *  same card renders fine and is 4.1× faster than CPU (10.3s vs 42.7s on the
 *  reference scene).
 *
 *  So the probe does a real 32×32, 1-sample render per backend and keeps the
 *  first that survives. It needs a camera — an empty scene fails with
 *  "Cannot render, no camera" for reasons unrelated to the backend, which
 *  would falsely condemn every GPU.
 *
 *  Cost is ~2.6s of probe work (~6s wall including Blender startup), which is
 *  why `resolveComputeDevice()` caches it per host for the sidecar's lifetime
 *  rather than paying it per render. */
export function buildDeviceProbeScript(): string {
  return (
    `import bpy\n` +
    `def _try(backend):\n` +
    `    try:\n` +
    `        cp = bpy.context.preferences.addons['cycles'].preferences\n` +
    `        cp.compute_device_type = backend\n` +
    `        cp.get_devices()\n` +
    `        if not any(d.type == backend for d in cp.devices):\n` +
    `            return False\n` +
    `        for d in cp.devices:\n` +
    `            d.use = (d.type == backend)\n` +
    `        sc = bpy.context.scene\n` +
    `        sc.render.engine = 'CYCLES'\n` +
    `        sc.cycles.device = 'GPU'\n` +
    `        sc.cycles.samples = 1\n` +
    `        sc.render.resolution_x = 32\n` +
    `        sc.render.resolution_y = 32\n` +
    `        sc.render.resolution_percentage = 100\n` +
    `        bpy.ops.render.render(write_still=False)\n` +
    `        return True\n` +
    `    except Exception:\n` +
    `        return False\n` +
    `bpy.ops.wm.read_factory_settings(use_empty=True)\n` +
    `_cd = bpy.data.cameras.new('ProbeCam')\n` +
    `_co = bpy.data.objects.new('ProbeCam', _cd)\n` +
    `bpy.context.scene.collection.objects.link(_co)\n` +
    `bpy.context.scene.camera = _co\n` +
    `_chosen = 'CPU'\n` +
    `for _b in ['OPTIX', 'CUDA']:\n` +
    `    if _try(_b):\n` +
    `        _chosen = _b\n` +
    `        break\n` +
    `print('${DEVICE_PROBE_MARKER}' + _chosen)\n`
  );
}

/** Read the probe's verdict out of its stdout. */
export function parseProbeDevice(text: string): BlenderDevice | null {
  const m = text.match(/\[studio\] cycles_device_probe=(OPTIX|CUDA|CPU)/);
  return m ? (m[1] as BlenderDevice) : null;
}

/** `--python-expr` fragment that pins Cycles to an already-resolved compute
 *  device (G-BL-GPU).
 *
 *  **Why this exists.** Headless Blender does NOT inherit the GUI's device
 *  preference — `compute_device_type` lives in user preferences that `-b`
 *  starts empty, so Cycles silently falls back to **CPU**. The adapter
 *  shipped without this, so every Cycles render ran on the CPU while the GPU
 *  sat idle: renders still succeeded, just ~4× slower, with no error to
 *  notice. That is Plan 16's F5 latency risk reintroduced at the adapter
 *  layer.
 *
 *  This function does no discovery — `resolveComputeDevice()` already decided
 *  via `buildDeviceProbeScript()`. It only pins, so a render never pays probe
 *  cost and never silently lands somewhere other than what the ledger claims.
 *
 *  `get_devices()` must be called AFTER setting `compute_device_type` — it
 *  populates `.devices` for the selected backend. Deliberately does not touch
 *  `scene.render.engine`: the `.blend` is the source of truth for which engine
 *  to use (see G-BL-ENUM — Plan 24's `BLENDER_EEVEE_NEXT` does not exist in
 *  Blender 5.x). EEVEE ignores all of this, so injecting it unconditionally is
 *  safe; the block is wrapped so a Blender build without the Cycles addon
 *  cannot fail the render.
 *
 *  Exported (pure, no I/O) so it is unit-testable without a Blender binary. */
export function buildDeviceExpr(device: BlenderDevice = 'CPU'): string {
  if (device === 'CPU') {
    return (
      `try:\n` +
      `    bpy.context.scene.cycles.device = 'CPU'\n` +
      `    print('${DEVICE_MARKER}CPU')\n` +
      `except Exception as _e:\n` +
      `    print('${DEVICE_MARKER}unavailable')\n`
    );
  }

  return (
    `try:\n` +
    `    _cprefs = bpy.context.preferences.addons['cycles'].preferences\n` +
    `    _cprefs.compute_device_type = '${device}'\n` +
    `    _cprefs.get_devices()\n` +
    `    if any(_d.type == '${device}' for _d in _cprefs.devices):\n` +
    `        for _d in _cprefs.devices:\n` +
    `            _d.use = (_d.type == '${device}')\n` +
    `        bpy.context.scene.cycles.device = 'GPU'\n` +
    `        print('${DEVICE_MARKER}${device}')\n` +
    `    else:\n` +
    `        bpy.context.scene.cycles.device = 'CPU'\n` +
    `        print('${DEVICE_MARKER}CPU')\n` +
    `except Exception as _e:\n` +
    `    print('${DEVICE_MARKER}unavailable')\n`
  );
}

/** Read the device the injected preamble reported. Returns `null` when the
 *  chunk carries no device signal. Exported (pure) for tests. */
export function parseDeviceFromChunk(chunk: string): string | null {
  const m = chunk.match(/\[studio\] cycles_device=(\w+)/);
  return m ? m[1]! : null;
}

/** Build the leading `--background [.blend] [--python file.py] --python-expr
 *  <resolution setup>` argv shared by preview() and render(). Output flags
 *  (`-o`/`-F`/…) and the render trigger (`-f`/`-a`) MUST come after this —
 *  callers append them. This is also where the G-74 preview-arg-order bug
 *  lived: `-o` was previously appended AFTER `-f 1`, which Blender parses
 *  strictly left-to-right, so the frame landed at the scene's default
 *  output path instead of ours. Exported (pure, no I/O) for arg-construction
 *  tests. */
export function buildBaseArgs(
  contentPath: string,
  res: { w: number; h: number },
  device?: BlenderDevice,
): string[] {
  const args: string[] = ['--background'];
  if (contentPath.toLowerCase().endsWith('.blend')) {
    args.push(contentPath);
  } else if (contentPath.toLowerCase().endsWith('.py')) {
    args.push('--python', contentPath);
  }
  // One `--python-expr`, two concerns: resolution (G1) then compute device
  // (G-BL-GPU). Composed into a single expr rather than a second
  // `--python-expr` so the existing arg-order contract (and its tests) is
  // untouched — `buildResolutionExpr` already emits the `import bpy`.
  args.push('--python-expr', buildResolutionExpr(res.w, res.h) + buildDeviceExpr(device));
  return args;
}

/** Host compute-device verdict, cached for the sidecar's lifetime. The probe
 *  costs ~6s wall, and the answer is a property of the host (GPU + driver +
 *  Blender build), not of the cell — so it is paid once, like
 *  `cachedBlenderVersion`. */
let cachedComputeDevice: BlenderDevice | undefined;

/** Determine — by actually rendering, see `buildDeviceProbeScript()` — which
 *  Cycles backend this host can use. Never throws: a probe failure degrades
 *  to `'CPU'`, which always works. */
export async function resolveComputeDevice(blenderBin: string): Promise<BlenderDevice> {
  if (cachedComputeDevice) return cachedComputeDevice;

  let tmp: string | undefined;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'studio-blender-probe-'));
    const scriptPath = join(tmp, 'probe.py');
    writeFileSync(scriptPath, buildDeviceProbeScript(), 'utf-8');

    const out = execSync(`"${blenderBin}" -b --python "${scriptPath}"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 120_000,
    });
    cachedComputeDevice = parseProbeDevice(out) ?? 'CPU';
  } catch {
    // A probe that cannot run tells us nothing good about the GPU — fall back
    // to the backend that is always available rather than failing the render.
    cachedComputeDevice = 'CPU';
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }

  return cachedComputeDevice;
}

/** Test seam — drop the cached probe verdict. */
export function __resetComputeDeviceCache(): void {
  cachedComputeDevice = undefined;
}

/** Full preview() argv: output flags precede the `-f 1` trigger (G-74 #2). */
export function buildPreviewArgs(
  contentPath: string,
  res: { w: number; h: number },
  outPrefix: string,
  device?: BlenderDevice,
): string[] {
  return [
    ...buildBaseArgs(contentPath, res, device),
    '-o', outPrefix,
    '-F', 'PNG',
    '-x', '1',
    '-f', '1',
  ];
}

/** Full render() argv: output flags + frame range precede the `-a` trigger
 *  (G-74 #2). Renders a PNG sequence, never `-F FFMPEG` (see file header for
 *  why). */
export function buildRenderArgs(
  contentPath: string,
  res: { w: number; h: number },
  framePattern: string,
  totalFrames: number,
  device?: BlenderDevice,
): string[] {
  return [
    ...buildBaseArgs(contentPath, res, device),
    '-o', framePattern,
    '-F', 'PNG',
    '-x', '1',
    '-s', '1',
    '-e', String(totalFrames),
    '-a',
  ];
}

/** `cell.duration_ms` → frame count at the frozen P1 30fps time model
 *  (G-74 #4 — the old code fell back to 24fps). Exported (pure) for tests. */
export function computeTotalFrames(durationMs: number | undefined | null, fps = BLENDER_FPS): number {
  return Math.max(1, Math.round(((durationMs || 3000) / 1000) * fps));
}

/** Where the final MP4 lands — `<rendersDir>/blender/<rungDir>/<uid>.mp4`,
 *  never a frame-range-suffixed name (G-74 #1). Exported (pure) so
 *  output-path derivation is testable without spawning anything. */
export function blenderOutputPath(rendersDir: string, cell: Pick<Cell, 'uid' | 'rung'>): {
  outDir: string;
  outPath: string;
} {
  const outDir = join(rendersDir, 'blender', rungDir(cell.rung));
  return { outDir, outPath: join(outDir, `${cell.uid}.mp4`) };
}

/** Parse the frame number out of a chunk of Blender stdout. Returns `null` if
 *  the chunk carries no frame signal — exported (pure) for progress-parsing
 *  tests.
 *
 *  Two things this has to get right, both learned the hard way:
 *
 *  1. **Blender 5.x puts a SPACE after the colon** — the real line reads
 *     `00:07.157  render  | Fra: 1 | Rendering 1 / 64 samples`. The original
 *     `/Fra:(\d+)/` is a 4.x-era pattern (`Fra:1`) that silently stopped
 *     matching, so progress reported frame 0 forever and the UI showed a
 *     render that never advanced. `\s*` covers both spellings.
 *  2. **Take the LAST match, not the first.** A single stdout chunk carries
 *     many progress lines; matching the first reports the oldest frame in
 *     the chunk, which makes progress lag and can look non-monotonic across
 *     chunk boundaries. */
export function parseFrameFromChunk(text: string): number | null {
  const matches = [...text.matchAll(/Fra:\s*(\d+)/gi)];
  const last = matches[matches.length - 1];
  return last ? parseInt(last[1]!, 10) : null;
}

function resolveAspectAndResolution(
  opts: RenderOptions | undefined,
  ctx: RenderContext,
): { aspect: AspectRatio; res: { w: number; h: number } } {
  const aspect = opts?.aspect_ratio ?? ctx.aspectRatio;
  const res = opts?.resolution ?? ctx.resolution;
  return { aspect, res };
}

/** Even-dimension, scale-to-fit + pad-to-exact filter — identical to
 *  excalidraw.ts's scalePadFilter so the two local encoders agree on
 *  framing behaviour. Exported (pure) for tests. */
export function scalePadFilter(w: number, h: number): string {
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`
  );
}

/** Translate Blender's `#`-padding output pattern into ffmpeg's `%0Nd` form.
 *
 *  Blender and ffmpeg spell numeric padding differently and BOTH are handed
 *  the same base path here: Blender writes `frame_####.png` via `-o`, ffmpeg
 *  must read it back as `frame_%04d.png` via `-i`. Passing Blender's form to
 *  ffmpeg yields `Error opening input file … frame_####.png` and the whole
 *  render fails at the last step, after every frame has already been paid
 *  for. The width of the run of `#` is the zero-pad width.
 *
 *  Exported (pure) so the translation is testable without either binary. */
export function ffmpegPatternFromBlender(pattern: string): string {
  return pattern.replace(/#+/g, (hashes) => `%0${hashes.length}d`);
}

/** Run ffmpeg to assemble a `frame_%04d.png` sequence into an h264 MP4.
 *  Mirrors excalidraw.ts's runFfmpeg: stderr piped + drained into a tail,
 *  process-group killable via `onAbort`. */
function assembleFrames(
  framePattern: string,
  outPath: string,
  res: { w: number; h: number },
  ctx: RenderContext,
  registerChild: (c: ChildProcess) => void,
): Promise<void> {
  return new Promise<void>((resolveExit, reject) => {
    const args = [
      '-y',
      '-framerate', String(BLENDER_FPS),
      '-i', ffmpegPatternFromBlender(framePattern),
      '-vf', scalePadFilter(res.w, res.h),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      outPath,
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    registerChild(child);
    const tail = { text: '' };
    if (child.stderr) drainToTail(child.stderr, tail);
    child.once('error', reject);
    child.once('close', (code) => {
      if (ctx.signal.aborted) {
        reject(Object.assign(new Error('[blender] ffmpeg assembly aborted'), { cancelled: true }));
        return;
      }
      if (code === 0) resolveExit();
      else reject(new Error(`[blender] ffmpeg exited ${code ?? 'spawn-error'}:\n${tail.text.slice(-1500)}`));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────

export const blenderAdapter: RendererAdapter = {
  id: 'blender',

  capabilities: {
    still: true,
    video: true,
    interactive: false,
    range: true,
    combine: false,
    aspect_ratios: ['16:9', '9:16', '1:1'],
    max_duration_ms: null, // local rendering is unbounded
    supported_codecs: ['h264', 'hevc', 'png', 'exr'],
    requires_network: false, // local execution
  },

  async validate(cell: Cell, ctx: RenderContext): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    const blenderBin = await resolveBlenderPath(ctx.vault);

    if (!blenderBin) {
      diagnostics.push({
        severity: 'error',
        code: 'BLENDER_NOT_FOUND',
        message:
          'Blender executable not found on host. Install Blender or configure `blender_executable_path` in settings.',
        path: 'renderer',
      });
    }

    if (cell.content_path) {
      const fullPath = resolve(ctx.projectRoot, cell.content_path);
      if (!existsSync(fullPath)) {
        diagnostics.push({
          severity: 'error',
          code: 'CONTENT_MISSING',
          message: `Blender source file missing at ${cell.content_path}`,
          path: 'content_path',
        });
      }
    }

    // Capability cross-check (G1/G2) — defensive second line of defence,
    // matching hyperframes.ts / excalidraw.ts. Since render() now actually
    // injects the resolved resolution (G-74 #6), this check protects against
    // a caller requesting an aspect outside the declared set rather than
    // papering over an unenforced one.
    if (!blenderAdapter.capabilities.aspect_ratios.includes(ctx.aspectRatio)) {
      diagnostics.push({
        severity: 'error',
        code: 'aspect-not-supported',
        message: `Blender adapter does not support aspect ratio ${ctx.aspectRatio}`,
      });
    }

    return diagnostics;
  },

  async preview(cell: Cell, ctx: RenderContext): Promise<PreviewURL> {
    if (ctx.signal.aborted) {
      const err = new Error('[blender] preview aborted before start');
      (err as Error & { cancelled?: boolean }).cancelled = true;
      throw err;
    }

    const outDir = join(ctx.rendersDir, 'blender', rungDir(cell.rung));
    mkdirSync(outDir, { recursive: true });
    const previewPng = join(outDir, `${cell.uid}_preview.png`);

    if (existsSync(previewPng)) {
      return `file://${previewPng}`;
    }

    const blenderBin = await resolveBlenderPath(ctx.vault);
    if (!blenderBin) {
      throw new Error('[blender] Executable not found. Cannot render preview.');
    }

    const contentPath = cell.content_path ? resolve(ctx.projectRoot, cell.content_path) : '';
    if (!contentPath || !existsSync(contentPath)) {
      throw new Error(`[blender] Content file missing at ${cell.content_path}`);
    }

    const { res } = resolveAspectAndResolution(undefined, ctx);

    // G-74 #2 fix: `-o`/`-F` now precede the render trigger `-f 1` (Blender
    // parses argv strictly left-to-right — a trailing `-o` after `-f` is a
    // no-op, which is exactly how the old code lost the preview frame to
    // the scene's default output path). Explicit `####` padding gives us a
    // predictable emitted filename instead of guessing Blender's default
    // pad width.
    const outPrefix = join(outDir, `${cell.uid}_preview_####`);
    const expectedFrame = join(outDir, `${cell.uid}_preview_0001.png`);

    const device = await resolveComputeDevice(blenderBin);
    const args = buildPreviewArgs(contentPath, res, outPrefix, device);

    const tail = { text: '' };
    await new Promise<void>((res2, rej) => {
      const child = spawn(blenderBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.stdout) drainToTail(child.stdout, tail);
      if (child.stderr) drainToTail(child.stderr, tail);
      const onAbort = () => {
        child.kill('SIGTERM');
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        ctx.signal.removeEventListener('abort', onAbort);
        rej(e);
      });
      child.on('close', (code) => {
        ctx.signal.removeEventListener('abort', onAbort);
        if (ctx.signal.aborted) {
          rej(Object.assign(new Error('[blender] preview aborted'), { cancelled: true }));
        } else if (code === 0) {
          res2();
        } else {
          rej(new Error(`[blender] Preview render exited with code ${code}:\n${tail.text.slice(-1500)}`));
        }
      });
    });

    if (!existsSync(expectedFrame)) {
      throw new Error(
        `[blender] preview render exited 0 but output not found at ${expectedFrame}\n${tail.text.slice(-1500)}`,
      );
    }

    return `file://${expectedFrame}`;
  },

  async render(cell: Cell, opts: RenderOptions, ctx: RenderContext): Promise<RenderRecord> {
    const recordId = randomUUID();

    // G-74 #5: bail before ever spawning if the caller raced cancel() in
    // ahead of dequeue — an abort listener registered post-spawn can never
    // fire for a signal that already fired.
    if (ctx.signal.aborted) {
      const err = new Error('[blender] render aborted before start (ctx.signal already aborted)');
      (err as Error & { cancelled?: boolean }).cancelled = true;
      throw err;
    }

    const blenderBin = await resolveBlenderPath(ctx.vault);
    if (!blenderBin) {
      throw new Error('[blender] Executable not found on host (G-51).');
    }

    const version = await getBlenderVersion(blenderBin);
    const { aspect, res } = resolveAspectAndResolution(opts, ctx);

    const { outDir, outPath } = blenderOutputPath(ctx.rendersDir, cell);
    mkdirSync(outDir, { recursive: true });

    const contentPath = cell.content_path ? resolve(ctx.projectRoot, cell.content_path) : '';
    if (!contentPath || !existsSync(contentPath)) {
      throw new Error(`[blender] Content path missing or unreadable: ${cell.content_path}`);
    }

    const startedAt = nowIso();
    const startedAtMs = Date.now();

    const totalFrames = computeTotalFrames(cell.duration_ms);

    let scratchDir: string | null = null;
    let currentChild: ChildProcess | null = null;

    const onAbort = () => {
      if (currentChild) killTree(currentChild);
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    try {
      scratchDir = mkdtempSync(join(tmpdir(), 'ikenga-blender-render-'));
      const framePattern = join(scratchDir, 'frame_####.png');

      // G-74 #2/#6 fix: output flags (`-o -F -x -s -e`) precede the render
      // trigger (`-a`); resolution is injected via `--python-expr` before
      // any of that so the requested aspect/resolution is real, not
      // scene-defined (G1 honesty).
      const device = await resolveComputeDevice(blenderBin);
      const args = buildRenderArgs(contentPath, res, framePattern, totalFrames, device);

      ctx.emit({
        type: 'render.progress',
        payload: { recordId, cellId: cell.uid, engine: 'blender', progress: 0, frame: 0 },
      });

      const stderrTail = { text: '' };
      let lastFrame = 0;
      let computeDevice: string | null = null;
      let lastBucket = -1;

      await new Promise<void>((resResolve, rej) => {
        const child = spawn(blenderBin, args, {
          cwd: ctx.projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        currentChild = child;
        activeChildren.set(recordId, child);
        if (child.pid !== undefined) recordRenderPid(recordId, child.pid);

        // G-74 #3 fix: stdout AND stderr are both drained. The old code only
        // attached a handler to stdout — any stderr chatty enough to fill
        // the 64KB OS pipe buffer would block Blender on write and wedge the
        // serial render queue forever.
        if (child.stderr) drainToTail(child.stderr, stderrTail);

        child.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          // G-BL-GPU: the injected preamble prints the device it bound.
          // Recorded as provenance so a silent CPU fallback is visible in
          // the ledger instead of only showing up as a slow render.
          const dev = parseDeviceFromChunk(text);
          if (dev !== null) computeDevice = dev;

          const currentFrame = parseFrameFromChunk(text);
          if (currentFrame !== null) {
            lastFrame = currentFrame;
            const progress = Math.min(1, currentFrame / totalFrames);
            const bucket = Math.floor(progress * 100);
            if (bucket !== lastBucket) {
              lastBucket = bucket;
              ctx.emit({
                type: 'render.progress',
                payload: { recordId, cellId: cell.uid, engine: 'blender', progress, frame: currentFrame },
              });
            }
          }
        });

        child.on('error', (err) => {
          activeChildren.delete(recordId);
          clearRenderPid(recordId);
          rej(err);
        });

        child.on('close', (code) => {
          activeChildren.delete(recordId);
          clearRenderPid(recordId);
          if (ctx.signal.aborted) {
            rej(Object.assign(new Error('[blender] render cancelled by abort signal'), { cancelled: true }));
          } else if (code === 0) {
            resResolve();
          } else {
            rej(new Error(`[blender] Process exited with code ${code}:\n${stderrTail.text.slice(-1500)}`));
          }
        });
      });

      currentChild = null;

      if (ctx.signal.aborted) {
        throw Object.assign(new Error('[blender] render aborted via ctx.signal'), { cancelled: true });
      }

      ctx.emit({
        type: 'render.progress',
        payload: { recordId, cellId: cell.uid, engine: 'blender', progress: 1, frame: lastFrame },
      });

      // Assemble the PNG sequence into the final MP4 (excalidraw.ts's
      // encode shape — see file header for why this beats renaming
      // Blender's own FFMPEG movie output).
      await assembleFrames(framePattern, outPath, res, ctx, (c) => {
        currentChild = c;
      });
      currentChild = null;

      if (ctx.signal.aborted) {
        throw Object.assign(new Error('[blender] render aborted via ctx.signal'), { cancelled: true });
      }

      if (!existsSync(outPath)) {
        throw new Error(`[blender] encode exited 0 but output missing at ${outPath}`);
      }

      const finishedAt = nowIso();
      const finishedAtMs = Date.now();

      const record: RenderRecord = {
        id: recordId,
        cell_uid: cell.uid,
        rung: cell.rung,
        engine: 'blender',
        model_id: 'blender-bpy',
        engine_version: version,
        variant: opts.variant ?? 'default',
        status: 'done',
        output: { uri: outPath, mime: 'video/mp4' },
        cost_estimate: 0,
        cost_actual: 0,
        started_at: startedAt,
        finished_at: finishedAt,
        metadata: {
          aspect_ratio: aspect,
          resolution_requested: res,
          resolution_actual: res,
          fps: BLENDER_FPS,
          duration_ms: cell.duration_ms,
          frames_observed: lastFrame,
          elapsed_ms: finishedAtMs - startedAtMs,
          compute_device: computeDevice ?? 'unknown',
        },
      };

      return record;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      activeChildren.delete(recordId);
      clearRenderPid(recordId);
      if (scratchDir && existsSync(scratchDir)) {
        try {
          rmSync(scratchDir, { recursive: true, force: true });
        } catch {
          // best-effort temp cleanup
        }
      }
    }
  },

  async cancel(recordId: string): Promise<void> {
    const child = activeChildren.get(recordId);
    if (!child) return;
    killTree(child);
  },
};

/**
 * Standalone 3D anchor plate generator (WP-25).
 * Renders multi-angle reference stills of a 3D asset (.glb/.obj) under 3-point lighting.
 */
export async function generateAnchorPlate(
  opts: {
    meshPath: string;
    angle: 'front' | 'three_quarter_left' | 'three_quarter_right' | 'profile';
    aspect?: AspectRatio;
    keyGetter?: () => Promise<string | undefined>;
  },
  outPath: string,
): Promise<{ uri: string; model_id: string; cost: number }> {
  const blenderBin = await resolveBlenderPath(opts.keyGetter ? { get: opts.keyGetter } : undefined);
  if (!blenderBin) {
    throw new Error('[blender] Executable not found on host.');
  }

  // Headless script setting up 3-point lighting & camera angle for asset import
  const pythonScript = `
import bpy, sys, math, mathutils

# Clear default scene
bpy.ops.wm.read_factory_settings(use_empty=True)

# Import mesh
mesh_path = sys.argv[sys.argv.index('--mesh') + 1]
if mesh_path.endswith('.glb') or mesh_path.endswith('.gltf'):
    bpy.ops.import_scene.gltf(filepath=mesh_path)
elif mesh_path.endswith('.obj'):
    bpy.ops.wm.obj_import(filepath=mesh_path)

# ── Fit the subject (G-PLATE-FIT) ────────────────────────────────────────
# The camera used to sit at a hardcoded cam_dist=4.0 aimed by fixed euler
# angles, which framed exactly one asset size: anything else was cropped or
# lost in the distance. (Verified 2026-09-07: a stock 2-unit Suzanne ran off
# both the right and bottom edges.) Plates exist to be COMPARABLE reference
# of a character across angles, so the subject must land at the same size in
# every plate, for every asset.
#
# Angles stay fixed — only distance adapts, derived from the mesh's world
# bounding sphere and the camera's actual FOV. Lighting scales with the same
# radius, or a large asset would be lit by three candles at its feet.
_objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
_coords = [o.matrix_world @ mathutils.Vector(c) for o in _objs for c in o.bound_box]
if _coords:
    _min = mathutils.Vector((min(c.x for c in _coords), min(c.y for c in _coords), min(c.z for c in _coords)))
    _max = mathutils.Vector((max(c.x for c in _coords), max(c.y for c in _coords), max(c.z for c in _coords)))
    center = (_min + _max) / 2.0
    radius = max((c - center).length for c in _coords) or 1.0
else:
    center = mathutils.Vector((0.0, 0.0, 0.0))
    radius = 1.0

# Camera Setup
cam_data = bpy.data.cameras.new("Camera")
cam_obj = bpy.data.objects.new("Camera", cam_data)
bpy.context.scene.collection.objects.link(cam_obj)
bpy.context.scene.camera = cam_obj

angle = sys.argv[sys.argv.index('--angle') + 1]
_dirs = {
    'front': mathutils.Vector((0.0, -1.0, 0.22)),
    'three_quarter_left': mathutils.Vector((-0.7, -0.7, 0.22)),
    'three_quarter_right': mathutils.Vector((0.7, -0.7, 0.22)),
    'profile': mathutils.Vector((1.0, 0.0, 0.22)),
}
_dir = _dirs.get(angle, _dirs['front']).normalized()

# Fit the bounding SPHERE in the NARROWER of the two FOV axes, with a small
# margin, so a portrait plate crops the subject no more than a landscape one.
#
# Sphere-fitting is deliberate. Scene.camera_fit_coords() would fit the
# projected geometry more tightly, but it DOES NOT EXIST in Blender 5.2
# (AttributeError) — and because Blender exits 0 on an uncaught Python
# exception (see the exit-code guard below), reaching for it fails silently.
# The sphere is conservative for a wide subject, which is the right way to be
# wrong for a reference plate: too much margin is legible, a cropped face is
# not.
_fov = min(cam_data.angle_x, cam_data.angle_y)
cam_dist = (radius / math.sin(_fov / 2.0)) * 1.08
cam_obj.location = center + _dir * cam_dist
# Aim at the centre instead of guessing an euler — this is what kept the old
# fixed rotations from ever pointing at an off-origin asset.
cam_obj.rotation_euler = (center - cam_obj.location).to_track_quat('-Z', 'Y').to_euler()

# 3-Point Lighting — positions and energy scale with the subject so the rig
# reads the same on a prop and on a full figure. Inverse-square means energy
# must grow with distance squared to hold exposure.
_lr = radius * 2.5
_energy_scale = max(1.0, (_lr / 3.0) ** 2)

key_light = bpy.data.lights.new("KeyLight", type='AREA')
key_light.energy = 500 * _energy_scale
key_light.size = radius
key_obj = bpy.data.objects.new("KeyLight", key_light)
key_obj.location = center + mathutils.Vector((-0.55, -0.8, 0.8)).normalized() * _lr
key_obj.rotation_euler = (center - key_obj.location).to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.collection.objects.link(key_obj)

fill_light = bpy.data.lights.new("FillLight", type='AREA')
fill_light.energy = 250 * _energy_scale
fill_light.size = radius
fill_obj = bpy.data.objects.new("FillLight", fill_light)
fill_obj.location = center + mathutils.Vector((0.85, -0.5, 0.45)).normalized() * _lr
fill_obj.rotation_euler = (center - fill_obj.location).to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.collection.objects.link(fill_obj)

rim_light = bpy.data.lights.new("RimLight", type='SPOT')
rim_light.energy = 400 * _energy_scale
rim_light.spot_size = math.radians(90)
rim_obj = bpy.data.objects.new("RimLight", rim_light)
rim_obj.location = center + mathutils.Vector((0.0, 0.9, 0.8)).normalized() * _lr
rim_obj.rotation_euler = (center - rim_obj.location).to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.collection.objects.link(rim_obj)

# Render settings
bpy.context.scene.render.image_settings.file_format = 'PNG'
bpy.context.scene.render.filepath = sys.argv[sys.argv.index('--out') + 1]
bpy.ops.render.render(write_still=True)
print('${PLATE_OK_SENTINEL}')
`;

  mkdirSync(dirname(outPath), { recursive: true });

  // Blender exits 0 even when --python-expr raises (verified 5.2.1: an
  // uncaught RuntimeError still yields exit code 0), so `code === 0` proves
  // nothing on its own. Two guards close that hole:
  //   1. remove any previous plate first — otherwise existsSync() happily
  //      passes on a STALE file and a failed render reports success. This
  //      actually fooled a verification pass on 2026-09-07.
  //   2. require the sentinel that only the final line of the script prints.
  if (existsSync(outPath)) {
    rmSync(outPath, { force: true });
  }

  const tail = { text: '' };
  await new Promise<void>((res, rej) => {
    const args = [
      '--background',
      '--python-expr',
      pythonScript,
      '--',
      '--mesh',
      opts.meshPath,
      '--angle',
      opts.angle,
      '--out',
      outPath,
    ];
    const child = spawn(blenderBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // G-74 #3 fix: drain both piped streams so a chatty import/render can't
    // deadlock on a full stderr pipe.
    if (child.stdout) drainToTail(child.stdout, tail);
    if (child.stderr) drainToTail(child.stderr, tail);
    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0 && existsSync(outPath) && tail.text.includes(PLATE_OK_SENTINEL)) {
        res();
      } else {
        rej(
          new Error(
            `[blender] Anchor plate generation failed (exit ${code}, ` +
              `output ${existsSync(outPath) ? 'present' : 'missing'}, ` +
              `sentinel ${tail.text.includes(PLATE_OK_SENTINEL) ? 'seen' : 'ABSENT'}):\n` +
              tail.text.slice(-1500),
          ),
        );
      }
    });
  });

  return { uri: outPath, model_id: 'blender-3point', cost: 0 };
}

export default blenderAdapter;
