// Files made with a connected allowance tool (Canva) count as generated when the ledger links the
// generation to the job (rules/refs.ts §3b): ingest --via, the rules check, never_from_photo,
// `rules/cli.ts allow`, `rules/cli.ts adopt-allowance` and `spend/cli.ts allowance`.
// Synthetic project and files only (rules/__fixtures__/project.ts).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createLocalHost } from '../hosts/local.ts';
import { createManualProvider, ManualIngestError } from '../providers/manual/index.ts';
import type { Job } from '../providers/contract.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { AkukoProjectSchema, type AkukoProject } from '../schema/akuko-project.ts';
import { allowanceEntryFor, recordAllowance } from '../spend/allowance.ts';
import { run as spendCli } from '../spend/cli.ts';
import { adoptAllowance } from './allowance.ts';
import { checkJob } from './check.ts';
import { run as rulesCli } from './cli.ts';
import { REFS_EXTERNAL_TAG, allowanceTag, generatingJob, sha256Bytes } from './refs.ts';
import { FILES, HASH, STYLE, T0, job, rulesFolder } from './__fixtures__/project.ts';

const rules = (bs: { rule: string }[]): string[] => bs.map((b) => b.rule);
const TS = '2026-11-12T16:00:00.000Z';
const read = async (dir: string): Promise<AkukoProject> => AkukoProjectSchema.parse(JSON.parse(await readFile(join(dir, 'akuko.json'), 'utf8')));
/** A shot job that uses `id` as a reference for KIT (never_from_photo in the fixture). */
const kitShot = (id: string, uri: string): Job => job({ unit: 'S02-010', prompt: STYLE, refs: [{ id, uri, role: 'character' }] });
/** A manual bible job for KIT, as `bible/cli.ts step --provider manual` saves it. */
const manualKitJob = (id: string, refs: { id: string; uri: string }[] = []): Job =>
  job({ unit: 'KIT', prompt: 'a turnaround of Kit', output: 'turnaround', refs }, { id, stage: 'bible', provider: 'manual' });
const PNG = new TextEncoder().encode('synthetic file: a turnaround made with an allowance tool\n');

/** KIT_sketch (brought back by hand for job_bible_w1_bbbb2222_r1) as the allowance tool's: what ingest --via records. */
function viaCanva(p: AkukoProject, o: { link?: string | null; status?: 'done' | 'failed'; refsExternal?: boolean } = {}): void {
  const a = p.assets.find((x) => x.id === 'KIT_sketch')!;
  a.provider = 'canva';
  a.tags = [...a.tags, allowanceTag('canva'), ...(o.refsExternal ? [REFS_EXTERNAL_TAG] : [])];
  a.file = { ...a.file!, hash: HASH.kitByHand };
  const link = o.link === undefined ? 'job_bible_w1_bbbb2222_r1' : o.link;
  p.ledger.push({ id: 'allow_canva.KIT_sketch.1', ts: T0, provider: 'canva', model: 'generate-image', unit: 'KIT_sketch', estimate: 0, actual: 0, status: o.status ?? 'done',
    allowance: { service: 'canva', units: 1, ...(link !== null ? { job: link } : {}) } });
}

describe('allowance-tool files in the rules (refs.ts §3b)', () => {
  it('generated when a done allowance entry of the same service links the same job and unit; never_from_photo accepts it', async () => {
    const { dir, project: p } = await rulesFolder((q) => viaCanva(q));
    assert.equal(generatingJob(p, p.assets.find((a) => a.id === 'KIT_sketch')!), 'job_bible_w1_bbbb2222_r1');
    const r = await checkJob(p, kitShot('KIT_sketch', FILES.kitByHand.path), { projectDir: dir });
    assert.deepEqual(r.breaches, []);
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('external without that entry: no job linked, another job, a failed call, or no allowance tag', async () => {
    const cases: [string, (q: AkukoProject) => void][] = [
      ['entry not linked', (q) => viaCanva(q, { link: null })],
      ['entry for another job', (q) => viaCanva(q, { link: 'job_other' })],
      ['the call failed', (q) => viaCanva(q, { status: 'failed' })],
      ['no allowance:canva tag', (q) => { viaCanva(q); const a = q.assets.find((x) => x.id === 'KIT_sketch')!; a.tags = a.tags.filter((t) => t !== allowanceTag('canva')); }],
    ];
    for (const [why, mutate] of cases) {
      const { dir, project: p } = await rulesFolder(mutate);
      assert.equal(generatingJob(p, p.assets.find((a) => a.id === 'KIT_sketch')!), undefined, why);
      const r = await checkJob(p, kitShot('KIT_sketch', FILES.kitByHand.path), { projectDir: dir });
      assert.deepEqual(rules(r.breaches), ['never-from-photo', 'uploads'], why);
    }
  });

  it('never_from_photo: refused when its job gave it a reference akuko did not generate (refs:external); other entries may still use it', async () => {
    const { dir, project: p } = await rulesFolder((q) => viaCanva(q, { refsExternal: true }));
    const r = await checkJob(p, kitShot('KIT_sketch', FILES.kitByHand.path), { projectDir: dir });
    assert.deepEqual(rules(r.breaches), ['never-from-photo']);
    assert.match(r.breaches[0]!.message, /made with canva for job job_bible_w1_bbbb2222_r1, but that job gave it a reference that is not a file akuko generated/);
    // the same file as a reference for the harbour (not never_from_photo): fine, it is generated
    const { dir: d2, project: p2 } = await rulesFolder((q) => { viaCanva(q, { refsExternal: true }); q.assets.find((x) => x.id === 'KIT_sketch')!.owner = 'HARBOUR'; });
    const h = await checkJob(p2, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'KIT_sketch', uri: FILES.kitByHand.path }] }), { projectDir: d2 });
    assert.deepEqual(h.breaches, []);
  });

  it('a swapped file is still refused as changed', async () => {
    const { dir, project: p } = await rulesFolder((q) => viaCanva(q));
    await writeFile(join(dir, FILES.kitByHand.path), 'another picture');
    const r = await checkJob(p, kitShot('KIT_sketch', FILES.kitByHand.path), { projectDir: dir });
    assert.deepEqual(rules(r.breaches), ['generated-changed']);
  });
});

describe('ingest --via <service> (providers/manual)', () => {
  const ingestVia = async (dir: string, j: Job, via?: string) =>
    createManualProvider(createLocalHost({ projectDir: dir }), { now: () => TS }).ingest({ job: j, unit: 'KIT', file: { filename: 'kit.png', mime: 'image/png', data: PNG }, ...(via ? { via, projectDir: dir } : {}) });

  it('refuses without a done allowance entry for the unit, and names the command that records one', async () => {
    const { dir } = await rulesFolder();
    await assert.rejects(ingestVia(dir, manualKitJob('job_m1'), 'canva'), (e: unknown) => e instanceof ManualIngestError && /no done canva allowance entry for KIT .*spend\/cli\.ts allowance --service canva --units KIT --job job_m1/.test(e.message));
    await assert.rejects(ingestVia(dir, manualKitJob('job_m1'), 'manual'), /a connected service id/);
    assert.equal((await read(dir)).assets.length, 3, 'nothing was stored');
  });

  it('records the file as the service\'s, links the ledger entry to the job, records its sha256; the rules then accept it for KIT', async () => {
    const { dir } = await rulesFolder();
    await createLocalHost({ projectDir: dir }).writeState(recordAllowance(await read(dir), { service: 'canva', tool: 'generate-image', ts: TS, units: [{ unit: 'KIT' }] }));
    const r = await ingestVia(dir, manualKitJob('job_m1'), 'canva');
    const p = await read(dir);
    const a = p.assets.find((x) => x.id === r.asset.id)!;
    assert.equal(a.provider, 'canva');
    assert.ok(a.tags.includes('job:job_m1') && a.tags.includes(allowanceTag('canva')) && a.tags.includes('manual'));
    assert.ok(!a.tags.includes(REFS_EXTERNAL_TAG), 'the job sent no refs');
    assert.equal(a.file?.hash, sha256Bytes(PNG));
    const e = p.ledger.find((x) => x.allowance?.service === 'canva')!;
    assert.equal(e.allowance?.job, 'job_m1');
    assert.equal(generatingJob(p, a), 'job_m1');
    const c = await checkJob(p, kitShot(a.id, a.file!.uri), { projectDir: dir });
    assert.deepEqual(c.breaches, []);
    assert.deepEqual(checkIntegrity(p), []);
    // the entry is spent: another job can't claim the same generation
    await assert.rejects(ingestVia(dir, manualKitJob('job_m2'), 'canva'), /no done canva allowance entry/);
  });

  it('a job that gave the tool a photo as a reference: the file is tagged refs:external and KIT refuses it', async () => {
    const { dir } = await rulesFolder();
    await createLocalHost({ projectDir: dir }).writeState(recordAllowance(await read(dir), { service: 'canva', ts: TS, job: 'job_m1', units: [{ unit: 'KIT' }] }));
    const r = await ingestVia(dir, manualKitJob('job_m1', [{ id: 'loose', uri: FILES.street.path }]), 'canva');
    const p = await read(dir);
    const a = p.assets.find((x) => x.id === r.asset.id)!;
    assert.ok(a.tags.includes(REFS_EXTERNAL_TAG));
    const c = await checkJob(p, kitShot(a.id, a.file!.uri), { projectDir: dir });
    assert.deepEqual(rules(c.breaches), ['never-from-photo']);
  });

  it('without --via the file stays manual and external, as before', async () => {
    const { dir } = await rulesFolder();
    await createLocalHost({ projectDir: dir }).writeState(recordAllowance(await read(dir), { service: 'canva', ts: TS, units: [{ unit: 'KIT' }] }));
    const r = await ingestVia(dir, manualKitJob('job_m1'));
    const p = await read(dir);
    const a = p.assets.find((x) => x.id === r.asset.id)!;
    assert.equal(a.provider, 'manual');
    assert.equal(generatingJob(p, a), undefined);
    assert.equal(p.ledger.find((x) => x.allowance)!.allowance!.job, undefined, 'the entry is left unlinked');
  });
});

describe('recording allowance generations', () => {
  it('recordAllowance carries the job; allowanceEntryFor prefers the linked entry, else the latest free one', () => {
    const base = AkukoProjectSchema.parse({ format: 'akuko', schema_version: 1, project: { slug: 'x', title: 'X', profile: 'film', created_at: T0 }, assets: [{ id: 'A', kind: 'portrait', stage: 'bible', status: 'pending' }] });
    let p = recordAllowance(base, { service: 'canva', ts: TS, units: [{ unit: 'A' }] });
    p = recordAllowance(p, { service: 'canva', ts: TS, units: [{ unit: 'A', count: 2 }] });
    p = recordAllowance(p, { service: 'canva', ts: TS, job: 'job_1', units: [{ unit: 'A' }] });
    assert.deepEqual(p.ledger.map((e) => [e.allowance?.units, e.allowance?.job]), [[1, undefined], [2, undefined], [1, 'job_1']]);
    assert.equal(allowanceEntryFor(p, 'canva', ['A'], 'job_1'), 2);
    assert.equal(allowanceEntryFor(p, 'canva', ['A'], 'job_2'), 1, 'the latest one not linked');
    assert.equal(allowanceEntryFor(p, 'gemini-app', ['A'], 'job_1'), -1);
  });

  it('spend/cli.ts allowance records one entry per unit with the job, and refuses unknown units', async () => {
    const { dir } = await rulesFolder();
    const r = await spendCli(['allowance', '--project', dir, '--service', 'canva', '--tool', 'generate-image', '--job', 'job_m1', '--units', 'KIT,KIT_sketch:2', '--failed', 'HARBOUR'], () => new Date(TS));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Recorded 4 canva generations in the ledger \(no money\), for job job_m1/);
    const p = await read(dir);
    const added = p.ledger.filter((e) => e.allowance);
    assert.deepEqual(added.map((e) => [e.unit, e.allowance!.units, e.allowance!.job, e.status, e.actual]), [['KIT', 1, 'job_m1', 'done', 0], ['KIT_sketch', 2, 'job_m1', 'done', 0], ['HARBOUR', 1, 'job_m1', 'failed', 0]]);
    assert.deepEqual(checkIntegrity(p), []);
    assert.equal((await spendCli(['allowance', '--project', dir, '--service', 'canva', '--units', 'NOPE'])).code, 1);
    assert.equal((await spendCli(['allowance', '--project', dir, '--service', 'Canva!', '--units', 'KIT'])).code, 2);
    assert.equal((await spendCli(['allowance', '--project', dir, '--service', 'canva', '--units', 'KIT:0'])).code, 2);
  });
});

describe('rules/cli.ts allow', () => {
  it('hashes the file and appends it to rules.uploads.allow with its label and entries; refuses a duplicate hash', async () => {
    const { dir } = await rulesFolder();
    const r = await rulesCli(['allow', '--project', dir, '--file', join(dir, FILES.street.path), '--label', 'Street photo (person said yes)', '--for', 'ADA', '--for', 'HARBOUR', '--note', 'on the person\'s word']);
    assert.equal(r.code, 0, r.out);
    const p = await read(dir);
    const added = p.rules!.uploads.allow.at(-1)!;
    assert.deepEqual(added, { sha256: HASH.street, label: 'Street photo (person said yes)', for: ['ADA', 'HARBOUR'], note: 'on the person\'s word' });
    const again = await rulesCli(['allow', '--project', dir, '--file', join(dir, FILES.street.path), '--label', 'again']);
    assert.equal(again.code, 1);
    assert.match(again.out, /already allowed as "Street photo \(person said yes\)"\. Nothing changed/);
    assert.equal((await read(dir)).rules!.uploads.allow.length, 4);
  });

  it('refuses unknown entries and missing arguments, and warns when never_from_photo wins', async () => {
    const { dir } = await rulesFolder();
    assert.equal((await rulesCli(['allow', '--project', dir, '--file', join(dir, FILES.street.path), '--label', 'x', '--for', 'NOBODY'])).code, 1);
    assert.equal((await rulesCli(['allow', '--project', dir, '--file', join(dir, FILES.street.path)])).code, 2);
    const k = await rulesCli(['allow', '--project', dir, '--file', join(dir, FILES.street.path), '--label', 'x', '--for', 'KIT']);
    assert.equal(k.code, 0);
    assert.match(k.out, /warn: KIT is never_from_photo, which wins/);
  });
});

describe('rules/cli.ts adopt-allowance (one-time back-fill)', () => {
  /** KIT_sketch as ingested before --via existed, plus a canva entry for it with no job, and its saved job. */
  const before = (q: AkukoProject): void => {
    q.ledger.push({ id: 'allow_canva.KIT_sketch.1', ts: T0, provider: 'canva', unit: 'KIT_sketch', estimate: 0, actual: 0, status: 'done', allowance: { service: 'canva', units: 1 } });
  };
  const saveJob = async (dir: string, id: string, items: { unit: string; refs?: { id: string; uri: string }[] }[]) => {
    await mkdir(join(dir, 'bible', 'jobs'), { recursive: true });
    await writeFile(join(dir, 'bible', 'jobs', `${id}.json`), JSON.stringify({ job: { id, stage: 'bible', kind: 'image', provider: 'manual', label: 'x', items: items.map((i) => ({ prompt: '', output: 'portrait', ...i })) }, handle: {} }));
  };

  it('dry run by default: prints the change and writes nothing; --apply writes it and the file becomes generated', async () => {
    const { dir } = await rulesFolder(before);
    await saveJob(dir, 'job_bible_w1_bbbb2222_r1', [{ unit: 'KIT_sketch' }]);
    const raw = await readFile(join(dir, 'akuko.json'), 'utf8');
    const dry = await rulesCli(['adopt-allowance', '--project', dir, '--service', 'canva']);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /dry run \(nothing written; add --apply to write\)/);
    assert.match(dry.out, /KIT_sketch: manual → canva · job job_bible_w1_bbbb2222_r1 · ledger allow_canva\.KIT_sketch\.1 linked · sha256 recorded · refs all generated/);
    assert.match(dry.out, /1 file would be adopted, 0 skipped/);
    assert.equal(await readFile(join(dir, 'akuko.json'), 'utf8'), raw, 'a dry run writes nothing');

    const wet = await rulesCli(['adopt-allowance', '--project', dir, '--service', 'canva', '--apply']);
    assert.equal(wet.code, 0, wet.out);
    const p = await read(dir);
    const a = p.assets.find((x) => x.id === 'KIT_sketch')!;
    assert.equal(a.provider, 'canva');
    assert.equal(a.file?.hash, HASH.kitByHand);
    assert.equal(generatingJob(p, a), 'job_bible_w1_bbbb2222_r1');
    assert.deepEqual((await checkJob(p, kitShot('KIT_sketch', FILES.kitByHand.path), { projectDir: dir })).breaches, []);
    assert.deepEqual(checkIntegrity(p), []);
    // running it again changes nothing
    const again = await rulesCli(['adopt-allowance', '--project', dir, '--service', 'canva']);
    assert.match(again.out, /0 files would be adopted/);
  });

  it('a file whose saved job is gone, or whose bytes changed, is not trusted', async () => {
    const { dir, project } = await rulesFolder(before);
    const gone = await adoptAllowance(project, 'canva', { projectDir: dir, job: () => undefined });
    assert.equal(gone.changes[0]?.refsUnknown, 'no saved job job_bible_w1_bbbb2222_r1');
    assert.ok(gone.project.assets.find((x) => x.id === 'KIT_sketch')!.tags.includes(REFS_EXTERNAL_TAG));
    const changed = structuredClone(project);
    changed.assets.find((x) => x.id === 'KIT_sketch')!.file!.hash = HASH.street;
    const r = await adoptAllowance(changed, 'canva', { projectDir: dir, job: () => ({ items: [{ unit: 'KIT_sketch' }] }) });
    assert.equal(r.changes.length, 0);
    assert.match(r.skipped[0]!.reason, /changed since it was ingested/);
  });

  it('adopts in generation order, so a portrait made from an adopted lookbook counts its refs as generated', async () => {
    const { dir, project } = await rulesFolder((q) => {
      before(q);
      // a lookbook, brought back by hand earlier (its generation is older), that KIT_sketch's job used as a reference
      q.assets.push({ id: 'house-style_lookbook', kind: 'lookbook', stage: 'bible', status: 'approved', comments: [], owner: 'house-style', provider: 'manual',
        tags: ['bible', 'manual', 'job:job_look_1'], file: { uri: FILES.birds.path, mime: 'image/png', hash: HASH.birds } });
      q.ledger.push({ id: 'allow_canva.house-style_lookbook.1', ts: '2026-11-08T10:00:00Z', provider: 'canva', unit: 'house-style_lookbook', estimate: 0, actual: 0, status: 'done', allowance: { service: 'canva', units: 1 } });
    });
    const jobs: Record<string, { items: { unit: string; refs?: { id: string; uri: string }[] }[] }> = {
      job_look_1: { items: [{ unit: 'house-style_lookbook' }] },
      job_bible_w1_bbbb2222_r1: { items: [{ unit: 'KIT_sketch', refs: [{ id: 'house-style_lookbook', uri: FILES.birds.path }] }] },
    };
    const r = await adoptAllowance(project, 'canva', { projectDir: dir, job: (id) => jobs[id] });
    assert.deepEqual(r.changes.map((c) => [c.asset, c.externalRefs]), [['house-style_lookbook', []], ['KIT_sketch', []]]);
    assert.ok(!r.project.assets.find((x) => x.id === 'KIT_sketch')!.tags.includes(REFS_EXTERNAL_TAG));
    // with no generation recorded for the lookbook, it stays external (even though its hash is allowed), so the portrait is tagged
    const noLook = { ...project, ledger: project.ledger.filter((e) => e.unit !== 'house-style_lookbook') };
    const solo = await adoptAllowance(noLook, 'canva', { projectDir: dir, job: (id) => jobs[id] });
    assert.deepEqual(solo.changes.map((c) => c.asset), ['KIT_sketch']);
    const kit = solo.changes.find((c) => c.asset === 'KIT_sketch')!;
    assert.deepEqual(kit.externalRefs, ['house-style_lookbook']);
  });
});

describe('ingest into a filled slot (refused unless --new-take)', () => {
  const portraitJob = (id: string): Job => job({ unit: 'KIT_portrait', prompt: 'a portrait of Kit', output: 'portrait' }, { id, stage: 'bible', provider: 'manual' });
  const ingest = async (dir: string, j: Job, o: { via?: string; newTake?: boolean } = {}) =>
    createManualProvider(createLocalHost({ projectDir: dir }), { now: () => TS }).ingest({ job: j, unit: 'KIT_portrait', file: { filename: 'kit.png', mime: 'image/png', data: PNG }, ...(o.via ? { via: o.via, projectDir: dir } : {}), ...(o.newTake ? { newTake: true } : {}) });

  it('an asset that already has a file and was not sent back is refused, with or without --via; nothing is stored', async () => {
    const { dir } = await rulesFolder();
    await createLocalHost({ projectDir: dir }).writeState(recordAllowance(await read(dir), { service: 'canva', ts: TS, units: [{ unit: 'KIT_portrait' }] }));
    const raw = await readFile(join(dir, 'akuko.json'), 'utf8');
    for (const via of [undefined, 'canva']) {
      await assert.rejects(ingest(dir, portraitJob('job_m1'), via ? { via } : {}), (e: unknown) =>
        e instanceof ManualIngestError && /"KIT_portrait" already has a file .*approved\)\. Nothing was stored\. .*Request changes.*step --units KIT_portrait.*--new-take/.test(e.message));
    }
    assert.equal(await readFile(join(dir, 'akuko.json'), 'utf8'), raw);
  });

  it('--new-take stores it beside the original as <unit>-<stage>; a sent-back asset takes the new file in place, the old one kept', async () => {
    const { dir } = await rulesFolder();
    const r = await ingest(dir, portraitJob('job_m1'), { newTake: true });
    assert.equal(r.asset.id, 'KIT_portrait-bible');
    const p = await read(dir);
    assert.equal(p.assets.find((a) => a.id === 'KIT_portrait')!.file?.uri, FILES.kitGenerated.path, 'the original is untouched');
    const { dir: d2 } = await rulesFolder((q) => { q.assets.find((a) => a.id === 'KIT_portrait')!.status = 'needs-rework'; });
    const back = await ingest(d2, portraitJob('job_m2'));
    assert.equal(back.asset.id, 'KIT_portrait', 'no stray KIT_portrait-bible asset beside the sent-back one');
    const q = await read(d2);
    assert.ok(!q.assets.some((a) => a.id === 'KIT_portrait-bible'));
    const kit = q.assets.find((a) => a.id === 'KIT_portrait')!;
    assert.equal(kit.status, 'pending-review');
    assert.notEqual(kit.file?.uri, FILES.kitGenerated.path);
    assert.ok(existsSync(join(d2, ...FILES.kitGenerated.path.split('/'))), 'the old file stays stored');
    assert.ok(kit.comments.some((c) => c.author === 'agent' && c.text.startsWith('Revised:') && c.text.includes(FILES.kitGenerated.path)));
  });
});
