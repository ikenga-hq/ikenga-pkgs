// WP-26 — project rules: matching, every rule type, references by hash, and
// the guard in front of the spend gate. Synthetic rules and files only.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Job, JobHandle } from '../providers/contract.ts';
import type { QuoteResult, RunResult, SpendGate } from '../spend/gate.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { checkJob, checkProjectRules, type Breach } from './check.ts';
import { RULES_BREACH, RULES_MISSING, guardGate } from './guard.ts';
import { canBeSlice, parseSliceNote, sliceNote } from './refs.ts';
import { bannedMatches, containsRequired } from './text.ts';
import { FILES, HASH, STYLE, job, rulesFolder, rulesProject } from './__fixtures__/project.ts';

const rulesOf = (bs: Breach[]): string[] => bs.map((b) => b.rule);

describe('text matching', () => {
  it('whole words, any case; hyphens, apostrophes and punctuation are boundaries', () => {
    assert.equal(bannedMatches('An ACME sign.', 'acme').length, 1);
    assert.equal(bannedMatches("Acme's van", 'acme').length, 1);
    assert.equal(bannedMatches('acme-brand van', 'acme').length, 1);
    assert.equal(bannedMatches('acmeville, acmes', 'acme').length, 0);
    assert.equal(bannedMatches('notacme', 'acme').length, 0);
  });

  it('is Unicode-aware: letters with accents are word characters', () => {
    assert.equal(bannedMatches('the Ünïcorn badge', 'ünïcorn').length, 1);
    assert.equal(bannedMatches('Ünïcorns', 'ünïcorn').length, 0);
    assert.equal(bannedMatches('café', 'caf').length, 0, 'é is part of the word');
  });

  it('a multi-word term matches across any whitespace', () => {
    assert.equal(bannedMatches('a Blue  Star\nline poster', 'blue star line').length, 1);
  });

  it('an exception allows the longer word and nothing else', () => {
    assert.deepEqual(bannedMatches('a Gore-Tex jacket', 'gore', ['Gore-Tex']), []);
    assert.equal(bannedMatches('a Gore-Tex jacket, no gore', 'gore', ['Gore-Tex']).length, 1);
    assert.equal(bannedMatches('a gore-tex jacket', 'gore').length, 1, 'without the exception the hyphen is a boundary');
  });

  it('required text: any case, collapsed whitespace, its own closing full stop ignored', () => {
    assert.ok(containsRequired('… Silhouettes   ONLY, hands …', 'silhouettes only.'));
    assert.ok(!containsRequired('silhouette only', 'silhouettes only'));
    assert.ok(!containsRequired(undefined, 'x'));
  });
});

describe('checkJob: text rules', () => {
  it('banned: a term in the prompt is a breach naming the rule and the text', async () => {
    const p = rulesProject();
    const r = await checkJob(p, job({ unit: 'S01-010', prompt: `An Acme crate on the wall, ${STYLE}` }));
    assert.equal(r.outcome, 'rules-breach');
    const b = r.breaches.find((x) => x.rule === 'banned')!;
    assert.equal(b.shot, 'S01-010');
    assert.match(b.message, /banned term "acme" in the prompt: ".*Acme crate/);
    assert.match(b.message, /a brand name/);
  });

  it('banned: the exception (a fabric word) passes; the bare word does not', async () => {
    const p = rulesProject();
    assert.deepEqual((await checkJob(p, job({ unit: 'S01-010', prompt: `A Gore-Tex coat, ${STYLE}` }))).breaches, []);
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S01-010', prompt: `Gore on the floor, ${STYLE}` }))).breaches), ['banned']);
  });

  it('banned: the negative, the camera note and the reference notes are checked too', async () => {
    const p = rulesProject();
    const r = await checkJob(p, job({ unit: 'S01-010', prompt: STYLE, negative: 'acme logos', camera: 'acme dolly', refs: [{ id: 'x', note: 'like the acme ad' }] }, { provider: 'manual' }));
    assert.deepEqual(r.breaches.map((b) => b.field), ['negative prompt', 'camera note', 'note on ref x']);
  });

  it('banned: a scoped term applies only to shots in its scope, and never to a bible job', async () => {
    const p = rulesProject();
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S02-010', prompt: `zorblax, ${STYLE}` }))).breaches), ['banned']);
    assert.deepEqual((await checkJob(p, job({ unit: 'S01-010', prompt: `zorblax, ${STYLE}` }))).breaches, []);
    assert.deepEqual((await checkJob(p, job({ unit: 'ADA', prompt: 'zorblax', output: 'portrait' }, { stage: 'bible' }))).breaches, []);
    // an unscoped term applies to a bible job
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'ADA', prompt: 'an acme hat', output: 'portrait' }, { stage: 'bible' }))).breaches), ['banned']);
  });

  it('banned: the spoken text of a voice job is checked (sound carries it as the prompt)', async () => {
    const p = rulesProject();
    const r = await checkJob(p, job({ unit: 'S01-010', prompt: 'I bought it at Acme.', output: 'vo', refs: [{ id: 'voice-1', role: 'voice' }] }, { kind: 'audio', stage: 'sound', provider: 'elevenlabs' }));
    assert.deepEqual(r.breaches.map((b) => [b.rule, b.field]), [['banned', 'spoken text']]);
  });

  it('require: scoped required text is needed in its scene only', async () => {
    const p = rulesProject();
    const miss = await checkJob(p, job({ unit: 'S03-010', prompt: `Guests dance, ${STYLE}` }));
    assert.deepEqual(rulesOf(miss.breaches), ['require']);
    assert.match(miss.breaches[0]!.message, /lacks required text "silhouettes only" \(applies to scenes S03\)/);
    assert.deepEqual((await checkJob(p, job({ unit: 'S03-020', prompt: `Silhouettes only, ${STYLE}` }))).breaches, []);
    assert.deepEqual((await checkJob(p, job({ unit: 'S01-010', prompt: STYLE }))).breaches, []);
  });

  it('require: applies to picture outputs of shots (key frames, clips), not to voice text or bible images', async () => {
    const p = rulesProject();
    assert.deepEqual((await checkJob(p, job({ unit: 'S03-010', prompt: 'Spoken words.', output: 'vo' }, { kind: 'audio', stage: 'sound' }))).breaches, []);
    assert.deepEqual((await checkJob(p, job({ unit: 'HARBOUR', prompt: 'a plate', output: 'plate' }, { stage: 'bible' }))).breaches, []);
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S03-010', prompt: 'a clip', output: 'clip' }, { kind: 'video', stage: 'motion' }))).breaches), ['require', 'require']);
  });

  it('require on the negative: the job must send a negative that carries it', async () => {
    const p = rulesProject();
    p.rules!.require.push({ text: 'no text, no logos', applies_to: 'negative' });
    const none = await checkJob(p, job({ unit: 'S01-010', prompt: STYLE }));
    assert.match(none.breaches[0]!.message, /required text "no text, no logos" is missing: there is no negative prompt/);
    assert.deepEqual((await checkJob(p, job({ unit: 'S01-010', prompt: STYLE, negative: 'blur, No text, no logos' }))).breaches, []);
  });

  it('exempt: a reference shot skipping "house-style" needs no style text, but every other rule still applies', async () => {
    const p = rulesProject();
    assert.deepEqual((await checkJob(p, job({ unit: 'S01-020', prompt: '(Archive look) a child' }))).breaches, []);
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S01-020', prompt: '(Archive look) an acme box' }))).breaches), ['banned']);
    // A non-exempt shot without the style is a breach.
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S01-010', prompt: 'no style here' }))).breaches), ['require']);
    // house-style skips only requires that are part of the house style
    p.rules!.require.push({ text: 'hands in frame', applies_to: 'prompt', scope: { shots: ['S01-020'] } });
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S01-020', prompt: '(Archive look)' }))).breaches), ['require']);
  });

  it('exempt: banned, banned:<term>, require and require:<text> switch those off for the shot', async () => {
    const p = rulesProject();
    p.rules!.exempt.push({ shots: ['S03-010'], skip: ['banned:acme', 'require:silhouettes only'] });
    assert.deepEqual((await checkJob(p, job({ unit: 'S03-010', prompt: `acme, ${STYLE}` }))).breaches, []);
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S03-010', prompt: `gore, ${STYLE}` }))).breaches), ['banned']);
  });

  it('a unit owned by a shot (a key frame asset) is checked as that shot', async () => {
    const p = rulesProject();
    p.assets.push({ id: 'S03-010_keyframe', kind: 'keyframe', stage: 'keyframes', status: 'pending', owner: 'S03-010', comments: [], tags: [] });
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S03-010_keyframe', prompt: STYLE }))).breaches), ['require']);
  });
});

describe('checkJob: references, by content hash', () => {
  it('an allowed file is accepted for its entry; a renamed copy of it is accepted by hash', async () => {
    const { dir, project: p } = await rulesFolder();
    const ok = await checkJob(p, job({ unit: 'ADA', prompt: 'portrait', output: 'portrait', refs: [{ id: 'ref_ada_crop', uri: FILES.crop.path }] }, { stage: 'bible' }), { projectDir: dir });
    assert.deepEqual(ok.breaches, []);
    // Same bytes, another name and no asset: still the allowed file. Here for ADA's shot S01-020 (ADA only).
    const copy = await checkJob(p, job({ unit: 'S01-020', prompt: '(x)', refs: [{ id: 'loose', uri: FILES.cropCopy.path }] }), { projectDir: dir });
    assert.deepEqual(copy.breaches, []);
  });

  it('a photo that is not allowed is refused, naming the file and its hash', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'loose', uri: FILES.street.path }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['uploads']);
    assert.equal(r.breaches[0]!.file, FILES.street.path);
    assert.equal(r.breaches[0]!.sha256, HASH.street);
    assert.match(r.breaches[0]!.message, /not a file akuko generated and its hash is not in rules.uploads.allow/);
  });

  it('`for` misuse: an allowed crop of one person used as a reference for another is refused', async () => {
    const { dir, project: p } = await rulesFolder();
    // Attached to HARBOUR's entry: it is a reference for HARBOUR, which the allowance does not cover.
    p.assets.push({ id: 'ref_misused', kind: 'reference', stage: 'bible', status: 'approved', owner: 'HARBOUR', comments: [], tags: [], file: { uri: FILES.cropCopy.path, mime: 'image/png' } });
    const r = await checkJob(p, job({ unit: 'HARBOUR', prompt: 'plate', output: 'plate', refs: [{ id: 'ref_misused', uri: FILES.cropCopy.path }] }, { stage: 'bible' }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['uploads']);
    assert.match(r.breaches[0]!.message, /may be a reference only for ADA; here it is for HARBOUR/);
    // A loose file in a shot with ADA and HARBOUR is a reference for both: HARBOUR is outside `for`.
    const shot = await checkJob(p, job({ unit: 'S01-010', prompt: STYLE, refs: [{ id: 'loose', uri: FILES.cropCopy.path }] }), { projectDir: dir });
    assert.match(shot.breaches[0]!.message, /here it is for HARBOUR$/);
  });

  it('a file with no `for` may be used for any entry', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'loose', uri: FILES.birds.path }] }), { projectDir: dir });
    assert.deepEqual(r.breaches, []);
  });

  it('never_from_photo: a generated portrait is fine; any photo, even an allowed one, is refused', async () => {
    const { dir, project: p } = await rulesFolder();
    const gen = await checkJob(p, job({ unit: 'S02-010', prompt: STYLE, refs: [{ id: 'KIT_portrait', uri: FILES.kitGenerated.path, role: 'character' }] }), { projectDir: dir });
    assert.deepEqual(gen.breaches, []);
    const photo = await checkJob(p, job({ unit: 'S02-010', prompt: STYLE, refs: [{ id: 'loose', uri: FILES.birds.path }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(photo.breaches), ['never-from-photo']);
    assert.match(photo.breaches[0]!.message, /KIT may only use generated references/);
  });

  it('a file brought back by hand (manual) is external, even with a ledger entry', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'KIT_portrait', prompt: 'turnaround', output: 'turnaround', refs: [{ id: 'KIT_sketch', uri: FILES.kitByHand.path }] }, { stage: 'bible' }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['never-from-photo', 'uploads']);
  });

  it('a ref that borrows a generated asset id but points at another file is judged by that file', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S02-010', prompt: STYLE, refs: [{ id: 'KIT_portrait', uri: FILES.street.path }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['never-from-photo', 'uploads']);
  });

  it('a generated file swapped on disk is refused as changed', async () => {
    const { dir, project: p } = await rulesFolder();
    await writeFile(join(dir, FILES.kitGenerated.path), 'something else');
    const r = await checkJob(p, job({ unit: 'S02-010', prompt: STYLE, refs: [{ id: 'KIT_portrait', uri: FILES.kitGenerated.path }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['generated-changed']);
  });

  it('a remote or missing file cannot be checked by hash and is refused', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'a', uri: 'https://example.invalid/x.png' }, { id: 'b', uri: 'inbox/gone.png' }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['uploads', 'uploads']);
    assert.match(r.breaches[0]!.message, /not a local file/);
    assert.match(r.breaches[1]!.message, /the file is not there/);
  });

  it('a ref with no file (a provider voice id) has nothing to upload', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S01-010', prompt: 'words', output: 'vo', refs: [{ id: 'voice-1', role: 'voice' }] }, { kind: 'audio', stage: 'sound', provider: 'elevenlabs' }), { projectDir: dir });
    assert.deepEqual(r.breaches, []);
  });

  it('slices: a slice of a file allowed with slices: true is accepted; of one without, refused; a picture cannot claim to be a slice', async () => {
    const { dir, project: p } = await rulesFolder();
    const note = sliceNote(HASH.master, 12.5, 14.25);
    assert.deepEqual(parseSliceNote(`line L001; ${note}`), { sha256: HASH.master, in_s: 12.5, out_s: 14.25 });
    assert.ok(canBeSlice('audio/x.wav') && !canBeSlice('x.png'));
    const ok = await checkJob(p, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'L001', uri: FILES.slice.path, role: 'audio', note }] }, { kind: 'video', stage: 'motion' }), { projectDir: dir });
    assert.deepEqual(ok.breaches.filter((b) => b.rule !== 'require'), []);
    const notSlices = await checkJob(p, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'L001', uri: FILES.slice.path, note: sliceNote(HASH.birds) }] }), { projectDir: dir });
    assert.match(notSlices.breaches[0]!.message, /is a slice of sha256 .* not in rules.uploads.allow with slices: true/);
    const picture = await checkJob(p, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'p', uri: FILES.street.path, note }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(picture.breaches), ['uploads']);
  });

  it('a free (manual) job gets the text rules only: akuko uploads nothing for it', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'loose', uri: FILES.street.path }] }, { provider: 'manual' }), { projectDir: dir });
    assert.equal(r.paid, false);
    assert.deepEqual(r.breaches, []);
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S03-020', prompt: 'acme' }, { provider: 'manual' }), { projectDir: dir })).breaches), ['banned', 'require', 'require']);
  });
});

describe('rules.required', () => {
  it('required with nothing to enforce refuses a paid job as rules-missing; a manual job still runs', async () => {
    const p = rulesProject();
    p.rules = { required: true, banned: [], require: [], uploads: { allow: [] }, never_from_photo: [], exempt: [], consent: [] };
    const r = await checkJob(p, job({ unit: 'S01-010', prompt: 'x' }));
    assert.equal(r.outcome, 'rules-missing');
    assert.match(r.breaches[0]!.message, /rules.required is true but the project has no rules/);
    assert.equal((await checkJob(p, job({ unit: 'S01-010', prompt: 'x' }, { provider: 'manual' }))).outcome, 'ok');
  });

  it('invalid rules refuse every job', async () => {
    const p = rulesProject();
    (p.rules as unknown as { banned: unknown[] }).banned.push({ term: '' });
    assert.equal((await checkJob(p, job({ unit: 'S01-010', prompt: 'x' }, { provider: 'manual' }))).outcome, 'rules-missing');
  });

  it('a project with no rules block checks nothing', async () => {
    const p = rulesProject();
    delete p.rules;
    assert.equal((await checkJob(p, job({ unit: 'S01-010', prompt: 'acme', refs: [{ id: 'x', uri: 'https://example.invalid/a.png' }] }))).outcome, 'ok');
  });
});

describe('the synthetic project', () => {
  it('passes integrity (its rules name real ids)', () => {
    assert.deepEqual(checkIntegrity(rulesProject()), []);
  });
});

/** A gate that counts calls and would "spend" if reached. */
function spyGate(): SpendGate & { calls: string[] } {
  const calls: string[] = [];
  const cost = { amount: 0.04, currency: 'USD', per_unit: {}, basis: 'spy' };
  return {
    calls,
    async quote(j: Job): Promise<QuoteResult> { calls.push(`quote:${j.id}`); return { cost: { ...cost, per_unit: { [j.items[0]!.unit]: 0.04 } }, billing: 'direct-api', paid: true }; },
    async run(j: Job): Promise<RunResult> { calls.push(`run:${j.id}`); return { status: 'refused', refusal: { code: 'not-approved', message: 'spy' } }; },
    async collect(h: JobHandle) { calls.push(`collect:${h.job}`); return { status: { state: 'done' as const }, assets: [] }; },
  };
}

describe('guardGate', () => {
  it('a refused job never reaches the gate: not quote, not run', async () => {
    const { dir, project } = await rulesFolder();
    const spy = spyGate();
    const g = guardGate(spy, project, { projectDir: dir });
    const bad = job({ unit: 'S01-010', prompt: `An Acme sign, ${STYLE}` }, { id: 'job_bad' });
    const q = await g.quote(bad);
    assert.equal(q.refusal?.code, RULES_BREACH);
    assert.match(q.refusal!.message, /refuse job job_bad; nothing was priced, sent or spent/);
    assert.match(q.refusal!.message, /S01-010 \[banned\] banned term "acme"/);
    assert.match(q.refusal!.message, /rules\/cli.ts check/);
    assert.equal(q.cost.amount, 0);
    const r = await g.run(bad);
    assert.equal(r.status, 'refused');
    assert.equal(r.status === 'refused' ? r.refusal.code : '', RULES_BREACH);
    assert.deepEqual(spy.calls, []);
  });

  it('a clean job passes straight through; collect always passes through', async () => {
    const { dir, project } = await rulesFolder();
    const spy = spyGate();
    const g = guardGate(spy, project, { projectDir: dir });
    const good = job({ unit: 'S01-010', prompt: STYLE }, { id: 'job_good' });
    assert.equal((await g.quote(good)).cost.amount, 0.04);
    await g.run(good);
    await g.collect({ job: 'job_x', provider: 'fal', ref: 'r', stage: 'keyframes', units: [], submitted_at: 'now', ledger: [] });
    assert.deepEqual(spy.calls, ['quote:job_good', 'run:job_good', 'collect:job_x']);
  });

  it('reads the project fresh on every call (a rule added after the guard was built still applies)', async () => {
    const { dir, project } = await rulesFolder();
    let current = project;
    const spy = spyGate();
    const g = guardGate(spy, { readState: async () => current }, { projectDir: dir });
    const j = job({ unit: 'S01-010', prompt: `quokka, ${STYLE}` });
    assert.equal(await g.check(j), null);
    current = structuredClone(project);
    current.rules!.banned.push({ term: 'quokka' });
    assert.equal((await g.check(j))?.code, RULES_BREACH);
  });

  it('rules-missing has its own code', async () => {
    const p = rulesProject();
    p.rules = { required: true, banned: [], require: [], uploads: { allow: [] }, never_from_photo: [], exempt: [], consent: [] };
    const spy = spyGate();
    const r = await guardGate(spy, p).run(job({ unit: 'S01-010', prompt: 'x' }));
    assert.equal(r.status === 'refused' ? r.refusal.code : '', RULES_MISSING);
    assert.deepEqual(spy.calls, []);
  });

  it('checks the job it hands on: changing the caller\'s object afterwards changes nothing', async () => {
    const { dir, project } = await rulesFolder();
    const seen: Job[] = [];
    const spy = spyGate();
    const g = guardGate({ ...spy, quote: async (j) => { seen.push(j); return spy.quote(j); } }, project, { projectDir: dir });
    const j = job({ unit: 'S01-010', prompt: STYLE });
    const pending = g.quote(j);
    j.items[0]!.prompt = 'acme';
    await pending;
    assert.equal(seen[0]!.items[0]!.prompt, STYLE);
  });
});

describe('checkProjectRules (the preflight)', () => {
  it('lists every breach in the project with its shot id, and nothing for a clean one', async () => {
    const { dir, project: p } = await rulesFolder((q) => {
      q.shots.find((s) => s.id === 'S02-010')!.prompt = `Kit by an Acme van, zorblax, ${STYLE}`;
      q.bible.characters.find((e) => e.id === 'KIT')!.refs.push('KIT_sketch');
      q.assets.push({ id: 'ref_street', kind: 'reference', stage: 'bible', status: 'approved', owner: 'S03-020', comments: [], tags: [], file: { uri: FILES.street.path, mime: 'image/jpeg' } });
    });
    const c = await checkProjectRules(p, { projectDir: dir });
    const got = c.breaches.map((b) => `${b.where} ${b.rule}`);
    assert.deepEqual(got, [
      'S02-010 banned',            // acme
      'S02-010 banned',            // zorblax, in P2
      'S03-010 require',           // silhouettes only
      'S03-020 uploads',           // the street photo attached to the shot
      'bible:KIT never-from-photo', // the hand-made portrait listed for KIT
      'bible:KIT uploads',
    ]);
    assert.deepEqual(c.counts, { shots: 5, entries: 5, refs: 4 });
  });
});
