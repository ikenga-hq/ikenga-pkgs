// WP-09 — unit tests for the eval runner (evals/run-evals.mjs).
//
// Scoring is tested on canned model outputs. The runner itself is never pointed
// at a model here: `runModel` is a stub, and the one subprocess test runs `node -e`
// on a tiny script that prints a canned trace.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface TriggerItem { query: string; should_trigger: boolean }
interface StageItem { id: number; name: string; action: string; prompt: string; assertions: string[] }
interface Report {
  prompts_sent: number;
  verdict: 'PASS' | 'FAIL';
  trigger_rate: number | null;
  routing_rate: number | null;
  errors: number;
  trigger: { passed: number; total: number };
  routing: { passed: number; total: number };
  results: Array<{ pass: boolean; kind: string; error?: string; triggered?: boolean; routed_action?: string | null; method?: string }>;
}
interface Mod {
  toolCalls(o: string): Array<{ name: string; input: Record<string, unknown> }>;
  detectTrigger(o: string): { triggered: boolean; method: string };
  detectAction(o: string): { action: string | null; method: string };
  scoreTrigger(i: TriggerItem, o: string): { pass: boolean; triggered: boolean };
  scoreRouting(i: StageItem, o: string): { pass: boolean; routed_action: string | null };
  rate(rows: Array<{ pass: boolean }>): number | null;
  verdict(t: Array<{ pass: boolean }>, r: Array<{ pass: boolean }>, th?: number): { verdict: string; trigger_rate: number | null; routing_rate: number | null };
  loadEvals(dir?: string): { triggers: TriggerItem[]; stages: StageItem[] };
  runEvals(o: Record<string, unknown>): Promise<Report>;
  commandRunner(t: string, o?: Record<string, unknown>): (p: string) => Promise<string>;
  main(argv: string[], o?: { log?: (s: string) => void }): Promise<number>;
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
const file = pathToFileURL(join(HERE, 'run-evals.mjs')).href;
const m = (await import(file)) as Mod;

const SK = '/home/me/.claude/skills/akuko';
const line = (o: unknown): string => JSON.stringify(o);
const use = (name: string, input: Record<string, unknown>): string => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const trace = (...lines: string[]): string => [line({ type: 'system', subtype: 'init' }), ...lines, line({ type: 'result', result: 'done' })].join('\n');

const loadsSkill = trace(use('Skill', { skill: 'akuko' }), use('Read', { file_path: `${SK}/actions/keyframes.md` }));
const loadsOther = trace(use('Skill', { skill: 'groundwork' }), use('Read', { file_path: '/x/skills/groundwork/actions/init.md' }));
const loadsNothing = trace(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here is a story about an astronaut.' }] } }));

describe('reading a trace', () => {
  it('finds tool calls wherever the stream nests them', () => {
    const calls = m.toolCalls(loadsSkill);
    assert.deepEqual(calls.map((c) => c.name), ['Skill', 'Read']);
    assert.deepEqual(m.toolCalls('plain text, no JSON'), []);
    assert.deepEqual(m.toolCalls(JSON.stringify({ messages: [{ content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a' } }] }] })).map((c) => c.name), ['Read']);
  });

  it('triggered means the akuko Skill call, or a read of its SKILL.md or an action file', () => {
    assert.deepEqual(m.detectTrigger(loadsSkill), { triggered: true, method: 'trace' });
    assert.deepEqual(m.detectTrigger(trace(use('Skill', { skill: 'plugin:akuko' }))), { triggered: true, method: 'trace' });
    assert.deepEqual(m.detectTrigger(trace(use('Read', { file_path: `${SK}/SKILL.md` }))), { triggered: true, method: 'trace' });
    assert.deepEqual(m.detectTrigger(loadsOther), { triggered: false, method: 'trace' }, 'another skill is not akuko');
    assert.deepEqual(m.detectTrigger(loadsNothing), { triggered: false, method: 'trace' });
  });

  it('with plain text only, falls back to mentions and says so', () => {
    assert.deepEqual(m.detectTrigger('I will use Skill(akuko) and read actions/bible.md'), { triggered: true, method: 'text' });
    assert.deepEqual(m.detectTrigger('Here is your story.'), { triggered: false, method: 'text' });
    assert.deepEqual(m.detectAction('open /skills/akuko/actions/board.md first'), { action: 'board', method: 'text' });
  });

  it('routing is the first akuko action file opened, and other skills\' actions do not count', () => {
    assert.deepEqual(m.detectAction(loadsSkill), { action: 'keyframes', method: 'trace' });
    assert.deepEqual(m.detectAction(trace(use('Read', { file_path: `${SK}/SKILL.md` }), use('Read', { file_path: `${SK}/actions/setup.md` }), use('Read', { file_path: `${SK}/actions/doctor.md` }))).action, 'setup');
    assert.equal(m.detectAction(loadsOther).action, null);
    assert.equal(m.detectAction(trace(use('Bash', { command: `cat ${SK}\\actions\\bible.md` }))).action, 'bible', 'a Windows path in a command counts');
    assert.equal(m.detectAction(loadsNothing).action, null);
  });
});

describe('scoring', () => {
  it('a trigger eval passes when the skill loaded as expected', () => {
    assert.equal(m.scoreTrigger({ query: 'turn this short story into a short film', should_trigger: true }, loadsSkill).pass, true);
    assert.equal(m.scoreTrigger({ query: 'turn this short story into a short film', should_trigger: true }, loadsNothing).pass, false);
    assert.equal(m.scoreTrigger({ query: 'write me a short story', should_trigger: false }, loadsNothing).pass, true);
    assert.equal(m.scoreTrigger({ query: 'write me a short story', should_trigger: false }, loadsSkill).pass, false);
  });

  it('a routing eval passes when the model opened the expected action file', () => {
    const item = { id: 6, name: 'stage-routing-keyframes', action: 'keyframes', prompt: 'make the key frames', assertions: ['Routes to actions/keyframes.md'] };
    assert.equal(m.scoreRouting(item, loadsSkill).pass, true);
    assert.equal(m.scoreRouting(item, trace(use('Read', { file_path: `${SK}/actions/bible.md` }))).pass, false);
    assert.equal(m.scoreRouting(item, loadsNothing).routed_action, null);
  });

  it('the verdict needs each rate that was run to reach the threshold', () => {
    const rows = (pass: number, total: number) => Array.from({ length: total }, (_, i) => ({ pass: i < pass }));
    assert.equal(m.rate(rows(0, 0)), null);
    assert.deepEqual(m.verdict(rows(10, 12), rows(12, 14)), { trigger_rate: 10 / 12, routing_rate: 12 / 14, threshold: 0.8, verdict: 'PASS' });
    assert.equal(m.verdict(rows(9, 12), rows(14, 14)).verdict, 'FAIL', '75% on triggering fails');
    assert.equal(m.verdict(rows(12, 12), rows(11, 14)).verdict, 'FAIL', '79% on routing fails');
    assert.equal(m.verdict(rows(10, 12), rows(0, 0)).verdict, 'PASS', 'a set that was not run does not count');
    assert.equal(m.verdict(rows(0, 0), rows(0, 0)).verdict, 'FAIL', 'nothing run is not a pass');
    assert.equal(m.verdict(rows(4, 5), rows(4, 5)).verdict, 'PASS', 'exactly 80% passes');
  });
});

describe('running the real eval set with a stub model', () => {
  const { triggers, stages } = m.loadEvals();

  /** A model that behaves perfectly: loads akuko for the positive queries and opens the expected action. */
  const perfect = async (prompt: string): Promise<string> => {
    const t = triggers.find((x) => x.query === prompt);
    if (t) return t.should_trigger ? loadsSkill : loadsNothing;
    const s = stages.find((x) => x.prompt === prompt)!;
    return trace(use('Skill', { skill: 'akuko' }), use('Read', { file_path: `${SK}/actions/${s.action}.md` }));
  };

  it('sends one call per prompt (24 triggering + 14 routing) and passes a perfect model', async () => {
    const sent: string[] = [];
    const r = await m.runEvals({ triggers, stages, runModel: async (p: string) => { sent.push(p); return perfect(p); } });
    assert.equal(sent.length, 38);
    assert.equal(r.prompts_sent, 38);
    assert.deepEqual(r.trigger, { passed: 24, total: 24 });
    assert.deepEqual(r.routing, { passed: 14, total: 14 });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.errors, 0);
  });

  it('fails a model that never loads the skill, and a model that always opens the wrong action', async () => {
    const never = await m.runEvals({ triggers, stages, runModel: async () => loadsNothing });
    assert.equal(never.trigger.passed, 12, 'it gets the 12 negatives right and the 12 positives wrong');
    assert.equal(never.routing.passed, 0);
    assert.equal(never.verdict, 'FAIL');

    const wrong = await m.runEvals({ triggers, stages, runModel: async (p: string) => (stages.some((s) => s.prompt === p) ? trace(use('Read', { file_path: `${SK}/actions/export.md` })) : perfect(p)) });
    assert.equal(wrong.routing.passed, 0);
    assert.equal(wrong.verdict, 'FAIL');
  });

  it('exactly at the line: 80% of each passes, one fewer fails', async () => {
    const miss = (set: Set<string>) => async (p: string): Promise<string> => (set.has(p) ? loadsNothing : perfect(p));
    // 24 triggers: 80% is 19.2, so 20 must pass (4 wrong); 14 routing: 80% is 11.2, so 12 must pass (2 wrong).
    const wrongTriggers = new Set(triggers.filter((t) => t.should_trigger).slice(0, 4).map((t) => t.query));
    const wrongStages = new Set(stages.slice(0, 2).map((s) => s.prompt));
    const ok = await m.runEvals({ triggers, stages, runModel: miss(new Set([...wrongTriggers, ...wrongStages])) });
    assert.deepEqual([ok.trigger.passed, ok.routing.passed, ok.verdict], [20, 12, 'PASS']);
    const more = new Set([...wrongTriggers, ...wrongStages, stages[2]!.prompt]);
    assert.equal((await m.runEvals({ triggers, stages, runModel: miss(more) })).verdict, 'FAIL');
  });

  it('counts a prompt whose command failed as a failure and reports the error', async () => {
    const r = await m.runEvals({ triggers, stages, runModel: async (p: string) => { if (p === stages[0]!.prompt) throw new Error('boom'); return perfect(p); } });
    assert.equal(r.errors, 1);
    assert.equal(r.results.find((x) => x.error)?.pass, false);
    assert.equal(r.routing.passed, 13);
  });

  it('--only and --limit narrow what is sent', async () => {
    const sent: string[] = [];
    const run = (o: Record<string, unknown>) => m.runEvals({ triggers, stages, runModel: async (p: string) => { sent.push(p); return perfect(p); }, ...o });
    await run({ only: 'trigger', limit: 3 });
    assert.equal(sent.length, 3);
    sent.length = 0;
    const r = await run({ only: 'routing' });
    assert.equal(sent.length, 14);
    assert.equal(r.trigger.total, 0);
    assert.equal(r.verdict, 'PASS');
  });
});

describe('the command line', () => {
  it('--dry-run lists the prompts and sends nothing (no command needed)', async () => {
    const out: string[] = [];
    const code = await m.main(['--dry-run'], { log: (s) => out.push(s) });
    assert.equal(code, 0);
    assert.match(out[0]!, /24 triggering prompts \+ 14 stage-routing prompts = 38 calls/);
    assert.equal(out.at(-1), 'Dry run: nothing was sent.');
    assert.equal(out.filter((l) => l.startsWith('  trigger')).length, 24);
  });

  it('refuses to run without a command, and rejects bad options', async () => {
    const out: string[] = [];
    assert.equal(await m.main([], { log: (s) => out.push(s) }), 2);
    assert.match(out.join('\n'), /--cmd is required/);
    assert.equal(await m.main(['--bogus'], { log: () => {} }), 2);
    assert.equal(await m.main(['--only', 'both', '--dry-run'], { log: () => {} }), 2);
    assert.equal(await m.main(['--threshold', '0', '--dry-run'], { log: () => {} }), 2);
  });

  it('runs a command template with the prompt on stdin and writes the results file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-evals-test-'));
    try {
      // A "model" that is a node one-liner: it reads the prompt from stdin and prints a canned trace.
      const script = join(dir, 'fake-model.mjs');
      const body = [
        "import { readFileSync } from 'node:fs';",
        "const prompt = readFileSync(0, 'utf8');",
        "const use = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });",
        "const positive = /story|film|storyboard|key frames|bible|budget|akuko/i.test(prompt);",
        "console.log(positive ? use('Skill', { skill: 'akuko' }) : JSON.stringify({ type: 'result' }));",
      ].join('\n');
      (await import('node:fs')).writeFileSync(script, body);
      const out = join(dir, 'results.json');
      const logs: string[] = [];
      const code = await m.main(['--cmd', `node "${script}"`, '--only', 'trigger', '--limit', '4', '--out', out, '--concurrency', '2'], { log: (s) => logs.push(s) });
      const saved = JSON.parse(readFileSync(out, 'utf8')) as Report & { command: string };
      assert.equal(saved.prompts_sent, 4);
      assert.equal(saved.results.length, 4);
      assert.ok(saved.results.every((r) => r.method === 'trace'));
      assert.equal(saved.command, `node "${script}"`);
      assert.equal(typeof code, 'number');
      assert.match(logs.join('\n'), /Verdict \(each at least 80%\): (PASS|FAIL)/);
      assert.match(logs.join('\n'), /Triggering:    \d+\/4/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never calls a model by itself: no test or default path spawns anything but the given command', () => {
    const src = readFileSync(join(HERE, 'run-evals.mjs'), 'utf8');
    assert.ok(!/api\.anthropic\.com|ANTHROPIC_API_KEY|fetch\(/.test(src), 'the runner has no model client of its own');
  });
});
