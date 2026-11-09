// WP-23 — the DaVinci Resolve handoff, on the short-story fixture ("The Last Ferry").
//
// What this proves (Definition of Done 1-5):
//   - every shot is listed in order, each with the right media (clip, still or gap); the unapproved clip
//     is left out and listed;
//   - the FCPXML parses, validates against Apple's FCPXMLv1_8.dtd when AKUKO_FCPXML_DTD points at it
//     (skipped otherwise), and every clip's length equals its shot's, in whole frames, back to back,
//     totalling the sum of the shots;
//   - the EDL round-trips through a parser: events, timecodes, reel and clip names;
//   - voice-over starts at each shot's first frame; music and SFX are placed or listed;
//   - the project is never changed; a re-run is idempotent and leaves the person's own files alone.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { run as cli } from './cli.ts';
import { appleFormatName } from './fcpxml.ts';
import { parseEdl } from './edl.ts';
import { buildPlan, type ExportPlan } from './plan.ts';
import { probeMp3, probeMp4 } from './probe.ts';
import { HandoffError, fcpTime, framesFor, parseFcpTime, parseFps, parseTimecode, timecode, START_FRAMES } from './timecode.ts';
import { MANIFEST, planFromFolder, writeExport } from './write.ts';
import { buildBeatingProject } from './__fixtures__/beating.ts';
import { EXPECT, buildExportProject, miniMp4 } from './__fixtures__/project.ts';
import { parseDtd, validate } from './__fixtures__/dtd.ts';
import { find, parseXml, walk, type XmlNode } from './__fixtures__/xml.ts';
import type { AkukoProject } from '../schema/akuko-project.ts';

const tmps: string[] = [];
const scratch = async (name: string): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), `akuko-${name}-`));
  tmps.push(d);
  return d;
};
after(async () => {
  for (const d of tmps) await rm(d, { recursive: true, force: true });
});

/** Every file under `dir` (except `skip`) with its hash. */
function tree(dir: string, skip = ''): Record<string, string> {
  const out: Record<string, string> = {};
  const go = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const rel = relative(dir, p).replaceAll('\\', '/');
      if (skip && (rel === skip || rel.startsWith(`${skip}/`))) continue;
      if (statSync(p).isDirectory()) go(p);
      else out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  go(dir);
  return out;
}

const fps24 = parseFps('24');

describe('frames and timecode', () => {
  it('rounds shot by shot, halves up, at least one frame', () => {
    assert.equal(framesFor(6, fps24), 144);
    assert.equal(framesFor(5.5 / 24, fps24), 6); // 5.5 frames -> 6
    assert.equal(framesFor(5.4 / 24, fps24), 5);
    assert.equal(framesFor(0.01, fps24), 1);
    assert.equal(framesFor(0, fps24), 0);
    assert.equal(framesFor(6, parseFps('23.976')), 144); // nominal timebase: 6 s is 144 frames at 23.976 too
    assert.equal(framesFor(6, parseFps('25')), 150);
  });
  it('timecode round-trips and starts at 01:00:00:00', () => {
    for (const f of ['23.976', '24', '25', '29.97', '30', '50', '59.94', '60']) {
      const r = parseFps(f);
      for (const n of [0, 1, r.nominal - 1, r.nominal, 12345, START_FRAMES(r)]) assert.equal(parseTimecode(timecode(n, r), r), n);
    }
    assert.equal(timecode(START_FRAMES(fps24), fps24), '01:00:00:00');
    assert.equal(timecode(START_FRAMES(fps24) + 150, fps24), '01:00:06:06');
  });
  it('FCPXML times are exact rationals of whole frames', () => {
    assert.equal(fcpTime(144, fps24), '6s');
    assert.equal(fcpTime(1, fps24), '1/24s');
    const r = parseFps('23.976');
    assert.equal(fcpTime(1, r), '1001/24000s');
    assert.equal(fcpTime(START_FRAMES(r), r), '18018/5s'); // 01:00:00:00 at 23.976 is 3603.6 s
    for (const n of [1, 7, 144, 86400]) assert.equal(parseFcpTime(fcpTime(n, r), r), n);
  });
  it('refuses an unknown frame rate', () => {
    assert.throws(() => parseFps('12'), HandoffError);
  });
});

describe('reading media length', () => {
  it('mp4: from the movie header', async () => {
    const d = await scratch('probe');
    await writeFile(join(d, 'a.mp4'), miniMp4(7.5));
    assert.equal((await probeMp4(join(d, 'a.mp4'))).durationS, 7.5);
  });
  it('mp3: by walking the frames (MPEG-1 Layer III, 128 kbps, 44.1 kHz)', () => {
    const frame = new Uint8Array(417);
    frame.set([0xff, 0xfb, 0x90, 0x00]);
    const bytes = new Uint8Array(417 * 100);
    for (let i = 0; i < 100; i++) bytes.set(frame, i * 417);
    const r = probeMp3(bytes);
    assert.ok(Math.abs((r.durationS ?? 0) - (100 * 1152) / 44100) < 1e-9);
    assert.equal(r.sampleRate, 44100);
    assert.deepEqual(probeMp3(new Uint8Array(50)), {});
  });
});

let dir: string;
let project: AkukoProject;
let plan: ExportPlan;
let beforeTree: Record<string, string>;

describe('the short-story export', () => {
  before(async () => {
    dir = await scratch('fixture');
    project = await buildExportProject(dir);
    beforeTree = tree(dir);
    plan = await planFromFolder({ project, projectDir: dir });
  });

  it('lists every shot in order, with the right media', () => {
    assert.deepEqual(plan.shots.map((s) => s.shot), EXPECT.shots);
    for (const s of plan.shots) {
      assert.equal(s.uses, EXPECT.uses[s.shot], s.shot);
      assert.equal(s.frames, EXPECT.frames24[s.shot], s.shot);
    }
    const dest = (shot: string): string | undefined => plan.video.find((v) => v.shot === shot && v.media)?.media?.dest;
    assert.equal(dest('sc1_sh1'), 'media/001_sc1_sh1.mp4');
    assert.equal(dest('sc2_sh1'), 'media/005_sc2_sh1_still.png');
    assert.equal(dest('sc3_sh2'), undefined);
  });

  it('leaves out what is not approved, and says why', () => {
    const out = new Map(plan.leftOut.map((x) => [x.unit, x.why]));
    assert.match(out.get('sc2_sh1_clip') ?? '', /pending-review/); // the unapproved clip
    assert.match(out.get('sc3_sh2_keyframe') ?? '', /needs-rework/);
    assert.match(out.get('sc3_sh2') ?? '', /missing/);
    assert.match(out.get('sc1_sh3_vo') ?? '', /pending-review/);
    assert.match(out.get('sc2_sfx_2') ?? '', /pending-review/);
    // planned-but-never-made units are not noise
    assert.equal(out.has('sc2_sh2_clip'), false);
    // nothing unapproved is on the timeline
    const used = new Set([...plan.media.map((m) => m.asset)]);
    for (const id of ['sc2_sh1_clip', 'sc3_sh2_keyframe', 'sc1_sh3_vo', 'sc2_sfx_2']) assert.equal(used.has(id), false, id);
    for (const m of plan.media) assert.equal(project.assets.find((a) => a.id === m.asset)?.status, 'approved', m.asset);
  });

  it('every shot is exactly its length in frames, back to back, totalling the shots', () => {
    const sum = Object.values(EXPECT.frames24).reduce((a, b) => a + b, 0);
    assert.equal(plan.totalFrames, sum);
    let at = 0;
    const perShot = new Map<string, number>();
    for (const v of plan.video) {
      assert.equal(v.recIn, at, `${v.shot} starts where the last event ended`);
      at += v.frames;
      perShot.set(v.shot, (perShot.get(v.shot) ?? 0) + v.frames);
    }
    assert.equal(at, sum);
    for (const [shot, frames] of perShot) assert.equal(frames, EXPECT.frames24[shot], shot);
  });

  it('a clip shorter than its shot is followed by a gap and a warning; a longer one is cut at the shot', () => {
    const sh3 = plan.video.filter((v) => v.shot === 'sc1_sh3');
    assert.deepEqual(sh3.map((v) => [v.kind, v.frames]), [['clip', 96], ['gap', 24]]);
    assert.ok(plan.warnings.some((w) => w.startsWith('sc1_sh3:') && /gap/.test(w)));
    const sh1 = plan.video.filter((v) => v.shot === 'sc1_sh1');
    assert.deepEqual(sh1.map((v) => [v.kind, v.frames]), [['clip', 144]]);
    assert.match(sh1[0]!.note ?? '', /longer than the shot/);
  });

  it('puts voice-over at its shot\'s first frame; places or lists the music and SFX', () => {
    const vo = plan.audio.filter((a) => a.role === 'vo');
    assert.deepEqual(vo.map((a) => [a.shot, a.recIn, a.frames, a.track]), [['sc1_sh1', 0, 96, 1], ['sc1_sh2', 144, 72, 1]]);
    const music = plan.audio.find((a) => a.role === 'music')!;
    assert.equal(music.media.asset, 'film_music_1');
    assert.equal(music.recIn, 0);
    assert.equal(music.frames, 40 * 24 > plan.totalFrames ? plan.totalFrames : 40 * 24);
    const sfx = plan.audio.find((a) => a.role === 'sfx')!;
    assert.equal(sfx.recIn, plan.shots.find((s) => s.shot === 'sc1_sh4')!.recIn);
    assert.equal(sfx.frames, 36);
    assert.deepEqual(plan.notPlaced.map((m) => m.asset), ['loose_music_2']);
    // Music on a scene stops where the scene ends (sc1 is 6+5+5+8 = 24 s), though its file is 40 s; it overlaps the
    // film-wide bed, so it takes its own track.
    const sceneMusic = plan.audio.find((a) => a.media.asset === 'scene_music_3')!;
    assert.equal(sceneMusic.recIn, 0);
    assert.equal(sceneMusic.frames, 24 * 24);
    assert.match(sceneMusic.note ?? '', /end of its scene/);
    assert.notEqual(sceneMusic.track, music.track);
    assert.ok(plan.audio.every((a) => a.track >= 1));
    assert.ok(plan.captions.length === 2);
  });

  it('writes the folder, and the FCPXML is well formed and matches the plan', async () => {
    const out = join(dir, 'export', 'resolve');
    const r = await writeExport({ project, projectDir: dir, outDir: out, format: 'both' });
    assert.ok(r.written.includes('timeline.fcpxml'));
    for (const m of plan.media) assert.ok(existsSync(join(out, ...m.dest.split('/'))), m.dest);
    // The captions start at 0; the timeline starts at 01:00:00:00, so a shifted copy is written too.
    assert.match(readFileSync(join(out, 'captions', 'captions.srt'), 'utf8'), /^1\n00:00:00,000 --> 00:00:02,000/);
    assert.match(readFileSync(join(out, 'captions', 'captions_timeline_01h.srt'), 'utf8'), /^1\n01:00:00,000 --> 01:00:02,000/);

    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    assert.equal(root.name, 'fcpxml');
    assert.equal(root.attrs['version'], '1.8');
    const resources = find(root, 'resources')[0]!;
    const assets = new Map(find(resources, 'asset').map((a) => [a.attrs['id']!, a]));
    const fmt = find(resources, 'format')[0]!;
    assert.equal(fmt.attrs['frameDuration'], '1/24s');
    assert.equal(fmt.attrs['width'], '1920');

    // Every asset URL is the media file we copied, escaped properly.
    for (const a of assets.values()) {
      const p = fileURLToPath(a.attrs['src']!);
      assert.ok(existsSync(p), `${a.attrs['src']} does not point at a file`);
      assert.equal(relative(out, p).replaceAll('\\', '/').split('/')[0] === 'media' || relative(out, p).replaceAll('\\', '/').split('/')[0] === 'audio', true);
    }

    const seq = find(find(find(find(root, 'library')[0]!, 'event')[0]!, 'project')[0]!, 'sequence')[0]!;
    const spine = find(seq, 'spine')[0]!;
    const tcStart = parseFcpTime(seq.attrs['tcStart']!, fps24);
    assert.equal(tcStart, START_FRAMES(fps24));
    let at = tcStart;
    const lens = new Map<string, number>();
    for (const item of spine.children) {
      assert.ok(['asset-clip', 'video', 'gap'].includes(item.name), item.name);
      assert.equal(parseFcpTime(item.attrs['offset']!, fps24), at, 'items are contiguous');
      const len = parseFcpTime(item.attrs['duration']!, fps24);
      at += len;
      const shot = /(sc\d_sh\d)/.exec(item.attrs['name']!)?.[1];
      assert.ok(shot, item.attrs['name']);
      lens.set(shot!, (lens.get(shot!) ?? 0) + len);
    }
    assert.equal(at - tcStart, parseFcpTime(seq.attrs['duration']!, fps24), 'sequence length is the sum');
    assert.equal(at - tcStart, plan.totalFrames);
    for (const [shot, len] of lens) assert.equal(len, EXPECT.frames24[shot], shot);

    // Audio: anchored under the video it starts with, at its start.
    const vo1 = find(spine.children[0]!, 'asset-clip').find((c) => /_vo$/.test(c.attrs['name']!))!;
    assert.equal(parseFcpTime(vo1.attrs['offset']!, fps24), 0);
    assert.equal(vo1.attrs['lane'], '-1');
    // refs resolve
    walk(root, (n) => {
      if (n.attrs['ref'] !== undefined) assert.ok(assets.has(n.attrs['ref']), `ref ${n.attrs['ref']}`);
    });
  });

  it('validates against Apple\'s FCPXMLv1_8.dtd (when AKUKO_FCPXML_DTD is set)', { skip: !process.env['AKUKO_FCPXML_DTD'] }, async () => {
    const dtd = parseDtd(readFileSync(process.env['AKUKO_FCPXML_DTD']!, 'utf8'));
    const root = parseXml(readFileSync(join(dir, 'export', 'resolve', 'timeline.fcpxml'), 'utf8'));
    assert.deepEqual(validate(root, dtd), []);
  });

  it('the EDL parses back: events, timecodes, reel and clip names', async () => {
    const out = join(dir, 'export', 'resolve');
    const v = parseEdl(readFileSync(join(out, 'edl', 'video.edl'), 'utf8'));
    assert.equal(v.fcm, 'NON-DROP FRAME');
    assert.equal(v.events.length, plan.video.length);
    let at = START_FRAMES(fps24);
    v.events.forEach((e, i) => {
      const pv = plan.video[i]!;
      assert.equal(e.event, i + 1);
      assert.equal(parseTimecode(e.recIn, fps24), at);
      at = parseTimecode(e.recOut, fps24);
      assert.equal(parseTimecode(e.recOut, fps24) - parseTimecode(e.recIn, fps24), pv.frames);
      assert.equal(parseTimecode(e.srcOut, fps24) - parseTimecode(e.srcIn, fps24), pv.frames);
      if (pv.media) {
        assert.equal(e.clipName, pv.media.dest.split('/').pop());
        assert.equal(e.reel, `V${String(plan.shots.find((s) => s.shot === pv.shot)!.n).padStart(3, '0')}`);
      } else assert.equal(e.reel, 'BL');
    });
    assert.equal(at - START_FRAMES(fps24), plan.totalFrames);
    const a1 = parseEdl(readFileSync(join(out, 'edl', 'audio-1.edl'), 'utf8'));
    assert.deepEqual(a1.events.map((e) => [e.clipName, e.recIn, e.track, e.reel]), [
      ['001_sc1_sh1_vo.wav', '01:00:00:00', 'A', 'A001'],
      ['002_sc1_sh2_vo.wav', '01:00:06:00', 'A', 'A002'],
    ]);
  });

  it('EDL reel names: one per file, never shared across video, voice-over, music and SFX, at most 8 characters', () => {
    const out = join(dir, 'export', 'resolve');
    const byReel = new Map<string, Set<string>>();
    const files = readdirSync(join(out, 'edl')).filter((f) => f.endsWith('.edl'));
    assert.ok(files.length >= 4, 'video plus voice-over, music and SFX tracks');
    for (const f of files) {
      for (const e of parseEdl(readFileSync(join(out, 'edl', f), 'utf8')).events) {
        assert.ok(e.reel.length <= 8, `${e.reel} is longer than 8 characters`);
        if (e.reel === 'BL') continue;
        byReel.set(e.reel, (byReel.get(e.reel) ?? new Set()).add(e.clipName!));
      }
    }
    for (const [reel, names] of byReel) assert.equal(names.size, 1, `reel ${reel} names ${[...names].join(' and ')}`);
    assert.ok(byReel.has('V001') && byReel.has('A001') && byReel.has('MUS01') && byReel.has('SFX01'));
  });

  it('the newest captions are exported, and the person is told to sync again if approvals changed', () => {
    const out = join(dir, 'export', 'resolve');
    assert.match(readFileSync(join(out, 'captions', 'captions.srt'), 'utf8'), /The ferry was very late\./);
    assert.match(readFileSync(join(out, 'captions', 'captions.vtt'), 'utf8'), /The ferry was very late\./);
    assert.match(readFileSync(join(out, 'captions', 'captions_timeline_01h.srt'), 'utf8'), /very late/);
    assert.equal(plan.captions.find((c) => c.dest.endsWith('.srt'))!.uri, 'audio/vo/captions-2.srt');
    assert.ok(plan.warnings.some((w) => /sound sync/.test(w) && /captions/.test(w)));
  });

  it('a clip with its own sound track keeps it in the timeline', () => {
    const out = join(dir, 'export', 'resolve');
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const assets = find(find(root, 'resources')[0]!, 'asset');
    const sh4 = assets.find((a) => a.attrs['name'] === '004_sc1_sh4')!;
    assert.equal(sh4.attrs['hasVideo'], '1');
    assert.equal(sh4.attrs['hasAudio'], '1');
    assert.equal(sh4.attrs['audioSources'], '1');
    assert.equal(sh4.attrs['audioChannels'], '1');
    assert.equal(sh4.attrs['audioRate'], '48000');
    const sh1 = assets.find((a) => a.attrs['name'] === '001_sc1_sh1')!;
    assert.equal(sh1.attrs['hasAudio'], undefined, 'a clip without sound is not given any');
  });

  it('changes nothing in the project: akuko.json and every file are exactly as before', () => {
    assert.deepEqual(tree(dir, 'export'), beforeTree);
  });

  it('a re-run is idempotent, replaces only its own files and never deletes the person\'s', async () => {
    const out = join(dir, 'export', 'resolve');
    await writeFile(join(out, 'my-notes.txt'), 'mine');
    await mkdir(join(out, 'media', 'mine'), { recursive: true });
    await writeFile(join(out, 'media', 'mine', 'b-roll.mov'), 'mine too');
    const before1 = tree(out);
    const r2 = await writeExport({ project, projectDir: dir, outDir: out, format: 'both' });
    assert.deepEqual(r2.written, [], 'nothing needed writing');
    assert.deepEqual(r2.removed, []);
    assert.deepEqual(tree(out), before1);

    // Approve nothing new but drop a shot's clip: its media is removed from the export, mine stays.
    const trimmed = structuredClone(project);
    trimmed.assets.find((a) => a.id === 'sc1_sh2_clip')!.status = 'needs-rework';
    const r3 = await writeExport({ project: trimmed, projectDir: dir, outDir: out, format: 'both' });
    assert.ok(r3.removed.includes('media/002_sc1_sh2.mp4'));
    assert.ok(existsSync(join(out, 'my-notes.txt')));
    assert.ok(existsSync(join(out, 'media', 'mine', 'b-roll.mov')));
    assert.deepEqual(tree(dir, 'export'), beforeTree);
    const manifest = JSON.parse(readFileSync(join(out, MANIFEST), 'utf8')) as { files: Array<{ path: string }> };
    assert.ok(!manifest.files.some((f) => f.path === 'my-notes.txt'));

    // A stale file the person has since edited is kept.
    await writeExport({ project, projectDir: dir, outDir: out, format: 'both' });
    await writeFile(join(out, 'media', '002_sc1_sh2.mp4'), 'edited by hand');
    const r4 = await writeExport({ project: trimmed, projectDir: dir, outDir: out, format: 'both' });
    assert.deepEqual(r4.keptModified, ['media/002_sc1_sh2.mp4']);
    assert.equal(readFileSync(join(out, 'media', '002_sc1_sh2.mp4'), 'utf8'), 'edited by hand');
  });

  it('refuses to overwrite a file of the person\'s own at one of its paths, before writing anything', async () => {
    const out = await scratch('conflict');
    await mkdir(join(out, 'media'), { recursive: true });
    await writeFile(join(out, 'media', '001_sc1_sh1.mp4'), 'someone else\'s');
    await assert.rejects(writeExport({ project, projectDir: dir, outDir: out }), /not written by akuko/);
    assert.deepEqual(Object.keys(tree(out)), ['media/001_sc1_sh1.mp4']);
  });

  it('handles an export folder with spaces, and titles with & and quotes', async () => {
    const out = join(await scratch('sp ace'), 'Resolve & export');
    const p2 = structuredClone(project);
    p2.project.title = 'Tom & Jerry "the film" <1>';
    const r = await writeExport({ project: p2, projectDir: dir, outDir: out });
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    assert.equal(find(find(find(root, 'library')[0]!, 'event')[0]!, 'project')[0]!.attrs['name'], 'Tom & Jerry "the film" <1>');
    walk(root, (n: XmlNode) => {
      if (n.name === 'asset') assert.ok(existsSync(fileURLToPath(n.attrs['src']!)), n.attrs['src']);
    });
    assert.ok(r.written.length > 0);
  });

  it('timeline-only (no files here): the timeline and a download list, nothing copied', async () => {
    const out = await scratch('tl-only');
    const r = await writeExport({ project, projectDir: join(dir, 'nowhere'), outDir: out, timelineOnly: true });
    assert.ok(existsSync(join(out, 'timeline.fcpxml')));
    assert.ok(existsSync(join(out, 'DOWNLOAD-LIST.md')));
    assert.equal(existsSync(join(out, 'media')), false);
    assert.match(readFileSync(join(out, 'DOWNLOAD-LIST.md'), 'utf8'), /media\/001_sc1_sh1\.mp4 \| motion\/sc1_sh1\/sc1_sh1_clip\.mp4/);
    assert.equal(r.plan.unchecked, true);
    assert.equal(r.plan.totalFrames, plan.totalFrames);
  });

  it('other frame rates: whole frames, record timecode and tcStart follow', async () => {
    for (const f of ['25', '23.976', '30']) {
      const r = parseFps(f);
      const pl = await buildPlan({ project, fps: r, exists: () => true, probe: async () => ({}) });
      assert.equal(pl.totalFrames, project.shots.reduce((s, x) => s + framesFor(x.duration_s!, r), 0));
      const out = await scratch(`fps${f}`);
      await writeExport({ project, projectDir: dir, outDir: out, fps: f });
      const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
      const seq = find(find(find(find(root, 'library')[0]!, 'event')[0]!, 'project')[0]!, 'sequence')[0]!;
      assert.equal(parseFcpTime(seq.attrs['tcStart']!, r), START_FRAMES(r));
      assert.equal(parseFcpTime(seq.attrs['duration']!, r), pl.totalFrames);
    }
  });

  it('a shot with no duration is left off and listed, and the rest still lands in order', async () => {
    const p2 = structuredClone(project);
    delete p2.shots.find((s) => s.id === 'sc2_sh2')!.duration_s;
    const pl = await buildPlan({ project: p2, fps: fps24, exists: () => true, probe: async () => ({ durationS: 100 }) });
    assert.equal(pl.shots.find((s) => s.shot === 'sc2_sh2')!.uses, 'no-duration');
    assert.ok(pl.leftOut.some((x) => x.unit === 'sc2_sh2' && /no duration/.test(x.why)));
    assert.equal(pl.totalFrames, plan.totalFrames - EXPECT.frames24['sc2_sh2']!);
  });
});

describe('command line', () => {
  it('export writes the default folder and reports; it never writes akuko.json', async () => {
    const d = await scratch('cli');
    await buildExportProject(d);
    const snap = tree(d);
    const r = await cli(['export', '--project', d, '--format', 'both', '--fps', '24']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Exported 11 shots, 00:01:09:00 \(1656 frames at 24 fps\)/);
    assert.match(r.out, /left out: 5/);
    assert.ok(existsSync(join(d, 'export', 'resolve', 'timeline.fcpxml')));
    assert.deepEqual(tree(d, 'export'), snap);
    const again = await cli(['export', '--project', d, '--format', 'both']);
    assert.match(again.out, /0 written/);
  });
  it('says what is wrong in plain words', async () => {
    assert.equal((await cli(['export'])).code, 2);
    const d = await scratch('cli2');
    await buildExportProject(d);
    const bad = await cli(['export', '--project', d, '--fps', '12']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /not supported/);
    assert.equal((await cli(['export', '--project', d, '--format', 'xml'])).code, 2);
  });
});

describe('review fixes', () => {
  it('mp4: a sound track is detected, with its channels and rate; none is invented', async () => {
    const d = await scratch('probe-audio');
    await writeFile(join(d, 'with.mp4'), miniMp4(4, true));
    await writeFile(join(d, 'without.mp4'), miniMp4(4, false));
    const w = await probeMp4(join(d, 'with.mp4'));
    assert.deepEqual([w.durationS, w.hasAudio, w.channels, w.sampleRate], [4, true, 1, 48000]);
    const wo = await probeMp4(join(d, 'without.mp4'));
    assert.equal(wo.hasAudio, undefined);
    assert.equal(wo.durationS, 4);
  });

  it('format name only for standard sizes: 1:1 and 9:16 get none', async () => {
    assert.equal(appleFormatName(1920, 1080, '24'), 'FFVideoFormat1080p24');
    assert.equal(appleFormatName(1280, 720, '23.976'), 'FFVideoFormat720p2398');
    assert.equal(appleFormatName(3840, 2160, '25'), 'FFVideoFormat3840x2160p25');
    assert.equal(appleFormatName(1080, 1080, '24'), undefined);
    assert.equal(appleFormatName(1080, 1920, '24'), undefined);
    for (const [aspect, w, h] of [['1:1', 1080, 1080], ['9:16', 1080, 1920], ['16:9', 1920, 1080]] as const) {
      const p2 = structuredClone(project);
      p2.project.aspect_ratio = aspect;
      const out = await scratch(`fmt-${w}`);
      await writeExport({ project: p2, projectDir: dir, outDir: out });
      const f = find(find(parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8')), 'resources')[0]!, 'format')[0]!;
      assert.equal(f.attrs['width'], String(w));
      assert.equal(f.attrs['height'], String(h));
      if (aspect === '16:9') assert.equal(f.attrs['name'], 'FFVideoFormat1080p24');
      else assert.equal(f.attrs['name'], undefined, `${aspect} must not be called 1080p`);
    }
  });

  it('a re-run keeps what the person edited at akuko\'s own paths, and says so', async () => {
    const out = await scratch('edited');
    await writeExport({ project, projectDir: dir, outDir: out, format: 'both' });
    await writeFile(join(out, 'README.md'), 'my own notes');
    await writeFile(join(out, 'media', '001_sc1_sh1.mp4'), 'a graded version');
    const entries = (): Record<string, string> => Object.fromEntries((JSON.parse(readFileSync(join(out, MANIFEST), 'utf8')) as { files: Array<{ path: string; sha256: string }> }).files.map((f) => [f.path, f.sha256]));
    const recorded = entries();
    const r = await writeExport({ project, projectDir: dir, outDir: out, format: 'both' });
    assert.deepEqual([...r.keptModified].sort(), ['README.md', 'media/001_sc1_sh1.mp4']);
    assert.ok(!r.written.includes('README.md') && !r.written.includes('media/001_sc1_sh1.mp4'));
    assert.equal(readFileSync(join(out, 'README.md'), 'utf8'), 'my own notes');
    assert.equal(readFileSync(join(out, 'media', '001_sc1_sh1.mp4'), 'utf8'), 'a graded version');
    // still reported next time, and the manifest still describes what akuko wrote
    const now = entries();
    assert.equal(now['README.md'], recorded['README.md']);
    assert.equal(now['media/001_sc1_sh1.mp4'], recorded['media/001_sc1_sh1.mp4']);
    const r2 = await writeExport({ project, projectDir: dir, outDir: out, format: 'both' });
    assert.deepEqual([...r2.keptModified].sort(), ['README.md', 'media/001_sc1_sh1.mp4']);
    // the checksum list describes the folder as it is, graded file included
    const sums = readFileSync(join(out, 'checksums.sha256'), 'utf8');
    assert.ok(sums.includes(`${createHash('sha256').update('a graded version').digest('hex')}  media/001_sc1_sh1.mp4`));
    // the command line reports it
    const text = await cli(['export', '--project', dir, '--out', out, '--format', 'both']);
    assert.match(text.out, /kept \(you changed them since the last export\): .*media\/001_sc1_sh1\.mp4/);
    // once the person deletes theirs, the next export writes akuko's again
    await rm(join(out, 'README.md'));
    const r3 = await writeExport({ project, projectDir: dir, outDir: out, format: 'both' });
    assert.ok(r3.written.includes('README.md'));
  });

  it('a run that dies half way leaves files the next run knows as its own', async () => {
    const out = await scratch('crash');
    await mkdir(join(out, 'media', '003_sc1_sh3.mp4.akuko-tmp'), { recursive: true }); // the third copy cannot be written
    await assert.rejects(writeExport({ project, projectDir: dir, outDir: out }));
    assert.ok(existsSync(join(out, 'media', '001_sc1_sh1.mp4')), 'the first copies were made before the failure');
    const m = JSON.parse(readFileSync(join(out, MANIFEST), 'utf8')) as { files: Array<{ path: string }> };
    assert.ok(m.files.some((f) => f.path === 'media/001_sc1_sh1.mp4'));
    assert.ok(m.files.some((f) => f.path === 'media/003_sc1_sh3.mp4'), 'a path is listed before it is written');
    await rm(join(out, 'media', '003_sc1_sh3.mp4.akuko-tmp'), { recursive: true });
    const r = await writeExport({ project, projectDir: dir, outDir: out }); // no "not written by akuko" refusal
    assert.ok(r.written.includes('timeline.fcpxml'));
    assert.deepEqual(readdirSync(join(out, 'media')).filter((f) => f.endsWith('.akuko-tmp')), []);
  });

  it('shots that share a beat in a Studio import are flagged; akuko\'s own are not', async () => {
    const shared = project.shots.filter((s) => s.beat === 'sc3_b2').map((s) => s.id);
    assert.deepEqual(shared, ['sc3_sh2', 'sc3_sh3']);
    assert.ok(!plan.warnings.some((w) => w.startsWith('Check:')), 'no Studio data, no warning');
    const p2 = structuredClone(project);
    for (const s of p2.shots) if (shared.includes(s.id)) (s as { studio?: unknown }).studio = { index: 1 };
    const pl = await buildPlan({ project: p2, fps: fps24, exists: () => true, probe: async () => ({ durationS: 100 }) });
    const w = pl.warnings.find((x) => x.startsWith('Check:'))!;
    assert.match(w, /sc3_sh2, sc3_sh3 share the beat "sc3_b2"/);
    assert.match(w, /alternate/);
    assert.equal(pl.totalFrames, plan.totalFrames, 'all of them are still placed');
  });

  it('warns when a clip\'s length cannot be read', async () => {
    const pl = await buildPlan({ project, fps: fps24, exists: () => true, probe: async () => ({}) });
    assert.ok(pl.warnings.some((w) => w.startsWith('sc1_sh1:') && /could not be read/.test(w)));
    const ok = await buildPlan({ project, fps: fps24, exists: () => true, probe: async () => ({ durationS: 100 }) });
    assert.ok(!ok.warnings.some((w) => /could not be read/.test(w)));
  });

  it('the timeline-only export says the clips open offline until relinked', async () => {
    const out = await scratch('tl-readme');
    await writeExport({ project, projectDir: join(dir, 'nowhere'), outDir: out, timelineOnly: true });
    assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /open offline in Resolve until you relink them/);
  });

  it('the README names the exact EDL conform setting and says an EDL import makes a new timeline', () => {
    const readme = readFileSync(join(dir, 'export', 'resolve', 'README.md'), 'utf8');
    assert.match(readme, /Assist using reel names from the\*\* and pick \*\*Source clip filename\*\*/);
    assert.match(readme, /Importing an EDL makes a \*\*new timeline\*\*/);
    assert.match(readme, /Each `edl\/audio-N\.edl` becomes its own new timeline/);
  });
});

describe('The Beating', () => {
  it('exports 12 shots, 1680 frames at 24 fps, with the right mix of clips, stills and gaps', async () => {
    const d = await scratch('beating');
    const p = await buildBeatingProject(d);
    const out = join(d, 'export', 'resolve');
    const before = tree(d);
    const r = await writeExport({ project: p, projectDir: d, outDir: out, format: 'both' });
    const pl = r.plan;
    assert.equal(pl.shots.length, 12);
    assert.equal(pl.totalFrames, 1680);
    assert.deepEqual(pl.shots.map((s) => s.uses), ['clip', 'clip', 'clip', 'clip', 'still', 'still', 'still', 'gap', 'still', 'still', 'still', 'still']);
    assert.deepEqual(pl.shots.map((s) => s.frames), [144, 96, 144, 168, 96, 120, 144, 168, 144, 192, 120, 144]);
    const left = new Map(pl.leftOut.map((x) => [x.unit, x.why]));
    assert.match(left.get('sc2_sh2_clip') ?? '', /pending-review/);
    assert.match(left.get('sc3_sh1_keyframe') ?? '', /needs-rework/);
    assert.match(left.get('sc3_sh1') ?? '', /missing/);
    // the 3.5 s clip in a 6 s shot: 84 frames, then a 60 frame gap
    assert.deepEqual(pl.video.filter((v) => v.shot === 'sc1_sh3').map((v) => [v.kind, v.frames]), [['clip', 84], ['gap', 60]]);
    assert.ok(pl.warnings.some((w) => w.startsWith('sc1_sh3:')));
    // FCPXML: contiguous, the total the sum
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const seq = find(find(find(find(root, 'library')[0]!, 'event')[0]!, 'project')[0]!, 'sequence')[0]!;
    let at = START_FRAMES(fps24);
    for (const item of find(seq, 'spine')[0]!.children) {
      assert.equal(parseFcpTime(item.attrs['offset']!, fps24), at);
      at += parseFcpTime(item.attrs['duration']!, fps24);
    }
    assert.equal(at - START_FRAMES(fps24), 1680);
    // the EDL agrees, and nothing in the project changed
    const e = parseEdl(readFileSync(join(out, 'edl', 'video.edl'), 'utf8'));
    assert.equal(parseTimecode(e.events.at(-1)!.recOut, fps24) - START_FRAMES(fps24), 1680);
    assert.deepEqual(tree(d, 'export'), before);
    const dtdPath = process.env['AKUKO_FCPXML_DTD'];
    if (dtdPath) assert.deepEqual(validate(root, parseDtd(readFileSync(dtdPath, 'utf8'))), []);
  });
});
