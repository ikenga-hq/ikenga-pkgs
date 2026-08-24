import { exec, spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { dirname, join } from 'path';
import { promisify } from 'util';
import type { Cell, RenderRecord } from '@ikenga/studio-schema';
import type { Diagnostic, PreviewURL, RenderContext, RenderOptions, RendererAdapter } from './types.js';

const execAsync = promisify(exec);

export class BlenderAdapter implements RendererAdapter {
  readonly id = 'blender';

  readonly capabilities = {
    still: true,
    video: true,
    interactive: false,
    range: true,
    combine: false,
    aspect_ratios: ['16:9', '9:16', '1:1'] as any[],
    max_duration_ms: null,
    supported_codecs: ['h264', 'png'],
    requires_network: false,
  };

  private async findBlenderBinary(): Promise<string | null> {
    try {
      const { stdout } = await execAsync('which blender');
      if (stdout.trim()) return stdout.trim();
    } catch {
      // ignore
    }
    const defaultPaths = ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender'];
    for (const p of defaultPaths) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  async validate(cell: Cell, ctx: RenderContext): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];

    const blenderPath = await this.findBlenderBinary();
    if (!blenderPath) {
      diagnostics.push({
        severity: 'warning',
        code: 'BLENDER_NOT_FOUND',
        message: 'Blender executable not found in PATH or standard locations.',
      });
    }

    const contentPath = join(ctx.cellDir, cell.content_path || 'scene.blend');
    if (!existsSync(contentPath)) {
      diagnostics.push({
        severity: 'error',
        code: 'MISSING_BLEND_FILE',
        message: `Blender content file does not exist: ${contentPath}`,
        path: 'content_path',
      });
    }

    return diagnostics;
  }

  async preview(cell: Cell, ctx: RenderContext): Promise<PreviewURL> {
    const previewPng = join(ctx.rendersDir, `${cell.uid}_preview.png`);
    if (existsSync(previewPng)) {
      return `file://${previewPng}`;
    }
    return `file://${join(ctx.cellDir, cell.content_path || 'scene.blend')}`;
  }

  async render(cell: Cell, opts: RenderOptions, ctx: RenderContext): Promise<RenderRecord> {
    const startTime = Date.now();
    const blenderBin = (await this.findBlenderBinary()) || 'blender';

    const contentPath = join(ctx.cellDir, cell.content_path || 'scene.blend');
    const outputPath = join(ctx.rendersDir, `blender_${cell.uid}_#.mp4`);

    await fs.mkdir(ctx.rendersDir, { recursive: true });

    return new Promise<RenderRecord>((resolve, reject) => {
      // Spawn blender headless: blender -b <file> -o <output> -a
      const args = ['-b', contentPath, '-o', outputPath, '-F', 'H264', '-x', '1', '-a'];

      const child = spawn(blenderBin, args, {
        cwd: ctx.cellDir,
        env: { ...process.env },
      });

      let totalFrames = 100;
      let currentFrame = 0;

      const handleAbort = () => {
        child.kill('SIGKILL');
        reject(new Error('Blender render cancelled'));
      };

      if (ctx.signal.aborted) {
        return handleAbort();
      }
      ctx.signal.addEventListener('abort', handleAbort);

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        // Parse stdout line like "Fra:15 Mem:20.4M ..."
        const match = text.match(/Fra:(\d+)/);
        if (match) {
          currentFrame = parseInt(match[1], 10);
          const progress = Math.min(1.0, currentFrame / totalFrames);
          ctx.emit({
            type: 'render/progress',
            payload: {
              cellUid: cell.uid,
              engine: this.id,
              progress,
              frame: currentFrame,
            },
          });
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        console.warn(`[Blender stderr] ${data.toString()}`);
      });

      child.on('close', (code) => {
        ctx.signal.removeEventListener('abort', handleAbort);

        const durationMs = Date.now() - startTime;
        const finalMp4Path = join(ctx.rendersDir, `blender_${cell.uid}_0001.mp4`);

        if (code === 0 || existsSync(finalMp4Path)) {
          resolve({
            id: `blender_${cell.uid}_${Date.now()}`,
            cell_id: cell.uid,
            engine: this.id,
            output_path: finalMp4Path,
            status: 'done',
            created_at: new Date().toISOString(),
            duration_ms: durationMs,
            cost_actual: 0,
            metadata: {
              aspect_ratio: opts.aspect_ratio || ctx.aspectRatio,
              resolution: opts.resolution || ctx.resolution,
            },
          });
        } else {
          reject(new Error(`Blender process exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        ctx.signal.removeEventListener('abort', handleAbort);
        reject(err);
      });
    });
  }
}
