// WP-26 — `rules/cli.ts`: the free preflight and the hash helper, over a
// synthetic project folder.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from './cli.ts';
import type { AkukoProject } from '../schema/akuko-project.ts';
import { FILES, HASH, STYLE, rulesFolder } from './__fixtures__/project.ts';

/** The fixture's one deliberate breach (S03-010 lacks its scene's required text), fixed. */
const clean = (p: AkukoProject): void => { p.shots.find((s) => s.id === 'S03-010')!.prompt = `Guests dance, silhouettes only, ${STYLE}`; };

describe('rules cli', () => {
  it('check: a clean project prints the summary and exits 0', async () => {
    const { dir } = await rulesFolder(clean);
    const r = await run(['check', '--project', dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^Rules check: Rules Demo/);
    assert.match(r.out, /rules: 3 banned terms, 2 required texts, 3 allowed files, 1 never-from-photo, 1 exemption; required: no/);
    assert.match(r.out, /checked: 5 shots, 5 bible entries, 2 reference files/);
    assert.match(r.out, /No breaches\./);
  });

  it('check: prints every breach with its shot id and exits 1; nothing is written', async () => {
    const { dir, project } = await rulesFolder((p) => {
      clean(p);
      p.shots.find((s) => s.id === 'S02-010')!.prompt = 'Kit next to an ACME van';
      p.bible.characters.find((e) => e.id === 'KIT')!.refs.push('KIT_sketch');
      p.rules!.exempt.push({ shots: ['S01-010'], skip: ['uploads', 'frobnicate'] });
    });
    const r = await run(['check', '--project', dir]);
    assert.equal(r.code, 1, r.out);
    const lines = r.out.split('\n');
    assert.ok(lines.includes('BREACH S02-010 [banned] banned term "acme" in the prompt: "Kit next to an ACME van" (a brand name)'), r.out);
    assert.ok(lines.some((l) => l.startsWith('BREACH S02-010 [require] the prompt lacks required text "painterly 35mm grain')), r.out);
    assert.ok(lines.some((l) => l.startsWith('BREACH bible:KIT [never-from-photo] ref KIT_sketch')), r.out);
    assert.ok(lines.some((l) => /^warn: exempt names "uploads", which can't be skipped/.test(l)), r.out);
    assert.ok(lines.some((l) => /^warn: exempt names "frobnicate", which is not a rule akuko knows/.test(l)), r.out);
    assert.match(r.out, /4 breaches\. Nothing was spent/);
    const { createLocalHost } = await import('../hosts/local.ts');
    assert.deepEqual((await createLocalHost({ projectDir: dir }).readState()).pending_spend, project.pending_spend);
  });

  it('check --json: the breaches as data', async () => {
    const { dir } = await rulesFolder((p) => { clean(p); p.shots[0]!.prompt = 'acme'; });
    const r = await run(['check', '--project', dir, '--json']);
    assert.equal(r.code, 1);
    const j = JSON.parse(r.out) as { breaches: Array<{ where: string; rule: string }> };
    assert.deepEqual(j.breaches.map((b) => `${b.where} ${b.rule}`), ['S01-010 banned', 'S01-010 require']);
  });

  it('hash: prints the sha256 that rules.uploads.allow takes', async () => {
    const { dir } = await rulesFolder();
    const r = await run(['hash', join(dir, FILES.crop.path)]);
    assert.equal(r.code, 0);
    assert.ok(r.out.startsWith(`${HASH.crop}  `));
    assert.equal((await run(['hash', join(dir, 'nope.png')])).code, 1);
  });

  it('needs --project and a known command', async () => {
    assert.equal((await run(['check'])).code, 2);
    assert.equal((await run(['frobnicate'])).code, 2);
  });
});
