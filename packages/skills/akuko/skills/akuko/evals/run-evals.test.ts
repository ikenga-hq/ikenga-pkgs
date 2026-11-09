// WP-09 — unit tests for the eval runner (evals/run-evals.mjs).
//
// Scoring is tested on canned model outputs. The runner itself is never pointed
// at a model here: `runModel` is a stub, and the one subprocess test runs `node -e`
// on a tiny script that prints a canned trace.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface TriggerItem { query: string; should_trigger: boolean }
interface StageItem { id: number; name: string; action: string; prompt: string; assertions: string[] }
interface Report {
  prompts_sent: number;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  error_reasons: string[];
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
  detectAction(o: string): { action: string | null; actions: string[]; method: string };
  scoreTrigger(i: TriggerItem, o: string): { pass: boolean; triggered: boolean };
  modelCallError(o: string): string | null;
  isRealOutcome(o: string): boolean;
  linkedActions(action: string, dir?: string): string[];
  scoreRouting(i: StageItem, o: string, opts?: { actionsDir?: string }): { pass: boolean; routed_action: string | null; actions_read: string[]; reason?: string };
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
    assert.deepEqual(m.detectAction('open /skills/akuko/actions/board.md first'), { action: 'board', actions: ['board'], method: 'text' });
  });

  it('routing is the first akuko action file opened, and other skills\' actions do not count', () => {
    assert.deepEqual(m.detectAction(loadsSkill), { action: 'keyframes', actions: ['keyframes'], method: 'trace' });
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

  it('routing fails when the first action opened is not the expected one, and says why', () => {
    const item = { id: 6, name: 'stage-routing-keyframes', action: 'keyframes', prompt: 'make the key frames', assertions: [] };
    const hedge = trace(use('Skill', { skill: 'akuko' }), use('Read', { file_path: `${SK}/actions/bible.md` }), use('Read', { file_path: `${SK}/actions/keyframes.md` }));
    const d = m.detectAction(hedge);
    assert.equal(d.action, 'bible', 'first opened');
    assert.deepEqual(d.actions, ['bible', 'keyframes'], 'every distinct action, in order');
    const r = m.scoreRouting(item, hedge);
    assert.equal(r.pass, false, 'the expected action was among them but not first');
    assert.deepEqual(r.actions_read, ['bible', 'keyframes'], 'every action read is still listed');
    assert.match(r.reason!, /opened bible first, expected keyframes/);
    // the same action read twice is one action
    const twice = trace(use('Read', { file_path: `${SK}/actions/keyframes.md` }), use('Read', { file_path: `${SK}/actions/keyframes.md` }));
    assert.equal(m.scoreRouting(item, twice).pass, true);
    assert.deepEqual(m.scoreRouting(item, twice).actions_read, ['keyframes']);
    // wrong single action and no action each carry a reason
    assert.match(m.scoreRouting(item, trace(use('Read', { file_path: `${SK}/actions/bible.md` }))).reason!, /opened bible first, expected keyframes/);
    assert.match(m.scoreRouting(item, loadsNothing).reason!, /no akuko action file/);
    assert.equal(m.scoreRouting(item, loadsSkill).reason, undefined);
  });

  it('routing passes when the extra action files are ones the expected action links to (setup then doctor)', () => {
    const setup = { id: 0, name: 'stage-routing-setup', action: 'setup', prompt: 'set up akuko', assertions: [] };
    // setup.md points at doctor.md, so the model following that pointer is still routing to setup.
    assert.ok(m.linkedActions('setup').includes('doctor'));
    const smoke = trace(use('Skill', { skill: 'akuko' }), use('Read', { file_path: `${SK}/actions/setup.md` }), use('Read', { file_path: `${SK}/actions/doctor.md` }));
    const r = m.scoreRouting(setup, smoke);
    assert.equal(r.pass, true);
    assert.equal(r.reason, undefined);
    assert.deepEqual(r.actions_read, ['setup', 'doctor'], 'both are still listed');
    // an unrelated second action is a fail, naming it
    const stray = m.scoreRouting(setup, trace(use('Read', { file_path: `${SK}/actions/setup.md` }), use('Read', { file_path: `${SK}/actions/keyframes.md` })));
    assert.equal(stray.pass, false);
    assert.match(stray.reason!, /opened keyframes besides setup, which setup does not link to/);
    // the linked action first is the wrong first file even though setup links to it
    const reversed = m.scoreRouting(setup, trace(use('Read', { file_path: `${SK}/actions/doctor.md` }), use('Read', { file_path: `${SK}/actions/setup.md` })));
    assert.equal(reversed.pass, false);
    assert.match(reversed.reason!, /opened doctor first, expected setup/);
  });

  it('linkedActions reads markdown links, backticked paths and actions/ paths, and only names real actions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-actions-'));
    try {
      writeFileSync(join(dir, 'a.md'), 'See [doctor](doctor.md), `./b.md`, [x](../actions/c.md#top), ../lib/state.md and notes.md. Not a.md itself.');
      for (const n of ['b', 'c', 'doctor']) writeFileSync(join(dir, `${n}.md`), '');
      assert.deepEqual(m.linkedActions('a', dir).sort(), ['b', 'c', 'doctor']);
      assert.deepEqual(m.linkedActions('missing', dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('a row that errored is left out of the rates, and any error makes the verdict INCONCLUSIVE', () => {
    const ok = { pass: true };
    const bad = { pass: false };
    const err = { pass: false, error: 'boom' };
    assert.equal(m.rate([ok, bad, err, err]), 0.5, 'two scored rows, one passed');
    assert.equal(m.rate([err, err]), null, 'nothing scored');
    const v = m.verdict([ok, ok, ok, ok, err], [ok]);
    assert.equal(v.verdict, 'INCONCLUSIVE');
    assert.equal(v.trigger_rate, 1);
    // A clear FAIL stays a FAIL: even counting the errored row as a pass, triggering is at 50%.
    assert.equal(m.verdict([bad, err], [ok]).verdict, 'FAIL', 'a set that misses the line even if every error had passed');
    assert.equal(m.verdict([ok, bad, err, err, err], [ok]).verdict, 'INCONCLUSIVE', 'the errors could still lift it to 80%: 4 of 5');
    assert.equal(m.verdict([ok, ok, ok, ok, ok, bad, bad, err], [ok]).verdict, 'FAIL', '6 of 8 at best is 75%');
  });
});

describe('a failed model call is an error, not a FAIL', () => {
  // Exactly what an expired CLI sign-in printed in a live run: an init event, one assistant text, and a
  // result event that still says "success" with one turn and no cost.
  const expiredSignIn = [
    line({ type: 'system', subtype: 'init' }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] } }),
    line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }),
  ].join('\n');

  it('recognises the expired sign-in trace, and nothing a working model prints', () => {
    assert.match(m.modelCallError(expiredSignIn)!, /Failed to authenticate: OAuth session expired/);
    assert.equal(m.modelCallError(loadsSkill), null);
    assert.equal(m.modelCallError(loadsNothing), null, 'a model that simply did not trigger is a real FAIL');
    // a model that did work and then mentions authentication is not an error
    assert.equal(m.modelCallError(trace(use('Read', { file_path: 'x/actions/setup.md' }), line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Failed to authenticate' }] } }))), null);
    assert.equal(m.modelCallError(trace(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Auth for the keys is in setup: I will write the story now.' }] } }))), null);
    assert.match(m.modelCallError(trace(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 429 {"type":"rate_limit_error"}' }] } })))!, /429/);
    assert.match(m.modelCallError(`${line({ type: 'system', subtype: 'init' })}\n${line({ type: 'result', is_error: true, result: 'upstream said no' })}`)!, /upstream said no/);
    assert.match(m.modelCallError('Invalid API key - Please run /login')!, /Invalid API key/, 'plain text output works too');
  });

  it('counts such a prompt as an error: out of both rates, verdict INCONCLUSIVE, reason reported', async () => {
    const { triggers, stages } = m.loadEvals();
    const r = await m.runEvals({ triggers, stages, runModel: async () => expiredSignIn });
    assert.equal(r.errors, triggers.length + stages.length);
    assert.equal(r.trigger_rate, null);
    assert.equal(r.routing_rate, null);
    assert.deepEqual(r.trigger, { passed: 0, total: 0 });
    assert.equal(r.verdict, 'INCONCLUSIVE');
    assert.equal(r.error_reasons.length, 1);
    assert.match(r.error_reasons[0]!, /Failed to authenticate/);
    assert.ok(r.results.every((x) => x.error && x.pass === false));
  });

  const maxTurns = trace(
    use('Skill', { skill: 'akuko' }),
    use('Read', { file_path: `${SK}/actions/bible.md` }),
    line({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 8 }),
  );

  it('a non-zero exit is still scored when the trace is a real outcome (tools used, or stopped at max turns)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-evals-exit-'));
    try {
      const exits = (name: string, out: string) => {
        const script = join(dir, name);
        writeFileSync(script, `console.log(${JSON.stringify(out)}); process.exit(1);`);
        return m.commandRunner(`node "${script}"`);
      };
      assert.equal(m.isRealOutcome(maxTurns), true);
      assert.equal(m.isRealOutcome(loadsSkill), true);
      assert.equal(m.isRealOutcome(expiredSignIn), false);
      assert.equal(m.isRealOutcome(loadsNothing), false);
      assert.equal(m.isRealOutcome('plain text'), false);
      // max turns, exit 1, never opened the right action: scored as a FAIL, not dropped as an error
      const { triggers, stages } = m.loadEvals();
      const item = stages.find((x) => x.action === 'keyframes')!;
      const r = await m.runEvals({ triggers: [], stages: [item], runModel: exits('max.mjs', maxTurns) });
      assert.equal(r.errors, 0);
      assert.deepEqual(r.routing, { passed: 0, total: 1 });
      assert.equal(r.verdict, 'FAIL');
      assert.match(String((r.results[0] as { reason?: string }).reason), /opened bible first, expected keyframes/);
      // max turns after reaching the right action is a pass
      const ok = trace(use('Read', { file_path: `${SK}/actions/keyframes.md` }), line({ type: 'result', subtype: 'error_max_turns', is_error: true }));
      assert.equal((await m.runEvals({ triggers: [], stages: [item], runModel: exits('ok.mjs', ok) })).verdict, 'PASS');
      // a trigger prompt whose run exited 1 after loading the skill is scored too
      const t = triggers.find((x) => x.should_trigger)!;
      assert.equal((await m.runEvals({ triggers: [t], stages: [], runModel: exits('t.mjs', loadsSkill) })).trigger.passed, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-zero exit with no trace, no tool use, or a non-max-turns error result is an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-evals-exit-'));
    try {
      const script = join(dir, 'exits-1.mjs');
      writeFileSync(script, "console.log('boom, no json'); console.error('something broke'); process.exit(1);");
      const run = m.commandRunner(`node "${script}"`);
      await assert.rejects(run('any prompt'), /command exited 1: something broke/);
      const quiet = join(dir, 'quiet.mjs');
      writeFileSync(quiet, `console.log(${JSON.stringify(loadsNothing)}); process.exit(1);`);
      await assert.rejects(m.commandRunner(`node "${quiet}"`)('p'), /command exited 1/);
      const { triggers, stages } = m.loadEvals();
      const r = await m.runEvals({ triggers, stages, limit: 2, runModel: run });
      assert.equal(r.errors, 4);
      assert.equal(r.verdict, 'INCONCLUSIVE');
      assert.equal(r.trigger_rate, null);
      // an error result that is not max turns is an error even at exit 0
      assert.match(m.modelCallError(trace(line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'crashed' })))!, /crashed/);
      assert.equal(m.modelCallError(maxTurns), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an answer that mentions API keys or rate limits is not an error: only a short whole-output message is', () => {
    const say = (text: string) => trace(line({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));
    // the negative trigger queries are about stories, images and voices; a model may well talk about keys and limits
    const long = `Here is how to cope with rate limit exceeded errors from an image API: back off and retry. If you see an invalid API key message, check that the key is set in your environment, never in a file. ${'More detail follows. '.repeat(12)}`;
    assert.ok(long.length > 300);
    assert.equal(m.modelCallError(say(long)), null, 'a long answer in trace mode');
    assert.equal(m.modelCallError(long), null, 'a long answer in plain text');
    assert.equal(m.modelCallError(say('Midjourney has a rate limit exceeded policy; check your plan.'))?.startsWith('the model call failed'), true, 'a short whole-output message that matches is still an error');
    const { triggers } = m.loadEvals();
    for (const t of triggers.filter((x) => !x.should_trigger)) assert.equal(m.modelCallError(say(`Sure: ${t.query}`)), null, t.query);
  });

  it('the command line prints the reason, leaves the rates blank and exits 3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-evals-auth-'));
    try {
      const script = join(dir, 'expired.mjs');
      writeFileSync(script, `console.log(${JSON.stringify(expiredSignIn)}); process.exit(1);`);
      const logs: string[] = [];
      const code = await m.main(['--cmd', `node "${script}"`, '--limit', '1', '--out', join(dir, 'r.json')], { log: (s) => logs.push(s) });
      const text = logs.join('\n');
      assert.equal(code, 3);
      assert.match(text, /Errors: 2 prompt\(s\) never got a model answer \(command exited 1: the model call failed: Failed to authenticate/);
      assert.match(text, /left out of both rates/);
      assert.match(text, /Triggering:    0\/0 \(n\/a\)/);
      assert.match(text, /Verdict \(each at least 80%\): INCONCLUSIVE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('sends one call per prompt (24 triggering + 17 routing) and passes a perfect model', async () => {
    const sent: string[] = [];
    const r = await m.runEvals({ triggers, stages, runModel: async (p: string) => { sent.push(p); return perfect(p); } });
    assert.equal(sent.length, 41);
    assert.equal(r.prompts_sent, 41);
    assert.deepEqual(r.trigger, { passed: 24, total: 24 });
    assert.deepEqual(r.routing, { passed: 17, total: 17 });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.errors, 0);
  });

  it('fails a model that never loads the skill, and a model that always opens the wrong action', async () => {
    const never = await m.runEvals({ triggers, stages, runModel: async () => loadsNothing });
    assert.equal(never.trigger.passed, 12, 'it gets the 12 negatives right and the 12 positives wrong');
    assert.equal(never.routing.passed, 0);
    assert.equal(never.verdict, 'FAIL');

    const wrong = await m.runEvals({ triggers, stages, runModel: async (p: string) => (stages.some((s) => s.prompt === p) ? trace(use('Read', { file_path: `${SK}/actions/${stages.find((x) => x.prompt === p)!.action === 'export' ? 'bible' : 'export'}.md` })) : perfect(p)) });
    assert.equal(wrong.routing.passed, 0);
    assert.equal(wrong.verdict, 'FAIL');
  });

  it('exactly at the line: 80% of each passes, one fewer fails', async () => {
    const miss = (set: Set<string>) => async (p: string): Promise<string> => (set.has(p) ? loadsNothing : perfect(p));
    // 24 triggers: 80% is 19.2, so 20 must pass (4 wrong); 17 routing: 80% is 13.6, so 14 must pass (3 wrong).
    const wrongTriggers = new Set(triggers.filter((t) => t.should_trigger).slice(0, 4).map((t) => t.query));
    const wrongStages = new Set(stages.slice(0, 3).map((s) => s.prompt));
    const ok = await m.runEvals({ triggers, stages, runModel: miss(new Set([...wrongTriggers, ...wrongStages])) });
    assert.deepEqual([ok.trigger.passed, ok.routing.passed, ok.verdict], [20, 14, 'PASS']);
    const more = new Set([...wrongTriggers, ...wrongStages, stages[3]!.prompt]);
    assert.equal((await m.runEvals({ triggers, stages, runModel: miss(more) })).verdict, 'FAIL');
  });

  it('counts a prompt whose command failed as an error, not a failure, and the verdict is INCONCLUSIVE', async () => {
    const r = await m.runEvals({ triggers, stages, runModel: async (p: string) => { if (p === stages[0]!.prompt) throw new Error('boom'); return perfect(p); } });
    assert.equal(r.errors, 1);
    assert.deepEqual(r.error_reasons, ['boom']);
    assert.equal(r.results.find((x) => x.error)?.pass, false);
    assert.deepEqual(r.routing, { passed: 16, total: 16 }, 'the errored prompt is out of the count');
    assert.equal(r.routing_rate, 1);
    assert.equal(r.verdict, 'INCONCLUSIVE');
  });

  it('--only and --limit narrow what is sent', async () => {
    const sent: string[] = [];
    const run = (o: Record<string, unknown>) => m.runEvals({ triggers, stages, runModel: async (p: string) => { sent.push(p); return perfect(p); }, ...o });
    await run({ only: 'trigger', limit: 3 });
    assert.equal(sent.length, 3);
    sent.length = 0;
    const r = await run({ only: 'routing' });
    assert.equal(sent.length, 17);
    assert.equal(r.trigger.total, 0);
    assert.equal(r.verdict, 'PASS');
  });
});

describe('the command line', () => {
  it('--dry-run lists the prompts and sends nothing (no command needed)', async () => {
    const out: string[] = [];
    const code = await m.main(['--dry-run'], { log: (s) => out.push(s) });
    assert.equal(code, 0);
    assert.match(out[0]!, /24 triggering prompts \+ 17 stage-routing prompts = 41 calls/);
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
