import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AkukoProjectSchema, type AkukoProject } from '../../schema/akuko-project.ts';
import { checkIntegrity } from '../../schema/integrity.ts';
import { alreadyBrokenDown, applyBreakdown, checkProposal, planRetag } from '../../breakdown/apply.ts';
import { completeIntake, createProject } from '../../breakdown/intake.ts';
import { hasErrors, lintShots, lintTags } from '../../breakdown/lint.ts';
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
