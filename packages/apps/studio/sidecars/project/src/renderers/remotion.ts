/**
 * Remotion renderer adapter (WP-13, Phase 3).
 *
 * Deterministic React/TSX video rendering engine for com.ikenga.studio.
 * Spawns the Remotion CLI against on-disk .tsx cell compositions,
 * streams frame progress as `render.progress`, and outputs deterministic MP4 renders.
 *
 * ─── Pinned Chrome (G24) ──────────────────────────────────────────────────
 * Uses `resolveChromeExecutable()` from `./chrome.ts` and sets both
 * `PUPPETEER_EXECUTABLE_PATH` in env and `--browser-executable` in CLI args.
 *
 * ─── Output Path (G14) ────────────────────────────────────────────────────
 * Lands at `<rendersDir>/remotion/<rungDir(cell.rung)>/<uid>.mp4`.
 *
 * ─── Anti-trap Guarantees (blender-headless + 09-orchestration) ───────────
 * 1. Output file deleted before spawn to prevent stale passes.
 * 2. Strict success guard: code === 0 AND file exists AND size > 0.
 * 3. Detached process group with negative-PID kill escalation for clean cancellation.
 * 4. Robust multi-pattern progress parsing with ANSI escape stripping.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_RESOLUTION,
  rungDir,
  type AspectRatio,
  type Cell,
  type RenderRecord,
} from '@ikenga/studio-schema';

import { resolveChromeExecutable } from './chrome.js';
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

export const REMOTION_DEFAULT_FPS = 30;

const activeChildren = new Map<string, ChildProcess>();

let cachedEngineVersion: string | null = null;
let cachedRemotionBin: string | null = null;

// ─────────────────────────────────────────────────────────────────────────
// Process & Execution Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Terminate a detached child process and its entire process group.
 * SIGTERM first, then SIGKILL after grace period.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const isWin = process.platform === 'win32';

  if (isWin) {
    try {
      // On Windows, taskkill /T /F ensures the entire process tree is terminated
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    return;
  }

  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
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

/** Strip ANSI escape sequences from console output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Parse progress from Remotion CLI stdout/stderr chunks.
 * Matches:
 *   - "Rendering frames ... 30/120" / "Rendered frames ... 120/120"
 *   - "Encoding video ... 60/120" / "Muxing video ... 120/120"
 *   - "Bundling code ... 45%"
 *   - General frame patterns "N/M frames"
 */
export function parseProgressLine(
  rawLine: string,
): { frame: number; total: number | null } | { pct: number } | null {
  const line = stripAnsi(rawLine).trim();
  if (!line) return null;

  // 1. Rendering / Rendered / Encoding / Muxing frames N/M
  const m1 = line.match(/(?:Rendering|Rendered|Encoding|Encoded|Muxing|Muxed)\s+(?:frames?|video|audio|still)?\s*.*?(\d+)\s*\/\s*(\d+)/i);
  if (m1) {
    const frame = Number(m1[1]);
    const total = Number(m1[2]);
    if (Number.isFinite(frame) && Number.isFinite(total) && total > 0) {
      return { frame, total };
    }
  }

  // 2. Explicit N/M progress (e.g. from table or column view: "  45/120  ")
  const m2 = line.match(/(?:^|\s)(\d+)\s*\/\s*(\d+)\s*(?:frames?|remaining|\d+ms)?/i);
  if (m2) {
    const frame = Number(m2[1]);
    const total = Number(m2[2]);
    if (Number.isFinite(frame) && Number.isFinite(total) && total > 0 && frame <= total) {
      return { frame, total };
    }
  }

  // 3. Bundling progress: "Bundling code ... 25%"
  const m3 = line.match(/(?:Bundling|Bundled)\s+code\s*.*?(\d{1,3})%/i);
  if (m3) {
    const v = Number(m3[1]);
    if (v >= 0 && v <= 100) return { pct: v / 100 };
  }

  // 4. Standalone percentage bar
  const m4 = line.match(/(\d{1,3})%\s*(?:$|\s)/);
  if (m4) {
    const v = Number(m4[1]);
    if (v >= 0 && v <= 100) return { pct: v / 100 };
  }

  return null;
}

/**
 * Resolve local or system Remotion CLI executable.
 * Checks vault, environment, local node_modules/.bin, monorepo roots, and PATH.
 */
export async function resolveRemotionExecutable(
  projectRoot?: string,
  vault?: { get(key: string): Promise<string | undefined> },
): Promise<string> {
  if (cachedRemotionBin && existsSync(cachedRemotionBin)) {
    return cachedRemotionBin;
  }

  // 1. Vault override
  if (vault) {
    const fromVault = await vault.get('remotion_executable_path');
    if (fromVault && existsSync(fromVault)) {
      cachedRemotionBin = fromVault;
      return fromVault;
    }
  }

  // 2. Env override
  if (process.env.REMOTION_PATH && existsSync(process.env.REMOTION_PATH)) {
    cachedRemotionBin = process.env.REMOTION_PATH;
    return process.env.REMOTION_PATH;
  }

  const isWin = process.platform === 'win32';
  const binName = isWin ? 'remotion.cmd' : 'remotion';

  // 3. Project-local or monorepo node_modules/.bin
  const candidates: string[] = [];
  if (projectRoot) {
    candidates.push(join(projectRoot, 'node_modules', '.bin', binName));
    candidates.push(join(projectRoot, '..', 'node_modules', '.bin', binName));
    candidates.push(join(projectRoot, '..', '..', 'node_modules', '.bin', binName));
    candidates.push(join(projectRoot, '..', '..', '..', 'node_modules', '.bin', binName));
  }

  for (const c of candidates) {
    if (existsSync(c)) {
      cachedRemotionBin = c;
      return c;
    }
  }

  // 4. Fallback to npx
  return isWin ? 'npx.cmd' : 'npx';
}

/** Query and cache `remotion --version`. */
export async function detectEngineVersion(remotionBin?: string): Promise<string> {
  if (cachedEngineVersion !== null) return cachedEngineVersion;

  return new Promise<string>((resolveExit) => {
    const isNpx = !remotionBin || remotionBin === 'npx' || remotionBin === 'npx.cmd';
    const bin = isNpx ? (process.platform === 'win32' ? 'npx.cmd' : 'npx') : remotionBin;
    const args = isNpx ? ['--yes', '--package=@remotion/cli', 'remotion', '--version'] : ['--version'];

    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      cachedEngineVersion = 'unknown';
      return resolveExit('unknown');
    }

    let out = '';
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('error', () => {
      cachedEngineVersion = 'unknown';
      resolveExit('unknown');
    });
    child.on('close', () => {
      const clean = stripAnsi(out);
      const m = clean.match(/(\d+\.\d+\.\d+[\w.-]*)/);
      cachedEngineVersion = m ? m[1] : clean.trim() || 'unknown';
      resolveExit(cachedEngineVersion);
    });
  });
}

/** Resolve output file path under `<rendersDir>/remotion/<rungDir>/<uid>.mp4`. */
export function resolveOutputPath(cell: Cell, ctx: RenderContext): string {
  const dir = join(ctx.rendersDir, 'remotion', rungDir(cell.rung));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const base = join(dir, `${cell.uid}.mp4`);
  if (!existsSync(base)) return base;
  const suffix = randomUUID().slice(0, 8);
  return join(dir, `${cell.uid}.${suffix}.mp4`);
}

/** Resolve cell's absolute content path. */
export function absContentPath(cell: Cell, ctx: RenderContext): string {
  return isAbsolute(cell.content_path)
    ? cell.content_path
    : resolve(ctx.projectRoot, cell.content_path);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Prepares the Remotion entrypoint for rendering.
 * If the source file already contains `registerRoot`, it is used directly.
 * Otherwise, generates an ephemeral wrapper that imports the component and calls `registerRoot`.
 */
export function prepareEntrypoint(
  cell: Cell,
  ctx: RenderContext,
  opts: { durationInFrames: number; fps: number; width: number; height: number },
): { entryPath: string; isTemp: boolean; compositionId: string; tempDir?: string } {
  const sourcePath = absContentPath(cell, ctx);
  const metadataCompId = typeof cell.metadata?.composition_id === 'string'
    ? cell.metadata.composition_id
    : undefined;

  let sourceContent = '';
  try {
    sourceContent = readFileSync(sourcePath, 'utf8');
  } catch {
    // If not readable, let Remotion CLI fail with an informative path
    return { entryPath: sourcePath, isTemp: false, compositionId: metadataCompId ?? cell.uid };
  }

  // If registerRoot is already present, use file as-is
  if (sourceContent.includes('registerRoot(')) {
    return {
      entryPath: sourcePath,
      isTemp: false,
      compositionId: metadataCompId ?? cell.uid,
    };
  }

  // Generate ephemeral entrypoint
  const tempDir = mkdtempSync(join(tmpdir(), 'studio-remotion-'));
  const entryPath = join(tempDir, 'entry.tsx');
  const compId = metadataCompId ?? 'Cell';

  // Normalize path for JS import
  const escapedImport = sourcePath.replace(/\\/g, '/');

  const wrapperCode = `
import React from 'react';
import { registerRoot, Composition } from 'remotion';
import * as CellModule from '${escapedImport}';

const Component = (CellModule as any).default || (CellModule as any).Composition || (CellModule as any)[Object.keys(CellModule)[0]] || (() => null);

export const Root: React.FC = () => {
  return (
    <Composition
      id="${compId}"
      component={Component}
      durationInFrames={${opts.durationInFrames}}
      fps={${opts.fps}}
      width={${opts.width}}
      height={${opts.height}}
    />
  );
};

registerRoot(Root);
`;

  writeFileSync(entryPath, wrapperCode, 'utf8');
  return { entryPath, isTemp: true, compositionId: compId, tempDir };
}

// ─────────────────────────────────────────────────────────────────────────
// Adapter Implementation
// ─────────────────────────────────────────────────────────────────────────

export const remotionAdapter: RendererAdapter = {
  id: 'remotion',

  capabilities: {
    still: true,
    video: true,
    interactive: false,
    range: true,
    combine: false,
    aspect_ratios: ['16:9', '9:16', '1:1'],
    max_duration_ms: null,
    supported_codecs: ['h264', 'hevc'],
    requires_network: false,
  },

  async validate(cell, ctx) {
    const diags: Diagnostic[] = [];
    const abs = absContentPath(cell, ctx);

    // 1. Existence
    if (!existsSync(abs)) {
      diags.push({
        severity: 'error',
        code: 'content-missing',
        message: `Cell content not found on disk: ${abs}`,
        path: 'content_path',
      });
      return diags;
    }

    // 2. Extension (.tsx)
    if (!abs.toLowerCase().endsWith('.tsx')) {
      diags.push({
        severity: 'error',
        code: 'unsupported-content-type',
        message: 'Remotion requires .tsx cell content',
        path: 'content_path',
      });
    }

    // 3. Non-empty
    let bytes = 0;
    try {
      bytes = statSync(abs).size;
    } catch {
      // handled
    }
    if (bytes === 0) {
      diags.push({
        severity: 'error',
        code: 'content-empty',
        message: 'Cell .tsx file is empty',
        path: 'content_path',
      });
    }

    // 4. Aspect ratio check
    const aspect = ctx.aspectRatio;
    if (!remotionAdapter.capabilities.aspect_ratios.includes(aspect)) {
      diags.push({
        severity: 'error',
        code: 'aspect-not-supported',
        message: `Remotion does not support aspect ratio ${aspect}`,
      });
    }

    return diags;
  },

  async preview(cell, ctx) {
    const outDir = join(ctx.rendersDir, 'remotion', 'preview');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const previewPath = join(outDir, `${cell.uid}.png`);

    // If an MP4 render already exists, returning it or preview still is valid
    if (existsSync(previewPath)) {
      return `file://${previewPath}`;
    }

    // Render still frame via remotion still
    const abs = absContentPath(cell, ctx);
    const aspect = ctx.aspectRatio;
    const resolution = ctx.resolution ?? DEFAULT_RESOLUTION[aspect];
    const fps = REMOTION_DEFAULT_FPS;
    const durationMs = cell.duration_ms || 3000;
    const totalFrames = Math.max(1, Math.round((durationMs / 1000) * fps));

    const { entryPath, isTemp, compositionId, tempDir } = prepareEntrypoint(cell, ctx, {
      durationInFrames: totalFrames,
      fps,
      width: resolution.w,
      height: resolution.h,
    });

    let chromePath: string;
    try {
      chromePath = resolveChromeExecutable();
    } catch {
      chromePath = '';
    }

    const remotionBin = await resolveRemotionExecutable(ctx.projectRoot, ctx.vault);
    const isNpx = remotionBin === 'npx' || remotionBin === 'npx.cmd';
    const bin = isNpx ? (process.platform === 'win32' ? 'npx.cmd' : 'npx') : remotionBin;

    const args = [
      ...(isNpx ? ['--yes', '--package=@remotion/cli', 'remotion'] : []),
      'still',
      entryPath,
      compositionId,
      previewPath,
      '--frame=0',
      '--overwrite',
      ...(chromePath ? [`--browser-executable=${chromePath}`] : []),
    ];

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(bin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...(chromePath ? { PUPPETEER_EXECUTABLE_PATH: chromePath, PUPPETEER_SKIP_DOWNLOAD: 'true' } : {}),
          },
        });
        child.on('error', rejectPromise);
        child.on('close', (code) => {
          if (code === 0 && existsSync(previewPath)) resolvePromise();
          else rejectPromise(new Error(`remotion still exited with code ${code}`));
        });
      });
    } catch {
      // Fall back to file URL of source if still generation fails
      return `file://${abs}`;
    } finally {
      if (isTemp && tempDir && existsSync(tempDir)) {
        try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    return `file://${previewPath}`;
  },

  async render(cell, opts, ctx) {
    if (ctx.signal.aborted) {
      throw new Error('[remotion] render aborted before spawn');
    }

    const recordId = randomUUID();
    const startedAt = nowIso();
    const startedAtMs = Date.now();

    const aspect: AspectRatio = opts.aspect_ratio ?? ctx.aspectRatio;
    const resolution = opts.resolution ?? ctx.resolution ?? DEFAULT_RESOLUTION[aspect];
    const durationMs = cell.duration_ms || 3000;
    const fps = REMOTION_DEFAULT_FPS;
    const totalFrames = Math.max(1, Math.round((durationMs / 1000) * fps));

    const outPath = resolveOutputPath(cell, ctx);

    // Trap 1 Defense: delete prior output before spawning so staleness cannot mask failure
    if (existsSync(outPath)) {
      rmSync(outPath, { force: true });
    }

    const { entryPath, isTemp, compositionId, tempDir } = prepareEntrypoint(cell, ctx, {
      durationInFrames: totalFrames,
      fps,
      width: resolution.w,
      height: resolution.h,
    });

    let chromePath = '';
    try {
      chromePath = resolveChromeExecutable();
    } catch (e) {
      // Non-fatal if Remotion has its own bundled headless shell; log diagnostic
      console.warn(`[remotion] Pinned Chrome warning: ${(e as Error).message}`);
    }

    const remotionBin = await resolveRemotionExecutable(ctx.projectRoot, ctx.vault);
    const engineVersion = await detectEngineVersion(remotionBin);

    const isNpx = remotionBin === 'npx' || remotionBin === 'npx.cmd';
    const bin = isNpx ? (process.platform === 'win32' ? 'npx.cmd' : 'npx') : remotionBin;

    const args = [
      ...(isNpx ? ['--yes', '--package=@remotion/cli', 'remotion'] : []),
      'render',
      entryPath,
      compositionId,
      outPath,
      '--overwrite',
      `--fps=${fps}`,
      `--width=${resolution.w}`,
      `--height=${resolution.h}`,
      '--concurrency=2',
      ...(chromePath ? [`--browser-executable=${chromePath}`] : []),
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(chromePath
        ? {
            PUPPETEER_EXECUTABLE_PATH: chromePath,
            PUPPETEER_SKIP_DOWNLOAD: 'true',
          }
        : {}),
    };

    return new Promise<RenderRecord>((resolvePromise, rejectPromise) => {
      let child: ChildProcess;
      try {
        child = spawn(bin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
          detached: process.platform !== 'win32',
        });
      } catch (err) {
        if (isTemp && tempDir && existsSync(tempDir)) {
          try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        return rejectPromise(err);
      }

      activeChildren.set(recordId, child);
      if (child.pid !== undefined) {
        recordRenderPid(recordId, child.pid);
      }

      let stderrTail = '';

      const onAbort = () => {
        killTree(child);
        cleanup();
        rejectPromise(new Error('[remotion] render cancelled by signal'));
      };

      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => {
        ctx.signal.removeEventListener('abort', onAbort);
        activeChildren.delete(recordId);
        clearRenderPid(recordId);
        if (isTemp && tempDir && existsSync(tempDir)) {
          try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      };

      const handleChunk = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        const lines = text.split(/[\r\n]+/);
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = parseProgressLine(line);
          if (parsed) {
            let progressValue = 0;
            let frameNum: number | undefined;
            if ('frame' in parsed) {
              frameNum = parsed.frame;
              const total = parsed.total ?? totalFrames;
              progressValue = Math.min(1, Math.max(0, parsed.frame / total));
            } else if ('pct' in parsed) {
              progressValue = parsed.pct;
            }
            ctx.emit({
              type: 'render.progress',
              payload: {
                recordId,
                cellId: cell.uid,
                engine: 'remotion',
                progress: progressValue,
                frame: frameNum,
              },
            });
          }
        }
      };

      child.stdout?.on('data', handleChunk);
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        handleChunk(chunk);
        stderrTail += text;
        if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);
      });

      child.on('error', (err) => {
        cleanup();
        rejectPromise(err);
      });

      child.on('close', (code) => {
        cleanup();

        // Trap 1 Defense: require exit code 0 AND output exists AND non-zero size
        const outputExists = existsSync(outPath);
        const outputSize = outputExists ? statSync(outPath).size : 0;

        if (code !== 0 || !outputExists || outputSize === 0) {
          return rejectPromise(
            new Error(
              `[remotion] Render failed (exit code: ${code}, output present: ${outputExists}, size: ${outputSize} bytes). ${stderrTail.slice(-1000)}`,
            ),
          );
        }

        const record: RenderRecord = {
          id: recordId,
          cell_uid: cell.uid,
          engine: 'remotion',
          engine_version: engineVersion,
          variant: opts.variant ?? 'default',
          cost_actual: 0,
          cost_estimate: 0,
          status: 'done',
          started_at: startedAt,
          finished_at: nowIso(),
          output: {
            uri: relative(ctx.projectRoot, outPath),
            mime: 'video/mp4',
          },
          metadata: {
            fps,
            total_frames: totalFrames,
            composition_id: compositionId,
            size_bytes: outputSize,
            width: resolution.w,
            height: resolution.h,
            aspect_ratio: aspect,
          },
        };

        resolvePromise(record);
      });
    });
  },

  async cancel(recordId) {
    const child = activeChildren.get(recordId);
    if (child) {
      killTree(child);
      activeChildren.delete(recordId);
      clearRenderPid(recordId);
    }
  },
};
