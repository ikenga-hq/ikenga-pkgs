// WP-26 — the guard is wired into each paid stage's command line. A paid step
// whose text breaks a rule is refused before the spend gate: no pending
// spend is written (the gate's quote() would write one), the ledger is
// untouched and the network is never called. The same step without the rule
// does reach the gate (the control), so the test can tell the difference.
// Dummy key values only; fetch is stubbed and fails the test if called.

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createLocalHost, serializeProject } from '../hosts/local.ts';
import type { AkukoProject } from '../schema/akuko-project.ts';
import { run as bibleCli } from '../bible/cli.ts';
import { run as keyframesCli } from '../keyframes/cli.ts';
import { run as motionCli } from '../motion/cli.ts';
import { run as soundCli } from '../sound/cli.ts';
import { breakdownApproved } from '../bible/__fixtures__/project.ts';
import { bibleApproved } from '../keyframes/__fixtures__/project.ts';
import { keyframesApproved as motionReady } from '../motion/__fixtures__/project.ts';
import { keyframesApproved as soundReady } from '../sound/__fixtures__/project.ts';

const T = () => new Date('2026-11-09T10:00:00Z');
const BUDGET = { budget: { cap: 10, currency: 'USD' } };
const WORD = 'zorblax';
const RULES = { required: false, banned: [{ term: WORD, note: 'a synthetic banned word' }], require: [], uploads: { allow: [] }, never_from_photo: [], exempt: [], consent: [] };

type Cli = (argv: string[], now?: () => Date) => Promise<{ code: number; out: string }>;

interface Stage {
  name: string;
  cli: Cli;
  provider: string;
  plan: string[];
  extra?: string[];
  project: () => AkukoProject;
  /** Put the banned word into the text this stage sends. */
  taint: (p: AkukoProject) => void;
}

const STAGES: Stage[] = [
  {
    name: 'bible', cli: bibleCli, provider: 'fal', plan: ['plan'], project: () => breakdownApproved(BUDGET),
    taint: (p) => { for (const e of [...p.bible.characters, ...p.bible.locations, ...p.bible.styles]) e.description = `${e.description ?? ''} wearing a ${WORD} pin`; },
  },
  {
    name: 'keyframes', cli: keyframesCli, provider: 'fal', plan: ['plan'], project: () => bibleApproved(BUDGET),
    taint: (p) => { for (const s of p.shots) s.prompt = `a ${WORD} on the table`; },
  },
  {
    name: 'motion', cli: motionCli, provider: 'fal-video', plan: ['plan'], project: () => motionReady(BUDGET),
    taint: (p) => { for (const s of p.shots) s.prompt = `a ${WORD} on the table`; },
  },
  {
    name: 'sound', cli: soundCli, provider: 'elevenlabs', plan: ['plan'], extra: ['--voice', 'v1'], project: () => soundReady(BUDGET),
    taint: (p) => { for (const s of p.shots) s.narration = `I left the ${WORD} behind.`; },
  },
];

const KEYS = ['FAL_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY'] as const;
const kept: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let fetches = 0;

before(() => {
  for (const k of KEYS) { kept[k] = process.env[k]; process.env[k] = 'dummy-not-a-secret'; }
  globalThis.fetch = (async () => { fetches++; throw new Error('the network must not be called'); }) as typeof fetch;
});
after(() => {
  for (const k of KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; }
  globalThis.fetch = realFetch;
});

async function folder(p: AkukoProject): Promise<{ dir: string; read: () => Promise<AkukoProject> }> {
  const dir = await mkdtemp(join(tmpdir(), 'akuko-rules-cli-'));
  await writeFile(join(dir, 'akuko.json'), serializeProject(p));
  const host = createLocalHost({ projectDir: dir, now: T });
  return { dir, read: () => host.readState() };
}

describe('the rules guard in each stage command line', () => {
  for (const s of STAGES) {
    it(`${s.name}: a paid step without rules reaches the gate (control): a pending spend is written`, async () => {
      const p = s.project();
      s.taint(p);
      const { dir, read } = await folder(p);
      assert.equal((await s.cli([...s.plan, '--project', dir], T)).code, 0);
      const r = await s.cli(['step', '--project', dir, '--provider', s.provider, ...(s.extra ?? [])], T);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Reply "approve/);
      assert.equal((await read()).pending_spend.length, 1);
      assert.equal(fetches, 0);
    });

    it(`${s.name}: the same step with a banned word is refused as rules-breach before the gate`, async () => {
      const p = s.project();
      s.taint(p);
      p.rules = structuredClone(RULES);
      const { dir, read } = await folder(p);
      assert.equal((await s.cli([...s.plan, '--project', dir], T)).code, 0);
      const r = await s.cli(['step', '--project', dir, '--provider', s.provider, ...(s.extra ?? [])], T);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /^Refused \(rules-breach\): The project rules refuse job /);
      assert.match(r.out, new RegExp(`banned term "${WORD}"`));
      const after = await read();
      assert.deepEqual(after.pending_spend, [], 'quote() was never reached');
      assert.deepEqual(after.ledger, []);
      assert.equal(fetches, 0);
    });
  }
});
