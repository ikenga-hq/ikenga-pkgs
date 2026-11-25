/**
 * akuko — command line for `assemble preview` (B-11) and `assemble rough`. Free: no provider, no spend, never writes akuko.json.
 *
 *   node --experimental-strip-types assemble/cli.ts preview --project <folder> [--out <file.mp4>] [--fps 24] [--dry-run]
 *   node --experimental-strip-types assemble/cli.ts preview --state <akuko.json> --media <folder> [--out <file.mp4>] ...
 *   node --experimental-strip-types assemble/cli.ts rough --project <folder> [--out <file.mp4>] [--fps 24] [--dry-run]
 *        [--music <file> [--music-offset <s>]] [--room-tone <file>] [--sfx <file>@<shot id>]...
 *
 *   preview   an animatic preview: each approved key frame held for its shot's length, in film order, with a
 *             gentle move only where the shot asks for one; black where a key frame is not approved yet. Writes
 *             one silent MP4 when ffmpeg is available (default `<project>/cut/preview/animatic-preview.mp4`).
 *             It is never a review unit and records nothing in the project.
 *   --state / --media   host A (claude.ai): the project read from the board's database and saved to a file, and
 *             a folder holding the downloaded key frames, each named `<asset id>.<ext>` or by its file name.
 *   rough     a rough cut with sound: each shot's approved clip (conformed to the shot: cut if longer, last frame
 *             held if shorter), else its approved key frame (held, with its gentle move), else black; approved
 *             voice-over takes at each shot's start + 0.1 s; optional music (ducked under the voice), room tone and
 *             effects the person points at. Default `<project>/cut/rough/rough-cut.mp4`. Never a review unit.
 *   --dry-run  print the plan only.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AkukoProjectSchema, type AkukoProject } from '../schema/akuko-project.ts';
import { createLocalHost } from '../hosts/local.ts';
import { localPath, masterPath } from '../handoff/write.ts';
import { probeFile } from '../handoff/probe.ts';
import { fpsForMasterProject } from '../handoff/master.ts';
import { HandoffError, parseFps } from '../handoff/timecode.ts';
import { describePreview, planPreview, renderPreview, type RenderPreviewOptions } from './preview.ts';
import { describeRough, planRough, renderRough, type RenderRoughOptions, type RoughOptions } from './rough.ts';

export interface CliResult { code: number; out: string }

function flags(argv: string[]): { cmd: string; opt: Map<string, string | true>; all: Map<string, string[]> } {
  const [cmd = '', ...rest] = argv;
  const opt = new Map<string, string | true>();
  const all = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opt.set(a.slice(2), next);
      all.set(a.slice(2), [...(all.get(a.slice(2)) ?? []), next]);
      i++;
    } else opt.set(a.slice(2), true);
  }
  return { cmd, opt, all };
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

type RunOptions = Pick<RenderPreviewOptions, 'available' | 'run' | 'ffmpeg'> & { rough?: Pick<RenderRoughOptions, 'available' | 'run' | 'ffmpeg' | 'versionText'> };

/** The person's bed flags for `rough`: files are checked here, so a typo stops before anything renders. */
function bedsFrom(opt: Map<string, string | true>, all: Map<string, string[]>): Pick<RoughOptions, 'music' | 'roomTone' | 'sfx'> | string {
  const out: Pick<RoughOptions, 'music' | 'roomTone' | 'sfx'> = {};
  const file = (v: string): string | undefined => (existsSync(resolve(v)) ? resolve(v) : undefined);
  const music = str(opt.get('music'));
  if (music !== undefined) {
    const f = file(music);
    if (!f) return `akuko: --music ${music}: file not found.`;
    const off = str(opt.get('music-offset'));
    const offsetS = off === undefined ? 0 : Number(off);
    if (!(Number.isFinite(offsetS) && offsetS >= 0)) return `akuko: --music-offset must be seconds (0 or more) into the music file, not "${off}".`;
    out.music = { file: f, ...(offsetS > 0 ? { offsetS } : {}) };
  } else if (opt.has('music-offset')) return 'akuko: --music-offset needs --music <file>.';
  const room = str(opt.get('room-tone'));
  if (room !== undefined) {
    const f = file(room);
    if (!f) return `akuko: --room-tone ${room}: file not found.`;
    out.roomTone = { file: f };
  }
  for (const v of all.get('sfx') ?? []) {
    const at = v.lastIndexOf('@');
    if (at <= 0 || at === v.length - 1) return `akuko: --sfx takes <file>@<shot id>, e.g. door.wav@sc2_sh1 (got "${v}").`;
    const f = file(v.slice(0, at));
    if (!f) return `akuko: --sfx ${v.slice(0, at)}: file not found.`;
    (out.sfx ??= []).push({ file: f, shot: v.slice(at + 1) });
  }
  return out;
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<CliResult> {
  const { cmd, opt, all } = flags(argv);
  const { rough: roughOpts, ...previewOpts } = opts;
  if (cmd !== 'preview' && cmd !== 'rough') return { code: 2, out: 'akuko: command must be preview or rough (picture lock and its review are not built yet).' };
  const dir = str(opt.get('project'));
  const stateFile = str(opt.get('state'));
  if (!dir && !stateFile) return { code: 2, out: 'akuko: --project <folder> (or --state <akuko.json> --media <folder> on claude.ai) is required.' };
  try {
    let project: AkukoProject;
    let pathOf: (uri: string) => string | undefined;
    if (dir) {
      project = await createLocalHost({ projectDir: dir }).readState();
      pathOf = (uri) => localPath(dir, uri);
    } else {
      project = AkukoProjectSchema.parse(JSON.parse(await readFile(stateFile!, 'utf8')));
      const media = str(opt.get('media'));
      if (!media) return { code: 2, out: `akuko: --media <folder> (the downloaded ${cmd === 'rough' ? 'clips, key frames and takes' : 'key frames'}) is required with --state.` };
      const assetOf = new Map(project.assets.filter((a) => a.file).map((a) => [a.file!.uri, a.id]));
      pathOf = mediaResolver(media, assetOf);
    }
    const onDisk = (uri: string): boolean => { const p = pathOf(uri); return p !== undefined && existsSync(p); };

    if (cmd === 'preview') {
      const fps = parseFps(str(opt.get('fps')));
      const plan = planPreview(project, { fps, exists: onDisk });
      const text = describePreview(plan);
      if (opt.has('dry-run')) return { code: 0, out: text };
      const out = str(opt.get('out')) ?? (dir ? join(dir, 'cut', 'preview', 'animatic-preview.mp4') : resolve('animatic-preview.mp4'));
      const r = await renderPreview(plan, { out, pathOf, ...previewOpts });
      if (r.status === 'no-ffmpeg') return { code: 0, out: `${text}\n${r.message}` };
      return { code: 0, out: `${text}\nWrote ${r.out} (${Number(r.seconds.toFixed(3))} s).` };
    }

    // rough
    const beds = bedsFrom(opt, all);
    if (typeof beds === 'string') return { code: 2, out: beds };
    const fps = fpsForMasterProject(project, str(opt.get('fps')));
    const master = project.audio.master;
    if (master) {
      const mp = dir ? masterPath(dir, master.uri) : pathOf(master.uri);
      const inner = pathOf;
      pathOf = (uri) => (uri === master.uri ? mp : inner(uri));
    }
    // Lengths of the approved clips and takes, read from their headers (mp4, wav, mp3); unreadable is unknown.
    const lengths = new Map<string, number>();
    const uris = project.assets.filter((a) => (a.kind === 'clip' || a.kind === 'vo') && a.status === 'approved' && a.file).map((a) => a.file!.uri);
    for (const uri of uris) {
      const p = pathOf(uri);
      if (p === undefined || !existsSync(p)) continue;
      const pr = await probeFile(p, (x) => readFile(x));
      if (pr.durationS !== undefined) lengths.set(uri, pr.durationS);
    }
    const plan = planRough(project, {
      fps,
      exists: onDisk,
      lengthOf: (uri) => lengths.get(uri),
      ...(master ? { masterExists: onDisk(master.uri) } : {}),
      ...beds,
    });
    const text = describeRough(plan);
    if (opt.has('dry-run')) return { code: plan.problems.length > 0 ? 2 : 0, out: text };
    const out = str(opt.get('out')) ?? (dir ? join(dir, 'cut', 'rough', 'rough-cut.mp4') : resolve('rough-cut.mp4'));
    const r = await renderRough(plan, { out, pathOf, ...(roughOpts ?? {}) });
    if (r.status === 'no-ffmpeg') return { code: 0, out: `${text}\n${r.message}` };
    const loud = r.lufs !== undefined ? ` Measured loudness: ${r.lufs} LUFS integrated.` : plan.audio.length > 0 ? ' The loudness could not be measured.' : ' Silent.';
    return { code: 0, out: `${text}\nWrote ${r.out} (${Number(r.seconds.toFixed(3))} s).${loud}` };
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
