// Every action stub's frontmatter validates against the Atelier
// `ActionFrontmatter` (vendored in ./_frontmatter.ts); SKILL.md routes every
// action; the film profile names the schema's stages.
//
// YAML is parsed by the small block-YAML reader below (no dependency): maps,
// lists (of scalars or maps), `|` block scalars, quoted and plain scalars,
// `[]` / `{}` / simple flow lists, comments. That covers Atelier frontmatter.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STAGES } from '../schema/akuko-project.ts';
import { ActionFrontmatter } from './_frontmatter.ts';

export type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

interface Line { indent: number; text: string; raw: string }

/** Parse the block-YAML subset used by action frontmatter. Throws on anything else. */
export function parseYaml(src: string): { [k: string]: Yaml } {
  const lines: Line[] = src.split(/\r?\n/).map((raw) => {
    const indent = raw.length - raw.trimStart().length;
    return { indent, text: raw.trim(), raw };
  });
  let i = 0;

  const skip = () => {
    while (i < lines.length && (lines[i]!.text === '' || lines[i]!.text.startsWith('#'))) i++;
  };
  const isSeq = (l: Line) => l.text === '-' || l.text.startsWith('- ');

  function block(indent: number): Yaml {
    skip();
    const l = lines[i];
    if (!l || l.indent < indent) return null;
    return isSeq(l) ? seq(l.indent) : map(l.indent);
  }

  function map(indent: number): { [k: string]: Yaml } {
    const out: { [k: string]: Yaml } = {};
    for (skip(); i < lines.length; skip()) {
      const l = lines[i]!;
      if (l.indent < indent || isSeq(l)) break;
      if (l.indent > indent) throw new Error(`yaml: unexpected indent at "${l.raw}"`);
      const m = /^([^:#]+?):(?:\s+(.*))?$/.exec(l.text);
      if (!m) throw new Error(`yaml: expected "key: value" at "${l.raw}"`);
      const key = m[1]!.trim();
      const rest = stripComment(m[2] ?? '');
      i++;
      if (key in out) throw new Error(`yaml: duplicate key "${key}"`);
      if (rest === '|' || rest === '|-') out[key] = blockScalar(indent, rest === '|-');
      else if (rest !== '') out[key] = scalar(rest);
      else {
        skip();
        const next = lines[i];
        // a list may sit at the same indent as its key
        if (next && (next.indent > indent || (next.indent === indent && isSeq(next)))) out[key] = block(next.indent);
        else out[key] = null;
      }
    }
    return out;
  }

  function seq(indent: number): Yaml[] {
    const out: Yaml[] = [];
    for (skip(); i < lines.length; skip()) {
      const l = lines[i]!;
      if (l.indent !== indent || !isSeq(l)) {
        if (l.indent > indent) throw new Error(`yaml: unexpected indent at "${l.raw}"`);
        break;
      }
      const rest = l.text === '-' ? '' : l.text.slice(2);
      if (rest.trim() === '') {
        i++;
        out.push(block(indent + 1));
      } else if (/^[^:#'"[{]+?:(\s|$)/.test(rest)) {
        // "- key: value" opens a map whose keys sit where `key` starts
        const col = indent + 2 + (rest.length - rest.trimStart().length);
        lines[i] = { indent: col, text: rest.trim(), raw: l.raw };
        out.push(map(col));
      } else {
        i++;
        out.push(scalar(stripComment(rest)));
      }
    }
    return out;
  }

  function blockScalar(parentIndent: number, strip: boolean): string {
    const body: string[] = [];
    let base = -1;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.text !== '' && l.indent <= parentIndent) break;
      if (l.text !== '' && base < 0) base = l.indent;
      body.push(l.text === '' ? '' : l.raw.slice(base));
      i++;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const text = body.join('\n');
    return strip || text === '' ? text : `${text}\n`;
  }

  const out = map(0);
  skip();
  if (i < lines.length) throw new Error(`yaml: could not parse "${lines[i]!.raw}"`);
  return out;
}

function stripComment(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') || t.startsWith("'")) return t;
  return t.replace(/\s+#.*$/, '').trim();
}

function scalar(s: string): Yaml {
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s.startsWith('"')) return JSON.parse(s) as string;
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new Error(`yaml: unterminated string ${s}`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map(scalar);
  }
  if (s.startsWith('{') || s.startsWith('[')) throw new Error(`yaml: unsupported flow value ${s}`);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Split a markdown file into its YAML frontmatter and body. */
export function splitFrontmatter(md: string): { frontmatter: string; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  return m ? { frontmatter: m[1]!, body: m[2]! } : undefined;
}

// ─────────────────────────────────────────────────────────────────────────

const ACTIONS_DIR = fileURLToPath(new URL('.', import.meta.url));
const SKILL_MD = fileURLToPath(new URL('../SKILL.md', import.meta.url));
const PROFILE = fileURLToPath(new URL('../profiles/film/profile.json', import.meta.url));

/** The actions WP-02 must route (09 §WP-02 FILES). */
const EXPECTED = [
  'setup', 'doctor', 'intake', 'breakdown', 'bible', 'board', 'keyframes',
  'motion', 'sound', 'assemble', 'export', 'review', 'view', 'status',
].sort();

const stubs = readdirSync(ACTIONS_DIR).filter((f) => f.endsWith('.md')).sort();

describe('yaml reader', () => {
  it('reads the Atelier worked example A (triage-inbox)', () => {
    const y = parseYaml([
      'name: triage-inbox',
      'ux_mode: approve            # run-then-pause',
      'inputs_schema:',
      '  type: object',
      '  properties:',
      '    max_messages:',
      '      type: integer',
      '      minimum: 1',
      '  required: []',
      '  additionalProperties: false',
      'run:',
      '  kind: chat_prompt',
      '  prompt: |',
      '    Triage up to {{max_messages}} messages.',
      '',
      '    Then stop.',
      'triggers:',
      '  - kind: manual            # on demand',
      '  - kind: schedule',
      '    cron: "0 8 * * 1-5"',
      '    label: Weekday morning triage',
      'depends_on:',
      '- skill-core',
      "tags: [a, 'b c']",
    ].join('\n'));
    assert.deepEqual(y, {
      name: 'triage-inbox',
      ux_mode: 'approve',
      inputs_schema: { type: 'object', properties: { max_messages: { type: 'integer', minimum: 1 } }, required: [], additionalProperties: false },
      run: { kind: 'chat_prompt', prompt: 'Triage up to {{max_messages}} messages.\n\nThen stop.\n' },
      triggers: [{ kind: 'manual' }, { kind: 'schedule', cron: '0 8 * * 1-5', label: 'Weekday morning triage' }],
      depends_on: ['skill-core'],
      tags: ['a', 'b c'],
    });
  });

  it('rejects what it does not understand', () => {
    assert.throws(() => parseYaml('a: 1\n   b: 2'));
    assert.throws(() => parseYaml('a: 1\na: 2'));
    assert.throws(() => parseYaml('just text'));
  });
});

describe('action stubs', () => {
  it('exactly the routed set of actions exists', () => {
    assert.deepEqual(stubs.map((f) => f.replace(/\.md$/, '')), EXPECTED);
  });

  for (const file of stubs) {
    it(`${file} frontmatter validates against ActionFrontmatter`, () => {
      const md = readFileSync(`${ACTIONS_DIR}/${file}`, 'utf8');
      const parts = splitFrontmatter(md);
      assert.ok(parts, `${file} has no frontmatter`);
      const result = ActionFrontmatter.safeParse(parseYaml(parts.frontmatter));
      assert.ok(result.success, `${file}: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
      assert.equal(result.data.name, file.replace(/\.md$/, ''), 'name matches the file name');
      assert.match(parts.body, new RegExp(`^# action: \`${result.data.name}\``, 'm'));
      assert.match(parts.body, /Stub \(WP-02\)/, 'stub says it is a stub and who fills it');
    });
  }

  it('the validator is real: a setup block on a non-setup action is refused', () => {
    const md = readFileSync(`${ACTIONS_DIR}/setup.md`, 'utf8');
    const fm = parseYaml(splitFrontmatter(md)!.frontmatter) as Record<string, unknown>;
    assert.equal(ActionFrontmatter.safeParse({ ...fm, name: 'doctor' }).success, false);
    const { setup: _drop, ...noSetup } = fm;
    assert.equal(ActionFrontmatter.safeParse(noSetup).success, false);
  });
});

describe('SKILL.md router', () => {
  const skill = readFileSync(SKILL_MD, 'utf8');

  it('routes every action', () => {
    for (const name of EXPECTED) assert.ok(skill.includes(`(actions/${name}.md)`), `SKILL.md does not route ${name}`);
  });

  it('stays under 200 lines', () => {
    assert.ok(skill.split('\n').length < 200);
  });

  it('states the review and spend rules', () => {
    assert.match(skill, /## Review rules/);
    assert.match(skill, /## Spend rules/);
  });
});

describe('film profile', () => {
  it('lists the schema stages in order', () => {
    const p = JSON.parse(readFileSync(PROFILE, 'utf8')) as { name: string; stages: { id: string }[] };
    assert.equal(p.name, 'film');
    assert.deepEqual(p.stages.map((s) => s.id), STAGES.map((s) => s.id));
  });
});
