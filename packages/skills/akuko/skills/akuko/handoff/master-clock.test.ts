// The master-clock handoff (WP-23b): shots and cards at film time, the locked WAV uncut on A1.
// Synthetic project (`__fixtures__/master.ts`); nothing here runs Resolve (see MANUAL-CHECK.md).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkIntegrity } from '../schema/integrity.ts';
import { run as cli } from './cli.ts';
import { parseEdl } from './edl.ts';
import { easeInterps } from './fcpxml.ts';
import { readWavHeader } from './masterfile.ts';
import { parseStartTc } from './master.ts';
import { HandoffError, parseFcpTime, parseFps, timecode } from './timecode.ts';
import { planFromFolder, writeExport } from './write.ts';
import { parseDtd, validate } from './__fixtures__/dtd.ts';
import { buildMasterProject, type MasterFixtureOptions } from './__fixtures__/master.ts';
import { find, parseXml, walk, type XmlNode } from './__fixtures__/xml.ts';

const tmps: string[] = [];
const scratch = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'akuko-master-'));
  tmps.push(d);
  return d;
};
after(async () => {
  for (const d of tmps) await rm(d, { recursive: true, force: true });
});

const fps24 = parseFps('24');
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const row = (plan: Awaited<ReturnType<typeof planFromFolder>>, shot: string) => plan.video.find((v) => v.shot === shot)!;

async function build(o: MasterFixtureOptions = {}) {
  const root = await scratch();
  const fx = await buildMasterProject(root, o);
  return { root, ...fx };
}

describe('master clock: placement', () => {
  it('the synthetic project is a valid project with a clean integrity check', async () => {
    const { project } = await build();
    assert.deepEqual(checkIntegrity(project), []);
  });

  it('places every approved shot and card at its film time, in frames, with gaps kept', async () => {
    const { project, dir } = await build();
    const plan = await planFromFolder({ project, projectDir: dir });
    assert.equal(plan.totalFrames, 240, 'as long as the master (10 s at 24 fps)');
    assert.equal(plan.startFrames, 0);
    // Record-ins (frames from the start) and lengths, in timeline order.
    assert.deepEqual(
      plan.video.map((v) => [v.kind, v.shot, v.recIn, v.frames]),
      [
        ['still', 'S00-020', 0, 24], // the title card
        ['gap', '', 24, 12], // the scene-start gap, 1.0 - 1.5 s
        ['clip', 'S01-010', 36, 60],
        ['still', 'S01-020', 96, 54],
        ['gap', '', 150, 18], // the unapproved part card's time: nothing placed
        ['clip', 'S02-010', 168, 48],
        ['gap', 'S02-020', 216, 24], // nothing approved
      ],
    );
    // No overlaps, no holes: events tile the timeline exactly.
    let at = 0;
    for (const v of plan.video) {
      assert.equal(v.recIn, at);
      at += v.frames;
    }
    assert.equal(at, plan.totalFrames);
    assert.deepEqual(plan.cards, [{ asset: 'card_S00-020', sheetId: 'S00-020', recIn: 0, frames: 24 }]);
  });

  it('picture order: lip-sync, else clip, else key frame, else a gap', async () => {
    const { project, dir } = await build();
    const plan = await planFromFolder({ project, projectDir: dir });
    assert.deepEqual(plan.shots.map((s) => [s.shot, s.uses]), [['S01-010', 'lipsync'], ['S01-020', 'still'], ['S02-010', 'clip'], ['S02-020', 'gap']]);
    assert.equal(row(plan, 'S01-010').media!.asset, 'S01-010_lipsync', 'the lip-sync clip wins over the approved clip');
    assert.equal(row(plan, 'S01-020').media!.asset, 'S01-020_keyframe', 'the unapproved clip is not used');
    const why = Object.fromEntries(plan.leftOut.map((x) => [x.unit, x.why]));
    assert.match(why['S01-020_clip']!, /pending-review/);
    assert.match(why['S02-020']!, /no approved/);
    assert.match(why['card_P2-CARD']!, /pending-review/, 'an unapproved card is left out and listed');
  });

  it('a clip longer than its slot is cut at the slot; the cut is noted', async () => {
    const { project, dir } = await build();
    const plan = await planFromFolder({ project, projectDir: dir });
    const v = row(plan, 'S02-010');
    assert.equal(v.frames, 48);
    assert.equal(v.srcIn, 0);
    assert.match(v.note!, /longer than its slot, cut at the slot's end \(frame 48\)/);
  });

  it('a clip shorter than its slot is followed by a gap, never stretched', async () => {
    const { project, dir } = await build();
    // Make the lip-sync clip's slot longer than its 2.5 s file: 1.25 - 4 s (66 frames; the file has 60).
    project.shots[0]!.film = { in_s: 1.25, out_s: 4 };
    const plan = await planFromFolder({ project, projectDir: dir });
    const clip = row(plan, 'S01-010');
    assert.equal(clip.frames, 60);
    const after = plan.video[plan.video.indexOf(clip) + 1]!;
    assert.equal(after.kind, 'gap');
    assert.equal(after.recIn, 30 + 60);
    assert.equal(after.frames, 6);
    assert.ok(plan.warnings.some((w) => /S01-010: the file is 2\.500 s but its slot is 2\.750 s/.test(w) && /Nothing was stretched or frozen/.test(w)));
  });

  it('the master is on A1, whole and uncut; voice-over and music are covered, not laid', async () => {
    const { project, dir } = await build();
    const plan = await planFromFolder({ project, projectDir: dir });
    assert.equal(plan.audio.length, 1);
    const a = plan.audio[0]!;
    assert.deepEqual([a.role, a.track, a.recIn, a.frames, a.srcIn], ['master', 1, 0, 240, 0]);
    assert.equal(a.media.role, 'master');
    assert.ok(plan.media.every((m) => m.role !== 'vo' && m.role !== 'music' && m.role !== 'sfx'), 'no other sound is copied or laid');
    assert.deepEqual(plan.covered!.map((c) => c.unit).sort(), ['S01-010_vo', 'bed']);
    assert.equal(plan.notPlaced.length, 0);
  });

  it('never uses the sound of a picture file: a clip with its own sound is muted', async () => {
    const { project, dir } = await build();
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out });
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const assets = find(find(root, 'resources')[0]!, 'asset');
    const clipAsset = assets.find((a) => /S02-010/.test(a.attrs['name']!))!;
    assert.equal(clipAsset.attrs['hasAudio'], undefined, 'declared silent');
    const ev = find(spineOf(root), 'asset-clip').find((c) => /S02-010/.test(c.attrs['name']!))!;
    assert.equal(find(ev, 'adjust-volume')[0]!.attrs['amount'], '-96dB');
    assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /Picture files that carry sound \(muted\)[\s\S]*S02-010/);
  });
});

function spineOf(root: XmlNode): XmlNode {
  return find(find(find(find(root, 'library')[0]!, 'event')[0]!, 'project')[0]!, 'sequence')[0]!.children.find((c) => c.name === 'spine')!;
}
const sequenceOf = (root: XmlNode): XmlNode => find(find(find(find(root, 'library')[0]!, 'event')[0]!, 'project')[0]!, 'sequence')[0]!;

describe('master clock: the FCPXML', () => {
  it('starts at start_tc, is as long as the master, and tiles frame-exact', async () => {
    const { project, dir } = await build();
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out, format: 'both' });
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const seq = sequenceOf(root);
    assert.equal(seq.attrs['tcStart'], '0s');
    assert.equal(parseFcpTime(seq.attrs['duration']!, fps24), 240);
    let at = 0;
    for (const item of spineOf(root).children) {
      assert.equal(parseFcpTime(item.attrs['offset']!, fps24), at);
      at += parseFcpTime(item.attrs['duration']!, fps24);
    }
    assert.equal(at, 240, 'the spine is exactly the master long');
  });

  it('lays the master WAV uncut from frame 0 on its own track, copied byte for byte', async () => {
    const { project, dir, masterPath } = await build({ masterOutside: true });
    const out = join(await scratch(), 'resolve');
    const r = await writeExport({ project, projectDir: dir, outDir: out });
    assert.ok(r.written.includes('audio/master.wav'));
    assert.equal(sha(join(out, 'audio', 'master.wav')), sha(masterPath), 'the copy is the file, untouched');
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const masterAsset = find(find(root, 'resources')[0]!, 'asset').find((a) => a.attrs['name'] === 'master')!;
    assert.equal(masterAsset.attrs['hasAudio'], '1');
    assert.equal(masterAsset.attrs['audioChannels'], '1');
    assert.equal(masterAsset.attrs['audioRate'], '24000');
    const clips: XmlNode[] = [];
    walk(spineOf(root), (n) => void (n.attrs['ref'] === masterAsset.attrs['id'] && clips.push(n)));
    assert.equal(clips.length, 1, 'the master appears once: never cut into pieces');
    const m = clips[0]!;
    assert.equal(m.attrs['lane'], '-1');
    assert.equal(m.attrs['offset'], '0s', 'from frame 0 (the parent starts there)');
    assert.equal(m.attrs['start'], '0s', 'from the first sample');
    assert.equal(parseFcpTime(m.attrs['duration']!, fps24), 240, 'the whole master');
    assert.equal(readFileSync(join(out, 'audio', 'master.wav')).length, readFileSync(masterPath).length);
  });

  it('--link-media references the master in place and copies nothing', async () => {
    const { project, dir, masterPath } = await build({ masterOutside: true });
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out, linkMedia: true });
    assert.ok(!existsSync(join(out, 'audio', 'master.wav')));
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const a = find(find(root, 'resources')[0]!, 'asset').find((x) => x.attrs['name'] === 'master')!;
    assert.equal(fileURLToPath(a.attrs['src']!), masterPath);
    assert.equal(a.attrs['src'], pathToFileURL(masterPath).href);
    assert.doesNotMatch(readFileSync(join(out, 'checksums.sha256'), 'utf8'), /master/);
    assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /referenced in place/);
  });

  it('a still with a move gets transform keyframes across its slot, and a marker', async () => {
    const { project, dir } = await build();
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out });
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const video = find(spineOf(root), 'video').find((v) => /S01-020/.test(v.attrs['name']!))!;
    assert.equal(parseFcpTime(video.attrs['duration']!, fps24), 54);
    const tr = find(video, 'adjust-transform')[0]!;
    const kfs = (name: string): XmlNode[] => find(find(find(tr, 'param').find((p) => p.attrs['name'] === name)!, 'keyframeAnimation')[0]!, 'keyframe');
    const pos = kfs('position');
    const scale = kfs('scale');
    assert.equal(pos.length, 2);
    assert.equal(parseFcpTime(pos[0]!.attrs['time']!, fps24), 0);
    assert.equal(parseFcpTime(pos[1]!.attrs['time']!, fps24), 54, 'the move runs for the whole slot');
    assert.equal(pos[0]!.attrs['value'], '0 0');
    // x = -40 px of a 1080-high frame = -3.7037 % of the height; y = -20 px (up) is +1.8519 % (FCPXML y is up).
    assert.equal(pos[1]!.attrs['value'], '-3.7037 1.8519');
    assert.equal(scale[0]!.attrs['value'], '1 1');
    assert.equal(scale[1]!.attrs['value'], '1.15 1.15');
    assert.equal(pos[0]!.attrs['interp'], 'ease');
    assert.equal(pos[1]!.attrs['interp'], 'ease');
    // The marker says the same in words, and comes after the transform (Apple's DTD order).
    const marker = find(video, 'marker')[0]!;
    assert.match(marker.attrs['value']!, /^MOVE S01-020: scale 1 to 1\.15, drift x -40 px, y -20 px.*ease ease-in-out$/);
    assert.ok(video.children.indexOf(marker) > video.children.indexOf(tr));
    // Only that still moves.
    assert.equal(find(spineOf(root), 'video').filter((v) => find(v, 'adjust-transform').length > 0).length, 1);
    assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /Camera moves on stills[\s\S]*Not verified[\s\S]*S01-020/);
  });

  it('eases map to keyframe interpolation', () => {
    assert.deepEqual(easeInterps(undefined), ['linear', 'linear']);
    assert.deepEqual(easeInterps('none'), ['linear', 'linear']);
    assert.deepEqual(easeInterps('ease-in'), ['easeOut', 'linear']);
    assert.deepEqual(easeInterps('ease-out'), ['linear', 'easeIn']);
    assert.deepEqual(easeInterps('ease-in-out'), ['ease', 'ease']);
  });

  it('validates against Apple\'s FCPXMLv1_8.dtd (when AKUKO_FCPXML_DTD is set)', { skip: !process.env['AKUKO_FCPXML_DTD'] }, async () => {
    const { project, dir } = await build();
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out });
    const dtd = parseDtd(readFileSync(process.env['AKUKO_FCPXML_DTD']!, 'utf8'));
    assert.deepEqual(validate(parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8')), dtd), []);
  });

  it('every ref resolves and every asset URL points at a real file', async () => {
    const { project, dir } = await build();
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out });
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const assets = new Map(find(find(root, 'resources')[0]!, 'asset').map((a) => [a.attrs['id']!, a]));
    for (const a of assets.values()) assert.ok(existsSync(fileURLToPath(a.attrs['src']!)), a.attrs['src']);
    walk(root, (n) => {
      if (n.attrs['ref'] !== undefined) assert.ok(assets.has(n.attrs['ref']), `ref ${n.attrs['ref']}`);
    });
  });
});

describe('master clock: timecode and frame rate', () => {
  it('start_tc sets tcStart and every record timecode', async () => {
    const { project, dir } = await build({ startTc: '01:00:00:00' });
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out });
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    assert.equal(parseFcpTime(sequenceOf(root).attrs['tcStart']!, fps24), 86400);
    assert.equal(parseFcpTime(spineOf(root).children[1]!.attrs['offset']!, fps24), 86400 + 24);
    assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /starts at \*\*01:00:00:00\*\*/);
  });

  it('refuses a start_tc frame the rate does not have', () => {
    assert.throws(() => parseStartTc('00:00:00:24', fps24), (e) => e instanceof HandoffError && /frame 24.*only 24 frames/.test(e.message));
    assert.throws(() => parseStartTc('00:61:00:00', fps24), HandoffError);
    assert.equal(parseStartTc('00:00:01:23', fps24), 47);
    assert.equal(parseStartTc('00:00:00:24', parseFps('25')), 24);
  });

  it('project.fps sets the rate; a clashing --fps is refused, a matching one is fine', async () => {
    const { project, dir } = await build({ fps: '25' });
    assert.equal((await planFromFolder({ project, projectDir: dir })).fps.label, '25');
    assert.equal((await planFromFolder({ project, projectDir: dir })).totalFrames, 250);
    assert.equal((await planFromFolder({ project, projectDir: dir, fps: '25' })).fps.label, '25');
    await assert.rejects(planFromFolder({ project, projectDir: dir, fps: '24' }), (e) => e instanceof HandoffError && /project\.fps/.test(e.message));
  });

  it('without project.fps the --fps flag decides', async () => {
    const { project, dir } = await build();
    delete project.project.fps;
    assert.equal((await planFromFolder({ project, projectDir: dir, fps: '30' })).totalFrames, 300);
  });

  it('a missing master stops the export with a plain message', async () => {
    const { project, dir, masterPath } = await build();
    await rm(masterPath);
    await assert.rejects(planFromFolder({ project, projectDir: dir }), (e) => e instanceof HandoffError && /master audio is missing/.test(e.message));
  });

  it('a master file whose length differs from the project is noted', async () => {
    const { project, dir } = await build();
    project.audio.master!.duration_s = 12;
    const plan = await planFromFolder({ project, projectDir: dir });
    assert.ok(plan.warnings.some((w) => /master file is 10\.000 s long but audio\.master\.duration_s says 12/.test(w)));
  });
});

describe('master clock: the EDL', () => {
  it('video EDL: events at record time, a card reel, black for gaps, the move as a comment', async () => {
    const { project, dir } = await build();
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out, format: 'both' });
    const v = parseEdl(readFileSync(join(out, 'edl', 'video.edl'), 'utf8'));
    assert.equal(v.fcm, 'NON-DROP FRAME');
    assert.deepEqual(
      v.events.map((e) => [e.reel, e.recIn, e.recOut]),
      [
        ['C001', '00:00:00:00', '00:00:01:00'],
        ['BL', '00:00:01:00', '00:00:01:12'],
        ['V001', '00:00:01:12', '00:00:04:00'],
        ['V002', '00:00:04:00', '00:00:06:06'],
        ['BL', '00:00:06:06', '00:00:07:00'],
        ['V003', '00:00:07:00', '00:00:09:00'],
        ['BL', '00:00:09:00', '00:00:10:00'],
      ],
    );
    assert.ok(v.events[0]!.comments.includes('CARD card_S00-020'));
    assert.ok(v.events[3]!.comments.some((c) => /^MOVE S01-020: scale 1 to 1\.15/.test(c)));
    // Source in-points are all 0 (picture starts at its first frame); the long clip is cut by its source out.
    assert.equal(v.events[5]!.srcIn, '00:00:00:00');
    assert.equal(v.events[5]!.srcOut, '00:00:02:00');
    // The master is the one audio event, whole, at the start.
    const a = parseEdl(readFileSync(join(out, 'edl', 'audio-1.edl'), 'utf8'));
    assert.equal(a.events.length, 1);
    assert.deepEqual([a.events[0]!.reel, a.events[0]!.track, a.events[0]!.srcIn, a.events[0]!.srcOut, a.events[0]!.recIn, a.events[0]!.recOut], ['MASTER', 'A', '00:00:00:00', '00:00:10:00', '00:00:00:00', '00:00:10:00']);
    assert.ok(!existsSync(join(out, 'edl', 'audio-2.edl')));
  });

  it('record timecodes follow start_tc', async () => {
    const { project, dir } = await build({ startTc: '10:00:00:00' });
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out, format: 'edl' });
    const v = parseEdl(readFileSync(join(out, 'edl', 'video.edl'), 'utf8'));
    assert.equal(v.events[0]!.recIn, '10:00:00:00');
    assert.equal(v.events[2]!.recIn, timecode(10 * 3600 * 24 + 36, fps24));
  });
});

describe('master clock: the folder and the README', () => {
  it('the README says what was placed, what was left out and how to import', async () => {
    const { project, dir } = await build();
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out });
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    assert.match(readme, /3 of 4 shots and 1 card are on the timeline/);
    assert.match(readme, /Audio track A1 is the master/);
    assert.match(readme, /Gaps are kept as gaps/);
    assert.match(readme, /start timecode is 00:00:00:00\*\*/);
    assert.match(readme, /\| 00:00:01:12 \| 60 \| 2\.500 s \| S01-010: lip-sync clip \|/);
    const left = readFileSync(join(out, 'LEFT-OUT.md'), 'utf8');
    assert.match(left, /card_P2-CARD/);
    assert.match(left, /Covered by the master audio[\s\S]*S01-010_vo[\s\S]*bed/);
  });

  it('a re-run of an unchanged project writes nothing', async () => {
    const { project, dir } = await build();
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out });
    const again = await writeExport({ project, projectDir: dir, outDir: out });
    assert.deepEqual(again.written, []);
  });

  it('timeline-only: no files are read or copied; the master is in the download list', async () => {
    const { project, dir, masterPath } = await build();
    await rm(masterPath);
    const out = join(await scratch(), 'resolve');
    const r = await writeExport({ project, projectDir: dir, outDir: out, timelineOnly: true });
    assert.ok(r.written.includes('timeline.fcpxml'));
    assert.ok(!existsSync(join(out, 'audio')));
    assert.match(readFileSync(join(out, 'DOWNLOAD-LIST.md'), 'utf8'), /audio\/master\.wav/);
  });

  it('the command line reports the master clock and takes --link-media', async () => {
    const { project, dir } = await build({ masterOutside: true });
    await writeFile(join(dir, 'akuko.json'), `${JSON.stringify(project)}\n`);
    const r = await cli(['export', '--project', dir, '--link-media', '--out', join(await scratch(), 'resolve')]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /master clock: starts at 00:00:00:00, 1 card\(s\), 1 camera move\(s\) on stills, the master referenced in place; 2 sound unit\(s\) covered/);
    assert.match(r.out, /on the video track: 2 clip\(s\), 1 still\(s\), 1 gap\(s\)/);
  });
});

describe('reading a master WAV header', () => {
  it('reads length, rate and channels without loading the file, including 24-bit', async () => {
    const root = await scratch();
    // A 24-bit mono 48 kHz header with a 2 s data chunk, but only a few bytes of real data after it.
    const h = Buffer.alloc(44 + 64);
    h.write('RIFF', 0); h.writeUInt32LE(36 + 288000, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(48000, 24); h.writeUInt32LE(144000, 28); h.writeUInt16LE(3, 32); h.writeUInt16LE(24, 34);
    h.write('data', 36); h.writeUInt32LE(0, 40); // a streamed file: no data size, so the rest of the file is the data
    const p = join(root, 'm.wav');
    await writeFile(p, h);
    const r = (await readWavHeader(p))!;
    assert.equal(r.sampleRate, 48000);
    assert.equal(r.channels, 1);
    assert.equal(r.bits, 24);
    assert.ok(Math.abs(r.durationS - 64 / 3 / 48000) < 1e-9);
    await writeFile(p, 'not a wav');
    assert.equal(await readWavHeader(p), undefined);
  });
});
