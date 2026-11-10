// Master-clock handoff, review fixes (WP-23b): cards are picture, real-rate frame counting, the mute, odd WAV
// headers, paths with spaces, and a ~200-shot centisecond project that must tile exactly. Synthetic data only.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AkukoProjectSchema, type AkukoProject } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { readWavHeader } from './masterfile.ts';
import { buildPlan } from './plan.ts';
import { parseFcpTime, parseFps } from './timecode.ts';
import { writeExport, planFromFolder } from './write.ts';
import { parseDtd, validate } from './__fixtures__/dtd.ts';
import { buildMasterProject, type MasterFixtureOptions } from './__fixtures__/master.ts';
import { miniMp4 } from './__fixtures__/project.ts';
import { find, parseXml, type XmlNode } from './__fixtures__/xml.ts';

const tmps: string[] = [];
const scratch = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'akuko-master2-'));
  tmps.push(d);
  return d;
};
after(async () => {
  for (const d of tmps) await rm(d, { recursive: true, force: true });
});

const fps24 = parseFps('24');
const build = async (o: MasterFixtureOptions = {}) => ({ root: await scratch(), ...(await buildMasterProject(await scratchDir(), o)) });
async function scratchDir(): Promise<string> {
  return scratch();
}
const sequenceOf = (root: XmlNode): XmlNode => find(find(find(find(root, 'library')[0]!, 'event')[0]!, 'project')[0]!, 'sequence')[0]!;
const spineOf = (root: XmlNode): XmlNode => sequenceOf(root).children.find((c) => c.name === 'spine')!;

/** A generated master-clock project: `n` approved-key-frame shots with centisecond film times, no files (timeline-only). */
function bigProject(n: number, fps: string): { project: AkukoProject; ins: number[]; outs: number[]; masterS: number } {
  const ins: number[] = [];
  const outs: number[] = [];
  let cs = 0;
  for (let i = 0; i < n; i++) {
    cs += i % 7 === 0 ? 46 : 0; // a short gap before some shots
    const d = 400 + ((i * 137) % 1000);
    ins.push(cs / 100);
    outs.push((cs + d) / 100);
    cs += d;
  }
  const masterS = outs[n - 1]! + 12.345678;
  const per = Math.ceil(n / 10);
  const sceneOf = (i: number): string => `S${String(Math.floor(i / per) + 1).padStart(2, '0')}`;
  const shots = ins.map((_, i) => ({ id: `${sceneOf(i)}-${String(10 * (i + 1)).padStart(3, '0')}`, stage: 'breakdown', status: 'pending-review', scene: sceneOf(i), film: { in_s: ins[i]!, out_s: outs[i]! } }));
  const raw = {
    format: 'akuko', schema_version: 1,
    project: { slug: 'big', title: 'Big', profile: 'film', fps, created_at: '2026-11-10T00:00:00Z' },
    scenes: Array.from({ length: 10 }, (_, k) => ({ id: `S${String(k + 1).padStart(2, '0')}` })),
    shots,
    bible: {},
    assets: shots.map((s) => ({ id: `${s.id}_keyframe`, kind: 'keyframe', stage: 'keyframes', status: 'approved', owner: s.id, tags: ['keyframe'], comments: [], file: { uri: `k/${s.id}.png`, mime: 'image/png', hash: 'x' } })),
    audio: { master: { uri: 'audio/master.wav', duration_s: masterS, sample_rate: 24000, start_tc: '00:00:00:00' } },
  };
  return { project: AkukoProjectSchema.parse(raw), ins, outs, masterS };
}
const planOf = (project: AkukoProject, label: string) => buildPlan({ project, fps: parseFps(label), timelineOnly: true, exists: () => true, probe: async () => ({}) });
const at = (s: number, rate: number): number => Math.floor(s * rate + 0.5 + 1e-9);

describe('master clock: review fixes', () => {
  it('cards are picture: still cards are still assets (0s) with hasVideo and a format; a video card is a clip asset', async () => {
    const { project, dir } = await build();
    // Approve the part card as a video (credits-like) card: 0.75 s is its 18-frame slot.
    const card = project.assets.find((a) => a.id === 'card_P2-CARD')!;
    card.status = 'approved';
    card.file = { uri: 'cut/cards/card_P2-CARD.mp4', mime: 'video/mp4', hash: 'x' };
    await mkdir(join(dir, 'cut', 'cards'), { recursive: true });
    await writeFile(join(dir, 'cut', 'cards', 'card_P2-CARD.mp4'), miniMp4(0.75));
    const out = join(await scratch(), 'resolve');
    const r = await writeExport({ project, projectDir: dir, outDir: out, format: 'both' });
    assert.ok(existsSync(join(out, 'media', 'card_S00-020.png')), 'no doubled card_ prefix');
    assert.ok(existsSync(join(out, 'media', 'card_P2-CARD.mp4')));
    assert.ok(!existsSync(join(out, 'media', 'card_card_S00-020.png')));
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const assets = new Map(find(find(root, 'resources')[0]!, 'asset').map((a) => [a.attrs['id']!, a]));
    const refs: Array<{ el: XmlNode; asset: XmlNode }> = [];
    for (const el of spineOf(root).children) if (el.name === 'video' || el.name === 'asset-clip') refs.push({ el, asset: assets.get(el.attrs['ref']!)! });
    assert.equal(refs.length, 5, 'title card, S01-010, S01-020, the video card and S02-010 are the pictures');
    for (const { el, asset } of refs) {
      assert.equal(asset.attrs['hasVideo'], '1', asset.attrs['name']);
      assert.equal(asset.attrs['format'], 'r1', asset.attrs['name']);
      assert.equal(asset.attrs['hasAudio'], undefined, `${asset.attrs['name']}: picture assets are declared silent`);
      if (el.name === 'video') assert.equal(asset.attrs['duration'], '0s', 'a still asset has no length');
      else {
        assert.equal(el.attrs['srcEnable'], 'video', 'the picture file\'s sound is switched off whatever the probe found');
        assert.notEqual(asset.attrs['duration'], '0s');
      }
    }
    const title = refs.find((x) => /card_S00-020/.test(x.asset.attrs['name']!))!;
    assert.equal(title.el.name, 'video');
    const credits = refs.find((x) => /card_P2-CARD/.test(x.asset.attrs['name']!))!;
    assert.equal(credits.el.name, 'asset-clip', 'the credits-style mp4 card is a video asset');
    assert.equal([...assets.values()].filter((a) => a.attrs['hasAudio'] === '1').length, 1, 'the master is the one audio asset');
    assert.equal(r.plan.video.filter((v) => v.card !== undefined).length, 2);
  });

  it('srcEnable="video" is on every picture asset-clip even when the probe finds no sound', async () => {
    const { project, dir } = await build();
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out });
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const clips = spineOf(root).children.filter((c) => c.name === 'asset-clip');
    assert.equal(clips.length, 2); // S01-010 (lip-sync) and S02-010
    for (const c of clips) assert.equal(c.attrs['srcEnable'], 'video', c.attrs['name']);
  });

  it('the master asset is declared as long as its clip (the frame-rounded total), never shorter', async () => {
    const { project, dir } = await build();
    project.audio.master!.duration_s = 10.01; // 240.24 frames: 241
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out });
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const a = find(find(root, 'resources')[0]!, 'asset').find((x) => x.attrs['name'] === 'master')!;
    assert.equal(parseFcpTime(a.attrs['duration']!, fps24), 241);
    assert.equal(parseFcpTime(sequenceOf(root).attrs['duration']!, fps24), 241);
  });

  it('a master whose uri is a file: URL is found', async () => {
    const { project, dir, masterPath } = await build({ masterOutside: true });
    project.audio.master!.uri = pathToFileURL(masterPath).href;
    const plan = await planFromFolder({ project, projectDir: dir, linkMedia: true });
    assert.equal(plan.master!.media.src, masterPath);
  });

  it('a master path with spaces, referenced in place, is a percent-encoded file URL that points at the file', async () => {
    const root = await scratch();
    const { project, dir, masterPath } = await buildMasterProject(join(root, 'my audio folder'), { masterOutside: true });
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out, linkMedia: true });
    const a = find(find(parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8')), 'resources')[0]!, 'asset').find((x) => x.attrs['name'] === 'master')!;
    assert.match(a.attrs['src']!, /^file:\/\/\/.*my%20audio%20folder\/audio\/master\.wav$/);
    assert.equal(fileURLToPath(a.attrs['src']!), masterPath);
    assert.ok(existsSync(fileURLToPath(a.attrs['src']!)));
  });

  it('reads a WAV with JUNK, LIST and an odd-length bext chunk before data', async () => {
    const root = await scratch();
    const chunk = (id: string, body: Buffer): Buffer => {
      const h = Buffer.alloc(8);
      h.write(id, 0);
      h.writeUInt32LE(body.length, 4);
      return Buffer.concat([h, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(2, 2); fmt.writeUInt32LE(48000, 4); fmt.writeUInt32LE(48000 * 6, 8); fmt.writeUInt16LE(6, 12); fmt.writeUInt16LE(24, 14);
    const data = Buffer.alloc(48000 * 6 * 2); // 2 s of 24-bit stereo
    const body = Buffer.concat([chunk('JUNK', Buffer.alloc(28)), chunk('bext', Buffer.alloc(603, 1)), chunk('LIST', Buffer.from('INFOISFT\x05\x00\x00\x00test\x00')), chunk('fmt ', fmt), chunk('data', data)]);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0); riff.writeUInt32LE(4 + body.length, 4); riff.write('WAVE', 8);
    const p = join(root, 'big.wav');
    await writeFile(p, Buffer.concat([riff, body]));
    const h = (await readWavHeader(p))!;
    assert.deepEqual([h.sampleRate, h.channels, h.bits], [48000, 2, 24]);
    assert.equal(h.durationS, 2);
  });

  it('23.976: frames are counted at the real rate, so a 33-minute master is not about 2 s too long', async () => {
    const fps = parseFps('23.976');
    const { project, ins, outs, masterS } = bigProject(200, '23.976');
    const plan = await planOf(project, '23.976');
    const rate = 24000 / 1001;
    assert.equal(plan.totalFrames, Math.ceil(masterS * rate - 1e-6));
    assert.notEqual(plan.totalFrames, Math.ceil(masterS * 24), 'counting the nominal 24 would be a longer timeline');
    for (const i of [0, 7, 99, 199]) {
      const v = plan.video.find((x) => x.shot === project.shots[i]!.id)!;
      assert.equal(v.recIn, at(ins[i]!, rate), `shot ${i} record in`);
      assert.equal(v.recIn + v.frames, at(outs[i]!, rate), `shot ${i} record out`);
      // Time on the timeline = time on the master, to within half a frame.
      assert.ok(Math.abs((v.recIn + v.frames) * fps.num / fps.den - outs[i]!) <= 0.5 * fps.num / fps.den + 1e-9);
    }
  });

  it('23.976 FCPXML: the sequence is the master long at the real rate', async () => {
    const fps = parseFps('23.976');
    const { project, masterS } = bigProject(30, '23.976');
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: await scratch(), outDir: out, timelineOnly: true });
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    assert.equal(parseFcpTime(sequenceOf(root).attrs['duration']!, fps), Math.ceil(masterS * 24000 / 1001 - 1e-6));
  });

  it('a ~200-shot centisecond project tiles exactly: no holes or overlaps, record-ins are round(in x fps), total is ceil(master x fps)', async () => {
    for (const label of ['24', '25', '29.97', '23.976']) {
      const fps = parseFps(label);
      const rate = fps.den / fps.num;
      const { project, ins, outs, masterS } = bigProject(200, label);
      assert.deepEqual(checkIntegrity(project), []);
      const plan = await planOf(project, label);
      assert.equal(plan.totalFrames, Math.ceil(masterS * rate - 1e-6), label);
      let cursor = 0;
      for (const v of plan.video) {
        assert.equal(v.recIn, cursor, `${label}: a hole or overlap at frame ${cursor}`);
        assert.ok(v.frames > 0);
        cursor += v.frames;
      }
      assert.equal(cursor, plan.totalFrames, label);
      project.shots.forEach((s, i) => {
        const v = plan.video.find((x) => x.shot === s.id)!;
        assert.equal(v.recIn, at(ins[i]!, rate), `${label} ${s.id} in`);
        assert.equal(v.recIn + v.frames, at(outs[i]!, rate), `${label} ${s.id} out`);
      });
      assert.equal(plan.video.filter((v) => v.kind === 'still').length, 200);
    }
  });

  it('the FCPXML of the full fixture validates against Apple\'s DTD (when AKUKO_FCPXML_DTD is set), cards and moves included', { skip: !process.env['AKUKO_FCPXML_DTD'] }, async () => {
    const { project, dir } = await build();
    const card = project.assets.find((a) => a.id === 'card_P2-CARD')!;
    card.status = 'approved';
    card.file = { uri: 'cut/cards/card_P2-CARD.mp4', mime: 'video/mp4', hash: 'x' };
    await mkdir(join(dir, 'cut', 'cards'), { recursive: true });
    await writeFile(join(dir, 'cut', 'cards', 'card_P2-CARD.mp4'), miniMp4(0.75));
    const out = join(await scratch(), 'resolve');
    await writeExport({ project, projectDir: dir, outDir: out });
    const dtd = parseDtd(readFileSync(process.env['AKUKO_FCPXML_DTD']!, 'utf8'));
    assert.deepEqual(validate(parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8')), dtd), []);
  });
});

describe('master clock: units removed from the sheet, shots with no film time', () => {
  const REMOVED = '2026-11-10T09:00:00Z';

  it('a removed shot is never placed, even approved; it is listed as removed from the sheet', async () => {
    const { project, dir } = await build();
    const shot = project.shots.find((s) => s.id === 'S01-020')!; // approved key frame, film time kept
    shot.source = { ...shot.source!, removed_at: REMOVED };
    const out = join(await scratch(), 'resolve');
    const r = await writeExport({ project, projectDir: dir, outDir: out });
    assert.ok(r.plan.video.every((v) => v.shot !== 'S01-020'), 'not on the timeline');
    assert.ok(!r.plan.media.some((m) => m.shot === 'S01-020'), 'its approved key frame is not exported');
    assert.deepEqual(r.plan.shots.find((s) => s.shot === 'S01-020')!.uses, 'removed');
    assert.match(r.plan.leftOut.find((x) => x.unit === 'S01-020')!.why, /removed from the sheet/);
    assert.equal(r.plan.video.reduce((n, v) => n + v.frames, 0), r.plan.totalFrames, 'the film time it had is a gap, not closed up');
    assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /S01-020 \(shot\): removed from the sheet/);
    assert.match(readFileSync(join(out, 'LEFT-OUT.md'), 'utf8'), /S01-020[^\n]*removed from the sheet/);
  });

  it('a removed card (which keeps its film time) is never placed, so it cannot cover the row that replaced it', async () => {
    const { project, dir } = await build();
    const card = project.assets.find((a) => a.id === 'card_S00-020')!; // approved, film 0 - 1 s
    card.source = { ...card.source!, removed_at: REMOVED };
    const plan = await planFromFolder({ project, projectDir: dir });
    assert.ok(plan.video.every((v) => v.card === undefined), 'no card on the timeline');
    assert.ok(!plan.media.some((m) => m.asset === 'card_S00-020'));
    assert.deepEqual(plan.cards, []);
    assert.match(plan.leftOut.find((x) => x.unit === 'card_S00-020')!.why, /removed from the sheet/);
    assert.deepEqual(plan.video[0]!.kind, 'gap', 'its slot is empty');
    assert.equal(plan.video[0]!.frames, 36, 'the empty slot joins the scene-start gap');
  });

  it('an approved shot with no film time is left out as "no film time" and nothing crashes', async () => {
    const { project, dir } = await build();
    delete project.shots.find((s) => s.id === 'S02-010')!.film; // its clip is approved
    const out = join(await scratch(), 'resolve');
    const r = await writeExport({ project, projectDir: dir, outDir: out });
    assert.ok(r.plan.video.every((v) => v.shot !== 'S02-010'));
    assert.match(r.plan.leftOut.find((x) => x.unit === 'S02-010')!.why, /no film time/);
    assert.equal(r.plan.shots.find((s) => s.shot === 'S02-010')!.uses, 'no-duration');
    assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /S02-010 \(shot\): it has no film time/);
    assert.equal(r.plan.video.reduce((n, v) => n + v.frames, 0), r.plan.totalFrames);
  });
});
