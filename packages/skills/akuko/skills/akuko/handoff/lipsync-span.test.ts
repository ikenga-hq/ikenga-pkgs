// WP-32: a lip-sync is placed at its span's film time in the master-clock handoff, with the shot's approved key
// frame (and its move) held before and after it. Synthetic project (`__fixtures__/master.ts`), invented times.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { PNG_BYTES } from '../providers/gemini-image/__fixtures__/mock-net.ts';
import { AkukoProjectSchema, type AkukoProject } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { parseEdl } from './edl.ts';
import { moveAt, movePiece } from './fcpxml.ts';
import { parseFcpTime, parseFps } from './timecode.ts';
import { planFromFolder, writeExport } from './write.ts';
import { buildMasterProject } from './__fixtures__/master.ts';
import { find, parseXml, type XmlNode } from './__fixtures__/xml.ts';

const tmps: string[] = [];
const scratch = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'akuko-lipspan-'));
  tmps.push(d);
  return d;
};
after(async () => {
  for (const d of tmps) await rm(d, { recursive: true, force: true });
});
const fps24 = parseFps('24');
const spineOf = (root: XmlNode): XmlNode =>
  find(find(find(find(root, 'library')[0]!, 'event')[0]!, 'project')[0]!, 'sequence')[0]!.children.find((c) => c.name === 'spine')!;

/**
 * The master fixture's S01-010 (film 1.5 to 4.0 s, frames 36 to 96 at 24 fps) with an approved key frame and a
 * camera move. Its lip-sync (a 2.5 s file) records the span of the audio it sent: 2.0 to 3.25 s, frames 48 to 78.
 */
async function build(o: { film?: boolean; keyframe?: 'approved' | 'pending-review'; lines?: boolean } = {}): Promise<{ project: AkukoProject; dir: string }> {
  const root = await scratch();
  const fx = await buildMasterProject(root);
  await writeFile(join(fx.dir, 'board', 'keyframes', 'S01-010.png'), PNG_BYTES);
  const p = structuredClone(fx.project) as AkukoProject;
  const shot = p.shots.find((s) => s.id === 'S01-010')!;
  shot.move = { from_scale: 1, to_scale: 1.2, x: -60, y: 0 };
  p.assets.push({ id: 'S01-010_keyframe', kind: 'keyframe', stage: 'keyframes', status: o.keyframe ?? 'approved', owner: 'S01-010', tags: ['keyframe'], comments: [], file: { uri: 'board/keyframes/S01-010.png', mime: 'image/png', hash: 'x' } } as never);
  const lip = p.assets.find((a) => a.id === 'S01-010_lipsync')!;
  if (o.film !== false) lip.film = { in_s: 2.0, out_s: 3.25 };
  if (o.lines) {
    // Today's line (invented): 2.5 to 3.0 s; the step's rule pads it to 2.3 to 3.3 s (frames 55 to 79).
    p.audio.lines = [{ id: 'L01', kind: 'spoken', film_in_s: 2.5, film_out_s: 3.0 }];
    shot.lines = [{ id: 'L01', kind: 'spoken' }];
  }
  return { project: AkukoProjectSchema.parse(p), dir: fx.dir };
}

const shotEvents = (plan: Awaited<ReturnType<typeof planFromFolder>>, shot: string) => plan.video.filter((v) => v.shot === shot).map((v) => [v.kind, v.from ?? '', v.recIn, v.frames]);

describe('lip-sync at its span (master-clock handoff)', () => {
  it('the project is valid with a recorded span', async () => {
    const { project } = await build();
    assert.deepEqual(checkIntegrity(project), []);
  });

  it('sits on V1 at its span\'s in, with the key frame held before and after it, shots still touching', async () => {
    const { project, dir } = await build();
    const plan = await planFromFolder({ project, projectDir: dir });
    assert.deepEqual(shotEvents(plan, 'S01-010'), [
      ['still', 'keyframe', 36, 12], // 1.5 to 2.0 s: the key frame holds
      ['clip', 'lipsync', 48, 30], // 2.0 to 3.25 s: the lip-sync, its 2.5 s file cut at the span's end
      ['still', 'keyframe', 78, 18], // 3.25 to 4.0 s: the key frame holds again
    ]);
    assert.equal(plan.shots.find((s) => s.shot === 'S01-010')!.uses, 'lipsync');
    // The shot's slot still runs 36 to 96 and the next shot starts where it ends: nothing moved, nothing overlaps.
    let at = 0;
    for (const v of plan.video) { assert.equal(v.recIn, at); at += v.frames; }
    assert.equal(plan.video.find((v) => v.shot === 'S01-020')!.recIn, 96);
    const pieces = plan.video.filter((v) => v.shot === 'S01-010' && v.kind === 'still');
    assert.deepEqual(pieces.map((v) => v.moveSpan), [{ at: 0, of: 60 }, { at: 42, of: 60 }]);
    assert.ok(pieces.every((v) => v.media!.asset === 'S01-010_keyframe'));
    assert.equal(plan.media.filter((m) => m.asset === 'S01-010_keyframe').length, 1, 'one still file for both pieces');
    const mv = plan.moves!.find((m) => m.shot === 'S01-010')!;
    assert.deepEqual([mv.recIn, mv.frames, mv.around], [36, 60, { recIn: 48, frames: 30 }]);
  });

  it('the move is split across the pieces, never restarted: each piece starts where the whole move is at that frame', async () => {
    const { project, dir } = await build();
    const out = join(await scratch(), 'resolve');
    await writeExport({ moves: 'keyframes', project, projectDir: dir, outDir: out, format: 'both' });
    const root = parseXml(readFileSync(join(out, 'timeline.fcpxml'), 'utf8'));
    const stills = find(spineOf(root), 'video').filter((v) => /S01-010_still/.test(v.attrs['name']!));
    assert.equal(stills.length, 2);
    const kfs = (v: XmlNode, name: string): XmlNode[] => find(find(find(find(v, 'adjust-transform')[0]!, 'param').find((x) => x.attrs['name'] === name)!, 'keyframeAnimation')[0]!, 'keyframe');
    const [a, b] = stills as [XmlNode, XmlNode];
    assert.equal(parseFcpTime(a.attrs['duration']!, fps24), 12);
    assert.equal(parseFcpTime(b.attrs['duration']!, fps24), 18);
    // Whole move over 60 frames: scale 1 -> 1.2, x 0 -> -60 px (-5.5556 % of the height). Linear (no ease).
    assert.deepEqual(kfs(a, 'scale').map((k) => k.attrs['value']), ['1 1', '1.04 1.04']); // frames 0 and 12 of 60
    assert.deepEqual(kfs(a, 'position').map((k) => k.attrs['value']), ['0 0', '-1.1111 0']);
    assert.deepEqual(kfs(b, 'scale').map((k) => k.attrs['value']), ['1.14 1.14', '1.2 1.2']); // frames 42 and 60 of 60
    assert.deepEqual(kfs(b, 'position').map((k) => k.attrs['value']), ['-3.8889 0', '-5.5556 0']);
    assert.equal(parseFcpTime(kfs(b, 'scale')[1]!.attrs['time']!, fps24), 18, 'keyframe times are in the piece\'s own time');
    const marker = find(b, 'marker')[0]!;
    assert.match(marker.attrs['value']!, /frames 42 to 60 of the shot's 60, held around its lip-sync/);
    // The lip-sync between them is a plain clip with no transform.
    const lip = find(spineOf(root), 'asset-clip').find((c) => /S01-010_lipsync/.test(c.attrs['name']!))!;
    assert.equal(find(lip, 'adjust-transform').length, 0);
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    assert.match(readme, /lip-sync clip sits at its line's film time/);
    assert.match(readme, /\| S01-010 \| 00:00:01:12 \| 60 frames \| .*held around the lip-sync at 00:00:02:00 \(30 frames\) \|/);
    // EDL: the held key frame is its own reel and says which piece of the move it carries.
    const edl = parseEdl(readFileSync(join(out, 'edl', 'video.edl'), 'utf8'));
    const held = edl.events.filter((e) => /^V\d{3}K$/.test(e.reel));
    assert.equal(held.length, 2, JSON.stringify(edl.events.map((e) => e.reel)));
    assert.ok(held[1]!.comments.some((c) => /MOVE S01-010: .*frames 42 to 60 of the shot's 60/.test(c)), held[1]!.comments.join(' | '));
  });

  it('eased moves: piece ends are exact on the eased curve; the cut ends are linear', () => {
    const mv = { from_scale: 1, to_scale: 1.2, x: -60, y: 0, ease: 'ease-in-out' as const };
    const p1 = movePiece(mv, 0, 12, 60);
    const p2 = movePiece(mv, 42, 18, 60);
    assert.deepEqual(p1.interps, ['ease', 'linear']);
    assert.deepEqual(p2.interps, ['linear', 'ease']);
    assert.ok(Math.abs(p1.end.scale - moveAt(mv, 0.2).scale) < 1e-12);
    assert.ok(Math.abs(p2.start.scale - moveAt(mv, 0.7).scale) < 1e-12);
    assert.ok(p2.start.scale > 1.14, 'an ease-in-out move is further along at 70% of its time than a linear one');
    assert.deepEqual(movePiece(mv, 0, 60, 60).interps, ['ease', 'ease'], 'a whole-slot still keeps the move\'s own eases');
  });

  it('with no approved key frame the slot around the lip-sync is a gap, listed as left out', async () => {
    const { project, dir } = await build({ keyframe: 'pending-review' });
    const plan = await planFromFolder({ project, projectDir: dir });
    assert.deepEqual(shotEvents(plan, 'S01-010'), [['gap', '', 36, 12], ['clip', 'lipsync', 48, 30], ['gap', '', 78, 18]]);
    const why = plan.leftOut.find((x) => x.unit === 'S01-010_keyframe')!.why;
    assert.match(why, /pending-review/);
    assert.match(why, /the slot around the lip-sync is a gap before it \(12 frames\) and after it \(18 frames\)/);
  });

  it('an old lip-sync with no recorded span falls back to today\'s lines, and says so', async () => {
    const { project, dir } = await build({ film: false, lines: true });
    const plan = await planFromFolder({ project, projectDir: dir });
    // wantedSpan: 2.5 - 0.2 = 2.3 s (frame 55) to 3.0 + 0.3 = 3.3 s (frame 79).
    assert.deepEqual(shotEvents(plan, 'S01-010'), [['still', 'keyframe', 36, 19], ['clip', 'lipsync', 55, 24], ['still', 'keyframe', 79, 17]]);
    assert.ok(plan.warnings.some((w) => /^S01-010_lipsync: no film span is recorded on it .* placed by today's lines at 2\.3 to 3\.3 s/.test(w)), plan.warnings.join('\n'));
  });

  it('an old lip-sync with no span and no line to place it by fills the shot from its start, as before, and says so', async () => {
    const { project, dir } = await build({ film: false });
    const plan = await planFromFolder({ project, projectDir: dir });
    assert.deepEqual(shotEvents(plan, 'S01-010'), [['clip', 'lipsync', 36, 60]]);
    assert.ok(plan.warnings.some((w) => /S01-010_lipsync: no film span is recorded on it and the shot has no spoken line/.test(w)));
  });

  it('a span shorter than one frame is placed on the whole slot and says so (not "outside the shot")', async () => {
    const { project, dir } = await build();
    project.assets.find((a) => a.id === 'S01-010_lipsync')!.film = { in_s: 2.0, out_s: 2.01 };
    const plan = await planFromFolder({ project, projectDir: dir });
    assert.deepEqual(shotEvents(plan, 'S01-010'), [['clip', 'lipsync', 36, 60]]);
    assert.ok(plan.warnings.some((w) => /S01-010_lipsync: its span \(2 to 2\.01 s\) is shorter than one frame at 24 fps, so it was placed on the whole slot/.test(w)), plan.warnings.join('\n'));
    assert.ok(!plan.warnings.some((w) => /falls outside/.test(w)));
    project.assets.find((a) => a.id === 'S01-010_lipsync')!.film = { in_s: 5, out_s: 6 };
    const out = await planFromFolder({ project, projectDir: dir });
    assert.ok(out.warnings.some((w) => /S01-010_lipsync: its span \(5 to 6 s\) falls outside the shot's film time/.test(w)));
  });

  it('the recorded span wins over today\'s lines (the lines moved after the lip-sync was made)', async () => {
    const { project, dir } = await build({ lines: true });
    const plan = await planFromFolder({ project, projectDir: dir });
    assert.deepEqual(shotEvents(plan, 'S01-010')[1], ['clip', 'lipsync', 48, 30]);
    assert.ok(!plan.warnings.some((w) => /no film span is recorded/.test(w)));
  });

  it('a clip whose shot moved since it was made is placed at the shot and the drift is named', async () => {
    const { project, dir } = await build();
    const clip = project.assets.find((a) => a.id === 'S02-010_clip')!;
    clip.film = { in_s: 6.5, out_s: 8.5 }; // made when the shot started at 6.5 s; it now starts at 7.0 s
    const plan = await planFromFolder({ project, projectDir: dir });
    assert.deepEqual(shotEvents(plan, 'S02-010'), [['clip', 'clip', 168, 48]]);
    assert.ok(plan.warnings.some((w) => /S02-010_clip: made when the shot started at 6\.5 s; the shot now starts at 7 s/.test(w)));
  });
});
