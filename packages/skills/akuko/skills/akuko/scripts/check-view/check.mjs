// akuko view conformance check — the engine behind scripts/check-view.mjs.
// Contract: views/contract.md. Machine-readable parts: views/views.schema.json
// (manifest, required views and fields) and views/decision.schema.json (the
// Decision record, generated from the Zod schema).
//
// The page's own scripts run (jsdom, `runScripts: 'dangerously'`): only check
// views you would open in a browser anyway. Nothing leaves the process: the
// host stores are fakes that record what the page writes.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { JSDOM, VirtualConsole } from 'jsdom';
import { blankComments, conformanceHash, escapeJsonForScript, findJsonBlock, PROJECT_BLOCK } from './hash.mjs';
import { decisionWriteSigns } from './predicates.mjs';
import { hiddenReason, smallText } from './hidden.mjs';
import { STAGE_IDS, approveSpendText, gateMoney, bibleEntries, expectedMoney, expectedYourMove, mutateProject, removedAt, unitsById } from './expected.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..', '..');
// @2: the recorded sha256 is the conformance hash (data block emptied, hash.mjs); @1 hashed the raw page.
export const CHECKER = 'check-view@2';
export const DEFAULT_PROJECT = join(SKILL, 'fixtures', 'the-beating', 'akuko.json');
/** The canonical decision writer: a page that inlines one carries it byte for byte (views/contract.md §Decision writer). */
export const WRITER = readFileSync(join(HERE, 'decision-writer.js'), 'utf8').replace(/\r\n/g, '\n').trim();
export const WRITER_VERSION = /akuko-decision-writer (v\d+)/.exec(WRITER)?.[1] ?? 'v?';
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
const TEN_MINUTES = 10 * 60 * 1000;
const WIDTH = 1440;
const EPS = 1e-9;
let decisionsChecked = 0;

// ─────────────────────────────────────────────────────────────────────────
// Static checks
// ─────────────────────────────────────────────────────────────────────────

/** The HTML with every comment blanked out (same length), so tags quoted in comments are never matched. */
const uncommented = blankComments;

/** The manifest block's text: undefined when absent; {bad} when the page has it twice, untyped or unclosed (hash.mjs#findJsonBlock). */
function jsonBlock(html, id) {
  const b = findJsonBlock(html, id, { json: false });
  return b.status === 'ok' ? html.slice(b.start, b.end) : b.status === 'bad' ? { bad: b.reason } : undefined;
}

/** The page with the project block's content replaced, found exactly as the conformance hash finds it; undefined when it has no good block. */
export function injectProject(html, project) {
  const b = findJsonBlock(html, PROJECT_BLOCK);
  if (b.status !== 'ok') return undefined;
  return html.slice(0, b.start) + escapeJsonForScript(JSON.stringify(project)) + html.slice(b.end);
}

function scripts(html) {
  // a browser ends a script at the first "</script", whatever follows it (</script >, </script/>, …)
  return [...uncommented(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script(?=[\s/>]|$)/gi)]
    .filter(([, attrs]) => !/type=["']application\/json["']/i.test(attrs))
    .map(([, , body]) => body);
}

/** Obvious direct writes of the project in a page's scripts (R4). */
const PROJECT_WRITES = [
  [/\bwriteState\s*\(/, 'calls writeState()'],
  [/showSaveFilePicker|\bcreateWritable\s*\(/, 'writes files from the page'],
  [/["'`]akuko\/project["'`]\s*\)\s*\.\s*(set|update|delete)\s*\(/, 'writes the akuko/project document'],
  [/akuko\.json["'`][\s\S]{0,80}method\s*:\s*["'`](PUT|POST|PATCH)/i, 'sends akuko.json to a server'],
];

function staticChecks(html, fail) {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const inline = [...html.matchAll(/style=["']([^"']*)["']/gi)].map((m) => m[1]).join(';');
  const code = scripts(html).join('\n');
  const all = `${css}\n${inline}\n${code}`;
  // R5 readability floor: no text under 12px (labels ≥12px; body ≥14px is checked by eye).
  // Any unit (px, pt, em, rem, %, vw, …), keywords, unitless 0 and the font: shorthand.
  const small = smallText(css, `${inline}\n${code}`, html);
  if (small.length) fail('R5', 'text-below-floor', `font-size ${small.slice(0, 3).join(', ')} is under the 12px readability floor`);
  if (!/:focus-visible|:focus\b/.test(css)) fail('R5', 'no-focus-style', 'no :focus-visible (or :focus) style: keyboard focus must be visible');
  if (/(transition|animation)\s*:/.test(css) && !/prefers-reduced-motion/.test(css)) fail('R5', 'no-reduced-motion', 'animates without honouring prefers-reduced-motion');
  // R4: obvious direct writes of the project.
  for (const [re, what] of PROJECT_WRITES) if (re.test(code)) fail('R4', 'writes-project', `the page ${what}; views write decisions only`);
  const stale = staleWriter(html);
  if (stale) fail('contract', 'stale-writer', stale);
  const tag = FRAME_TAG.exec(uncommented(html));
  if (tag) fail('R4', 'iframe-in-view', `the page holds a <${tag[1].toLowerCase()}>: a frame runs code the check cannot see; views embed none`);
}

/**
 * A page that inlines the decision writer carries the current canonical one,
 * byte for byte (line endings aside): a stale copy keeps its old bugs (v1
 * posted an empty list over the Ikenga shell's stored one on every pane
 * remount). Returns what is wrong, or null.
 */
export function staleWriter(html) {
  const code = scripts(html).join('\n').replace(/\r\n/g, '\n');
  const fix = `inline the current canonical ${WRITER_VERSION} block (scripts/check-view/decision-writer.js) verbatim, once`;
  // a writer is anything that defines the global the decision API lives on (07a2 review C6)
  const defines = (c) => /(?<![\w$.])(?:window\s*\.\s*|window\s*\[\s*["'`])?akukoDecisions(?:["'`]\s*\])?\s*=(?!=)/.test(c) || /akuko-decision-writer/.test(c);
  const copies = code.split(WRITER).length - 1;
  if (copies > 1) return `the page inlines the decision writer ${copies} times; ${fix}`;
  if (copies === 1) {
    if (defines(code.replace(WRITER, ''))) return `the page defines another decision writer beside the canonical ${WRITER_VERSION} block; ${fix}`;
    return null;
  }
  if (!defines(code)) return null;
  const found = /akuko-decision-writer (v\d+)/.exec(code)?.[1];
  const what = !/akuko-decision-writer/.test(code) ? 'a decision writer of its own (it defines window.akukoDecisions)' : !found ? 'an unversioned copy of akuko-decision-writer' : found === WRITER_VERSION ? `a changed copy of akuko-decision-writer ${found}` : `akuko-decision-writer ${found}`;
  return `the page inlines ${what}; ${fix}`;
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
  const rec = { epoch: 0, writes: [], posts: [], violations: [], errors: [], clipboard: null, timers: new Map(), now: 0 };
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/i.test(String(e.message))) rec.errors.push(String(e.message).split('\n')[0]); });
  const doc = injectProject(html, project) ?? html;
  const dom = new JSDOM(doc, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://view.check-view.test/view.html',
    virtualConsole: vc,
    beforeParse(w) {
      // A browser's user agent: a page must not behave differently under the check.
      Object.defineProperty(w.navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', configurable: true });
      Object.defineProperty(w.navigator, 'webdriver', { value: false, configurable: true });
      installClock(w, rec);
      // Observers report at once (everything is on screen and has a size), and
      // the page looks like the Chrome its user agent names (07a2 review C4).
      const rect = { x: 0, y: 0, top: 0, left: 0, width: WIDTH, height: 900, right: WIDTH, bottom: 900 };
      const observer = (entry) => class {
        constructor(cb) { this.cb = cb; this.els = new Set(); }
        observe(el) {
          this.els.add(el);
          w.setTimeout(() => {
            if (!this.els.has(el) || typeof this.cb !== 'function') return;
            try { this.cb([entry(el)], this); } catch (e) { rec.errors.push(String((e && e.message) || e)); }
          }, 0);
        }
        unobserve(el) { this.els.delete(el); }
        disconnect() { this.els.clear(); }
        takeRecords() { return []; }
      };
      w.IntersectionObserver = observer((target) => ({ target, isIntersecting: true, intersectionRatio: 1, boundingClientRect: rect, intersectionRect: rect, rootBounds: rect, time: w.performance.now() }));
      w.ResizeObserver = observer((target) => ({ target, contentRect: rect, borderBoxSize: [{ inlineSize: WIDTH, blockSize: 900 }], contentBoxSize: [{ inlineSize: WIDTH, blockSize: 900 }] }));
      if (w.chrome === undefined) w.chrome = {};
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
      // sendBeacon always POSTs: a write, like a non-GET fetch (07a2 review r06)
      Object.defineProperty(w.navigator, 'sendBeacon', { value: (url) => { rec.violations.push(`navigator.sendBeacon ${url}`); return true; }, configurable: true });
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
  if (w.document.readyState !== 'complete') await new Promise((r) => { const t = setTimeout(r, 15000); t.unref?.(); w.addEventListener('load', () => { clearTimeout(t); r(); }, { once: true }); });
  await settle(w, wait);
  return { dom, w, d: w.document, rec, host, slug: project.project.slug, close: () => { rec.closed = true; w.close(); } };
}

/** The page's real requestAnimationFrame, kept for settle() once the page's own is on the fake clock. */
const REAL_RAF = new WeakMap();

/**
 * The page's timers run on a clock the check controls: short ones (≤100 ms)
 * also run in real time so the page works, every one can be fast-forwarded,
 * so a page that approves "in a minute" is caught without waiting a minute.
 * requestAnimationFrame (a 16 ms timer), Date.now() and performance.now() are
 * on the same clock, so a frame-counting or clock-polling page is
 * fast-forwarded too (G-VIEW hardening F6).
 */
function installClock(w, rec) {
  const realSet = w.setTimeout.bind(w), realClear = w.clearTimeout.bind(w);
  let seq = 0;
  rec.skew = 0; // ms the page's clock runs ahead of real time
  const fire = (id) => {
    const t = rec.timers.get(id);
    if (!t || rec.closed) return;
    if (t.repeat) { t.due += Math.max(t.ms, 1); t.fired++; if (t.ms <= 100 && t.fired < 50) t.real = realSet(() => fire(id), t.ms); else t.real = null; }
    else rec.timers.delete(id);
    if (typeof t.fn === 'function') { try { t.fn(...t.args); } catch (e) { rec.errors.push(String(e && e.message || e)); } }
  };
  const add = (repeat, raf = false) => (fn, ms = 0, ...args) => {
    const id = ++seq;
    const d = Math.max(0, Number(ms) || 0);
    const t = { fn, ms: d, args, repeat, raf, due: rec.now + d, fired: 0, real: null };
    rec.timers.set(id, t);
    if (d <= 100) t.real = realSet(() => fire(id), d);
    return id;
  };
  const clear = (id) => { const t = rec.timers.get(id); if (t) { if (t.real) realClear(t.real); rec.timers.delete(id); } };
  w.setTimeout = add(false);
  w.setInterval = add(true);
  w.clearTimeout = clear;
  w.clearInterval = clear;
  const realDateNow = w.Date.now.bind(w.Date);
  const realPerfNow = w.performance.now.bind(w.performance);
  try { Object.defineProperty(w.Date, 'now', { value: () => realDateNow() + rec.skew, configurable: true, writable: true }); } catch { /* keep the real one */ }
  try { Object.defineProperty(w.performance, 'now', { value: () => realPerfNow() + rec.skew, configurable: true, writable: true }); } catch { /* keep the real one */ }
  if (typeof w.requestAnimationFrame === 'function') REAL_RAF.set(w, w.requestAnimationFrame.bind(w));
  const frame = add(false, true);
  w.requestAnimationFrame = (fn) => frame(() => fn(w.performance.now()), 16);
  w.cancelAnimationFrame = clear;
  rec.advance = (ms) => {
    const until = rec.now + ms;
    let frames = 0; // an animation loop never ends: give frames ten seconds' worth, then let the other timers run
    for (let guard = 0; guard < 5000; guard++) {
      let next = null;
      for (const [id, t] of rec.timers) if (t.due <= until && !(t.raf && frames >= 600) && (next === null || t.due < next[1].due)) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      if (t.real) { realClear(t.real); t.real = null; }
      if (t.repeat && t.fired >= 300) { rec.timers.delete(id); continue; }
      if (t.raf) frames++;
      if (t.due > rec.now) { rec.skew += t.due - rec.now; rec.now = t.due; }
      fire(id);
    }
    rec.skew += until - rec.now;
    rec.now = until;
  };
}

/** What a person might do without deciding anything: move, scroll, focus, switch tabs, press keys. */
async function idle(page) {
  const { w, d } = page;
  const ev = (target, type, init = {}) => { try { target.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true, ...init })); } catch { /* ignore */ } };
  for (const type of ['pointermove', 'mousemove', 'mouseover', 'pointerover', 'touchstart']) {
    for (const el of [d.body, ...d.querySelectorAll('[data-akuko-view], [data-akuko-action], button')].slice(0, 80)) {
      try { el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, view: w, clientX: 10, clientY: 10 })); } catch { ev(el, type); }
    }
  }
  ev(w, 'scroll'); ev(d, 'scroll'); ev(w, 'resize'); ev(w, 'focus'); ev(w, 'blur');
  for (const type of ['wheel', 'touchmove', 'touchend', 'contextmenu', 'selectionchange', 'copy']) { ev(d.body, type); ev(d, type); }
  // The same gestures with the fields a handler would test (Wave 3 review,
  // finding 4; Phase 1 follow-up): wheel turns of several sizes, each mouse
  // button, each pointer type, a real touch list.
  for (const el of [d.body, ...d.querySelectorAll('[data-akuko-view], [data-akuko-action], button')].slice(0, 80)) gestures(w, el);
  // Leaving the page decides nothing either (F3): hide the tab, fire what a
  // browser fires as the page goes away, then come back.
  Object.defineProperty(d, 'visibilityState', { value: 'hidden', configurable: true });
  Object.defineProperty(d, 'hidden', { value: true, configurable: true });
  ev(d, 'visibilitychange');
  ev(w, 'pagehide', { bubbles: false });
  ev(w, 'beforeunload', { bubbles: false });
  ev(w, 'unload', { bubbles: false });
  ev(w, 'freeze', { bubbles: false });
  Object.defineProperty(d, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(d, 'hidden', { value: false, configurable: true });
  ev(w, 'pageshow', { bubbles: false });
  ev(d, 'visibilitychange');
  for (const el of [...d.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].slice(0, 120)) { try { el.focus(); } catch { /* ignore */ } }
  // Each key carries `key`, `code` and the legacy `keyCode`, so a handler
  // testing any of them sees a real key press (Wave 3 review, finding 4).
  const keys = [['a', 'KeyA', 65], ['A', 'KeyA', 65, { shiftKey: true }], ['a', 'KeyA', 65, { ctrlKey: true }], ['a', 'KeyA', 65, { metaKey: true }], ['Enter', 'Enter', 13], [' ', 'Space', 32], ['Escape', 'Escape', 27], ['Tab', 'Tab', 9], ['ArrowDown', 'ArrowDown', 40], ['ArrowRight', 'ArrowRight', 39], ['j', 'KeyJ', 74], ['k', 'KeyK', 75], ['y', 'KeyY', 89], ['n', 'KeyN', 78], ['1', 'Digit1', 49]];
  for (const target of [d.body, d.activeElement ?? d.body, d]) {
    for (const [key, code, keyCode, mods = {}] of keys) {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        try {
          const e = new w.KeyboardEvent(type, { key, code, keyCode, charCode: type === 'keypress' ? keyCode : 0, bubbles: true, cancelable: true, ...mods });
          if (e.which !== keyCode) Object.defineProperty(e, 'which', { value: keyCode });
          target.dispatchEvent(e);
        } catch { /* ignore */ }
      }
    }
  }
  try { d.activeElement?.blur?.(); } catch { /* ignore */ }
  await settle(w);
  page.rec.advance(10 * 60 * 1000); // ten minutes of the page's timers
  await settle(w);
}

/**
 * The gestures a person's hands make on `el` that decide nothing, with every
 * field a handler might test (Phase 1 follow-up to the Wave 3 review, finding 4):
 * a wheel turn each way and in small and large steps (a threshold handler sees
 * both sides), a context menu, mousedown / mouseup with the left and the right
 * button (`button` 0 and 2), pointer events of every `pointerType`, and touch
 * events whose `touches`, `targetTouches` and `changedTouches` hold one touch
 * (a handler testing `touches.length === 1` sees one).
 */
function gestures(w, el) {
  const at = { bubbles: true, cancelable: true, composed: true, view: w, clientX: 10, clientY: 10 };
  const fire = (make) => { try { el.dispatchEvent(make()); } catch { /* ignore */ } };
  for (const deltaY of [120, -120, 1, -1, 400, -400]) fire(() => new w.WheelEvent('wheel', { ...at, deltaY, deltaMode: 0 }));
  fire(() => new w.MouseEvent('contextmenu', { ...at, button: 2, buttons: 2 }));
  for (const [button, buttons] of [[0, 1], [2, 2]]) {
    fire(() => new w.MouseEvent('mousedown', { ...at, button, buttons, detail: 1 }));
    fire(() => new w.MouseEvent('mouseup', { ...at, button, buttons: 0, detail: 1 }));
  }
  const P = typeof w.PointerEvent === 'function' ? w.PointerEvent : w.MouseEvent;
  for (const pointerType of ['mouse', 'touch', 'pen']) {
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      fire(() => {
        const e = new P(type, { ...at, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, isPrimary: true, pointerType });
        if (e.pointerType !== pointerType) Object.defineProperty(e, 'pointerType', { value: pointerType });
        return e;
      });
    }
  }
  for (const type of ['touchstart', 'touchmove', 'touchend']) {
    fire(() => {
      const e = new w.TouchEvent(type, { bubbles: true, cancelable: true, composed: true, view: w });
      const t = { identifier: 0, target: el, clientX: 10, clientY: 10, pageX: 10, pageY: 10, screenX: 10, screenY: 10, radiusX: 1, radiusY: 1, force: 1 };
      const one = [t];
      // touchend lists the lifted touch in changedTouches only, as a browser does.
      Object.defineProperties(e, {
        touches: { value: type === 'touchend' ? [] : one },
        targetTouches: { value: type === 'touchend' ? [] : one },
        changedTouches: { value: one },
      });
      return e;
    });
  }
}

async function settle(w, ms = 30, frames = 3) {
  for (let i = 0; i < frames; i++) {
    await sleep(0);
    await new Promise((r) => (REAL_RAF.get(w) ?? ((fn) => setTimeout(fn, 16)))(() => r()));
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

/**
 * A person's click, as a browser fires it (G-VIEW hardening F2): pointerdown,
 * mousedown, focus, pointerup, mouseup, click. A page listening on any of
 * them sees the click.
 */
function click(w, el) {
  const init = { bubbles: true, cancelable: true, composed: true, view: w, button: 0, clientX: 10, clientY: 10 };
  const P = typeof w.PointerEvent === 'function' ? w.PointerEvent : w.MouseEvent;
  const pointer = (type, buttons) => { try { el.dispatchEvent(new P(type, { ...init, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch { /* ignore */ } };
  pointer('pointerdown', 1);
  el.dispatchEvent(new w.MouseEvent('mousedown', { ...init, buttons: 1, detail: 1 }));
  try { if (el.isConnected && typeof el.focus === 'function') el.focus(); } catch { /* ignore */ }
  pointer('pointerup', 0);
  el.dispatchEvent(new w.MouseEvent('mouseup', { ...init, buttons: 0, detail: 1 }));
  el.dispatchEvent(new w.MouseEvent('click', { ...init, buttons: 0, detail: 1 }));
}

/**
 * Every value a person can pick in an unmarked form control (F1): each option
 * of a select, both states of a checkbox, a radio, the ends and middle of a
 * range, each followed by `input` and `change` as a browser fires them.
 */
function pickEveryValue(w, el) {
  const pick = (set) => {
    if (!el.isConnected) return;
    try { set(); } catch { return; }
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  if (el.tagName === 'SELECT') {
    const n = el.options.length;
    for (let i = 0; i < n; i++) pick(() => { if (el.multiple) el.options[i].selected = !el.options[i].selected; else el.selectedIndex = i; });
    if (n > 0 && !el.multiple) pick(() => { el.selectedIndex = 0; });
    return;
  }
  const type = String(el.type ?? '').toLowerCase();
  if (type === 'checkbox') { pick(() => { el.checked = !el.checked; }); pick(() => { el.checked = !el.checked; }); }
  else if (type === 'radio') pick(() => { el.checked = true; });
  else if (type === 'range') {
    const num = (x, dflt) => (Number.isFinite(Number.parseFloat(x)) ? Number.parseFloat(x) : dflt);
    const min = num(el.min, 0), max = num(el.max, 100);
    for (const v of [max, min, (min + max) / 2]) pick(() => { el.value = String(v); });
  }
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
      else if (Math.abs(n - Number(gateMoney(want))) > EPS) {
        // Exact = as the spend gate prints it (four decimals at most), never rounded further.
        const rounded = Math.abs(n - want) < 0.05 && String(n).length < gateMoney(want).length;
        fail('R2', rounded ? 'rounded-money' : 'wrong-money', `${what} shows ${text(shown)}, exactly ${gateMoney(want)} expected${rounded ? ' (rounded)' : ''}${tag}`);
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
    if (tot.length && Math.abs((firstNumber(text(tot[0])) ?? NaN) - Number(gateMoney(m.ledgerTotal))) > EPS) fail('R2', 'wrong-money', `the ledger total shows ${text(tot[0])}, exactly ${gateMoney(m.ledgerTotal)} expected${tag}`);
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
  if (ds && removedAt(p, ds) === undefined && (ds.status === 'pending-review' || ds.status === 'needs-rework')) {
    for (const a of ['approve', 'request-changes', 'note']) if (!control(a, ds.id)) fail('contract', 'missing-control', `shot detail for ${ds.id} has no visible "${a}" control`);
  }
  for (const j of p.pending_spend.filter((x) => x.status === 'awaiting-approval')) {
    for (const a of ['approve-spend', 'decline-spend']) if (!control(a, j.id)) fail('contract', 'missing-control', `the paid job ${j.id} has no visible "${a}" control`);
  }
  for (const a of p.assets.filter((x) => x.status === 'pending-review' && removedAt(p, x) === undefined)) if (!control('approve', a.id)) fail('contract', 'missing-control', `${a.id} is waiting for review but has no visible approve control`);
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
  page.rec.advance(TEN_MINUTES); // a write the click schedules for later is the click's (C3)
  await settle(page.w, 0, 1);
  let fresh = [...decisions(page).entries()].filter(([id]) => !before.has(id)).map(([, v]) => v.d);
  if (fresh.length === 0 && opts.text !== undefined) {
    const ta = [...page.d.querySelectorAll('textarea[data-akuko-text], input[data-akuko-text]')].find((e) => !hiddenReason(page.w, e));
    const submit = [...page.d.querySelectorAll('[data-akuko-submit]')].find((e) => !hiddenReason(page.w, e));
    if (ta && submit) {
      ta.value = opts.text;
      ta.dispatchEvent(new page.w.Event('input', { bubbles: true }));
      click(page.w, submit);
      await settle(page.w);
      page.rec.advance(TEN_MINUTES);
      await settle(page.w, 0, 1);
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
  if (shot && removedAt(p, shot) === undefined && (shot.status === 'pending-review' || shot.status === 'needs-rework')) {
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
  const asset = p.assets.find((a) => a.status === 'pending-review' && removedAt(p, a) === undefined);
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

/**
 * R1, every control: click everything a person can click, one at a time.
 * A control not marked data-akuko-action writes nothing (a composer's
 * [data-akuko-submit] may write the one decision it was opened for); a
 * marked control writes at most one decision, for its own unit, with its own action.
 */
async function sweep(html, p, fail, host = 'A') {
  const page = await load(html, p, host);
  const where = host === 'A' ? '' : host === 'C' ? ' (in Ikenga)' : ' (as a local file)';
  const INTERACTIVE = 'button, a[href], input, select, summary, label, [role="button"], [role="tab"], [role="link"], [role="checkbox"], [role="menuitem"], [role="option"], [onclick], [tabindex], [data-select], [data-act]';
  const name = (el) => (el.getAttribute('aria-label') || text(el) || el.getAttribute('title') || el.tagName.toLowerCase()).slice(0, 48);
  const sig = (el) => [el.tagName, el.id, el.getAttribute('data-k'), el.getAttribute('data-akuko-action'), el.getAttribute('data-akuko-unit'), el.getAttribute('data-select'), el.getAttribute('data-act'), el.getAttribute('data-id'), name(el)].join('|');
  const done = new Set();
  for (let guard = 0; guard < 400; guard++) {
    const el = [...page.d.querySelectorAll(INTERACTIVE)].find((e) => !done.has(sig(e)) && !e.matches('textarea, input[type="text"], input:not([type])') && !hiddenReason(page.w, e));
    if (!el) break;
    done.add(sig(el));
    const a = el.getAttribute('data-akuko-action');
    const u = el.getAttribute('data-akuko-unit');
    const before = new Set(decisions(page).keys());
    page.rec.epoch++;
    click(page.w, el);
    if (!a) gestures(page.w, el); // right button, touch, pen: none of them decides anything on a control that is not a decision control
    const picks = !a && el.matches('select, input[type="checkbox" i], input[type="radio" i], input[type="range" i]');
    if (picks) pickEveryValue(page.w, el);
    await settle(page.w, 0, 1);
    page.rec.advance(TEN_MINUTES); // what the click schedules for later counts too (C3)
    await settle(page.w, 0, 1);
    const fresh = [...decisions(page).entries()].filter(([id]) => !before.has(id)).map(([, v]) => v.d);
    const list = fresh.map((x) => `${x.action}:${x.unit}`).join(', ');
    if (!a) {
      if (el.hasAttribute('data-akuko-submit') && fresh.length <= 1) continue;
      if (fresh.length) fail('R1', 'unmarked-control-writes', `"${name(el)}" is not a decision control (no data-akuko-action) but ${picks ? 'clicking it or picking one of its values' : 'clicking it'} wrote ${list}${where}`);
    } else {
      if (fresh.some((x) => x.unit !== u)) fail('R1', 'writes-other-unit', `the "${a}" control for ${u} also wrote ${list}: one click, one unit${where}`);
      else if (fresh.length > 1) fail('R1', 'batch-approve', `one "${a}" click on ${u} wrote ${fresh.length} decisions (${list})${where}`);
      else if (fresh.length === 1 && fresh[0].action !== a) fail('decision', 'wrong-action', `the "${a}" control for ${u} wrote "${fresh[0].action}"${where}`);
    }
    for (const v of page.rec.violations.splice(0)) fail('R4', 'writes-project', `after clicking "${name(el)}": ${v}; views write decisions only${where}`);
  }
  // A click on what is not a control (a card, a field, a view, the page itself) writes nothing (C5).
  for (const el of [page.d.body, ...page.d.querySelectorAll('[data-akuko-field], [data-akuko-unit], [data-akuko-view]')].slice(0, 400)) {
    if (!el || !el.isConnected || el.matches(INTERACTIVE) || el.hasAttribute('data-akuko-action') || el.hasAttribute('data-akuko-submit') || hiddenReason(page.w, el)) continue;
    const before = new Set(decisions(page).keys());
    page.rec.epoch++;
    click(page.w, el);
    gestures(page.w, el);
    await sleep(0);
    page.rec.advance(TEN_MINUTES);
    await sleep(0);
    const fresh = [...decisions(page).entries()].filter(([id]) => !before.has(id)).map(([, v]) => v.d);
    if (fresh.length) fail('R1', 'unmarked-control-writes', `clicking "${name(el)}" (not a decision control) wrote ${fresh.map((x) => `${x.action}:${x.unit}`).join(', ')}${where}`);
    for (const v of page.rec.violations.splice(0)) fail('R4', 'writes-project', `after clicking "${name(el)}": ${v}; views write decisions only${where}`);
  }
  // A double-click on anything that is not a decision control writes nothing (F6).
  for (const el of [...page.d.querySelectorAll(`${INTERACTIVE}, [data-akuko-field], [data-akuko-unit], [data-akuko-view]`)].slice(0, 400)) {
    if (!el.isConnected || el.hasAttribute('data-akuko-action') || el.hasAttribute('data-akuko-submit') || hiddenReason(page.w, el)) continue;
    const before = new Set(decisions(page).keys());
    page.rec.epoch++;
    el.dispatchEvent(new page.w.MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, view: page.w, button: 0, detail: 2 }));
    await sleep(0);
    page.rec.advance(TEN_MINUTES);
    await sleep(0);
    const fresh = [...decisions(page).entries()].filter(([id]) => !before.has(id)).map(([, v]) => v.d);
    if (fresh.length) fail('R1', 'unmarked-control-writes', `double-clicking "${name(el)}" (not a decision control) wrote ${fresh.map((x) => `${x.action}:${x.unit}`).join(', ')}${where}`);
    for (const v of page.rec.violations.splice(0)) fail('R4', 'writes-project', `after double-clicking "${name(el)}": ${v}; views write decisions only${where}`);
  }
  const frame = page.d.querySelector(FRAMES);
  if (frame) fail('R4', 'iframe-in-view', `after the clicks the page holds a <${frame.tagName.toLowerCase()}>${where}: a frame runs code the check cannot see; views embed none`);
  page.close();
}

/** Embedded browsing contexts: their scripts are not checked, so a view holds none (07a2 review B7). */
const FRAMES = 'iframe, frame, object, embed';
const FRAME_TAG = /<(iframe|frame|object|embed)\b/i;

/** A page's load, idle and ten minutes of its clock on one host: what it wrote unasked (07a2 review C2). */
async function idleOn(html, project, host) {
  const page = await load(html, project, host, host === 'A' ? 400 : 40);
  const onOpen = new Set([...decisions(page).keys()]);
  const emptied = page.rec.posts.some((p) => p.msg?.__iyke && p.msg.kind === 'state' && p.msg.payload?.key === STATE_KEY && Array.isArray(p.msg.payload.value) && p.msg.payload.value.length === 0);
  await idle(page);
  const emptiedLater = page.rec.posts.some((p) => p.msg?.__iyke && p.msg.kind === 'state' && p.msg.payload?.key === STATE_KEY && Array.isArray(p.msg.payload.value) && p.msg.payload.value.length === 0);
  return { page, onOpen, emptied: emptied || emptiedLater, frame: page.d.querySelector(FRAMES) };
}

/**
 * A read-only view needs no check (§2), but only if it really is one. Its
 * manifest says `writes_decisions: false` and it has no decision control and
 * no decision writer; this then opens it on every host, idles, clicks, picks
 * and double-clicks everything, and returns what it saw it write (decisions
 * in any store, or the project). Empty: it is read-only. A page cannot dodge
 * the check by saying so in its manifest.
 */
async function readOnlyProbe(html, project) {
  const found = [];
  const code = scripts(html).join('\n');
  for (const [re, what] of PROJECT_WRITES) if (re.test(code)) found.push(`the page ${what}`);
  if (FRAME_TAG.test(uncommented(html))) found.push('it embeds a frame (<iframe>, <frame>, <object> or <embed>), whose code the check cannot see');
  for (const host of ['A', 'C', 'local']) {
    const { page, frame } = await idleOn(html, project, host);
    for (const { d, store } of decisions(page).values()) found.push(`it wrote a "${d.action}" for ${d.unit} (${store}) while it opened and idled`);
    for (const v of page.rec.violations.splice(0)) found.push(v);
    if (frame) found.push('it creates a frame, whose code the check cannot see');
    page.close();
    await sweep(html, project, (_rule, _code, message) => found.push(message), host);
  }
  return [...new Set(found)];
}

/** The skill's own conformed list: the views it ships (WP-07b's default board among them). */
// AKUKO_CHECK_VIEW_SHIPPED_LIST points it elsewhere for check-view's own tests only.
export const SHIPPED_LIST = resolve(process.env.AKUKO_CHECK_VIEW_SHIPPED_LIST || join(SKILL, 'views', 'conformed.json'));
/** Is this path the skill's shipped list? (--ship records nowhere else.) */
export const isShippedList = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() === SHIPPED_LIST.toLowerCase() : resolve(path) === SHIPPED_LIST);
const FIXTURE_VIEWS = [['test-board@1', 'tiny-board.html'], ['board-b-instrumented@0.1', 'board-b-instrumented.html']];
const idOf = (view) => view.slice(0, view.lastIndexOf('@'));

/**
 * Ids people rely on: the views the skill ships (views/conformed.json, plus
 * the list given with --ship), its own fixtures, and "default-board". A page
 * reusing one would borrow their conformance record (G-VIEW review C7).
 * `views` maps each recorded id@version to the hashes this checker recorded
 * for it (an entry from an older checker reserves the id but carries no
 * comparable hash).
 */
function reservedViews(extra = []) {
  const views = new Map();
  const ids = new Set(['default-board']);
  for (const path of [SHIPPED_LIST, ...extra]) {
    let list;
    try { list = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; /* no list yet */ }
    for (const v of list.views ?? []) {
      if (!v || typeof v.view !== 'string' || !v.view.includes('@')) continue;
      ids.add(idOf(v.view));
      const set = views.get(v.view) ?? new Set();
      if (v.sha256 && v.checker === CHECKER) set.add(v.sha256);
      views.set(v.view, set);
    }
  }
  for (const [view, file] of FIXTURE_VIEWS) {
    try {
      const h = conformanceHash(readFileSync(join(SKILL, 'views', '__fixtures__', file), 'utf8'));
      ids.add(idOf(view));
      views.set(view, new Set([...(views.get(view) ?? []), h]));
    } catch { /* fixture absent */ }
  }
  return { views, ids };
}

/**
 * id-collision (C7). Always: an id@version recorded for different HTML fails
 * (bump the version). Without --ship: any reserved id fails unless this very
 * page is what is recorded under it. With --ship <list>: a new version of a
 * shipped view (or a first one) may be checked, to be recorded into that list.
 */
function idCollision(view, sha256, fail, ship) {
  const { views, ids } = reservedViews(ship ? [ship] : []);
  const hashes = views.get(view);
  if (hashes && hashes.size > 0 && !hashes.has(sha256)) {
    fail('contract', 'id-collision', `the manifest says ${view}, a view id the skill already uses for different HTML; give this page its own id or a new version`);
  } else if (!ship && ids.has(idOf(view)) && !(hashes && hashes.has(sha256))) {
    fail('contract', 'id-collision', `"${idOf(view)}" is the id of a view the skill ships; give this page its own id (a new version of a shipped view is recorded with --ship <views/conformed.json>)`);
  } else if (ship && /^freehand:/.test(view)) {
    fail('contract', 'id-collision', `${view} is a freehand view; --ship records only the skill's own views`);
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
  const sha256 = conformanceHash(html);
  decisionsChecked = 0;
  let manifest = null;
  const raw = jsonBlock(html, 'akuko-view');
  if (raw === undefined) fail('contract', 'no-manifest', 'no <script type="application/json" id="akuko-view"> manifest');
  else if (typeof raw === 'object') fail('contract', 'bad-manifest', `${raw.bad}: the manifest must be one <script type="application/json" id="akuko-view"> block`);
  else {
    try { manifest = JSON.parse(raw); } catch { fail('contract', 'bad-manifest', 'the akuko-view manifest is not JSON'); }
    if (manifest && !validManifest(manifest)) fail('contract', 'bad-manifest', `the akuko-view manifest does not match views/views.schema.json: ${ajv.errorsText(validManifest.errors)}`);
  }
  // The project block, found as the conformance hash finds it (C1): anything
  // ambiguous fails closed, since its content is left out of the hash.
  const pb = findJsonBlock(html, PROJECT_BLOCK);
  if (pb.status === 'bad') {
    fail('contract', 'bad-project-block', `${pb.reason}. The page holds the project in exactly one <script type="application/json" id="akuko-project"> block, empty or JSON (views/contract.md §1, §8)`);
    return { ok: false, view: manifest ? `${manifest.id}@${manifest.version}` : null, sha256, failures, decisions_checked: 0, manual: [] };
  }
  // Read-only (§2): no check applies, once the page is seen to write nothing.
  const claimsReadOnly = !!manifest && validManifest(manifest) && manifest.writes_decisions === false;
  // One predicate with the publish gate (predicates.mjs, 07a2 review B8); comments never count.
  const signs = decisionWriteSigns(html);
  const hasDecisionCode = signs.length > 0;
  if (claimsReadOnly && hasDecisionCode) fail('R1', 'read-only-writes', `the manifest says writes_decisions: false, but the page has ${signs.join(', ')}: a page that writes is held to the whole contract`);
  if (claimsReadOnly && !hasDecisionCode) {
    const why = await readOnlyProbe(html, project);
    if (why.length === 0) {
      return { ok: true, skipped: true, view: `${manifest.id}@${manifest.version}`, sha256, failures: [], decisions_checked: 0, manual: [], note: 'read-only (not applicable)' };
    }
    for (const m of why) fail('R1', 'read-only-writes', `the manifest says writes_decisions: false, but ${m}: a page that writes is held to the whole contract`);
  }
  if (injectProject(html, project) === undefined) {
    fail('contract', 'no-project-block', 'no <script type="application/json" id="akuko-project"> block to read the project from');
    return { ok: false, view: manifest ? `${manifest.id}@${manifest.version}` : null, sha256, failures, manual: [] };
  }
  staticChecks(html, fail);

  // R1: nothing is written while the page opens, idles, is hovered, scrolled,
  // focused, hidden and shown, or typed at, nor when ten minutes of its timers run.
  const first = await load(html, project, 'A', 400);
  for (const e of first.rec.errors) fail('contract', 'page-error', `the page threw: ${e}`);
  const onOpen = new Set([...decisions(first).keys()]);
  for (const v of first.rec.violations.splice(0)) fail('R4', 'writes-project', `${v}; views write decisions only`);
  checkStructure(first, project, fail, '');
  checkControls(first, project, fail);
  first.close();
  // ... on every host: a page must not behave differently in Ikenga or as a local file (C2)
  for (const host of ['A', 'C', 'local']) {
    const where = host === 'A' ? '' : host === 'C' ? ' in Ikenga' : ' as a local file';
    const { page, onOpen: opened, emptied, frame } = await idleOn(html, project, host);
    for (const [id, { d }] of decisions(page)) {
      const auto = d.action === 'approve' || d.action === 'approve-spend';
      const when = opened.has(id) || onOpen.has(id) ? 'as the page opened' : 'while the person only moved, scrolled, focused or pressed keys, or as time passed';
      fail('R1', auto ? 'auto-approve' : 'decision-without-action', `the page wrote a "${d.action}" for ${d.unit} ${when}${where}, before anyone chose it`);
    }
    for (const v of page.rec.violations.splice(0)) fail('R4', 'writes-project', `${v}${where}; views write decisions only`);
    // C6: with nothing in its outbox, a page never posts an empty list over the shell's stored decisions
    if (host === 'C' && emptied) fail('contract', 'empties-ikenga-store', 'in Ikenga the page posted an empty akuko.decisions list with nothing decided: after a pane remount that wipes the decisions the shell holds (decision writer v2 never does)');
    if (frame) fail('R4', 'iframe-in-view', `the page creates a <${frame.tagName.toLowerCase()}>${where}: a frame runs code the check cannot see; views embed none`);
    page.close();
  }

  const mutated = mutateProject(project);
  const second = await load(html, mutated, 'A');
  checkStructure(second, mutated, fail, 'with a changed project');
  second.close();

  if (manifest?.writes_decisions !== false || hasDecisionCode) {
    await clickTests(html, project, manifest, fail);
    await sweep(html, project, fail, 'A');
    await sweep(html, project, fail, 'C');
  }
  if (manifest) idCollision(`${manifest.id}@${manifest.version}`, sha256, fail, opts.ship);
  return {
    ok: failures.length === 0,
    view: manifest ? `${manifest.id}@${manifest.version}` : null,
    sha256,
    failures,
    decisions_checked: decisionsChecked,
    manual: ['R5 contrast ≥ 4.5:1 and body text ≥ 14px are checked by eye (designs/_spec.md)'],
  };
}
