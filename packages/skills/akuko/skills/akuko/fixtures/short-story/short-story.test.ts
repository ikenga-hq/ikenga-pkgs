import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AkukoProjectSchema, type AkukoProject } from '../../schema/akuko-project.ts';
import { checkIntegrity } from '../../schema/integrity.ts';
import { alreadyBrokenDown, applyBreakdown, checkProposal, planRetag } from '../../breakdown/apply.ts';
import { completeIntake, createProject } from '../../breakdown/intake.ts';
import { hasErrors, lintShots, lintTags } from '../../breakdown/lint.ts';
import { run } from '../../breakdown/cli.ts';
import { readTags } from '../../breakdown/tags.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const read = (f: string) => readFileSync(join(HERE, f), 'utf8');

const sourceStory = read('source.md');
const screenplay = read('screenplay.fountain');
const proposal = JSON.parse(read('proposal.json')) as unknown;

const theBeatingJson = JSON.parse(readFileSync(join(HERE, '../the-beating/akuko.json'), 'utf8')) as AkukoProject;

const T0 = () => new Date('2026-11-08T10:00:00Z');

describe('short-story fixture: The Tell-Tale Heart / The Beating', () => {
  it('proposal passes checkProposal and conforms to BreakdownProposalSchema', () => {
    const { proposal: checked, problems } = checkProposal(proposal);
    assert.deepEqual(problems, [], `checkProposal had problems: ${problems.join(', ')}`);
    assert.ok(checked, 'checked proposal must be present');
  });

  it('runs adapt intake and breakdown in a temp folder with full integrity and lint cleanliness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-short-story-'));
    const sourcePath = join(dir, 'source.md');
    const screenplayPath = join(dir, 'screenplay.fountain');
    await writeFile(sourcePath, sourceStory);
    await writeFile(screenplayPath, screenplay);

    // 1. Create project & complete intake on adapt route
    const base = createProject({ title: 'The Beating', now: T0 });
    const intakeProject = completeIntake(base, { route: 'adapt', now: T0 });
    intakeProject.project.aspect_ratio = '16:9';
    intakeProject.project.runtime_s = 70;

    assert.equal(intakeProject.script.source, 'script/source.md');
    assert.equal(intakeProject.script.screenplay, 'script/screenplay.fountain');
    assert.equal(intakeProject.stages.intake.state, 'in-review');
    assert.equal(intakeProject.stages.breakdown.state, 'locked');

    // Simulate approval of intake assets by a person
    intakeProject.stages.intake.state = 'approved';
    intakeProject.stages.breakdown.state = 'not-started';
    for (const a of intakeProject.assets) {
      a.status = 'approved';
    }

    // 2. Apply proposal through library function
    const applied = applyBreakdown(intakeProject, proposal, { now: T0 });
    assert.equal(applied.skipped, false);
    const p = applied.project;

    // Validate project schema and integrity
    AkukoProjectSchema.parse(p);
    const integrityIssues = checkIntegrity(p);
    assert.deepEqual(integrityIssues, [], `checkIntegrity had issues: ${integrityIssues.join(', ')}`);

    // Verify lintShots reports no errors (warnings like duration-short for 4s inserts are allowed)
    const shotIssues = lintShots(p);
    assert.equal(hasErrors(shotIssues), false, `lintShots reported errors: ${JSON.stringify(shotIssues)}`);
    assert.ok(shotIssues.every((i) => i.severity !== 'error'));

    // 3. Scene and shot counts and total runtime match the-beating
    const expectedSceneCount = theBeatingJson.scenes.length; // 4
    const expectedShotCount = theBeatingJson.shots.length; // 12
    const expectedRuntime = theBeatingJson.project.runtime_s ?? 70; // 70

    assert.equal(p.scenes.length, expectedSceneCount, `Expected ${expectedSceneCount} scenes, got ${p.scenes.length}`);
    assert.equal(p.shots.length, expectedShotCount, `Expected ${expectedShotCount} shots, got ${p.shots.length}`);

    const totalRuntime = p.shots.reduce((acc, s) => acc + (s.duration_s ?? 0), 0);
    assert.equal(totalRuntime, expectedRuntime, `Expected total runtime ${expectedRuntime}s, got ${totalRuntime}s`);

    // Every unit status is pending-review and stage is breakdown
    assert.ok(p.shots.every((s) => s.status === 'pending-review' && s.stage === 'breakdown'));
    assert.equal(p.stages.breakdown.state, 'in-review');

    // 4. Tagging and verifying script_line is found verbatim in screenplay
    for (const s of p.shots) {
      assert.ok(s.script_line, `Shot ${s.id} is missing script_line`);
      assert.ok(
        screenplay.includes(s.script_line),
        `Shot ${s.id} script_line "${s.script_line}" is not a verbatim substring of screenplay.fountain`,
      );
    }

    const retag = planRetag(p, screenplay);
    assert.equal(retag.unplaced.length, 0, `Unplaced shots: ${JSON.stringify(retag.unplaced)}`);
    assert.equal(retag.conflicts.length, 0, `Conflicting tags: ${JSON.stringify(retag.conflicts)}`);
    assert.equal(retag.tagged.length, p.shots.length, `Expected all ${p.shots.length} shots to be tagged`);

    const tagIssues = lintTags(p, retag.text);
    assert.equal(hasErrors(tagIssues), false, `lintTags reported errors: ${JSON.stringify(tagIssues)}`);
    assert.deepEqual(tagIssues, []);

    // 5. A second apply changes nothing
    const second = applyBreakdown(p, proposal, { now: () => new Date('2027-01-01T00:00:00Z') });
    assert.equal(second.skipped, true);
    assert.deepEqual(second.created, { scenes: 0, beats: 0, shots: 0, characters: 0, locations: 0, styles: 0 });
    assert.equal(JSON.stringify(second.project), JSON.stringify(p), 'Second apply must leave project unchanged');
    assert.equal(alreadyBrokenDown(p), true);
  });
});

/** Same text with whitespace collapsed and curly quotes / dash spacing normalised. */
const norm = (t: string): string =>
  t
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s*[\u2014\u2013]\s*/g, '--')
    .replace(/\s+/g, ' ')
    .trim();

function approvedIntake(): AkukoProject {
  const base = completeIntake(createProject({ title: 'The Beating', now: T0 }), { route: 'adapt', now: T0 });
  base.stages.intake = { state: 'approved' };
  base.stages.breakdown = { state: 'not-started' };
  for (const a of base.assets) a.status = 'approved';
  return base;
}

describe('short-story fixture: shape matches the-beating', () => {
  const p = applyBreakdown(approvedIntake(), proposal, { now: T0 }).project;
  const ref = theBeatingJson;

  it('has the same scene and shot ids, shot counts per scene and durations, in order', () => {
    assert.deepEqual(p.scenes.map((s) => s.id), ref.scenes.map((s) => s.id));
    assert.deepEqual(p.shots.map((s) => s.id), ref.shots.map((s) => s.id));
    const perScene = (proj: AkukoProject) => proj.scenes.map((sc) => proj.shots.filter((s) => s.scene === sc.id).length);
    assert.deepEqual(perScene(p), [3, 4, 1, 4]);
    assert.deepEqual(perScene(p), perScene(ref));
    assert.deepEqual(p.shots.map((s) => s.duration_s), ref.shots.map((s) => s.duration_s));
    assert.deepEqual(p.shots.map((s) => s.duration_s), [6, 4, 6, 7, 4, 5, 6, 7, 6, 8, 5, 6]);
  });

  it('keeps every shot to at most 2 characters and 10 s, independent of lint', () => {
    for (const s of p.shots) {
      assert.ok((s.duration_s ?? 0) > 0 && (s.duration_s ?? 0) <= 10, `${s.id} duration ${s.duration_s}`);
      const chars = s.refs.filter((r) => p.bible.characters.some((c) => c.id === r));
      assert.ok(chars.length <= 2, `${s.id} has ${chars.length} characters in frame`);
    }
  });

  it('plans 3 characters, 2 locations and 1 style, none approved', () => {
    assert.equal(p.bible.characters.length, 3);
    assert.equal(p.bible.locations.length, 2);
    assert.equal(p.bible.styles.length, 1);
    for (const u of [...p.bible.characters, ...p.bible.locations, ...p.bible.styles]) {
      assert.notEqual(u.status, 'approved', `${u.id} must not start approved`);
    }
  });
});

describe('short-story fixture: provenance and hygiene', () => {
  it('source.md is the Poe text with its header and ending intact', () => {
    assert.ok(sourceStory.startsWith('# The Tell-Tale Heart'));
    assert.ok(sourceStory.trimEnd().endsWith('hideous heart!\u201D'));
    const n = norm(sourceStory);
    for (const sentence of [
      'I heard all things in the heaven and in the earth.',
      'He had the eye of a vulture',
      'I then took up three planks from the flooring of the chamber',
      'Hearken! and observe how healthily',
    ]) {
      assert.ok(n.includes(norm(sentence)), `source.md is missing: ${sentence}`);
    }
  });

  it('every script_line is Poe\'s exact words, after whitespace, dash and quote normalisation', () => {
    const src = norm(sourceStory);
    const play = norm(screenplay);
    const { proposal: checked } = checkProposal(proposal);
    for (const s of checked!.shots) {
      assert.ok(s.script_line, `a shot in scene ${s.scene} has no script_line`);
      const line = norm(s.script_line);
      assert.ok(src.includes(line), `script_line not found in source.md: ${s.script_line}`);
      assert.ok(play.includes(line), `script_line not found in screenplay.fountain: ${s.script_line}`);
    }
  });

  it('proposal.json carries no review state', () => {
    const banned = new Set(['status', 'decisions', 'approved']);
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          assert.ok(!banned.has(k), `proposal.json has a "${k}" key at ${path}`);
          walk(x, `${path}.${k}`);
        }
      }
    };
    walk(proposal, '$');
  });

  it('committed fixture files have no carriage returns', () => {
    for (const f of ['source.md', 'screenplay.fountain', 'proposal.json', 'README.md', 'short-story.test.ts']) {
      assert.ok(!read(f).includes('\r'), `${f} contains \r`);
    }
  });
});

describe('short-story fixture: README commands via the breakdown CLI', () => {
  it('new, intake, apply, tag and lint run clean and a second apply changes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-short-story-cli-'));
    await mkdir(join(dir, 'script'), { recursive: true });
    await writeFile(join(dir, 'script', 'source.md'), sourceStory);
    await writeFile(join(dir, 'script', 'screenplay.fountain'), screenplay);
    const proposalFile = join(dir, 'proposal.json');
    await writeFile(proposalFile, read('proposal.json'));

    assert.equal((await run(['new', '--project', dir, '--title', 'The Beating'], T0)).code, 0);
    const intake = await run(['intake', '--project', dir, '--route', 'adapt'], T0);
    assert.equal(intake.code, 0, intake.out);

    const f = join(dir, 'akuko.json');
    const proj = JSON.parse(await readFile(f, 'utf8')) as AkukoProject;
    proj.stages.intake = { state: 'approved' };
    proj.stages.breakdown = { state: 'not-started' };
    await writeFile(f, JSON.stringify(proj, null, 2));

    const applied = await run(['apply', '--project', dir, '--proposal', proposalFile], T0);
    assert.equal(applied.code, 0, applied.out);
    assert.match(applied.out, /4 scenes, \d+ beats, 12 shots/);
    const tagged = await run(['tag', '--project', dir], T0);
    assert.equal(tagged.code, 0, tagged.out);
    assert.match(tagged.out, /Tagged 12, already tagged 0, left untagged 0, conflicts 0/);
    const linted = await run(['lint', '--project', dir], T0);
    assert.equal(linted.code, 0, linted.out);

    const akuko1 = await readFile(f, 'utf8');
    // B-3: the approved screenplay is not rewritten; tags are in the derived copy
    assert.equal(await readFile(join(dir, 'script', 'screenplay.fountain'), 'utf8'), screenplay);
    const script1 = await readFile(join(dir, 'script', 'screenplay.tagged.fountain'), 'utf8');
    assert.equal(readTags(script1).length, 12);
    const again = await run(['apply', '--project', dir, '--proposal', proposalFile], () => new Date('2030-01-01T00:00:00Z'));
    assert.match(again.out, /Nothing created/);
    assert.match((await run(['tag', '--project', dir], T0)).out, /Tagged 0,/);
    assert.equal(await readFile(f, 'utf8'), akuko1);
    assert.equal(await readFile(join(dir, 'script', 'screenplay.tagged.fountain'), 'utf8'), script1);
    assert.equal(await readFile(join(dir, 'script', 'screenplay.fountain'), 'utf8'), screenplay);
  });
});
