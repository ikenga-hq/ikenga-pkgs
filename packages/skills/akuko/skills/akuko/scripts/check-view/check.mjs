// akuko view conformance check — the engine behind scripts/check-view.mjs.
// Contract: views/contract.md. Machine-readable parts: views/views.schema.json
// (manifest, required views and fields) and views/decision.schema.json (the
// Decision record, generated from the Zod schema).
//
// The page's own scripts run (jsdom, `runScripts: 'dangerously'`): only check
// views you would open in a browser anyway. Nothing leaves the process: the
// host stores are fakes that record what the page writes.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { JSDOM, VirtualConsole } from 'jsdom';
import { STAGE_IDS, approveSpendText, bibleEntries, expectedMoney, expectedYourMove, mutateProject, unitsById } from './expected.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..', '..');
export const CHECKER = 'check-view@1';
export const DEFAULT_PROJECT = join(SKILL, 'fixtures', 'the-beating', 'akuko.json');
const VIEWS_SCHEMA = JSON.parse(readFileSync(join(SKILL, 'views', 'views.schema.json'), 'utf8'));
const DECISION_SCHEMA = JSON.parse(readFileSync(join(SKILL, 'views', 'decision.schema.json'), 'utf8'));

const addFormats = addFormatsModule.default ?? addFormatsModule;
const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true });
addFormats(ajv);
const validManifest = ajv.compile(VIEWS_SCHEMA);
const validDecision = ajv.compile(DECISION_SCHEMA);

export const REQUIRED_VIEWS = VIEWS_SCHEMA.definitions.ViewName.enum;
export const ACTIONS = VIEWS_SCHEMA.definitions.Action.enum;
const FIELDS = Object.fromEntries(REQUIRED_VIEWS.map((v) => [v, VIEWS_SCHEMA.definitions[`fields:${v}`].enum]));
const AGENT_AUTHOR = /^(agent|akuko|claude|assistant|system|ai|bot|llm)(?:$|[\s:@/_.-])/i; // decisions/fold.ts
const STATE_KEY = 'akuko.decisions';
const WIDTH = 1440;
const EPS = 1e-9;
let decisionsChecked = 0;

// ─────────────────────────────────────────────────────────────────────────
// Static checks
// ─────────────────────────────────────────────────────────────────────────

/** The HTML with every comment blanked out (same length), so tags quoted in comments are never matched. */
const uncommented = (html) => html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));

function blockRange(html, id) {
  const m = new RegExp(`(<script[^>]*\\bid=["']${id}["'][^>]*>)([\\s\\S]*?)</script>`, 'i').exec(uncommented(html));
  return m ? { start: m.index + m[1].length, end: m.index + m[1].length + m[2].length } : undefined;
}

function jsonBlock(html, id) {
  const r = blockRange(html, id);
  return r ? html.slice(r.start, r.end) : undefined;
}

export function injectProject(html, project) {
  const r = blockRange(html, 'akuko-project');
  if (!r) return undefined;
  return html.slice(0, r.start) + JSON.stringify(project).replace(/</g, '\\u003c') + html.slice(r.end);
}

function scripts(html) {
  return [...uncommented(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs]) => !/type=["']application\/json["']/i.test(attrs))
    .map(([, , body]) => body);
}

function staticChecks(html, fail) {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const inline = [...html.matchAll(/style=["']([^"']*)["']/gi)].map((m) => m[1]).join(';');
  const code = scripts(html).join('\n');
  const all = `${css}\n${inline}\n${code}`;
  // R5 readability floor: no text under 12px (labels ≥12px; body ≥14px is checked by eye).
  for (const m of all.matchAll(/font-size\s*:\s*([\d.]+)(px|rem|em)\b/gi)) {
    const px = m[2].toLowerCase() === 'px' ? Number(m[1]) : Number(m[1]) * 16;
    if (px < 12) { fail('R5', 'text-below-floor', `a font-size of ${m[1]}${m[2]} is under the 12px readability floor`); break; }
  }
  if (!/:focus-visible|:focus\b/.test(css)) fail('R5', 'no-focus-style', 'no :focus-visible (or :focus) style: keyboard focus must be visible');
  if (/(transition|animation)\s*:/.test(css) && !/prefers-reduced-motion/.test(css)) fail('R5', 'no-reduced-motion', 'animates without honouring prefers-reduced-motion');
  // R4: obvious direct writes of the project.
  const writes = [
    [/\bwriteState\s*\(/, 'calls writeState()'],
    [/showSaveFilePicker|\bcreateWritable\s*\(/, 'writes files from the page'],
    [/["'`]akuko\/project["'`]\s*\)\s*\.\s*(set|update|delete)\s*\(/, 'writes the akuko/project document'],
    [/akuko\.json["'`][\s\S]{0,80}method\s*:\s*["'`](PUT|POST|PATCH)/i, 'sends akuko.json to a server'],
  ];
  for (const [re, what] of writes) if (re.test(code)) fail('R4', 'writes-project', `the page ${what}; views write decisions only`);
}

// ─────────────────────────────────────────────────────────────────────────
// Loading a page with a fake host
// ─────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mediaMatches(q) {
  const parts = String(q).split(',');
  return parts.some((part) => {
    let ok = true;
    for (const m of part.matchAll(/\((min|max)-width\s*:\s*(\d+)px\)/g)) ok &&= m[1] === 'min' ? WIDTH >= +m[2] : WIDTH <= +m[2];
    if (/prefers-reduced-motion\s*:\s*reduce/.test(part)) ok = false;
    if (/prefers-color-scheme\s*:\s*light/.test(part)) ok = false;
    return ok;
  });
}

function fakeDb(rec, project) {
  const write = (path, data, op) => {
    rec.writes.push({ path, data: data && JSON.parse(JSON.stringify(data)), op, epoch: rec.epoch });
    if (!/^decisions\/[^/]+$/.test(path) || op === 'delete') rec.violations.push(`${op} of "${path}" in the artifact database`);
    return Promise.resolve();
  };
  const snap = (path) => (path === 'akuko/project'
    ? { id: 'project', exists: true, data: () => structuredClone(project), metadata: {} }
    : { id: path.split('/').pop(), exists: false, data: () => undefined, metadata: {} });
  const qsnap = { docs: [], empty: true, size: 0, forEach() {}, docChanges: () => [] };
  let auto = 0;
  const ref = (path) => ({
    id: path.split('/').pop(), path,
    get: async () => snap(path),
    set: (d) => write(path, d, 'set'),
    update: (d) => write(path, d, 'update'),
    delete: () => write(path, null, 'delete'),
    onSnapshot: (fn) => { setTimeout(() => fn(snap(path)), 0); return () => {}; },
    collection: (c) => coll(`${path}/${c}`),
  });
  const query = (path) => ({
    where: () => query(path), orderBy: () => query(path), limit: () => query(path),
    get: async () => qsnap,
    onSnapshot: (fn) => { setTimeout(() => fn(qsnap), 0); return () => {}; },
  });
  const coll = (path) => ({
    ...query(path),
    doc: (id) => ref(`${path}/${id ?? `auto${++auto}`}`),
    add: async (d) => { const id = `auto${++auto}`; await write(`${path}/${id}`, d, 'add'); return ref(`${path}/${id}`); },
  });
  return { doc: ref, collection: coll };
}

async function load(html, project, host, wait = 40) {
  const rec = { epoch: 0, writes: [], posts: [], violations: [], errors: [], clipboard: null };
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/i.test(String(e.message))) rec.errors.push(String(e.message).split('\n')[0]); });
  const doc = injectProject(html, project);
  const dom = new JSDOM(doc, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://view.check-view.test/view.html',
    virtualConsole: vc,
    beforeParse(w) {
      w.Element.prototype.scrollIntoView = function () {};
      w.scrollTo = () => {}; w.scrollBy = () => {};
      Object.defineProperty(w, 'innerWidth', { value: WIDTH, configurable: true });
      Object.defineProperty(w, 'innerHeight', { value: 900, configurable: true });
      w.matchMedia = (q) => ({ matches: mediaMatches(q), media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
      Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { rec.clipboard = t; } }, configurable: true });
      w.fetch = async (url, init = {}) => {
        const method = String(init.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') rec.violations.push(`fetch ${method} ${url}`);
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      };
      const open = w.XMLHttpRequest.prototype.open;
      w.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (!/^(GET|HEAD)$/i.test(method)) rec.violations.push(`XMLHttpRequest ${method} ${url}`);
        return open.call(this, method, url, ...rest);
      };
      w.postMessage = (msg) => {
        rec.posts.push({ msg: msg && JSON.parse(JSON.stringify(msg)), epoch: rec.epoch });
        if (msg && msg.__iyke && msg.kind === 'state' && msg.payload?.key !== STATE_KEY) rec.violations.push(`a bridge state post under "${msg.payload?.key}"`);
      };
      if (host === 'A') {
        const db = fakeDb(rec, project);
        const user = { id: async () => 'u_check_view', isOwner: () => false, canEdit: () => false, can: () => null, me: async () => ({ id: 'u_check_view', name: '', isMe: true }) };
        const artifact = { publish: async () => { rec.violations.push('artifact.publish (the page republished itself with its state)'); } };
        w.claude = Object.freeze({ use: async (name) => { await sleep(1); return name === 'db' ? db : name === 'user' ? user : name === 'artifact' || name === 'self' ? artifact : null; } });
      }
      if (host === 'C') w.__ikenga_host__ = { kind: 'ikenga', user: null };
    },
  });
  const w = dom.window;
  if (w.document.readyState !== 'complete') await Promise.race([new Promise((r) => w.addEventListener('load', r, { once: true })), sleep(15000)]);
  await settle(w, wait);
  return { dom, w, d: w.document, rec, host, slug: project.project.slug, close: () => w.close() };
}

async function settle(w, ms = 30) {
  for (let i = 0; i < 3; i++) {
    await sleep(0);
    await new Promise((r) => w.requestAnimationFrame(() => r()));
  }
  await sleep(ms);
}

/** Every decision the page has written, by store, with the epoch it appeared in. */
function decisions(page) {
  const out = new Map();
  for (const wr of page.rec.writes) if (/^decisions\//.test(wr.path) && wr.data && wr.data.id) out.set(wr.data.id, { d: wr.data, epoch: wr.epoch, store: 'artifact-db' });
  for (const p of page.rec.posts) {
    const v = p.msg?.__iyke && p.msg.kind === 'state' && p.msg.payload?.key === STATE_KEY ? p.msg.payload.value : null;
    if (Array.isArray(v)) for (const d of v) if (d && d.id && !out.has(d.id)) out.set(d.id, { d, epoch: p.epoch, store: 'ikenga' });
  }
  if (page.host === 'local') {
    let box = [];
    try { box = JSON.parse(page.w.localStorage.getItem(`akuko-outbox:${page.slug}`) ?? '[]'); } catch { box = []; }
    for (const d of Array.isArray(box) ? box : []) if (d && d.id && !out.has(d.id)) out.set(d.id, { d, epoch: page.rec.epoch, store: 'outbox' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────────────────

function hiddenReason(w, el) {
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (e.hidden) return 'hidden attribute';
    if (e.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
    if (e.hasAttribute('inert')) return 'inert';
    if (e.tagName === 'DETAILS' && !e.open && e !== el && !el.closest('summary')) return 'inside a closed <details>';
    const cs = w.getComputedStyle(e);
    if (cs.display === 'none') return 'display: none';
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'visibility: hidden';
    if (cs.opacity === '0') return 'opacity: 0';
    if ((cs.position === 'absolute' || cs.position === 'fixed') && (cs.width === '1px' || cs.height === '1px' || /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip))) return 'visually hidden';
  }
  return null;
}

const text = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const firstNumber = (s) => { const m = /-?\d[\d,]*(?:\.\d+)?/.exec(s.replace(/−/g, '-')); return m ? Number(m[0].replace(/,/g, '')) : null; };
const sel = (attr, v) => `[${attr}="${String(v).replace(/"/g, '\\"')}"]`;
const inViews = (d, view) => [...d.querySelectorAll(sel('data-akuko-view', view))];
const fieldsIn = (roots, field) => roots.flatMap((r) => [...r.querySelectorAll(sel('data-akuko-field', field))]);

function isFocusable(el) {
  if (el.hasAttribute('disabled')) return false;
  const ti = el.getAttribute('tabindex');
  if (ti !== null && Number(ti) < 0) return false;
  if (/^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName)) return true;
  if (el.tagName === 'A' && el.hasAttribute('href')) return true;
  return ti !== null && Number(ti) >= 0;
}

function click(w, el) {
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, view: w }));
}

// ─────────────────────────────────────────────────────────────────────────
// Structure, money and the "your move" summary (run on every project)
// ─────────────────────────────────────────────────────────────────────────

function checkStructure(page, p, fail, label) {
  const { d, w } = page;
  const tag = label ? ` (${label})` : '';
  const views = Object.fromEntries(REQUIRED_VIEWS.map((v) => [v, inViews(d, v)]));
  for (const v of REQUIRED_VIEWS) {
    if (views[v].length > 0) continue;
    if (v === 'your-move') fail('R3', 'no-your-move', `no "your move" summary (data-akuko-view="your-move")${tag}`);
    else fail('contract', 'missing-view', `required view "${v}" is missing${tag}`);
  }
  const units = unitsById(p);
  const need = (view, field, extra = '') => {
    const els = fieldsIn(views[view], field);
    if (els.length === 0 && views[view].length > 0) fail('contract', 'missing-field', `view "${view}" has no ${field} field${extra}${tag}`);
    return els;
  };

  // pipeline
  if (views.pipeline.length) {
    const stages = need('pipeline', 'stage');
    for (const id of STAGE_IDS) {
      const el = stages.find((e) => e.getAttribute('data-akuko-stage') === id);
      if (!el) fail('contract', 'missing-field', `pipeline does not show stage "${id}"${tag}`);
      else if (el.getAttribute('data-akuko-status') !== p.stages[id].state) fail('contract', 'wrong-value', `pipeline shows ${id} as "${el.getAttribute('data-akuko-status')}", the project says "${p.stages[id].state}"${tag}`);
    }
    const cur = need('pipeline', 'current-stage');
    if (cur.length && !cur.some((e) => e.getAttribute('data-akuko-stage') === p.current_stage)) fail('contract', 'wrong-value', `the current stage shown is not "${p.current_stage}"${tag}`);
  }
  // shots
  if (views.shots.length) {
    const scenes = need('shots', 'scene');
    for (const sc of p.scenes) if (!scenes.some((e) => e.getAttribute('data-akuko-unit') === sc.id)) fail('contract', 'missing-field', `shots are not grouped under scene ${sc.id}${tag}`);
    const shots = need('shots', 'shot');
    for (const f of ['shot-type', 'duration', 'panel']) need('shots', f);
    for (const s of p.shots) {
      const el = shots.find((e) => e.getAttribute('data-akuko-unit') === s.id);
      if (!el) { fail('contract', 'missing-field', `shot ${s.id} is not listed${tag}`); continue; }
      const st = el.querySelector('[data-akuko-field="status"]');
      if (!st) fail('contract', 'missing-field', `shot ${s.id} has no status field${tag}`);
      else if (st.getAttribute('data-akuko-status') !== s.status) fail('contract', 'wrong-value', `shot ${s.id} shows "${st.getAttribute('data-akuko-status')}", the project says "${s.status}"${tag}`);
    }
  }
  // shot detail
  if (views['shot-detail'].length) {
    const v = views['shot-detail'].find((e) => units.has(e.getAttribute('data-akuko-unit') ?? '')) ?? null;
    if (!v) fail('contract', 'missing-field', `shot detail does not name the selected shot (data-akuko-unit)${tag}`);
    else for (const f of FIELDS['shot-detail']) if (!v.querySelector(sel('data-akuko-field', f))) fail('contract', 'missing-field', `shot detail has no ${f} field${tag}`);
  }
  // bible
  if (views.bible.length) {
    const entries = need('bible', 'bible-entry');
    for (const e of bibleEntries(p)) {
      const el = entries.find((x) => x.getAttribute('data-akuko-unit') === e.id);
      if (!el) fail('contract', 'missing-field', `bible entry ${e.id} is not shown${tag}`);
      else if (el.getAttribute('data-akuko-status') !== e.status) fail('contract', 'wrong-value', `bible entry ${e.id} shows "${el.getAttribute('data-akuko-status')}", the project says "${e.status}"${tag}`);
    }
  }
  // spend gate (R2)
  const m = expectedMoney(p);
  if (views['spend-gate'].length) {
    const gateHidden = views['spend-gate'].every((v) => hiddenReason(w, v));
    if (gateHidden && p.pending_spend.some((j) => j.status === 'awaiting-approval')) fail('R2', 'hidden-spend-gate', `a paid job is waiting but the spend gate is hidden (${hiddenReason(w, views['spend-gate'][0])})${tag}`);
    const money = (field, want, what, unit) => {
      const els = fieldsIn(views['spend-gate'], field).filter((e) => (unit ? e.getAttribute('data-akuko-unit') === unit || e.closest(sel('data-akuko-unit', unit)) : true));
      if (els.length === 0) { fail('R2', field === 'estimate' ? 'hidden-estimate' : 'missing-money', `${what} is not shown${tag}`); return; }
      const shown = els.find((e) => !hiddenReason(w, e));
      if (!shown) { fail('R2', field === 'estimate' ? 'hidden-estimate' : 'hidden-money', `${what} is in the page but hidden (${hiddenReason(w, els[0])})${tag}`); return; }
      const n = firstNumber(text(shown));
      if (n === null) fail('R2', 'missing-money', `${what} shows no amount ("${text(shown)}")${tag}`);
      else if (Math.abs(n - want) > EPS) {
        const rounded = Math.abs(n - want) < 0.05 && String(n).length < String(Number(want.toFixed(4))).length;
        fail('R2', rounded ? 'rounded-money' : 'wrong-money', `${what} shows ${text(shown)}, exactly ${Number(want.toFixed(4))} expected${rounded ? ' (rounded)' : ''}${tag}`);
      }
    };
    const jobs = p.pending_spend.length ? need('spend-gate', 'job') : [];
    for (const j of m.jobs) {
      const el = jobs.find((e) => e.getAttribute('data-akuko-unit') === j.id);
      if (!el) { fail('R2', 'hidden-estimate', `paid job ${j.id} is not shown${tag}`); continue; }
      const st = el.querySelector('[data-akuko-field="status"]');
      if (st && st.getAttribute('data-akuko-status') !== j.status) fail('contract', 'wrong-value', `job ${j.id} shows "${st.getAttribute('data-akuko-status')}", the project says "${j.status}"${tag}`);
      money('estimate', j.estimate, `the estimate for ${j.id}`, j.id);
    }
    if (p.budget) {
      money('cap', m.cap, 'the budget cap');
      money('spent', m.spent, 'what is spent');
      if (m.sunk > EPS) money('sunk', m.sunk, 'money sunk in failed calls');
      if (m.inFlight > EPS) money('in-flight', m.inFlight, 'money in flight');
      if (m.jobs.length) money('left-if-approved', m.leftIfApproved, 'what is left if you approve');
    }
  }
  // ledger
  if (views.ledger.length) {
    const rows = p.ledger.length ? need('ledger', 'ledger-entry') : fieldsIn(views.ledger, 'ledger-entry');
    if (rows.length !== p.ledger.length) fail('contract', 'wrong-value', `the ledger shows ${rows.length} entries, the project has ${p.ledger.length}${tag}`);
    const tot = need('ledger', 'ledger-total');
    if (tot.length && Math.abs((firstNumber(text(tot[0])) ?? NaN) - m.ledgerTotal) > EPS) fail('R2', 'wrong-money', `the ledger total shows ${text(tot[0])}, exactly ${Number(m.ledgerTotal.toFixed(4))} expected${tag}`);
  }
  // script link
  if (views['script-link'].length) {
    const tags = need('script-link', 'script-tag');
    for (const s of p.shots) if (s.script_line && !tags.some((e) => e.getAttribute('data-akuko-unit') === s.id)) fail('contract', 'missing-field', `the script has no tag for ${s.id}${tag}`);
  }
  // your move (R3)
  if (views['your-move'].length) {
    const vis = views['your-move'].find((v) => !hiddenReason(w, v));
    if (!vis) fail('R3', 'hidden-your-move', `the "your move" summary is hidden (${hiddenReason(w, views['your-move'][0])})${tag}`);
    checkYourMove(page, views['your-move'], expectedYourMove(p), fail, tag);
  }
}

function checkYourMove(page, roots, want, fail, tag, after = '') {
  for (const [field, n] of Object.entries(want)) {
    const els = fieldsIn(roots, field);
    if (els.length === 0) {
      if (n > 0) fail('R3', 'your-move-not-derived', `the "your move" summary does not count ${field} (${n})${after}${tag}`);
      continue;
    }
    const shown = firstNumber(text(els[0]));
    if (shown !== n) fail('R3', 'your-move-not-derived', `the "your move" summary says ${field} = ${shown}, the data says ${n}${after}${tag}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Controls and decisions (R1, R4, decision format)
// ─────────────────────────────────────────────────────────────────────────

function checkControls(page, p, fail) {
  const { d, w } = page;
  const units = unitsById(p);
  const jobs = new Set(p.pending_spend.map((j) => j.id));
  for (const el of d.querySelectorAll('[data-akuko-action]')) {
    const a = el.getAttribute('data-akuko-action');
    const u = el.getAttribute('data-akuko-unit');
    if (!ACTIONS.includes(a)) { fail('contract', 'unknown-action', `a control has data-akuko-action="${a}"`); continue; }
    if (!u) { fail('R1', 'batch-approve', `a "${a}" control (${text(el).slice(0, 40) || el.tagName}) names no single unit: one explicit action per unit`); continue; }
    if (!units.has(u) && !jobs.has(u)) fail('contract', 'unknown-unit', `a "${a}" control names "${u}", which is not in the project`);
    if ((el.type === 'checkbox' || el.type === 'radio') && (el.checked || el.hasAttribute('checked'))) fail('R1', 'pre-ticked', `the "${a}" control for ${u} is ticked before the person touched it`);
    if (!isFocusable(el)) fail('R5', 'not-keyboard-reachable', `the "${a}" control for ${u} cannot be reached with the keyboard`);
  }
  const control = (a, u) => [...d.querySelectorAll(`${sel('data-akuko-action', a)}${sel('data-akuko-unit', u)}`)].find((e) => !hiddenReason(w, e));
  const detail = inViews(d, 'shot-detail').map((e) => e.getAttribute('data-akuko-unit')).find((u) => units.has(u ?? ''));
  const ds = detail ? units.get(detail) : null;
  if (ds && (ds.status === 'pending-review' || ds.status === 'needs-rework')) {
    for (const a of ['approve', 'request-changes', 'note']) if (!control(a, ds.id)) fail('contract', 'missing-control', `shot detail for ${ds.id} has no visible "${a}" control`);
  }
  for (const j of p.pending_spend.filter((x) => x.status === 'awaiting-approval')) {
    for (const a of ['approve-spend', 'decline-spend']) if (!control(a, j.id)) fail('contract', 'missing-control', `the paid job ${j.id} has no visible "${a}" control`);
  }
  for (const a of p.assets.filter((x) => x.status === 'pending-review')) if (!control('approve', a.id)) fail('contract', 'missing-control', `${a.id} is waiting for review but has no visible approve control`);
  return { detail: ds, control };
}

function checkDecision(dec, page, p, want, fail, manifest) {
  decisionsChecked++;
  const where = `the "${want.action}" control for ${want.unit}`;
  if (!validDecision(dec)) {
    fail('decision', 'invalid-decision', `${where} wrote a record that is not a valid Decision: ${ajv.errorsText(validDecision.errors)}`);
    return;
  }
  if (dec.action !== want.action) fail('decision', 'wrong-action', `${where} wrote action "${dec.action}"`);
  if (dec.unit !== want.unit) fail('R1', 'batch-approve', `${where} wrote a decision for ${dec.unit}`);
  const stage = p.pending_spend.find((j) => j.id === dec.unit)?.stage ?? unitsById(p).get(dec.unit)?.stage;
  if (stage && dec.stage !== stage) fail('decision', 'wrong-stage', `${where} wrote stage "${dec.stage}", the unit is at "${stage}"`);
  if (manifest && dec.view !== `${manifest.id}@${manifest.version}`) fail('decision', 'wrong-view', `${where} signed the decision view "${dec.view}", the manifest says "${manifest.id}@${manifest.version}"`);
  if (AGENT_AUTHOR.test(dec.by)) fail('R1', 'signed-by-agent', `${where} signed the decision "${dec.by}", an agent name: decisions are a person's`);
  if (want.undoes && dec.undoes !== want.undoes) fail('decision', 'wrong-undo', `${where} undid ${dec.undoes}, not the decision just made (${want.undoes})`);
  if (want.text !== undefined && dec.text !== want.text) {
    fail(dec.action === 'approve-spend' ? 'R2' : 'decision', dec.action === 'approve-spend' ? 'spend-amount-not-bound' : 'wrong-text',
      `${where} wrote text ${JSON.stringify(dec.text ?? null)}, expected ${JSON.stringify(want.text)}${dec.action === 'approve-spend' ? ' (the amount the person was shown)' : ''}`);
  }
}

/** Click one control the way a person would; return the decisions that appeared. */
async function act(page, el, opts = {}) {
  const before = new Set(decisions(page).keys());
  page.rec.epoch++;
  click(page.w, el);
  await settle(page.w);
  let fresh = [...decisions(page).entries()].filter(([id]) => !before.has(id)).map(([, v]) => v.d);
  if (fresh.length === 0 && opts.text !== undefined) {
    const ta = [...page.d.querySelectorAll('textarea[data-akuko-text], input[data-akuko-text]')].find((e) => !hiddenReason(page.w, e));
    const submit = [...page.d.querySelectorAll('[data-akuko-submit]')].find((e) => !hiddenReason(page.w, e));
    if (ta && submit) {
      ta.value = opts.text;
      ta.dispatchEvent(new page.w.Event('input', { bubbles: true }));
      click(page.w, submit);
      await settle(page.w);
      fresh = [...decisions(page).entries()].filter(([id]) => !before.has(id)).map(([, v]) => v.d);
    } else return { fresh, composer: false };
  }
  return { fresh, composer: true };
}

async function clickTests(html, p, manifest, fail) {
  const one = async (page, a, unit, want = {}) => {
    const el = [...page.d.querySelectorAll(`${sel('data-akuko-action', a)}${sel('data-akuko-unit', unit)}`)].find((e) => !hiddenReason(page.w, e));
    if (!el) { fail('contract', 'missing-control', `no visible "${a}" control for ${unit}`); return null; }
    const r = await act(page, el, { text: want.compose });
    if (!r.composer) { fail('contract', 'no-composer', `the "${a}" control for ${unit} wrote nothing and opened no composer (textarea[data-akuko-text] + [data-akuko-submit])`); return null; }
    if (r.fresh.length === 0) { fail('decision', 'writes-nothing', `the "${a}" control for ${unit} wrote no decision`); return null; }
    if (r.fresh.length > 1) fail('R1', 'batch-approve', `one "${a}" click on ${unit} wrote ${r.fresh.length} decisions (${r.fresh.map((x) => `${x.action}:${x.unit}`).join(', ')})`);
    for (const dec of r.fresh) checkDecision(dec, page, p, { action: a, unit, ...want, ...(want.compose !== undefined ? { text: want.compose } : {}) }, fail, manifest);
    if (page.rec.violations.length) { for (const v of page.rec.violations.splice(0)) fail('R4', 'writes-project', `after a "${a}" click: ${v}; views write decisions only`); }
    return r.fresh[0];
  };
  const target = (page) => {
    const units = unitsById(p);
    const u = inViews(page.d, 'shot-detail').map((e) => e.getAttribute('data-akuko-unit')).find((x) => units.has(x ?? ''));
    return u ? units.get(u) : null;
  };

  // 1. a shot: approve → undo, request changes, note
  let page = await load(html, p, 'A');
  const shot = target(page);
  if (shot && (shot.status === 'pending-review' || shot.status === 'needs-rework')) {
    const ym = expectedYourMove(p);
    const ap = await one(page, 'approve', shot.id);
    if (ap && shot.status === 'pending-review' && inViews(page.d, 'your-move').length) {
      checkYourMove(page, inViews(page.d, 'your-move'), { ...ym, 'waiting-shots': ym['waiting-shots'] - 1 }, fail, '', ` after approving ${shot.id}`);
    }
    if (ap) await one(page, 'undo', shot.id, { undoes: ap.id });
    await one(page, 'request-changes', shot.id, { compose: 'check-view: please change this' });
    await one(page, 'note', shot.id, { compose: 'check-view: a note' });
  }
  page.close();

  // 2. a paid job: approve spend → undo, then decline
  const job = p.pending_spend.find((j) => j.status === 'awaiting-approval');
  if (job) {
    page = await load(html, p, 'A');
    const ok = await one(page, 'approve-spend', job.id, { text: approveSpendText(p, job) });
    if (ok) await one(page, 'undo', job.id, { undoes: ok.id });
    page.close();
    page = await load(html, p, 'A');
    await one(page, 'decline-spend', job.id);
    page.close();
  }

  // 3. a bible asset, and the script link selecting a shot
  page = await load(html, p, 'A');
  const asset = p.assets.find((a) => a.status === 'pending-review');
  if (asset) await one(page, 'approve', asset.id);
  const sel0 = target(page)?.id;
  const tagEl = [...page.d.querySelectorAll('[data-akuko-view="script-link"] [data-akuko-field="script-tag"]')].find((e) => e.getAttribute('data-akuko-unit') !== sel0 && !hiddenReason(page.w, e));
  if (tagEl) {
    const want = tagEl.getAttribute('data-akuko-unit');
    page.rec.epoch++;
    click(page.w, tagEl);
    await settle(page.w);
    if (target(page)?.id !== want) fail('contract', 'script-link-does-not-select', `activating the script tag for ${want} did not select it in shot detail`);
  }
  page.close();

  // 4. host C: the decision is posted to the Ikenga bridge, cumulatively
  // 5. no host store (a local file): the decision stays in the outbox, with a way to copy it out
  for (const host of ['C', 'local']) {
    page = await load(html, p, host);
    const s = target(page);
    const el = s && [...page.d.querySelectorAll(`[data-akuko-action="approve"]${sel('data-akuko-unit', s.id)}`)].find((e) => !hiddenReason(page.w, e));
    if (el) {
      const { fresh } = await act(page, el);
      if (host === 'C' && fresh.length === 0) fail('contract', 'not-posted-to-ikenga', 'in Ikenga the decision was not posted as {__iyke, kind: "state", payload: {key: "akuko.decisions", value: [...]}}');
      if (host === 'local') {
        if (fresh.length === 0) fail('contract', 'no-outbox', `without a host store the decision is not kept in localStorage "akuko-outbox:${p.project.slug}"`);
        if (![...page.d.querySelectorAll('[data-akuko-export]')].some((e) => !hiddenReason(page.w, e))) fail('contract', 'no-export', 'without a host store there is no visible "copy decisions for akuko" control (data-akuko-export)');
      }
    }
    page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check one view's HTML. Returns {ok, view, sha256, failures, manual}.
 * `project` defaults to the converted fixture (fixtures/the-beating/akuko.json).
 */
export async function checkView(html, opts = {}) {
  const project = opts.project ?? JSON.parse(readFileSync(DEFAULT_PROJECT, 'utf8'));
  const failures = [];
  const seen = new Set();
  const fail = (rule, code, message) => {
    const k = `${rule}|${code}|${message}`;
    if (!seen.has(k)) { seen.add(k); failures.push({ rule, code, message }); }
  };
  const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  decisionsChecked = 0;
  let manifest = null;
  const raw = jsonBlock(html, 'akuko-view');
  if (raw === undefined) fail('contract', 'no-manifest', 'no <script type="application/json" id="akuko-view"> manifest');
  else {
    try { manifest = JSON.parse(raw); } catch { fail('contract', 'bad-manifest', 'the akuko-view manifest is not JSON'); }
    if (manifest && !validManifest(manifest)) fail('contract', 'bad-manifest', `the akuko-view manifest does not match views/views.schema.json: ${ajv.errorsText(validManifest.errors)}`);
  }
  if (injectProject(html, project) === undefined) {
    fail('contract', 'no-project-block', 'no <script type="application/json" id="akuko-project"> block to read the project from');
    return { ok: false, view: manifest ? `${manifest.id}@${manifest.version}` : null, sha256, failures, manual: [] };
  }
  staticChecks(html, fail);

  const first = await load(html, project, 'A', 400); // long enough to catch a page that approves on a timer
  for (const e of first.rec.errors) fail('contract', 'page-error', `the page threw: ${e}`);
  const early = [...decisions(first).values()].filter((x) => x.epoch === 0);
  for (const { d } of early) {
    const auto = d.action === 'approve' || d.action === 'approve-spend';
    fail('R1', auto ? 'auto-approve' : 'decision-without-action', `the page wrote a "${d.action}" for ${d.unit} before anyone touched it`);
  }
  for (const v of first.rec.violations.splice(0)) fail('R4', 'writes-project', `${v}; views write decisions only`);
  checkStructure(first, project, fail, '');
  checkControls(first, project, fail);
  first.close();

  const mutated = mutateProject(project);
  const second = await load(html, mutated, 'A');
  checkStructure(second, mutated, fail, 'with a changed project');
  second.close();

  if (manifest?.writes_decisions !== false) await clickTests(html, project, manifest, fail);
  return {
    ok: failures.length === 0,
    view: manifest ? `${manifest.id}@${manifest.version}` : null,
    sha256,
    failures,
    decisions_checked: decisionsChecked,
    manual: ['R5 contrast ≥ 4.5:1 and body text ≥ 14px are checked by eye (designs/_spec.md)'],
  };
}
