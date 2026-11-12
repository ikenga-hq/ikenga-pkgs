// WP-04 — intake + breakdown: the code each route ends in.
//
// LLM-driven (not tested here): adapting prose to a screenplay, and the shot
// judgement that produces a proposal. Tested here: Fountain reading, tag
// insertion and reading, id allocation, lint, mapping a proposal into a
// schema-valid project, the idempotent re-run, and the CLI over a real folder.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../providers/__fixtures__/fake-host.ts';
import { AkukoProjectSchema, type AkukoProject } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { alreadyBrokenDown, applyBreakdown, checkProposal, planRetag, ProposalError, tagScriptCopy, taggedPathFor, withTaggedCopy } from './apply.ts';
import { run } from './cli.ts';
import { parseFountain } from './fountain.ts';
import { completeIntake, createProject, detectSourceKind, slugify } from './intake.ts';
import { hasErrors, lintShots, lintTags, principalsOf } from './lint.ts';
import { allocateShotId, insertedShotId, insertTags, readTags, stripTags } from './tags.ts';

const FIX = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const read = (f: string) => readFileSync(`${FIX}${f}`, 'utf8');
const story = read('story.md');
const screenplay = read('screenplay.fountain');
const adaptProposal = JSON.parse(read('proposal-adapt.json')) as unknown;
const directProposal = JSON.parse(read('proposal-direct.json')) as unknown;
const T0 = () => new Date('2026-11-07T10:00:00Z');

/** A project as breakdown finds it: intake done and approved by a person. */
function readyProject(route: 'adapt' | 'direct'): AkukoProject {
  const p = completeIntake(createProject({ title: 'The Last Ferry', now: T0 }), { route, now: T0 });
  p.stages.intake = { state: 'approved' };
  p.stages.breakdown = { state: 'not-started' };
  for (const a of p.assets) { a.status = 'approved'; }
  return AkukoProjectSchema.parse(p);
}

describe('fountain reader', () => {
  const doc = parseFountain(screenplay);
  it('numbers scenes in order and reads headings', () => {
    assert.deepEqual(doc.scenes.map((s) => [s.id, s.heading]), [
      ['sc1', 'EXT. RIVER PIER - DUSK'],
      ['sc2', 'EXT. THE FERRY - MID-RIVER - NIGHT'],
      ['sc3', 'EXT. FAR PIER - NIGHT'],
    ]);
  });
  it('names block kinds', () => {
    assert.equal(doc.blocks[0]!.kind, 'title');
    assert.ok(doc.blocks.some((b) => b.kind === 'dialogue' && b.text.startsWith('OREN')));
    assert.equal(doc.blocks.at(-1)!.kind, 'transition');
  });
  it('detects screenplay vs prose', () => {
    assert.equal(detectSourceKind(screenplay), 'fountain');
    assert.equal(detectSourceKind(story), 'prose');
  });
});

describe('tags', () => {
  const placements = [
    { shotId: 'sc1_sh1', scene: 1, scriptLine: 'hurries onto the pier as the light fades' },
    { shotId: 'sc1_sh3', scene: 1, scriptLine: "We're closed." },
  ];

  it('appends [[id]] to the paragraph a shot came from, and reads it back', () => {
    const r = insertTags(screenplay, placements);
    assert.deepEqual(r.tagged, ['sc1_sh1', 'sc1_sh3']);
    assert.match(r.text, /as the light fades\. \[\[sc1_sh1\]\]\n/);
    assert.match(r.text, /^We're closed\. \[\[sc1_sh3\]\]$/m);
    assert.deepEqual(readTags(r.text).map((t) => t.shotId), ['sc1_sh1', 'sc1_sh3']);
  });

  it('is a no-op when run again', () => {
    const once = insertTags(screenplay, placements);
    const twice = insertTags(once.text, placements);
    assert.equal(twice.text, once.text);
    assert.deepEqual(twice.tagged, []);
    assert.deepEqual(twice.alreadyTagged, ['sc1_sh1', 'sc1_sh3']);
  });

  it('removing the tags gives back the original script', () => {
    const all = insertTags(screenplay, [{ shotId: 'sc3_sh2', scene: 3, scriptLine: 'Mara steps off the ferry.' }]);
    assert.notEqual(all.text, screenplay);
    assert.equal(stripTags(all.text), screenplay);
  });

  it('puts several shots from one paragraph side by side', () => {
    const r = insertTags(screenplay, [
      { shotId: 'sc3_sh2', scene: 3, scriptLine: 'Mara steps off the ferry.' },
      { shotId: 'sc3_sh3', scene: 3, scriptLine: 'Oren turns the boat back into the fog.' },
    ]);
    assert.match(r.text, /into the fog\. \[\[sc3_sh2\]\] \[\[sc3_sh3\]\]\n/);
  });

  it('leaves a shot untagged when no paragraph matches, or several do', () => {
    const r = insertTags(screenplay, [
      { shotId: 'sc1_sh9', scene: 1, scriptLine: 'a line that is not in the script' },
      { shotId: 'sc1_sh8', scene: 1 },
      { shotId: 'sc2_sh9', scriptLine: 'fog' + ' closes in' }, // matches in scene 2 only once, but too short without scene? still unique
    ]);
    assert.deepEqual(r.unplaced.map((u) => u.shotId), ['sc1_sh9', 'sc1_sh8']);
    assert.match(r.unplaced[0]!.reason, /no paragraph/);
    assert.match(r.unplaced[1]!.reason, /no script line/);
    const amb = insertTags('Alpha beta gamma delta.\n\nAlpha beta gamma delta again.\n', [{ shotId: 'sc1_sh1', scriptLine: 'Alpha beta gamma delta' }]);
    assert.match(amb.unplaced[0]!.reason, /2 paragraphs/);
    assert.equal(amb.text, 'Alpha beta gamma delta.\n\nAlpha beta gamma delta again.\n');
  });

  it('does not move a tag that is already elsewhere; reports a conflict', () => {
    const tagged = screenplay.replace('coils the rope of a small ferry for the last crossing of the day.', 'coils the rope of a small ferry for the last crossing of the day. [[sc1_sh1]]');
    const r = insertTags(tagged, [{ shotId: 'sc1_sh1', scene: 1, scriptLine: 'hurries onto the pier as the light fades' }]);
    assert.equal(r.text, tagged);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0]!.shotId, 'sc1_sh1');
  });

  it('matches through smart quotes, dashes and emphasis marks', () => {
    const r = insertTags('She said “stay—now” and *left* at once.\n', [{ shotId: 'sc1_sh1', scriptLine: 'She said "stay-now" and left at once.' }], { prose: true });
    assert.deepEqual(r.tagged, ['sc1_sh1']);
  });

  it('keeps CRLF line endings', () => {
    const crlf = screenplay.replace(/\n/g, '\r\n');
    const r = insertTags(crlf, [{ shotId: 'sc1_sh3', scene: 1, scriptLine: "We're closed." }]);
    assert.ok(r.text.includes("We're closed. [[sc1_sh3]]\r\n"));
    assert.equal(r.text.replace(/\r\n/g, '\n'), insertTags(screenplay, [{ shotId: 'sc1_sh3', scene: 1, scriptLine: "We're closed." }]).text);
  });

  it('allocates shot ids per scene without reusing numbers', () => {
    assert.equal(allocateShotId([], 1), 'sc1_sh1');
    assert.equal(allocateShotId(['sc1_sh1', 'sc1_sh2', 'sc2_sh1'], 1), 'sc1_sh3');
    assert.equal(allocateShotId(['sc1_sh1', 'sc1_sh4'], 1), 'sc1_sh5');
    assert.equal(allocateShotId(['sc1_sh1'], 2), 'sc2_sh1');
  });

  it('allocates insert ids that keep neighbours stable', () => {
    assert.equal(insertedShotId('sc3_sh2', ['sc3_sh1', 'sc3_sh2', 'sc3_sh3']), 'sc3_sh2A');
    assert.equal(insertedShotId('sc3_sh2', ['sc3_sh2', 'sc3_sh2A']), 'sc3_sh2B');
    assert.throws(() => insertedShotId('opening', []), /not a canonical shot id/);
  });
});

describe('lint', () => {
  function withShots(): AkukoProject {
    return applyBreakdown(readyProject('adapt'), adaptProposal, { now: T0 }).project;
  }

  it('passes the adapted breakdown', () => {
    const p = withShots();
    assert.deepEqual(lintShots(p), []);
  });

  it('fails a shot over 10 s, with a message that says what to do', () => {
    const p = withShots();
    p.shots[0]!.duration_s = 12;
    const issues = lintShots(p);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.rule, 'duration-too-long');
    assert.equal(issues[0]!.severity, 'error');
    assert.match(issues[0]!.message, /sc1_sh1 runs 12 s; a shot can be at most 10 s\. Split it/);
  });

  it('allows exactly 10 s and warns under 5 s', () => {
    const p = withShots();
    p.shots[0]!.duration_s = 10;
    p.shots[1]!.duration_s = 3;
    const issues = lintShots(p);
    assert.deepEqual(issues.map((i) => [i.rule, i.severity]), [['duration-short', 'warning']]);
  });

  it('fails a shot with more than 2 principals; background characters do not count', () => {
    const p = withShots();
    const mara = p.bible.characters.find((c) => c.name === 'Mara')!;
    const oren = p.bible.characters.find((c) => c.name === 'Oren')!;
    const woman = p.bible.characters.find((c) => c.name === 'The Woman')!;
    p.shots[3]!.refs = [mara.id, oren.id, woman.id];
    let issues = lintShots(p);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.rule, 'too-many-principals');
    assert.match(issues[0]!.message, /sc1_sh4 has 3 principal characters \(Mara, Oren, The Woman\); a shot can have at most 2/);
    woman.role = 'Background';
    issues = lintShots(p);
    assert.deepEqual(issues, []);
    assert.deepEqual(principalsOf(p, p.shots[3]!), ['Mara', 'Oren']);
  });

  it('fails a shot with no duration, no action or no scene', () => {
    const p = withShots();
    delete p.shots[0]!.duration_s;
    delete p.shots[1]!.action;
    delete p.shots[2]!.scene;
    const rules = lintShots(p).map((i) => i.rule).sort();
    assert.deepEqual(rules, ['action-missing', 'duration-missing', 'scene-missing']);
  });

  it('the limits can be changed', () => {
    const p = withShots();
    assert.ok(lintShots(p, { maxSeconds: 7 }).some((i) => i.rule === 'duration-too-long'));
    assert.ok(lintShots(p, { maxPrincipals: 1 }).some((i) => i.rule === 'too-many-principals'));
  });

  it('checks tags against shots', () => {
    const p = withShots();
    const tagged = planRetag(p, screenplay).text;
    assert.deepEqual(lintTags(p, tagged), []);
    const bad = tagged + '\nA stray note. [[sc9_sh1]]\n';
    assert.deepEqual(lintTags(p, bad).map((i) => [i.rule, i.severity]), [['tag-unknown-shot', 'error']]);
    assert.ok(lintTags(p, screenplay).every((i) => i.rule === 'tag-missing' && i.severity === 'warning'));
    assert.ok(hasErrors(lintTags(p, bad)));
  });
});

describe('route: adapt (prose -> screenplay -> breakdown)', () => {
  it('intake records the story and the adapted screenplay for review', () => {
    const p = completeIntake(createProject({ title: 'The Last Ferry', now: T0 }), { route: 'adapt', now: T0 });
    assert.equal(p.project.slug, 'the-last-ferry');
    assert.equal(p.script.source, 'script/source.md');
    assert.equal(p.script.screenplay, 'script/screenplay.fountain');
    assert.deepEqual(p.assets.map((a) => [a.id, a.status, a.stage]), [
      ['script-source', 'pending-review', 'intake'],
      ['script-screenplay', 'pending-review', 'intake'],
    ]);
    assert.equal(p.stages.intake.state, 'in-review');
    assert.equal(p.stages.breakdown.state, 'locked');
    assert.deepEqual(completeIntake(p, { route: 'adapt', now: T0 }), p, 'repeating intake changes nothing');
  });

  it('breakdown of the adapted screenplay is schema-valid, consistent, reviewable and lint-clean', () => {
    const r = applyBreakdown(readyProject('adapt'), adaptProposal, { now: T0 });
    assert.equal(r.skipped, false);
    assert.deepEqual(r.created, { scenes: 3, beats: 10, shots: 11, characters: 3, locations: 3, styles: 1 });
    AkukoProjectSchema.parse(r.project);
    assert.deepEqual(checkIntegrity(r.project), []);
    assert.deepEqual(r.lint, []);
    assert.deepEqual(r.project.shots.map((s) => s.id), [
      'sc1_sh1', 'sc1_sh2', 'sc1_sh3', 'sc1_sh4', 'sc2_sh1', 'sc2_sh2', 'sc2_sh3', 'sc2_sh4', 'sc3_sh1', 'sc3_sh2', 'sc3_sh3',
    ]);
    assert.ok(r.project.shots.every((s) => s.status === 'pending-review' && s.stage === 'breakdown'), 'nothing is approved');
    assert.ok(r.project.shots.every((s) => (s.duration_s ?? 0) <= 10 && principalsOf(r.project, s).length <= 2));
    assert.ok([...r.project.bible.characters, ...r.project.bible.locations, ...r.project.bible.styles].every((e) => e.status === 'pending-review'));
    assert.equal(r.project.stages.breakdown.state, 'in-review');
    assert.equal(r.project.current_stage, 'breakdown');
    assert.equal(r.project.stages.sketch.state, 'locked');
  });

  it('writes beats and resolves bible refs from names', () => {
    const p = applyBreakdown(readyProject('adapt'), adaptProposal, { now: T0 }).project;
    assert.equal(p.script.beats.length, 10);
    const sh = p.shots.find((s) => s.id === 'sc1_sh4')!;
    assert.deepEqual(sh.refs, ['char_mara', 'char_oren', 'loc_river-pier', 'style_fog-and-lamplight']);
    assert.equal(sh.beat, 'sc1_b4');
    const beat = p.script.beats.find((b) => b.id === sh.beat)!;
    assert.deepEqual([beat.scene_id, beat.shot_id, beat.duration_ms, beat.metadata], ['sc1', 'sc1_sh4', 8000, { act: 'I', sequence: 'Arrival' }]);
    assert.deepEqual(p.scenes.map((s) => s.id), ['sc1', 'sc2', 'sc3']);
  });

  it('tags every shot in the screenplay, once', () => {
    const p = applyBreakdown(readyProject('adapt'), adaptProposal, { now: T0 }).project;
    const r = planRetag(p, screenplay);
    assert.equal(r.tagged.length, 11);
    assert.deepEqual(r.unplaced, []);
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(readTags(r.text).map((t) => t.shotId), p.shots.map((s) => s.id));
    assert.equal(stripTags(r.text), screenplay);
  });

  // B-3 (live claude.ai run, 2026-11-11): tagging re-pointed the APPROVED screenplay asset at a tagged copy.
  it('tags go into a derived copy: the approved script and its asset are never changed (B-3)', () => {
    const p = applyBreakdown(readyProject('adapt'), adaptProposal, { now: T0 }).project;
    const approvedBefore = structuredClone(p.assets.find((a) => a.id === 'script-screenplay'));
    assert.equal(taggedPathFor('script/screenplay.fountain'), 'script/screenplay.tagged.fountain');
    assert.equal(taggedPathFor('script/source.md'), 'script/source.tagged.md');
    assert.equal(taggedPathFor('notes/script'), 'notes/script.tagged');

    const first = tagScriptCopy(p, screenplay, undefined);
    assert.equal(first.rebuilt, false);
    assert.equal(first.tagged.length, 11);
    assert.equal(stripTags(first.text), screenplay);
    const recorded = withTaggedCopy(p, 'script/screenplay.tagged.fountain');
    assert.equal(recorded.script.tagged, 'script/screenplay.tagged.fountain');
    assert.equal(recorded.script.screenplay, p.script.screenplay, 'the approved script path is untouched');
    assert.deepEqual(recorded.assets, p.assets, 'no asset is added or re-pointed, so nothing approved changes');
    assert.deepEqual(recorded.assets.find((a) => a.id === 'script-screenplay'), approvedBefore);
    assert.equal(withTaggedCopy(recorded, 'script/screenplay.tagged.fountain'), recorded, 'recording the same copy again is a no-op');
    assert.doesNotThrow(() => AkukoProjectSchema.parse(recorded));

    // the copy is reused while it is the approved text plus tags
    const again = tagScriptCopy(recorded, screenplay, first.text);
    assert.deepEqual([again.text === first.text, again.tagged.length, again.rebuilt], [true, 0, false]);
    // an approved script that changed (a person revised and re-approved it) rebuilds the copy from it
    const revised = screenplay.replace('the last crossing of the day', 'the final crossing of the day');
    assert.notEqual(revised, screenplay);
    const rebuilt = tagScriptCopy(recorded, revised, first.text);
    assert.equal(rebuilt.rebuilt, true);
    assert.equal(stripTags(rebuilt.text), revised);
  });

  it('re-running breakdown creates nothing and leaves akuko.json untouched', async () => {
    const host = createFakeHost(readyProject('adapt'));
    const first = applyBreakdown(await host.readState(), adaptProposal, { now: T0 });
    await host.writeState(first.project);
    const before = JSON.stringify(host.peek());
    const second = applyBreakdown(await host.readState(), adaptProposal, { now: () => new Date('2027-01-01T00:00:00Z') });
    assert.equal(second.skipped, true);
    assert.deepEqual(second.created, { scenes: 0, beats: 0, shots: 0, characters: 0, locations: 0, styles: 0 });
    assert.equal(JSON.stringify(second.project), before, 'no new shots, ids or timestamps');
    // and the tag step on the already-tagged script is also a no-op
    const t1 = planRetag(first.project, screenplay);
    const t2 = planRetag(first.project, t1.text);
    assert.equal(t2.text, t1.text);
    assert.deepEqual(t2.tagged, []);
    assert.equal(alreadyBrokenDown(first.project), true);
  });

  it('a different proposal does not add shots next to existing ones', () => {
    const first = applyBreakdown(readyProject('adapt'), adaptProposal, { now: T0 }).project;
    const second = applyBreakdown(first, directProposal, { now: T0 });
    assert.equal(second.skipped, true);
    assert.equal(second.project.shots.length, 11);
  });
});

describe('route: direct (prose broken down as it stands)', () => {
  it('intake records the source only: no screenplay', () => {
    const p = completeIntake(createProject({ title: 'The Last Ferry', now: T0 }), { route: 'direct', now: T0 });
    assert.equal(p.script.screenplay, undefined);
    assert.deepEqual(p.assets.map((a) => a.id), ['script-source']);
    assert.equal(p.stages.intake.state, 'in-review');
  });

  it('breakdown of the prose is schema-valid, consistent, reviewable and lint-clean', () => {
    const r = applyBreakdown(readyProject('direct'), directProposal, { now: T0 });
    AkukoProjectSchema.parse(r.project);
    assert.deepEqual(checkIntegrity(r.project), []);
    assert.deepEqual(r.lint, []);
    assert.deepEqual(r.created, { scenes: 3, beats: 7, shots: 8, characters: 3, locations: 3, styles: 1 });
    assert.ok(r.project.shots.every((s) => s.status === 'pending-review'));
    assert.equal(r.project.script.screenplay, undefined);
  });

  it('tags the source paragraphs instead', () => {
    const p = applyBreakdown(readyProject('direct'), directProposal, { now: T0 }).project;
    const r = planRetag(p, story, { prose: true });
    assert.deepEqual(r.unplaced, []);
    assert.equal(r.tagged.length, 8);
    assert.match(r.text, /says\. Oren nods, not looking up\. \[\[sc2_sh3\]\]/);
    assert.match(r.text, /last crossing of the day\. \[\[sc1_sh1\]\] \[\[sc1_sh2\]\]/);
    assert.deepEqual(lintTags(p, r.text, { prose: true }), []);
  });

  it('re-running creates nothing', () => {
    const first = applyBreakdown(readyProject('direct'), directProposal, { now: T0 }).project;
    const again = applyBreakdown(first, directProposal, { now: T0 });
    assert.equal(again.skipped, true);
    assert.equal(JSON.stringify(again.project), JSON.stringify(first));
  });
});

describe('proposals are checked before anything is written', () => {
  const base = () => JSON.parse(read('proposal-adapt.json')) as { shots: Record<string, unknown>[]; scenes: unknown[]; checklist: { characters: unknown[] } };

  it('rejects an unknown character, location and scene, naming each', () => {
    const p = base();
    p.shots[0]!.characters = ['Nobody'];
    p.shots[1]!.location = 'Nowhere';
    p.shots[2]!.scene = 9;
    const { problems } = checkProposal(p);
    assert.equal(problems.length, 3);
    assert.ok(problems.some((m) => /character "Nobody" is not in the checklist/.test(m)));
    assert.ok(problems.some((m) => /location "Nowhere"/.test(m)));
    assert.ok(problems.some((m) => /scene 9 is not in scenes/.test(m)));
    assert.throws(() => applyBreakdown(readyProject('adapt'), p, { now: T0 }), ProposalError);
  });

  it('rejects unknown keys and bad enums (the agent does not invent ids or fields)', () => {
    const p = base();
    p.shots[0]!.id = 'sc1_sh1';
    p.shots[1]!.shot_type = 'dolly-zoom';
    const { problems } = checkProposal(p);
    assert.ok(problems.length >= 2);
  });

  it('refuses while intake is not approved (stage is locked)', () => {
    const locked = completeIntake(createProject({ title: 'The Last Ferry', now: T0 }), { route: 'adapt', now: T0 });
    assert.throws(() => applyBreakdown(locked, adaptProposal, { now: T0 }), /locked: intake must be approved/);
  });

  it('returns lint errors for an over-long shot so it can be fixed before writing', () => {
    const p = base();
    p.shots[0]!.duration_s = 14;
    const r = applyBreakdown(readyProject('adapt'), p, { now: T0 });
    assert.ok(hasErrors(r.lint));
    assert.equal(r.lint[0]!.rule, 'duration-too-long');
  });

  it('slugify makes folder-safe names', () => {
    assert.equal(slugify("The Beating: Poe's Tell-Tale Heart!"), 'the-beating-poe-s-tell-tale-heart');
    assert.equal(slugify('!!!'), 'film');
  });
});

describe('command line (host B / C)', () => {
  async function folder(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-bd-'));
    await mkdir(join(dir, 'script'), { recursive: true });
    return dir;
  }
  async function approveIntake(dir: string) {
    const f = join(dir, 'akuko.json');
    const p = JSON.parse(await readFile(f, 'utf8')) as AkukoProject;
    p.stages.intake = { state: 'approved' };
    p.stages.breakdown = { state: 'not-started' };
    await writeFile(f, JSON.stringify(p, null, 2));
  }

  for (const route of ['adapt', 'direct'] as const) {
    it(`${route}: new, intake, apply, tag, lint, then a re-run changes nothing`, async () => {
      const dir = await folder();
      const proposalFile = join(dir, 'proposal.json');
      await writeFile(proposalFile, route === 'adapt' ? read('proposal-adapt.json') : read('proposal-direct.json'));
      await writeFile(join(dir, 'script', 'source.md'), story);
      if (route === 'adapt') await writeFile(join(dir, 'script', 'screenplay.fountain'), screenplay);

      assert.equal((await run(['new', '--project', dir, '--title', 'The Last Ferry'], T0)).code, 0);
      const created = JSON.parse(await readFile(join(dir, 'akuko.json'), 'utf8')) as AkukoProject;
      assert.ok(['A', 'B', 'C'].includes(created.host?.level ?? ''), 'new records the detected host');
      assert.equal((await run(['new', '--project', dir, '--title', 'again'], T0)).code, 1, 'will not overwrite');
      assert.equal((await run(['apply', '--project', dir, '--proposal', proposalFile], T0)).code, 1, 'locked before intake is approved');
      assert.equal((await run(['intake', '--project', dir, '--route', route], T0)).code, 0);
      await approveIntake(dir);

      const applied = await run(['apply', '--project', dir, '--proposal', proposalFile], T0);
      assert.equal(applied.code, 0, applied.out);
      const tagged = await run(['tag', '--project', dir], T0);
      assert.equal(tagged.code, 0, tagged.out);
      const linted = await run(['lint', '--project', dir], T0);
      assert.equal(linted.code, 0, linted.out);
      assert.match(linted.out, /Lint passed/);

      const akuko1 = await readFile(join(dir, 'akuko.json'), 'utf8');
      // B-3: the approved script is never rewritten; the tags go into a derived copy that is not a review unit
      const approvedName = route === 'adapt' ? 'screenplay.fountain' : 'source.md';
      const taggedName = route === 'adapt' ? 'screenplay.tagged.fountain' : 'source.tagged.md';
      assert.ok(tagged.out.includes(`Tags are in script/${taggedName}; the approved script/${approvedName} is unchanged.`), tagged.out);
      assert.equal(await readFile(join(dir, 'script', approvedName), 'utf8'), route === 'adapt' ? screenplay : story, 'the approved file is byte-identical');
      const script1 = await readFile(join(dir, 'script', taggedName), 'utf8');
      assert.ok(readTags(script1, { prose: route === 'direct' }).length >= 8);
      assert.equal(stripTags(script1), stripTags(route === 'adapt' ? screenplay : story), 'the copy is the approved text plus tags');
      const saved = JSON.parse(akuko1) as AkukoProject;
      assert.equal(saved.script.tagged, `script/${taggedName}`);
      const intakeAsset = saved.assets.find((a) => a.id === (route === 'adapt' ? 'script-screenplay' : 'script-source'))!;
      assert.equal(intakeAsset.file?.uri, `script/${approvedName}`, 'the intake asset (and its approval) stays on the original file');
      assert.equal(saved.assets.some((a) => a.file?.uri === `script/${taggedName}`), false, 'the tagged copy is not an asset to review');

      const again = await run(['apply', '--project', dir, '--proposal', proposalFile], () => new Date('2030-01-01T00:00:00Z'));
      assert.equal(again.code, 0);
      assert.match(again.out, /Nothing created/);
      const retag = await run(['tag', '--project', dir], T0);
      assert.match(retag.out, /Tagged 0,/);
      assert.equal(await readFile(join(dir, 'akuko.json'), 'utf8'), akuko1);
      assert.equal(await readFile(join(dir, 'script', taggedName), 'utf8'), script1);
      AkukoProjectSchema.parse(JSON.parse(akuko1));
    });
  }

  it('apply writes nothing when lint finds an error', async () => {
    const dir = await folder();
    const prop = JSON.parse(read('proposal-adapt.json')) as { shots: { duration_s: number }[] };
    prop.shots[0]!.duration_s = 15;
    await writeFile(join(dir, 'p.json'), JSON.stringify(prop));
    await writeFile(join(dir, 'script', 'source.md'), story);
    await writeFile(join(dir, 'script', 'screenplay.fountain'), screenplay);
    await run(['new', '--project', dir, '--title', 'The Last Ferry'], T0);
    await run(['intake', '--project', dir, '--route', 'adapt'], T0);
    await approveIntake(dir);
    const before = await readFile(join(dir, 'akuko.json'), 'utf8');
    const r = await run(['apply', '--project', dir, '--proposal', join(dir, 'p.json')], T0);
    assert.equal(r.code, 1);
    assert.match(r.out, /Nothing written/);
    assert.match(r.out, /sc1_sh1 runs 15 s/);
    assert.equal(await readFile(join(dir, 'akuko.json'), 'utf8'), before);
  });

  it('asks for what it needs', async () => {
    assert.equal((await run(['lint'])).code, 2);
    assert.equal((await run(['bogus', '--project', await folder()])).code, 1, 'no akuko.json yet');
  });
});
