#!/usr/bin/env node
// akuko — eval runner (Phase 1 verification item 6).
//
//   node evals/run-evals.mjs --cmd '<command template>' [options]
//
// Sends every prompt in evals/trigger-evals.json and evals/evals.json to a model
// through YOUR command, then scores two things from what the model did:
//   - triggering: did it load the akuko skill when it should (and not when it should not)?
//   - stage routing: did it open the action file the eval expects (actions/<name>.md)?
// It prints both pass rates and a verdict (PASS when each is at least the threshold,
// 80% by default) and writes every result to a JSON file.
//
// A prompt whose model call itself failed (the command exited non-zero, or the model
// only printed an auth / API / rate-limit error such as an expired sign-in) is an
// ERROR, not a FAIL. Errors are left out of both rates, and any error makes the
// verdict INCONCLUSIVE: the skill was not tested on that prompt.
//
// THIS SCRIPT CALLS A MODEL THROUGH THE COMMAND YOU GIVE IT. It never runs on its
// own, no test runs it, and it uses whatever account your command uses. Use
// --dry-run to see what would be sent without sending anything.
//
// The command template
//   The prompt goes to the command's standard input. If the template contains
//   {prompt_file}, the prompt is written to a temporary file and that path is
//   substituted instead (double-quote it yourself if your shell needs it).
//   The command must print what the model did on standard output. Triggering and
//   routing are read from tool calls, so ask for a trace, for example with Claude Code:
//
//     --cmd "claude -p --output-format stream-json --verbose --max-turns 8 --tools \"Skill,Read,Glob,Grep\" --allowedTools \"Skill\" \"Read\" \"Glob\" \"Grep\""
//
//   run from a folder where the akuko skill is installed (for example a project with
//   .claude/skills/akuko, or a plugin that ships it). Both tool flags are needed:
//   --tools restricts which tools exist in the session (so Bash, Write and Edit are not
//   available at all), while --allowedTools only auto-approves permission prompts for the
//   tools listed and does not restrict anything on its own. Together the run is read-only:
//   nothing is written, executed or generated. If your claude version rejects Skill in
//   --tools, drop --tools and add --disallowedTools "Bash" "Write" "Edit" instead. Do not
//   add --bare: it skips skill discovery. Run --dry-run and then --limit 2 first.
//   With plain text output only (no trace) the script falls back to looking for
//   "Skill(akuko" and "actions/<name>.md" in the text, and says so in the result.
//
// Options
//   --cmd <template>       required unless --dry-run
//   --only trigger|routing run just one set
//   --limit <n>            only the first n of each set (smoke test)
//   --concurrency <n>      prompts in flight at once (default 2)
//   --timeout-s <n>        per prompt (default 240)
//   --threshold <0..1>     pass mark for each rate (default 0.8)
//   --out <file>           results file (default ./akuko-evals-<timestamp>.json)
//   --dry-run              print the plan and exit; sends nothing
//
// Exit code: 0 PASS, 1 FAIL, 2 usage error, 3 INCONCLUSIVE (some prompts errored).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ACTIONS_DIR = join(HERE, '..', 'actions');

export const DEFAULT_THRESHOLD = 0.8;
export const SKILL_NAME = 'akuko';

// ─────────────────────────────────────────────────────────────────────────
// Reading what the model did
// ─────────────────────────────────────────────────────────────────────────

/** Every JSON object found in the output: one per line (stream-json) or the whole text as one document. */
function jsonObjects(output) {
  const out = [];
  for (const line of String(output).split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) continue;
    try { out.push(JSON.parse(s)); } catch { /* not a JSON line */ }
  }
  if (out.length === 0) {
    try { out.push(JSON.parse(String(output))); } catch { /* plain text */ }
  }
  return out;
}

/** Tool calls in order, wherever they sit in the objects: [{name, input}]. */
export function toolCalls(output) {
  const calls = [];
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    if (v.type === 'tool_use' && typeof v.name === 'string') calls.push({ name: v.name, input: v.input ?? {} });
    for (const k of Object.keys(v)) walk(v[k]);
  };
  for (const o of jsonObjects(output)) walk(o);
  return calls;
}

/** Is this a structured trace (stream-json events or a JSON document of messages), even one with no tool calls? */
function isTrace(output) {
  return jsonObjects(output).some((o) => o && typeof o === 'object' && ('type' in o || 'messages' in o));
}

/**
 * What a failed model call looks like in the model's own words. One list, kept narrow:
 * every entry is a message a CLI or API prints when the call did not happen, not a
 * phrase a model might use while doing the task.
 */
export const MODEL_ERROR_PATTERNS = [
  /failed to authenticate/i,
  /oauth (?:session|token)[^.\n]{0,40}expired/i,
  /invalid api key/i,
  /please run \/login/i,
  /authentication_error/i,
  /rate[_ ]limit(?:_error| exceeded| reached)/i,
  /usage limit reached/i,
  /credit balance is too low/i,
  /overloaded_error/i,
  /api error: ?(?:4\d\d|5\d\d)\b/i,
];

/** Text the assistant printed, in order (stream-json assistant messages). */
function assistantText(output) {
  const texts = [];
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    if (v.type === 'text' && typeof v.text === 'string') texts.push(v.text);
    for (const k of Object.keys(v)) walk(v[k]);
  };
  for (const o of jsonObjects(output)) if (o && typeof o === 'object' && o.type === 'assistant') walk(o);
  return texts.join('\n').trim();
}

/**
 * Why this output is a failed model call rather than a model's answer, or null.
 * Only when the model used no tool at all and its only words match MODEL_ERROR_PATTERNS
 * (or a `result` event says is_error); a model that did work is never an error here.
 */
export function modelCallError(output) {
  if (toolCalls(output).length > 0) return null;
  const text = isTrace(output) ? assistantText(output) : String(output).trim().length <= 400 ? String(output).trim() : '';
  if (MODEL_ERROR_PATTERNS.some((p) => p.test(text))) return `the model call failed: ${text.replace(/\s+/g, ' ').slice(0, 160)}`;
  const flagged = jsonObjects(output).find((o) => o && typeof o === 'object' && o.type === 'result' && o.is_error === true);
  if (flagged) return `the model call failed: ${String(flagged.result ?? flagged.subtype ?? 'error result').replace(/\s+/g, ' ').slice(0, 160)}`;
  return null;
}

const ACTION_PATH = /(?:^|[\\/])actions[\\/]([a-z][a-z-]*)\.md\b/i;
const SKILL_PATH = /(?:^|[\\/])skills[\\/]akuko[\\/]SKILL\.md\b/i;

/** Did the model load the skill? How we know: 'trace' (a tool call) or 'text' (a mention in plain output). */
export function detectTrigger(output, skill = SKILL_NAME) {
  const calls = toolCalls(output);
  if (calls.length > 0 || isTrace(output)) {
    for (const c of calls) {
      if (c.name === 'Skill') {
        const named = String(c.input.skill ?? c.input.name ?? '');
        if (named === skill || named.endsWith(`:${skill}`)) return { triggered: true, method: 'trace' };
      }
      const target = String(c.input.file_path ?? c.input.path ?? c.input.command ?? c.input.pattern ?? '');
      if (SKILL_PATH.test(target) || ACTION_PATH.test(target)) {
        if (/akuko/i.test(target)) return { triggered: true, method: 'trace' };
      }
    }
    return { triggered: false, method: 'trace' };
  }
  const text = String(output);
  const hit = new RegExp(`Skill\\(\\s*${skill}\\b|"skill"\\s*:\\s*"${skill}"|skills[\\\\/]${skill}[\\\\/]SKILL\\.md|${skill}[\\\\/]actions[\\\\/][a-z-]+\\.md`, 'i').test(text);
  return { triggered: hit, method: 'text' };
}

/** The first action file the model opened (`actions/<name>.md`), or null. */
export function detectAction(output) {
  const calls = toolCalls(output);
  const seen = [];
  const add = (n) => { if (!seen.includes(n)) seen.push(n); };
  for (const c of calls) {
    const target = String(c.input.file_path ?? c.input.path ?? c.input.command ?? c.input.pattern ?? '');
    const m = ACTION_PATH.exec(target);
    // Only this skill's actions count (another skill may also keep files under actions/).
    if (m && /akuko/i.test(target)) add(m[1].toLowerCase());
  }
  const trace = calls.length > 0 || isTrace(output);
  if (!trace) for (const m of String(output).matchAll(/actions[\\/]([a-z][a-z-]*)\.md/gi)) add(m[1].toLowerCase());
  // `action` is the first one opened; `actions` is every distinct one, in order.
  return { action: seen[0] ?? null, actions: seen, method: trace ? 'trace' : 'text' };
}

// ─────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────

export function scoreTrigger(item, output) {
  const d = detectTrigger(output);
  return {
    kind: 'trigger',
    query: item.query,
    expected: item.should_trigger,
    triggered: d.triggered,
    method: d.method,
    pass: d.triggered === item.should_trigger,
  };
}

/**
 * The other actions an action file points at: any `<name>.md` reference (a markdown link, a
 * backticked `./doctor.md`, or `../actions/doctor.md`) whose name is an action file that exists.
 */
export function linkedActions(action, actionsDir = ACTIONS_DIR) {
  const file = join(actionsDir, `${action}.md`);
  if (!existsSync(file)) return [];
  const known = new Set(readdirSync(actionsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
  const linked = new Set();
  for (const m of readFileSync(file, 'utf8').matchAll(/(?:^|[\s(`/])(?:\.{1,2}\/)?(?:actions\/)?([a-z][a-z-]*)\.md\b/g)) {
    if (known.has(m[1]) && m[1] !== action) linked.add(m[1]);
  }
  return [...linked];
}

export function scoreRouting(item, output, { actionsDir = ACTIONS_DIR } = {}) {
  const d = detectAction(output);
  // Passes when the FIRST akuko action file opened is the expected one and every other one opened is
  // one the expected action itself points at (setup points at doctor, so reading both is following it).
  // A model that opens an unrelated action next to the right one is hedging, not routing.
  const allowed = linkedActions(item.action, actionsDir);
  const strays = d.actions.slice(1).filter((a) => a !== item.action && !allowed.includes(a));
  const pass = d.actions[0] === item.action && strays.length === 0;
  let reason;
  if (d.actions.length === 0) reason = 'opened no akuko action file';
  else if (d.actions[0] !== item.action) reason = `opened ${d.actions[0]} first, expected ${item.action}`;
  else if (strays.length > 0) reason = `opened ${strays.join(', ')} besides ${item.action}, which ${item.action} does not link to`;
  return {
    kind: 'routing',
    id: item.id,
    name: item.name,
    expected_action: item.action,
    routed_action: d.action,
    actions_read: d.actions,
    method: d.method,
    pass,
    ...(reason ? { reason } : {}),
    // The assertions are for a person (or a grader model) to check; this script scores routing only.
    assertions: item.assertions,
  };
}

/** Pass rate over the rows that were actually scored: a row that errored never got a model answer and is left out. */
export const rate = (rows) => {
  const scored = rows.filter((r) => !r.error);
  return scored.length === 0 ? null : scored.filter((r) => r.pass).length / scored.length;
};

/**
 * PASS when every rate that was run is at least the threshold; FAIL otherwise.
 * INCONCLUSIVE when any prompt errored: the skill was not tested on it.
 */
export function verdict(triggerRows, routingRows, threshold = DEFAULT_THRESHOLD) {
  const t = rate(triggerRows);
  const r = rate(routingRows);
  const ran = [t, r].filter((x) => x !== null);
  const errored = [...triggerRows, ...routingRows].some((x) => x.error);
  const pass = ran.length > 0 && ran.every((x) => x >= threshold);
  return { trigger_rate: t, routing_rate: r, threshold, verdict: errored ? 'INCONCLUSIVE' : pass ? 'PASS' : 'FAIL' };
}

// ─────────────────────────────────────────────────────────────────────────
// Running
// ─────────────────────────────────────────────────────────────────────────

export function loadEvals(dir = HERE) {
  return {
    triggers: JSON.parse(readFileSync(join(dir, 'trigger-evals.json'), 'utf8')),
    stages: JSON.parse(readFileSync(join(dir, 'evals.json'), 'utf8')).evals,
  };
}

/**
 * Run the evals through `runModel(prompt) => Promise<string>` and score them.
 * `runModel` is the only thing that touches a model; the tests give it canned outputs.
 */
export async function runEvals({ triggers, stages, runModel, only, limit, concurrency = 2, threshold = DEFAULT_THRESHOLD, onProgress, actionsDir = ACTIONS_DIR }) {
  const jobs = [];
  if (only !== 'routing') for (const t of limit ? triggers.slice(0, limit) : triggers) jobs.push({ kind: 'trigger', item: t, prompt: t.query });
  if (only !== 'trigger') for (const s of limit ? stages.slice(0, limit) : stages) jobs.push({ kind: 'routing', item: s, prompt: s.prompt });

  const results = new Array(jobs.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      let row;
      try {
        const output = await runModel(job.prompt);
        const failed = modelCallError(output);
        if (failed) throw new Error(failed);
        row = job.kind === 'trigger' ? scoreTrigger(job.item, output) : scoreRouting(job.item, output, { actionsDir });
      } catch (e) {
        const base = job.kind === 'trigger'
          ? { kind: 'trigger', query: job.item.query, expected: job.item.should_trigger }
          : { kind: 'routing', id: job.item.id, name: job.item.name, expected_action: job.item.action };
        row = { ...base, pass: false, error: e instanceof Error ? e.message : String(e) };
      }
      results[i] = row;
      done++;
      onProgress?.(done, jobs.length, row);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const trig = results.filter((r) => r.kind === 'trigger');
  const rout = results.filter((r) => r.kind === 'routing');
  const errored = results.filter((r) => r.error);
  const scored = (rows) => rows.filter((r) => !r.error);
  return {
    skill: SKILL_NAME,
    prompts_sent: jobs.length,
    ...verdict(trig, rout, threshold),
    errors: errored.length,
    error_reasons: [...new Set(errored.map((r) => r.error))],
    // `total` counts only the prompts that were scored; errored ones are listed under `errors`.
    trigger: { passed: trig.filter((r) => r.pass).length, total: scored(trig).length },
    routing: { passed: rout.filter((r) => r.pass).length, total: scored(rout).length },
    results,
  };
}

/** Run the user's command with the prompt on stdin (or in {prompt_file}); resolve with its standard output. */
export function commandRunner(template, { timeoutS = 240, cwd = process.cwd() } = {}) {
  return (prompt) => new Promise((resolveRun, reject) => {
    let cmd = template;
    let dir;
    if (template.includes('{prompt_file}')) {
      dir = mkdtempSync(join(tmpdir(), 'akuko-eval-'));
      const file = join(dir, 'prompt.txt');
      writeFileSync(file, prompt);
      cmd = template.split('{prompt_file}').join(file);
    }
    const child = spawn(cmd, { shell: true, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out after ${timeoutS}s`)); }, timeoutS * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (dir) rmSync(dir, { recursive: true, force: true });
      // A non-zero exit means the call itself failed, whatever it printed: that is an error, not an answer.
      if (code !== 0) reject(new Error(`command exited ${code}: ${(modelCallError(out) ?? (err.trim() || 'no error output')).slice(0, 300)}`));
      else resolveRun(out);
    });
    if (!template.includes('{prompt_file}')) child.stdin.end(prompt);
    else child.stdin.end();
  });
}

function parseArgs(argv) {
  const o = { cmd: undefined, only: undefined, limit: undefined, concurrency: 2, timeoutS: 240, threshold: DEFAULT_THRESHOLD, out: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--cmd') o.cmd = val();
    else if (a === '--only') o.only = val();
    else if (a === '--limit') o.limit = Number(val());
    else if (a === '--concurrency') o.concurrency = Number(val());
    else if (a === '--timeout-s') o.timeoutS = Number(val());
    else if (a === '--threshold') o.threshold = Number(val());
    else if (a === '--out') o.out = val();
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (o.only !== undefined && o.only !== 'trigger' && o.only !== 'routing') throw new Error('--only must be trigger or routing');
  for (const k of ['concurrency', 'timeoutS', 'threshold']) if (!Number.isFinite(o[k]) || o[k] <= 0) throw new Error(`--${k === 'timeoutS' ? 'timeout-s' : k} must be a positive number`);
  if (o.limit !== undefined && !(o.limit >= 1)) throw new Error('--limit must be at least 1');
  return o;
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);

export async function main(argv, { log = console.log, loadFrom = HERE } = {}) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    log(`usage error: ${e.message}\nusage: node evals/run-evals.mjs --cmd '<command template>' [--only trigger|routing] [--limit n] [--concurrency n] [--timeout-s n] [--threshold 0.8] [--out file] [--dry-run]`);
    return 2;
  }
  const { triggers, stages } = loadEvals(loadFrom);
  const nT = o.only === 'routing' ? 0 : Math.min(triggers.length, o.limit ?? Infinity);
  const nS = o.only === 'trigger' ? 0 : Math.min(stages.length, o.limit ?? Infinity);
  log(`${nT} triggering prompts + ${nS} stage-routing prompts = ${nT + nS} calls to your command.`);
  if (o.dryRun) {
    for (const t of triggers.slice(0, nT)) log(`  trigger  expect ${t.should_trigger ? 'LOAD   ' : 'NO LOAD'}  ${t.query}`);
    for (const s of stages.slice(0, nS)) log(`  routing  expect actions/${s.action}.md  ${s.name}`);
    log('Dry run: nothing was sent.');
    return 0;
  }
  if (!o.cmd) {
    log('usage error: --cmd is required (or use --dry-run).');
    return 2;
  }
  const out = resolve(o.out ?? `akuko-evals-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const report = await runEvals({
    triggers,
    stages,
    runModel: commandRunner(o.cmd, { timeoutS: o.timeoutS }),
    ...(o.only ? { only: o.only } : {}),
    ...(o.limit ? { limit: o.limit } : {}),
    concurrency: o.concurrency,
    threshold: o.threshold,
    onProgress: (n, total, row) => log(`[${n}/${total}] ${row.error ? 'ERROR' : row.pass ? 'pass' : 'FAIL'} ${row.kind} ${row.kind === 'trigger' ? row.query.slice(0, 60) : row.name}${row.error ? ` (error: ${row.error})` : ''}`),
  });
  writeFileSync(out, `${JSON.stringify({ ran_at: new Date().toISOString(), command: o.cmd, ...report }, null, 2)}\n`);
  log('');
  log(`Triggering:    ${report.trigger.passed}/${report.trigger.total} (${pct(report.trigger_rate)})`);
  log(`Stage routing: ${report.routing.passed}/${report.routing.total} (${pct(report.routing_rate)})`);
  if (report.errors > 0) {
    log(`Errors: ${report.errors} prompt(s) never got a model answer (${report.error_reasons.join('; ')}). They are left out of both rates.`);
    log('The skill was not tested on those prompts: fix the command or the sign-in and run again.');
  }
  log(`Verdict (each at least ${pct(o.threshold)}): ${report.verdict}`);
  log(`Results: ${out}`);
  return report.verdict === 'PASS' ? 0 : report.verdict === 'INCONCLUSIVE' ? 3 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 2; });
}
