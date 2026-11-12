/**
 * akuko — command line for `assemble preview` (B-11). Free: no provider, no spend, never writes akuko.json.
 *
 *   node --experimental-strip-types assemble/cli.ts preview --project <folder> [--out <file.mp4>] [--fps 24] [--dry-run]
 *   node --experimental-strip-types assemble/cli.ts preview --state <akuko.json> --media <folder> [--out <file.mp4>] ...
 *
 *   preview   an animatic preview: each approved key frame held for its shot's length, in film order, with a
 *             gentle move only where the shot asks for one; black where a key frame is not approved yet. Writes
 *             one silent MP4 when ffmpeg is available (default `<project>/cut/preview/animatic-preview.mp4`).
 *             It is never a review unit and records nothing in the project.
 *   --state / --media   host A (claude.ai): the project read from the board's database and saved to a file, and
 *             a folder holding the downloaded key frames, each named `<asset id>.<ext>` or by its file name.
 *   --dry-run  print the timing only.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AkukoProjectSchema, type AkukoProject } from '../schema/akuko-project.ts';
import { createLocalHost } from '../hosts/local.ts';
import { localPath } from '../handoff/write.ts';
import { HandoffError, parseFps } from '../handoff/timecode.ts';
import { describePreview, planPreview, renderPreview, type RenderPreviewOptions } from './preview.ts';

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

/** Host A: find a downloaded key frame in `media` by its asset id (`sc1_sh1_keyframe.png`) or by the uri's file name. */
function mediaResolver(media: string, assetOf: Map<string, string>): (uri: string) => string | undefined {
  const names = existsSync(media) ? readdirSync(media) : [];
  return (uri) => {
    const id = assetOf.get(uri);
    const byId = id !== undefined ? names.find((n) => basename(n, extname(n)) === id) : undefined;
    const byName = names.find((n) => n === basename(uri.split('?')[0] ?? uri));
    const hit = byId ?? byName;
    return hit !== undefined ? join(media, hit) : undefined;
  };
}

export async function run(argv: string[], opts: Pick<RenderPreviewOptions, 'available' | 'run' | 'ffmpeg'> = {}): Promise<CliResult> {
  const { cmd, opt } = flags(argv);
  if (cmd !== 'preview') return { code: 2, out: 'akuko: command must be preview (the rest of assemble, rough cut and picture lock, is not built yet).' };
  const dir = str(opt.get('project'));
  const stateFile = str(opt.get('state'));
  if (!dir && !stateFile) return { code: 2, out: 'akuko: --project <folder> (or --state <akuko.json> --media <folder> on claude.ai) is required.' };
  try {
    const fps = parseFps(str(opt.get('fps')));
    let project: AkukoProject;
    let pathOf: (uri: string) => string | undefined;
    if (dir) {
      project = await createLocalHost({ projectDir: dir }).readState();
      pathOf = (uri) => localPath(dir, uri);
    } else {
      project = AkukoProjectSchema.parse(JSON.parse(await readFile(stateFile!, 'utf8')));
      const media = str(opt.get('media'));
      if (!media) return { code: 2, out: 'akuko: --media <folder> (the downloaded key frames) is required with --state.' };
      const assetOf = new Map(project.assets.filter((a) => a.file).map((a) => [a.file!.uri, a.id]));
      pathOf = mediaResolver(media, assetOf);
    }
    const plan = planPreview(project, { fps, exists: (uri) => { const p = pathOf(uri); return p !== undefined && existsSync(p); } });
    const text = describePreview(plan);
    if (opt.has('dry-run')) return { code: 0, out: text };
    const out = str(opt.get('out')) ?? (dir ? join(dir, 'cut', 'preview', 'animatic-preview.mp4') : resolve('animatic-preview.mp4'));
    const r = await renderPreview(plan, { out, pathOf, ...opts });
    if (r.status === 'no-ffmpeg') return { code: 0, out: `${text}\n${r.message}` };
    return { code: 0, out: `${text}\nWrote ${r.out} (${Number(r.seconds.toFixed(3))} s).` };
  } catch (err) {
    if (err instanceof HandoffError) return { code: 2, out: `akuko: ${err.message}` };
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
