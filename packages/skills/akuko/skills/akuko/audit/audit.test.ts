// WP-14 — the continuity audit for key frames.
//
// Runs on the short-story fixture ("The Beating", 12 shots) with every key
// frame made and approved by a person. The audit is advisory: it must never
// change a status, and re-running it must replace only its own comments.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AkukoProjectSchema, type AkukoProject, type Asset } from '../schema/akuko-project.ts';
import { createLocalHost } from '../hosts/local.ts';
import { AUDIT_PREFIX, applyAuditComments, auditProject, isAuditComment, renderSummary, takeOf, type VisualNote } from './audit.ts';
import { run } from './cli.ts';
import { shortStoryKeyframesApproved } from './__fixtures__/project.ts';

const NOW = '2026-11-09T09:00:00Z';
const clean = (): AkukoProject => shortStoryKeyframesApproved();
const asset = (p: AkukoProject, id: string): Asset => p.assets.find((a) => a.id === id)!;
const kf = (shot: string): string => `${shot}_keyframe`;
const frame = (r: ReturnType<typeof auditProject>, shot: string) => r.frames.find((f) => f.shot === shot)!;
const checks = (r: ReturnType<typeof auditProject>, shot: string): string[] => [...frame(r, shot).structural, ...frame(r, shot).visual].map((f) => `${f.check}:${f.severity}`);

/** Everything that is not a comment: statuses, files, tags, stages, ledger. */
const withoutComments = (p: AkukoProject): unknown => JSON.parse(JSON.stringify({ ...p, assets: p.assets.map((a) => ({ ...a, comments: [] })) }));

describe('audit: the clean fixture', () => {
  it('has all 12 key frames approved, and the structural checks find no high finding', () => {
    const p = clean();
    assert.equal(p.stages.keyframes.state, 'approved');
    const r = auditProject(p, { now: NOW });
    assert.equal(r.summary.audited, 12);
    assert.equal(r.summary.high, 0);
    assert.equal(r.summary.clean, true);
    assert.deepEqual(r.not_made, []);
    for (const f of r.frames) assert.equal(f.status, 'approved');
  });

  it('is flat: no medium findings either, no suggestion, an empty-ish summary', () => {
    const r = auditProject(clean(), { now: NOW });
    assert.equal(r.summary.flagged, 0);
    assert.ok(r.frames.every((f) => f.suggestion === undefined));
    assert.match(renderSummary(r), /No high findings\./);
  });

  it('is a pure function: it does not change the project it is given', () => {
    const p = clean();
    const before = structuredClone(p);
    auditProject(p, { now: NOW });
    assert.deepEqual(p, before);
  });
});

describe('audit: a seeded drift case', () => {
  /** sc1_sh1 made without the narrator's turnaround; sc2_sh3 from a superseded turnaround; sc2_sh1 with 3 principals. */
  function seeded(): AkukoProject {
    const p = clean();
    // 1. sc1_sh1: made without the principal's turnaround (the stamp is missing).
    const a = asset(p, kf('sc1_sh1'));
    a.tags = a.tags.filter((t) => !t.startsWith('from:char_the-narrator_turnaround@'));
    // 2. sc2_sh3: the old man's turnaround was replaced after the frame was made (its file changed).
    asset(p, 'char_the-old-man_turnaround').file = { uri: 'mem://assets/char_the-old-man_turnaround-v2.png', mime: 'image/png', hash: 'h-new' };
    // 3. sc2_sh1: a third principal in one frame.
    p.bible.characters.find((c) => c.id === 'char_officers-3')!.role = 'Principal';
    p.shots.find((s) => s.id === 'sc2_sh1')!.refs.push('char_officers-3');
    return AkukoProjectSchema.parse(p);
  }

  it('flags a frame made without the principal\'s turnaround (high)', () => {
    const r = auditProject(seeded(), { now: NOW });
    assert.ok(checks(r, 'sc1_sh1').includes('missing-reference:high'));
    const f = frame(r, 'sc1_sh1');
    assert.match(f.structural.find((x) => x.check === 'missing-reference')!.text, /Made without The Narrator's approved turnaround/);
    assert.match(f.suggestion ?? '', /^send back sc1_sh1: /);
  });

  it('flags a frame made from a superseded turnaround (high), reusing the key-frame stage check', () => {
    const r = auditProject(seeded(), { now: NOW });
    // Every frame stamped with the old man's turnaround is stale, not just one.
    assert.ok(checks(r, 'sc2_sh3').includes('superseded-reference:high'));
    assert.match(frame(r, 'sc2_sh3').structural.find((x) => x.check === 'superseded-reference')!.text, /char_the-old-man_turnaround, which was replaced after this frame was made/);
    assert.ok(!checks(r, 'sc1_sh1').includes('superseded-reference:high'), 'a frame without that reference is not stale on it');
  });

  it('flags a frame with 3 principals (high)', () => {
    const r = auditProject(seeded(), { now: NOW });
    const f = frame(r, 'sc2_sh1').structural.find((x) => x.check === 'too-many-principals')!;
    assert.equal(f.severity, 'high');
    assert.match(f.text, /3 principals in one frame \(The Narrator, The Old Man, Officers/);
  });

  it('an unflagged frame stays clean', () => {
    const r = auditProject(seeded(), { now: NOW });
    assert.equal(frame(r, 'sc3_sh1').worst, 'none');
    assert.equal(r.summary.clean, false);
  });

  it('flags a superseded plate or lookbook as medium and a character no longer approved as high', () => {
    const p = clean();
    asset(p, 'style_lookbook_lookbook').status = 'needs-rework';
    const r = auditProject(p, { now: NOW });
    assert.ok(checks(r, 'sc3_sh1').includes('superseded-reference:medium'));
    asset(p, 'char_the-narrator_turnaround').status = 'needs-rework';
    assert.match(frame(auditProject(p, { now: NOW }), 'sc3_sh1').structural.map((x) => x.text).join(' '), /char_the-narrator_turnaround, which is now needs-rework/);
  });

  it('flags a character named in the shot but absent from its refs', () => {
    const p = clean();
    p.shots.find((s) => s.id === 'sc3_sh1')!.action = 'The Old Man stirs in the dark while the Narrator watches.';
    const r = auditProject(p, { now: NOW });
    assert.ok(checks(r, 'sc3_sh1').includes('character-not-in-prompt:medium'));
    assert.match(frame(r, 'sc3_sh1').structural.find((x) => x.check === 'character-not-in-prompt')!.text, /The Old Man is named/);
  });

  it('flags a mixed provider or model within one scene', () => {
    const p = clean();
    asset(p, kf('sc2_sh2')).model = 'model-b';
    const r = auditProject(p, { now: NOW });
    assert.deepEqual(checks(r, 'sc2_sh2'), ['mixed-model:medium']);
    assert.match(frame(r, 'sc2_sh2').structural[0]!.text, /gemini-image\/model-b while most of scene sc2 used gemini-image\/model-a/);
    assert.equal(frame(r, 'sc2_sh1').worst, 'none');
    // Another scene using another model is fine.
    const q = clean();
    for (const s of ['sc3_sh1']) asset(q, kf(s)).model = 'model-b';
    assert.equal(auditProject(q, { now: NOW }).summary.flagged, 0);
  });

  it('flags a lookbook that is not the style the shot names', () => {
    const p = clean();
    p.bible.styles.push({ ...p.bible.styles[0]!, id: 'style_other', name: 'Other', refs: [] });
    p.assets.push({ ...asset(p, 'style_lookbook_lookbook'), id: 'style_other_lookbook', owner: 'style_other' });
    asset(p, kf('sc3_sh1')).tags.push(`from:style_other_lookbook@00000000`);
    p.shots.find((s) => s.id === 'sc3_sh1')!.refs.push('style_lookbook');
    const r = auditProject(p, { now: NOW });
    assert.ok(checks(r, 'sc3_sh1').includes('lookbook-mismatch:medium'));
  });

  it('skips key frames with no image and lists them', () => {
    const p = clean();
    const a = asset(p, kf('sc4_sh4'));
    delete a.file;
    a.status = 'pending';
    const r = auditProject(p, { now: NOW });
    assert.equal(r.summary.audited, 11);
    assert.deepEqual(r.not_made, [kf('sc4_sh4')]);
  });
});

describe('audit: visual notes and comments', () => {
  const noteFor = (p: AkukoProject, shot: string, text: string, severity: VisualNote['severity']): VisualNote => ({ unit: kf(shot), text, severity, take: takeOf(asset(p, kf(shot))) });

  it('a recorded visual finding shows up as an "Audit:" agent comment and in the suggestion', () => {
    const p = clean();
    const r = auditProject(p, { visual: [noteFor(p, 'sc2_sh3', 'hair colour differs from the turnaround', 'high')], now: NOW, run: 'audit_r1' });
    assert.equal(r.summary.high, 1);
    assert.equal(frame(r, 'sc2_sh3').suggestion, 'send back sc2_sh3: hair colour differs from the turnaround');
    const next = applyAuditComments(p, r, NOW);
    const c = asset(next, kf('sc2_sh3')).comments.filter(isAuditComment);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.author, 'agent');
    assert.equal(c[0]!.stage, 'keyframes');
    assert.equal(c[0]!.text, `${AUDIT_PREFIX}high: hair colour differs from the turnaround. (audit audit_r1)`);
    AkukoProjectSchema.parse(next);
  });

  it('re-running replaces only its own comments and a person\'s comment survives', () => {
    let p = clean();
    const baseline = asset(p, kf('sc2_sh3')).comments.length; // the person's approval note
    asset(p, kf('sc2_sh3')).comments.push({ ts: '2026-11-08T12:00:00Z', stage: 'keyframes', author: 'you', text: 'Audit: I think this one is fine, leave it' });
    asset(p, kf('sc2_sh3')).comments.push({ ts: '2026-11-08T12:01:00Z', stage: 'keyframes', author: 'agent', text: 'Revised: regenerating after the requested changes' });
    const r1 = auditProject(p, { visual: [noteFor(p, 'sc2_sh3', 'hair too light', 'medium')], now: NOW, run: 'audit_r1' });
    p = applyAuditComments(p, r1, NOW);
    const r2 = auditProject(p, { visual: [noteFor(p, 'sc2_sh3', 'hair too light', 'medium'), noteFor(p, 'sc3_sh1', 'coat is the wrong colour', 'low')], now: NOW, run: 'audit_r2' });
    p = applyAuditComments(p, r2, NOW);
    const texts = asset(p, kf('sc2_sh3')).comments.map((c) => c.text);
    assert.equal(texts.length, baseline + 3, 'no pile-up: the earlier audit comment was replaced');
    assert.ok(texts.includes('Audit: I think this one is fine, leave it'), 'a person\'s comment, even one starting "Audit:", survives');
    assert.ok(texts.includes('Revised: regenerating after the requested changes'), 'the agent\'s other comments survive');
    assert.ok(texts.some((t) => t.endsWith('(audit audit_r2)')) && !texts.some((t) => t.endsWith('(audit audit_r1)')));
    assert.equal(asset(p, kf('sc3_sh1')).comments.filter(isAuditComment).length, 1);
    // A clean re-run removes the audit's comments and nothing else.
    p = applyAuditComments(p, auditProject(p, { now: NOW, run: 'audit_r3' }), NOW);
    assert.equal(p.assets.flatMap((a) => a.comments).filter(isAuditComment).length, 0);
    assert.equal(asset(p, kf('sc2_sh3')).comments.length, baseline + 2);
  });

  it('moves no status and touches nothing but comments', () => {
    const base = shortStoryKeyframesApproved();
    const p = structuredClone(base);
    // Seed several kinds of finding at once.
    asset(p, kf('sc1_sh1')).tags = asset(p, kf('sc1_sh1')).tags.filter((t) => !t.startsWith('from:char_the-narrator_turnaround@'));
    asset(p, kf('sc2_sh2')).model = 'model-b';
    const r = auditProject(p, { visual: [noteFor(p, 'sc3_sh1', 'looks like a different person', 'high')], now: NOW });
    const next = applyAuditComments(p, r, NOW);
    assert.deepEqual(withoutComments(next), withoutComments(p));
    assert.deepEqual(next.stages, p.stages);
    assert.deepEqual(next.ledger, p.ledger);
    assert.deepEqual(next.pending_spend, p.pending_spend);
    assert.equal(asset(next, kf('sc3_sh1')).status, 'approved');
    assert.ok(next.assets.flatMap((a) => a.comments).length > p.assets.flatMap((a) => a.comments).length);
  });

  it('leaves out a note recorded on an earlier take of a regenerated frame', () => {
    const p = clean();
    const note = noteFor(p, 'sc2_sh3', 'hair too light', 'high');
    asset(p, kf('sc2_sh3')).file = { uri: 'mem://assets/sc2_sh3_keyframe-r2.png', mime: 'image/png', hash: 'h-take2' };
    const r = auditProject(p, { visual: [note], now: NOW });
    assert.equal(r.summary.high, 0);
    assert.equal(r.stale_notes.length, 1);
    assert.match(renderSummary(r), /earlier take of a regenerated frame/);
  });
});

describe('audit: the command line', () => {
  async function setup(mutate?: (p: AkukoProject) => void): Promise<{ dir: string; p: AkukoProject }> {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-audit-'));
    const p = shortStoryKeyframesApproved();
    mutate?.(p);
    await createLocalHost({ projectDir: dir }).writeState(AkukoProjectSchema.parse(p));
    return { dir, p };
  }
  const read = (dir: string) => createLocalHost({ projectDir: dir }).readState();
  const clock = () => new Date(NOW);

  it('run writes board/audit.json and board/audit.md and changes no status', async () => {
    const { dir, p } = await setup((x) => { asset(x, kf('sc1_sh1')).tags = asset(x, kf('sc1_sh1')).tags.filter((t) => !t.startsWith('from:char_the-narrator_turnaround@')); });
    const r = await run(['run', '--project', dir], clock);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Audited 12 key frames: 1 with findings \(1 high, 0 medium, 0 low\)/);
    assert.match(r.out, /send back sc1_sh1/);
    const json = JSON.parse(readFileSync(join(dir, 'board', 'audit.json'), 'utf8')) as { report: { summary: { high: number } } };
    assert.equal(json.report.summary.high, 1);
    assert.match(readFileSync(join(dir, 'board', 'audit.md'), 'utf8'), /### sc1_sh1_keyframe \(high\)/);
    const after = await read(dir);
    assert.deepEqual(withoutComments(after), withoutComments(AkukoProjectSchema.parse(p)));
    assert.equal(asset(after, kf('sc1_sh1')).comments.filter(isAuditComment).length, 1);
  });

  it('record stores the agent\'s note; run publishes it; running again does not pile comments up', async () => {
    const { dir } = await setup();
    const rec = await run(['record', '--project', dir, '--unit', kf('sc2_sh3'), '--finding', 'hair colour differs from the turnaround', '--severity', 'high'], clock);
    assert.equal(rec.code, 0, rec.out);
    assert.equal((await read(dir)).assets.flatMap((a) => a.comments).filter(isAuditComment).length, 0, 'record alone writes no comment');
    await run(['run', '--project', dir], clock);
    await run(['run', '--project', dir], clock);
    const after = await read(dir);
    const mine = asset(after, kf('sc2_sh3')).comments.filter(isAuditComment);
    assert.equal(mine.length, 1);
    assert.match(mine[0]!.text, /^Audit: high: hair colour differs from the turnaround\. \(audit audit_/);
    const sum = await run(['summary', '--project', dir], clock);
    assert.match(sum.out, /send back sc2_sh3: hair colour differs from the turnaround/);
  });

  it('record refuses a unit that is not a key frame, a missing image, and a bad severity', async () => {
    const { dir } = await setup((x) => { const a = asset(x, kf('sc4_sh4')); delete a.file; a.status = 'pending'; });
    assert.equal((await run(['record', '--project', dir, '--unit', 'sc1_sh1', '--finding', 'x', '--severity', 'low'], clock)).code, 1);
    assert.equal((await run(['record', '--project', dir, '--unit', kf('sc4_sh4'), '--finding', 'x', '--severity', 'low'], clock)).code, 1);
    assert.equal((await run(['record', '--project', dir, '--unit', kf('sc1_sh1'), '--finding', 'x', '--severity', 'bad'], clock)).code, 2);
    assert.equal((await run(['record', '--project', dir, '--unit', kf('sc1_sh1')], clock)).code, 2);
    assert.equal((await run(['nope', '--project', dir], clock)).code, 2);
  });
});
