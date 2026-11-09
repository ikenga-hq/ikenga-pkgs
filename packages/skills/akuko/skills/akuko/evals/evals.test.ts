import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ACTIONS_DIR = join(HERE, '../actions');

interface TriggerEval {
  query: string;
  should_trigger: boolean;
}

interface StageEval {
  id: number;
  name: string;
  action?: string;
  prompt: string;
  expected_output: string;
  assertions: string[];
}

interface EvalsDocument {
  skill_name: string;
  evals: StageEval[];
}

describe('evals draft (prep for WP-09)', () => {
  it('parses trigger-evals.json, validates format and balance', () => {
    const raw = readFileSync(join(HERE, 'trigger-evals.json'), 'utf8');
    const triggers = JSON.parse(raw) as TriggerEval[];

    assert.ok(Array.isArray(triggers), 'trigger-evals must be a JSON array');
    assert.ok(triggers.length >= 20, `expected around 24 trigger evals, got ${triggers.length}`);

    let positive = 0;
    let negative = 0;
    for (const t of triggers) {
      assert.equal(typeof t.query, 'string', 'each entry must have a query string');
      assert.ok(t.query.trim().length > 0, 'query must not be empty');
      assert.equal(typeof t.should_trigger, 'boolean', 'each entry must have a boolean should_trigger');
      if (t.should_trigger) positive++;
      else negative++;
    }

    assert.equal(positive, negative, `expected balanced trigger set, got ${positive} true vs ${negative} false`);
  });

  it('parses evals.json, validates unique names and actions exist as actions/<name>.md', () => {
    const raw = readFileSync(join(HERE, 'evals.json'), 'utf8');
    const doc = JSON.parse(raw) as EvalsDocument;

    assert.equal(doc.skill_name, 'akuko');
    assert.ok(Array.isArray(doc.evals), 'evals must be an array');
    assert.ok(doc.evals.length >= 12, `expected at least 12 stage-routing evals, got ${doc.evals.length}`);

    const names = new Set<string>();
    const ids = new Set<number>();

    for (const e of doc.evals) {
      assert.equal(typeof e.id, 'number', 'each eval must have an id number');
      assert.ok(!ids.has(e.id), `duplicate eval id ${e.id}`);
      ids.add(e.id);

      assert.equal(typeof e.name, 'string', 'each eval must have a name string');
      assert.ok(!names.has(e.name), `duplicate eval name "${e.name}"`);
      names.add(e.name);

      assert.ok(e.prompt && e.prompt.trim().length > 0, `eval "${e.name}" must have a prompt`);
      assert.ok(e.expected_output && e.expected_output.trim().length > 0, `eval "${e.name}" must have expected_output`);
      assert.ok(Array.isArray(e.assertions) && e.assertions.length > 0, `eval "${e.name}" must have assertions`);

      // Verify that every action an eval expects exists as actions/<name>.md
      if (e.action) {
        const actionPath = join(ACTIONS_DIR, `${e.action}.md`);
        assert.ok(
          existsSync(actionPath),
          `eval "${e.name}" expects action "${e.action}", but ${actionPath} does not exist`,
        );
      }
    }
  });

  const SKILL = readFileSync(join(HERE, '../SKILL.md'), 'utf8');
  const STOP = new Set(['this', 'that', 'from', 'make', 'them']);

  /** Parse the SKILL.md routing table into action -> trigger-phrase tokens. */
  function routing(): Map<string, Set<string>> {
    const rows = new Map<string, Set<string>>();
    for (const line of SKILL.split('\n')) {
      const m = /^\|\s*(.+?)\s*\|\s*\[`actions\/([a-z-]+)\.md`\]/.exec(line);
      if (!m) continue;
      const tokens = new Set<string>([m[2]!]);
      for (const q of m[1]!.matchAll(/"([^"]+)"/g)) {
        for (const w of q[1]!.toLowerCase().split(/[^a-z]+/)) if (w.length >= 4 && !STOP.has(w)) tokens.add(w);
      }
      rows.set(m[2]!, tokens);
    }
    return rows;
  }

  it('routes every eval to an action in the SKILL.md routing table, with a prompt that fits that row', () => {
    const table = routing();
    assert.ok(table.size >= 12, `routing table parsed to ${table.size} rows`);
    const doc = JSON.parse(readFileSync(join(HERE, 'evals.json'), 'utf8')) as EvalsDocument;
    for (const e of doc.evals) {
      assert.ok(e.action, `eval ${e.id} must name an action`);
      const tokens = table.get(e.action!);
      assert.ok(tokens, `eval ${e.id} action "${e.action}" is not a routed action in SKILL.md`);
      const prompt = e.prompt.toLowerCase();
      assert.ok(
        [...tokens].some((t) => prompt.includes(t)),
        `eval ${e.id} prompt does not match the "${e.action}" routing row (${[...tokens].join(', ')})`,
      );
    }
  });

  it('has a routing eval for every built stage action, and a stub eval only for assemble', () => {
    const doc = JSON.parse(readFileSync(join(HERE, 'evals.json'), 'utf8')) as EvalsDocument;
    const byName = (n: string) => doc.evals.find((e) => e.name === n);
    for (const [name, action, needle] of [
      ['stage-routing-motion', 'motion', /spend line/i],
      ['stage-routing-sound', 'sound', /--voice/],
      ['stage-routing-export', 'export', /approved material only/i],
    ] as const) {
      const e = byName(name);
      assert.ok(e, `${name} exists`);
      assert.equal(e!.action, action);
      assert.ok(!/stub/i.test(e!.expected_output), `${action} is built, not a stub`);
      assert.ok(e!.assertions.some((a) => needle.test(a)), `${name} asserts ${needle}`);
    }
    assert.ok(byName('stage-routing-motion')!.assertions.some((a) => /attempt/i.test(a)) && byName('stage-routing-motion')!.assertions.some((a) => /--fit/.test(a)));
    assert.ok(byName('stage-routing-sound')!.assertions.some((a) => /never invents narration/i.test(a)));
    assert.ok(byName('stage-routing-export')!.assertions.some((a) => /FCPXML/.test(a)) && byName('stage-routing-export')!.assertions.some((a) => /no unit or stage status/i.test(a)));
    assert.ok(!byName('stub-action-motion-refusal'), 'the motion stub eval is gone');
    const stubs = doc.evals.filter((e) => /^Stub ask/.test(e.expected_output));
    assert.deepEqual(stubs.map((e) => e.action), ['assemble']);
    assert.ok(/Stub \(WP-02\)/.test(readFileSync(join(ACTIONS_DIR, 'assemble.md'), 'utf8')), 'assemble is still a stub');
  });

  it('states the built behaviour of the keyframes and bible evals', () => {
    const doc = JSON.parse(readFileSync(join(HERE, 'evals.json'), 'utf8')) as EvalsDocument;
    const spend = doc.evals.find((e) => e.name === 'spend-gate-no-budget-refusal')!;
    assert.equal(spend.action, 'bible');
    assert.ok(spend.assertions.some((a) => a.includes('actions/bible.md')));
    const gating = doc.evals.find((e) => e.name === 'gating-keyframes-before-bible-approved')!;
    assert.ok(gating.assertions.some((a) => /bible/i.test(a) && /waiting|locked/i.test(a)));
    assert.ok(!doc.evals.some((e) => e.action === 'keyframes' && /stub/i.test(e.expected_output)), 'keyframes is built, not a stub');
  });

  it('trigger evals: exactly 24, unique, 12/12, with film-vocabulary near-misses', () => {
    const triggers = JSON.parse(readFileSync(join(HERE, 'trigger-evals.json'), 'utf8')) as TriggerEval[];
    assert.equal(triggers.length, 24);
    assert.equal(new Set(triggers.map((t) => t.query.trim().toLowerCase())).size, 24, 'queries must be unique');
    assert.equal(triggers.filter((t) => t.should_trigger).length, 12);
    assert.equal(triggers.filter((t) => !t.should_trigger).length, 12);
    const film = /\b(film|movie|video|mp4|scene|screenplay|script|storyboard|shot|frame|cinema)\b/i;
    const nearMisses = triggers.filter((t) => !t.should_trigger && film.test(t.query));
    assert.ok(nearMisses.length >= 4, `expected at least 4 film-vocabulary negatives, got ${nearMisses.length}`);
  });
});
