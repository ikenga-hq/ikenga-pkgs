/**
 * WP-09 — a full-run harness for the short-story fixture (Phase 1 verification, items 2 and 5).
 *
 * It drives the fixture project through intake -> breakdown -> sketch board ->
 * bibles -> key frames on a real project folder, calling the real command line
 * of each stage (`breakdown/cli.ts`, `board/cli.ts`, `bible/cli.ts`,
 * `keyframes/cli.ts`) and folding decisions the way every action does.
 *
 * Two kinds of run:
 *   - `manual`: the free provider. The prompt package comes out, a (tiny) PNG
 *     goes back in with `ingest`. No budget needed.
 *   - `gemini-image`: a paid provider on a MOCKED network. `globalThis.fetch`
 *     is replaced for the duration of the run and the "key" is a dummy value,
 *     so no request can leave the machine. The run records every spend prompt
 *     the gate shows, and the number of requests made when it showed it.
 *
 * "Approved" only ever arrives by folding a decision a person wrote through a
 * view on the conformed list (`default-board@0.1`, the skill's own board).
 * The harness checks that after every command: no command may newly approve a
 * unit or a stage.
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run as boardCli } from '../../board/cli.ts';
import { run as bibleCli } from '../../bible/cli.ts';
import { run as breakdownCli } from '../../breakdown/cli.ts';
import { conformedFrom } from '../../decisions/cli.ts';
import { foldDecisions, type FoldReport } from '../../decisions/fold.ts';
import { appendDecisions, readJsonlStore } from '../../decisions/jsonl.ts';
import { createLocalHost } from '../../hosts/local.ts';
import { run as keyframesCli } from '../../keyframes/cli.ts';
import { PNG_BYTES, mockGemini, type MockNet } from '../../providers/gemini-image/__fixtures__/mock-net.ts';
import { listUnits, type AkukoProject, type Decision, type StageId } from '../../schema/akuko-project.ts';
import { applySetup } from '../../setup/setup.ts';

export const FIXTURE_DIR = fileURLToPath(new URL('.', import.meta.url));

/** The board the person decides on: the skill's shipped default board, on `views/conformed.json`. */
export const VIEW = 'default-board@0.1';

/** A dummy key value: the mocked network never sees a real one, and nothing real is read from the environment. */
export const DUMMY_KEY = 'akuko-test-key-not-a-secret';

type CliRun = (argv: string[], now?: () => Date) => Promise<{ code: number; out: string }>;

// ─────────────────────────────────────────────────────────────────────────
// A clock and a person
// ─────────────────────────────────────────────────────────────────────────

/** Strictly increasing, one second a tick, so ordering is the same on every machine. */
export function makeClock(start = '2026-11-08T10:00:00Z'): { date: () => Date; iso: () => string } {
  let t = Date.parse(start);
  const date = (): Date => new Date((t += 1000));
  return { date, iso: () => date().toISOString().replace('.000Z', 'Z') };
}
export type Clock = ReturnType<typeof makeClock>;

const uuid = (seed: string): string => {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** The reviewer: writes decisions to `decisions.jsonl` (what "Copy decisions for akuko" gives host B) and folds them. */
export class Person {
  readonly written: Decision[] = [];
  readonly folds: FoldReport[] = [];
  private n = 0;

  readonly dir: string;
  readonly clock: Clock;
  readonly seed: string;

  constructor(dir: string, clock: Clock, seed = 'short-story') {
    this.dir = dir;
    this.clock = clock;
    this.seed = seed;
  }

  decision(action: Decision['action'], unit: string, stage: StageId, extra: Record<string, unknown> = {}): Decision {
    this.n++;
    return { id: uuid(`${this.seed}-${this.n}`), action, unit, stage, by: 'you', at: this.clock.iso(), view: VIEW, ...extra } as Decision;
  }

  async write(ds: Decision[]): Promise<void> {
    await appendDecisions(this.dir, ds);
    this.written.push(...ds);
  }

  async approve(units: string[], stage: StageId): Promise<void> {
    await this.write(units.map((u) => this.decision('approve', u, stage)));
  }

  /** The person types "approve <amount> <currency>" on the board for the job the gate showed. */
  async approveSpend(jobId: string, amount: number, currency: string, stage: StageId): Promise<Decision> {
    const d = this.decision('approve-spend', jobId, stage, { text: `approve ${String(Number(amount.toFixed(4)))} ${currency}` });
    await this.write([d]);
    return d;
  }

  /** Fold `decisions.jsonl` into `akuko.json` (the first thing every action does). */
  async fold(): Promise<FoldReport> {
    const host = createLocalHost({ projectDir: this.dir });
    const warnings: string[] = [];
    const read = await readJsonlStore(this.dir);
    if (read.invalid.length > 0) throw new Error(`invalid decision records: ${JSON.stringify(read.invalid)}`);
    const { project, report } = foldDecisions(await host.readState(), read.decisions, { conformed: conformedFrom(undefined, this.dir, warnings) });
    if (warnings.length > 0) throw new Error(`conformed list warnings: ${warnings.join('; ')}`);
    if (report.changed) await host.writeState(project);
    this.folds.push(report);
    return report;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────

export type StageName = 'intake' | 'breakdown' | 'sketch' | 'bible' | 'keyframes';
export const STAGE_ORDER: StageName[] = ['intake', 'breakdown', 'sketch', 'bible', 'keyframes'];

/** One thing the spend gate put in front of the person before a paid call. */
export interface SpendPrompt {
  stage: 'bible' | 'keyframes';
  job: string;
  estimate: number;
  /** The gate's spend line, as printed. */
  line: string;
  /** Requests the mocked network had seen when the prompt was shown, and again after the person approved. */
  requestsAtPrompt: number;
  requestsAfterApproval: number;
  /** The decision that approved it. */
  decision: string;
}

export interface RunEvidence {
  provider: 'manual' | 'gemini-image';
  /** Stage state after each stage was driven. */
  stageStates: Record<StageName, string>;
  spendPrompts: SpendPrompt[];
  /** What happened when a paid step was tried before any budget was set (paid runs only). */
  noBudgetRefusal?: string;
  /** Network requests the mock saw in total (paid runs). */
  requests: number;
  /** Hosts and key values the mocked requests carried (paid runs): only the mocked Gemini host, only the dummy key. */
  requestHosts: string[];
  requestKeys: string[];
  /** Commands run, by area. */
  commands: Record<string, number>;
  decisions: { total: number; byAction: Record<string, number>; byStage: Record<string, number> };
  folds: number;
  /** Files the manual hand-off brought back / paid files recorded. */
  filesRecorded: number;
  final: AkukoProject;
}

export interface RunOptions {
  dir: string;
  provider: 'manual' | 'gemini-image';
  /** Budget cap for a paid run (the person's answer to setup). */
  cap?: number;
  /** Only the key frames of these scenes are made (all by default). Earlier stages always cover the whole story. */
  scenes?: string[];
  /** Stop after this stage (the earlier ones are still run). */
  upTo?: StageName;
  clock?: Clock;
}

const approvedUnits = (p: AkukoProject): Set<string> => new Set(listUnits(p).filter((u) => u.unit.status === 'approved').map((u) => u.unit.id));
const approvedStages = (p: AkukoProject): Set<string> => new Set(Object.entries(p.stages).filter(([, s]) => s.state === 'approved').map(([k]) => k));

export interface Run {
  readonly dir: string;
  readonly person: Person;
  readonly clock: Clock;
  readonly net?: MockNet;
  readonly provider: 'manual' | 'gemini-image';
  readonly commands: Record<string, number>;
  readonly spendPrompts: SpendPrompt[];
  filesRecorded: number;
  noBudgetRefusal?: string;
  read(): Promise<AkukoProject>;
  /** Run a stage CLI and check it newly approved nothing. */
  cli(area: string, fn: CliRun, args: string[], expectCode?: number): Promise<string>;
}

export function startRun(o: RunOptions): Run {
  const clock = o.clock ?? makeClock();
  const commands: Record<string, number> = {};
  const net = o.provider === 'gemini-image' ? mockGemini() : undefined;
  const r: Run = {
    dir: o.dir,
    person: new Person(o.dir, clock),
    clock,
    ...(net ? { net } : {}),
    provider: o.provider,
    commands,
    spendPrompts: [],
    filesRecorded: 0,
    read: () => createLocalHost({ projectDir: o.dir }).readState(),
    async cli(area, fn, args, expectCode = 0) {
      const before = await r.read().catch(() => undefined);
      const res = await fn(args, clock.date);
      commands[area] = (commands[area] ?? 0) + 1;
      if (res.code !== expectCode) throw new Error(`${area} ${args.join(' ')} exited ${res.code} (wanted ${expectCode}):\n${res.out}`);
      const after = await r.read();
      if (before) {
        const was = approvedUnits(before);
        for (const id of approvedUnits(after)) if (!was.has(id)) throw new Error(`${area} ${args[0]} newly approved ${id}: only folding a person's decision may do that`);
        const wasStages = approvedStages(before);
        for (const s of approvedStages(after)) if (!wasStages.has(s)) throw new Error(`${area} ${args[0]} newly approved stage ${s}`);
      }
      return res.out;
    },
  };
  return r;
}

/**
 * Run `fn` with the mocked network and a dummy key in place of a real one, and restore both afterwards.
 *
 * The working directory is left alone: reference images (earlier approved bible images) are loaded
 * relative to the project folder, so the paid path runs from any cwd.
 */
export async function withMockedNetwork<T>(net: MockNet, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const had = Object.prototype.hasOwnProperty.call(process.env, 'GEMINI_API_KEY');
  const prev = process.env.GEMINI_API_KEY;
  globalThis.fetch = net.fetch;
  process.env.GEMINI_API_KEY = DUMMY_KEY;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (had) process.env.GEMINI_API_KEY = prev;
    else delete process.env.GEMINI_API_KEY;
  }
}

// ── stages ───────────────────────────────────────────────────────────────

const ids = (p: AkukoProject): string[] => [...p.shots, ...p.bible.characters, ...p.bible.locations, ...p.bible.styles].map((u) => u.id);

/** intake -> breakdown, with the person's approvals folded at each gate. */
export async function runIntakeAndBreakdown(r: Run): Promise<void> {
  const { dir } = r;
  await mkdir(join(dir, 'script'), { recursive: true });
  await r.cli('breakdown', breakdownCli, ['new', '--project', dir, '--title', 'The Beating', '--runtime', '70', '--source', "Adapted from Edgar Allan Poe's The Tell-Tale Heart (1843, public domain)"]);
  await copyFile(join(FIXTURE_DIR, 'source.md'), join(dir, 'script', 'source.md'));
  await copyFile(join(FIXTURE_DIR, 'screenplay.fountain'), join(dir, 'script', 'screenplay.fountain'));
  await r.cli('breakdown', breakdownCli, ['intake', '--project', dir, '--route', 'adapt']);

  // Breakdown is locked until a person approves intake.
  let p = await r.read();
  if (p.stages.breakdown.state !== 'locked') throw new Error(`breakdown should be locked before intake is approved, is ${p.stages.breakdown.state}`);
  await r.cli('breakdown', breakdownCli, ['apply', '--project', dir, '--proposal', join(FIXTURE_DIR, 'proposal.json')], 1);

  await r.person.approve(p.assets.filter((a) => a.stage === 'intake').map((a) => a.id), 'intake');
  await r.person.fold();

  await r.cli('breakdown', breakdownCli, ['apply', '--project', dir, '--proposal', join(FIXTURE_DIR, 'proposal.json')]);
  await r.cli('breakdown', breakdownCli, ['tag', '--project', dir]);
  await r.cli('breakdown', breakdownCli, ['lint', '--project', dir]);

  p = await r.read();
  await r.person.approve(ids(p), 'breakdown');
  await r.person.fold();
}

/** sketch board: draw a panel per shot (free), then the person approves them. */
export async function runSketch(r: Run): Promise<void> {
  await r.cli('board', boardCli, ['draw', '--project', r.dir]);
  const p = await r.read();
  await r.person.approve(p.shots.map((s) => s.id), 'sketch');
  await r.person.fold();
}

/** The next move of a paid or free image stage, until every image is approved. */
async function driveImages(r: Run, stage: 'bible' | 'keyframes', opts: { scenes?: string[]; keepOne?: boolean } = {}): Promise<void> {
  const cli = stage === 'bible' ? bibleCli : keyframesCli;
  const { dir } = r;
  const call = (args: string[], code = 0) => r.cli(stage, cli, [args[0]!, '--project', dir, ...args.slice(1)], code);
  const owned = (p: AkukoProject) => p.assets.filter((a) => a.stage === stage && a.tags.includes(stage === 'bible' ? 'bible' : 'keyframe'));
  const scenes = stage === 'keyframes' ? opts.scenes : undefined;

  await call(['plan']);
  for (let i = 0; i < 80; i++) {
    const p = await r.read();
    if (stage === 'keyframes' && scenes) {
      const mine = owned(p).filter((a) => scenes.some((sc) => a.id.startsWith(`${sc}_`)));
      if (mine.length > 0 && mine.every((a) => a.status === 'approved')) return;
    } else if (p.stages[stage].state === 'approved') return;

    const requestsBefore = r.net?.calls.length ?? 0;
    const stepArgs = ['step', '--provider', r.provider, ...(scenes && scenes.length === 1 ? ['--scene', scenes[0]!] : [])];
    const out = await call(stepArgs);

    if (/^Spend check/m.test(out)) {
      if (r.provider === 'manual') throw new Error('a free job was held for approval');
      const requestsAtPrompt = r.net!.calls.length;
      if (requestsAtPrompt !== requestsBefore) throw new Error(`a request was sent before the person approved (${requestsBefore} -> ${requestsAtPrompt})`);
      const q = await r.read();
      const pending = q.pending_spend.filter((j) => j.status === 'awaiting-approval' && j.stage === stage);
      if (pending.length !== 1) throw new Error(`expected one pending spend for ${stage}, found ${pending.length}`);
      const job = pending[0]!;
      const line = out.split('\n').find((l) => l.startsWith('Spend check')) ?? out;
      const d = await r.person.approveSpend(job.id, job.estimate, q.budget?.currency ?? 'USD', stage);
      await r.person.fold();
      r.spendPrompts.push({ stage, job: job.id, estimate: job.estimate, line, requestsAtPrompt, requestsAfterApproval: r.net!.calls.length, decision: d.id });
      continue;
    }

    const handoff = /\nJob (\S+?)\. When the files are back/.exec(out);
    if (handoff) {
      const jobId = handoff[1]!;
      const saved = JSON.parse(await readFile(join(dir, stage, 'jobs', `${jobId}.json`), 'utf8')) as { handle: { units: string[] } };
      for (const unit of saved.handle.units) {
        const file = join(dir, stage, 'jobs', `${unit}.png`);
        await writeFile(file, PNG_BYTES);
        await call(['ingest', '--job', jobId, '--unit', unit, '--file', file]);
        r.filesRecorded++;
      }
    } else if (/^Done:/m.test(out)) {
      r.filesRecorded += (/recorded \(([^)]*)\)/.exec(out)?.[1] ?? '').split(',').filter(Boolean).length;
    } else {
      throw new Error(`unexpected ${stage} step output:\n${out}`);
    }

    // The person reviews what came back.
    const after = await r.read();
    const waiting = owned(after).filter((a) => a.status === 'pending-review').map((a) => a.id);
    if (waiting.length === 0) throw new Error(`${stage}: a step finished but nothing is waiting for review`);
    await r.person.approve(waiting, stage);
    await r.person.fold();
    await call(['sync']);
  }
  throw new Error(`${stage} did not finish in 80 steps`);
}

/** Set the budget the way `setup` does, through the host. */
export async function setBudget(r: Run, cap: number): Promise<void> {
  const host = createLocalHost({ projectDir: r.dir });
  await applySetup({ cap }, { host, env: {}, platform: 'linux', now: () => r.clock.iso() });
}

/** Everything, start to finish. */
export async function runShortStory(o: RunOptions): Promise<RunEvidence> {
  const r = startRun(o);
  const states: Partial<Record<StageName, string>> = {};
  const body = async (): Promise<void> => {
    await runIntakeAndBreakdown(r);
    states.intake = (await r.read()).stages.intake.state;
    states.breakdown = (await r.read()).stages.breakdown.state;
    if (o.upTo === 'breakdown') return;
    await runSketch(r);
    states.sketch = (await r.read()).stages.sketch.state;
    if (o.upTo === 'sketch') return;

    let noBudgetRefusal: string | undefined;
    if (o.provider !== 'manual') {
      // No budget yet: a paid step is refused with the pointer to setup, and sends nothing.
      await driveRefusal(r).then((m) => { noBudgetRefusal = m; });
      await setBudget(r, o.cap ?? 25);
      r.noBudgetRefusal = noBudgetRefusal;
    }
    await driveImages(r, 'bible');
    states.bible = (await r.read()).stages.bible.state;
    if (o.upTo === 'bible') return;
    await driveImages(r, 'keyframes', { ...(o.scenes ? { scenes: o.scenes } : {}) });
    states.keyframes = (await r.read()).stages.keyframes.state;
  };
  if (r.net) await withMockedNetwork(r.net, body);
  else await body();

  const final = await r.read();
  const byAction: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  for (const d of r.person.written) {
    byAction[d.action] = (byAction[d.action] ?? 0) + 1;
    byStage[d.stage] = (byStage[d.stage] ?? 0) + 1;
  }
  const refusal = r.noBudgetRefusal;
  return {
    provider: o.provider,
    stageStates: Object.fromEntries(STAGE_ORDER.map((s) => [s, states[s] ?? final.stages[s].state])) as Record<StageName, string>,
    spendPrompts: r.spendPrompts,
    ...(refusal !== undefined ? { noBudgetRefusal: refusal } : {}),
    requests: r.net?.calls.length ?? 0,
    requestHosts: [...new Set((r.net?.calls ?? []).map((c) => new URL(c.url).host))],
    requestKeys: [...new Set((r.net?.calls ?? []).map((c) => c.headers['x-goog-api-key'] ?? '(none)'))],
    commands: r.commands,
    decisions: { total: r.person.written.length, byAction, byStage },
    folds: r.person.folds.length,
    filesRecorded: r.filesRecorded,
    final,
  };
}

/** A paid step with no budget set: refused (setup pointer), nothing sent. */
async function driveRefusal(r: Run): Promise<string> {
  const before = r.net!.calls.length;
  await r.cli('bible', bibleCli, ['plan', '--project', r.dir]);
  const out = await r.cli('bible', bibleCli, ['step', '--project', r.dir, '--provider', r.provider], 1);
  if (r.net!.calls.length !== before) throw new Error('a request was sent with no budget set');
  return out;
}
