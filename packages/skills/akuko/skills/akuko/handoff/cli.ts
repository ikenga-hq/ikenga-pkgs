/**
 * akuko — command line for the DaVinci Resolve handoff (hosts B and C). Free: no provider, no spend.
 *
 *   node --experimental-strip-types handoff/cli.ts export --project <folder>
 *        [--out <folder>] [--format fcpxml|edl|both] [--fps 24] [--timeline-only]
 *
 *   export   writes the export folder (default `<project>/export/resolve`): approved media copied in
 *            shot order, `timeline.fcpxml` (and EDLs with --format edl|both), README.md, LEFT-OUT.md,
 *            checksums.sha256. It changes no stage or unit status and writes nothing to akuko.json.
 *   --fps    timeline frame rate: 23.976, 24 (default), 25, 29.97, 30, 50, 59.94 or 60. The project
 *            records none, so this is the only place it is chosen.
 *   --timeline-only   copy nothing; write the timeline and DOWNLOAD-LIST.md. For a project whose
 *            files are not on this machine (claude.ai): clip lengths are not checked.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost } from '../hosts/local.ts';
import { HandoffError, timecode } from './timecode.ts';
import { writeExport, type TimelineFormat } from './write.ts';

export interface CliResult { code: number; out: string }

function flags(argv: string[]): { cmd: string; opt: Map<string, string | true> } {
  const [cmd = '', ...rest] = argv;
  const opt = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) { opt.set(a.slice(2), next); i++; } else opt.set(a.slice(2), true);
  }
  return { cmd, opt };
}
const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const NL = '\n';

export async function run(argv: string[], now: () => Date = () => new Date()): Promise<CliResult> {
  const { cmd, opt } = flags(argv);
  if (cmd !== 'export') return { code: 2, out: 'akuko: command must be export.' };
  const dir = str(opt.get('project'));
  if (!dir) return { code: 2, out: 'akuko: --project <folder> is required.' };
  const format = (str(opt.get('format')) ?? 'fcpxml') as TimelineFormat;
  if (!['fcpxml', 'edl', 'both'].includes(format)) return { code: 2, out: 'akuko: --format must be fcpxml, edl or both.' };
  try {
    const host = createLocalHost({ projectDir: dir, now });
    const project = await host.readState();
    const fps = str(opt.get('fps'));
    const r = await writeExport({
      project,
      projectDir: resolve(dir),
      outDir: str(opt.get('out')) ?? resolve(dir, 'export', 'resolve'),
      ...(fps ? { fps } : {}),
      format,
      ...(opt.has('timeline-only') ? { timelineOnly: true } : {}),
    });
    const p = r.plan;
    const out = [
      `Exported ${p.shots.length} shot${p.shots.length === 1 ? '' : 's'}, ${timecode(p.totalFrames, p.fps)} (${p.totalFrames} frames at ${p.fps.label} fps), to ${r.outDir}`,
      `  on the video track: ${p.shots.filter((s) => s.uses === 'clip').length} clip(s), ${p.shots.filter((s) => s.uses === 'still').length} still(s), ${p.shots.filter((s) => s.uses === 'gap').length} gap(s)${p.shots.some((s) => s.uses === 'no-duration') ? `, ${p.shots.filter((s) => s.uses === 'no-duration').length} left off (no duration)` : ''}`,
      `  audio: ${p.audio.length} placed${p.notPlaced.length ? `, ${p.notPlaced.length} not placed` : ''}${p.captions.length ? ', captions copied' : ''}`,
      `  files: ${r.written.length} written, ${r.unchanged.length} already up to date${r.removed.length ? `, ${r.removed.length} removed (no longer in the export)` : ''}`,
      ...(r.keptModified.length ? [`  kept (you changed them since the last export): ${r.keptModified.join(', ')}`] : []),
      `  left out: ${p.leftOut.length} (see LEFT-OUT.md)`,
      ...p.warnings.map((w) => `Note: ${w}`),
      'Next: open README.md in the export folder for the Resolve import steps.',
    ];
    return { code: 0, out: out.join(NL) };
  } catch (err) {
    if (err instanceof HandoffError) return { code: 1, out: `${err.message}` };
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
