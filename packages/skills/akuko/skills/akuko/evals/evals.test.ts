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
});
