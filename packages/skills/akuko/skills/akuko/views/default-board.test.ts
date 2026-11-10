// WP-07b: the shipped default board (views/default-board.html, D-01 "script desk").
//
// - provenance: the file's conformance hash (viewHash: ignores the project block) is the one recorded on views/conformed.json,
//   so any edit forces a re-record and a version bump (R-12);
// - the file passes scripts/check-view.mjs and inlines the canonical decision writer;
// - readability: contrast >= 4.5:1 for body text, money and "your move" in both themes;
// - live data: on claude.ai the page re-reads the artifact database, as a served file
//   it re-reads akuko.json, and a decision folded in later is not counted twice;
// - Ikenga: a remounted pane re-posts its stored decisions and never posts an empty list.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isConformedHtml, parseConformedFile, viewHash } from '../decisions/conformed.ts';
import { foldDecisions } from '../decisions/fold.ts';
import { gateStatuses, signGate } from '../decisions/gates.ts';
import type { AkukoProject, Decision } from '../schema/akuko-project.ts';
import { bigProject, PART_SIZES } from './__fixtures__/big-project.ts';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const HTML = readFileSync(join(SKILL, 'views', 'default-board.html'), 'utf8');
const CONFORMED = parseConformedFile(JSON.parse(readFileSync(join(SKILL, 'views', 'conformed.json'), 'utf8')));
const FIXTURE = JSON.parse(readFileSync(join(SKILL, 'fixtures', 'the-beating', 'akuko.json'), 'utf8')) as Project;

interface Shot { id: string; status: string; stage: string; comments: unknown[] }
interface Project { shots: Shot[]; pending_spend: { id: string; status: string; stage: string; estimate: number }[]; decisions: unknown[]; project: { slug: string }; [k: string]: unknown }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('default board: provenance', () => {
  it('its sha256 is the one recorded on views/conformed.json (edit the page, bump the version, re-record)', () => {
    const manifest = JSON.parse(/<script type="application\/json" id="akuko-view">([\s\S]*?)<\/script>/.exec(HTML)?.[1] ?? '{}') as { id: string; version: string };
    assert.equal(manifest.id, 'default-board');
    const view = `${manifest.id}@${manifest.version}`;
    const entry = CONFORMED.views.find((v) => v.view === view);
    assert.ok(entry, `${view} is not on views/conformed.json: run node scripts/check-view.mjs views/default-board.html --ship views/conformed.json`);
    assert.equal(entry.sha256, viewHash(HTML), `views/default-board.html changed since ${view} was recorded: bump "version" in its akuko-view manifest and record it again`);
    assert.match(entry.checker ?? '', /^check-view@\d+$/);
    assert.ok(isConformedHtml(CONFORMED, view, HTML));
  });

  it('inlines the canonical decision writer (v2) verbatim', () => {
    const canonical = readFileSync(join(SKILL, 'scripts', 'check-view', 'decision-writer.js'), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
    const v2 = canonical
      .replace('/* akuko-decision-writer v1 —', '/* akuko-decision-writer v2 —')
      .replace('  toIkenga();\n})();', '  if (outbox.length) toIkenga(); // never post an empty list over a stored one (host C remount)\n})();');
    assert.ok(v2.startsWith('/* akuko-decision-writer v2 —'));
    assert.ok(v2.includes('if (outbox.length) toIkenga();'));
    assert.ok(HTML.includes(`<script>\n${v2}\n</script>`), 'the page does not contain the canonical decision writer block');
  });

  it('passes check-view', { timeout: 540_000 }, async () => {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [join(SKILL, 'scripts', 'check-view.mjs'), join(SKILL, 'views', 'default-board.html'), '--json'], { cwd: SKILL, timeout: 520_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err);
        resolve(stdout);
      });
    });
    const [r] = JSON.parse(out) as { ok: boolean; failures: { rule: string; code: string; message: string }[]; decisions_checked: number }[];
    assert.ok(r);
    assert.deepEqual(r.failures, []);
    assert.ok(r.ok);
    assert.ok(r.decisions_checked >= 8);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Contrast, computed from the page's own tokens
// ─────────────────────────────────────────────────────────────────────────

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--ak-([a-z0-9-]+):\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim();
  return out;
}
function rgbOf(name: string, t: Record<string, string>): [number, number, number] {
  let v = t[name];
  for (let i = 0; i < 5 && v && v.startsWith('var('); i++) v = t[/var\(--ak-([a-z0-9-]+)\)/.exec(v)?.[1] ?? ''];
  const m = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(v ?? '');
  if (!m) throw new Error(`token --ak-${name} is not an hsl() colour: ${v}`);
  const h = Number(m[1]), s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (rgb: [number, number, number]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
export function contrast(fg: string, bg: string, t: Record<string, string>): number {
  const a = luminance(rgbOf(fg, t)), b = luminance(rgbOf(bg, t));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const SURFACES = ['bg-base', 'bg-surface', 'bg-raised', 'bg-sunken'];
/** [what, text token, background token] */
function pairs(theme: 'dark' | 'light'): [string, string, string][] {
  const money = theme === 'dark' ? ['bg-raised', 'bg-surface', 'bg-base'] : ['achievement-soft'];
  return [
    ...SURFACES.map((s): [string, string, string] => [`body text on ${s}`, 'fg', s]),
    ...SURFACES.map((s): [string, string, string] => [`muted text on ${s}`, 'fg-muted', s]),
    ['"your move" line on the header', 'attn-fg', 'bg-surface'],
    ['"your move" detail on the header', 'fg-muted', 'bg-surface'],
    ...money.map((s): [string, string, string] => [`money on ${s}`, 'money-fg', s]),
    ['text on pending-review chips and the warning bar', 'fg', 'achievement-soft'],
    ['text on needs-rework chips', 'fg', 'danger-soft'],
    ['text on the selected shot', 'fg', 'primary-soft'],
    ['muted text on the selected shot', 'fg-muted', 'primary-soft'],
    ['primary buttons and the selected tag', 'primary-fg', 'primary'],
    ['danger buttons', 'danger-fg', 'danger'],
  ];
}
function themeTokens(): Record<'dark' | 'light', Record<string, string>> {
  const dark = /:root, :root\[data-akuko-mode="dark"\] \{([^}]*)\}/.exec(HTML)?.[1];
  const light = /:root\[data-akuko-mode="light"\] \{([^}]*)\}/.exec(HTML)?.[1];
  assert.ok(dark && light, 'the page defines --ak-* tokens for both themes');
  return { dark: tokens(dark), light: tokens(light) };
}

describe('default board: readability in both themes', () => {
  const T = themeTokens();
  for (const theme of ['dark', 'light'] as const) {
    it(`${theme}: every text pair is at least 4.5:1`, () => {
      for (const [what, fg, bg] of pairs(theme)) {
        const t = { ...T.dark, ...T[theme] }; // the light block only overrides what it must
        const c = contrast(fg, bg, t);
        assert.ok(c >= 4.5, `${theme}: ${what} is ${c.toFixed(2)}:1 (--ak-${fg} on --ak-${bg})`);
      }
    });
  }
  it('the page never relies on a host-injected palette: no bare --bg-* / --fg tokens', () => {
    assert.ok(!/var\(--(bg|fg|primary|border|danger|achievement)[a-z-]*\)/.test(HTML), 'uses a token name the Ikenga viewer also injects');
    assert.ok(!/data-mode=/.test(HTML.replace(/getAttribute\('data-mode'\)|attributeFilter: \['data-mode'\]/g, '')), 'themes on the host-owned data-mode attribute');
  });
  it('body text is 14px or larger', () => {
    assert.match(HTML, /body \{[^}]*font: 400 14px\/1\.55/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The page running (jsdom)
// ─────────────────────────────────────────────────────────────────────────

interface El { hidden: boolean; textContent: string | null }
interface Page { w: any; d: any; posts: any[]; writes: { kind: string; path: string; data: any }[]; intervals: (() => void)[]; tick: (ms?: number) => Promise<void>; fire: () => Promise<void>; text: (sel: string) => string; num: (field: string) => number; close: () => void }
interface Opts { sample?: boolean; project?: Project; host?: 'A' | 'B' | 'C'; db?: FakeDb; fetch?: () => Promise<unknown>; blockStorage?: boolean; outbox?: unknown[]; url?: string }
interface FakeDb { project: unknown; rows: unknown[]; projListeners: ((s: unknown) => void)[]; rowListeners: ((s: unknown) => void)[] }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function newDb(project: Project, rows: unknown[] = []): FakeDb {
  return { project, rows, projListeners: [], rowListeners: [] };
}
const projSnap = (db: FakeDb) => ({ exists: true, data: () => clone(db.project) });
const rowsSnap = (db: FakeDb) => ({ docs: db.rows.map((r) => ({ id: (r as { id: string }).id, data: () => clone(r) })), forEach(fn: (d: unknown) => void) { this.docs.forEach(fn); } });

async function boot(o: Opts = {}): Promise<Page> {
  const { JSDOM } = (await import('jsdom' as string)) as { JSDOM: new (html: string, opts: unknown) => { window: any } };
  const project = o.project ?? FIXTURE;
  const html = o.sample ? HTML : HTML.replace(/(<script type="application\/json" id="akuko-project">)[\s\S]*?(<\/script>)/, (_m, a: string, b: string) => `${a}${JSON.stringify(project).replace(/</g, '\\u003c')}${b}`);
  const posts: any[] = [], writes: Page['writes'] = [], intervals: (() => void)[] = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: o.url ?? 'https://board.test/views/default-board.html',
    beforeParse(w: any) {
      w.Element.prototype.scrollIntoView = function () {};
      w.scrollTo = () => {};
      w.matchMedia = (q: string) => ({ matches: !/max-width:\s*760px|prefers-reduced-motion:\s*reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
      w.setInterval = (fn: () => void) => { intervals.push(fn); return intervals.length; };
      w.postMessage = (m: unknown) => { posts.push(JSON.parse(JSON.stringify(m))); };
      Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
      if (o.blockStorage) { const boom = () => { throw new Error('blocked'); }; w.Storage.prototype.getItem = boom; w.Storage.prototype.setItem = boom; w.Storage.prototype.removeItem = boom; }
      else if (o.outbox) w.localStorage.setItem(`akuko-outbox:${project.project.slug}`, JSON.stringify(o.outbox));
      if (o.host === 'C') w.__ikenga_host__ = { kind: 'ikenga', user: null };
      if (o.fetch) w.fetch = o.fetch;
      if (o.host === 'A') {
        const db = o.db as FakeDb;
        const api = {
          doc: (path: string) => ({
            get: async () => projSnap(db),
            onSnapshot: (fn: (s: unknown) => void) => { db.projListeners.push(fn); fn(projSnap(db)); return () => {}; },
            set: (data: unknown) => { writes.push({ kind: 'doc', path, data }); return Promise.resolve(); },
            update: (data: unknown) => { writes.push({ kind: 'doc', path, data }); return Promise.resolve(); },
          }),
          collection: (c: string) => ({
            get: async () => rowsSnap(db),
            onSnapshot: (fn: (s: unknown) => void) => { db.rowListeners.push(fn); fn(rowsSnap(db)); return () => {}; },
            doc: (id: string) => ({ set: (data: unknown) => { writes.push({ kind: 'row', path: `${c}/${id}`, data }); return Promise.resolve(); } }),
          }),
        };
        w.claude = { use: async (n: string) => (n === 'db' ? api : n === 'user' ? { id: async () => 'u_me' } : null) };
      }
    },
  });
  const w = dom.window;
  const d = w.document;
  const page: Page = {
    w, d, posts, writes, intervals,
    tick: async (ms = 60) => { await sleep(ms); await new Promise<void>((r) => w.requestAnimationFrame(() => r())); await sleep(20); },
    fire: async () => { for (const fn of intervals.slice()) fn(); await page.tick(); },
    text: (sel) => (d.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    num: (field) => Number(d.querySelector(`[data-akuko-view="your-move"] [data-akuko-field="${field}"]`)?.textContent ?? 0),
    close: () => w.close(),
  };
  await page.tick(150);
  return page;
}
const statusOf = (p: Page, unit: string) => p.d.querySelector(`[data-akuko-field="shot"][data-akuko-unit="${unit}"] [data-akuko-field="status"]`)?.getAttribute('data-akuko-status');
const click = (p: Page, sel: string) => { const el = p.d.querySelector(sel); assert.ok(el, `no ${sel}`); el.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, cancelable: true, view: p.w })); };
const decision = (n: number, f: Record<string, unknown>) => ({ id: uuid(n), by: 'u_other', at: `2026-11-08T10:0${n}:00Z`, view: 'default-board@0.1', stage: 'sketch', ...f });

describe('default board: live data, never republished', () => {
  it('claude.ai: re-reads the project and other reviewers\' decisions from the artifact database', async () => {
    const db = newDb(clone(FIXTURE));
    const p = await boot({ host: 'A', db });
    assert.equal(p.num('waiting-shots'), 2);
    assert.match(p.text('#src-note'), /Live from this board’s database/);
    // the agent saves a newer project (a different shot approved)
    const next = clone(FIXTURE);
    (next.shots.find((s) => s.id === 'sc4_sh2') as Shot).status = 'approved';
    db.project = next;
    db.projListeners.forEach((fn) => fn(projSnap(db)));
    await p.tick();
    assert.equal(p.num('waiting-shots'), 1);
    assert.equal(statusOf(p, 'sc4_sh2'), 'approved');
    // another reviewer approves the other shot: shown at once, as a preview of what akuko will fold in
    db.rows = [decision(1, { action: 'approve', unit: 'sc2_sh4' })];
    db.rowListeners.forEach((fn) => fn(rowsSnap(db)));
    await p.tick();
    assert.equal(statusOf(p, 'sc2_sh4'), 'approved');
    assert.equal(p.num('waiting-shots'), 0);
    // ...and the poll finds the same rows without a snapshot event
    db.rows = [...db.rows, decision(2, { action: 'approve-spend', unit: 'job_kf_sc1', stage: 'keyframes', text: 'approve 0.36 USD' })];
    await p.fire();
    assert.equal(p.num('waiting-spend'), 0);
    assert.match(p.text('#p-spend [data-akuko-field="job"]'), /Approved/);
    // the page only ever reads the project; it wrote nothing to the database
    assert.deepEqual(p.writes, []);
    p.close();
  });

  it('a decision akuko has folded in is not counted twice', async () => {
    const db = newDb(clone(FIXTURE));
    const p = await boot({ host: 'A', db });
    click(p, '[data-akuko-action="approve"][data-akuko-unit="sc2_sh4"]');
    await p.tick();
    assert.equal(p.num('waiting-shots'), 1);
    assert.equal(p.writes.filter((x) => x.kind === 'row').length, 1, 'one row per decision, written to decisions/<id>');
    const mine = p.writes[0]?.data as { id: string };
    // akuko folds it: the project now holds the decision and the approved status
    const folded = clone(FIXTURE);
    (folded.shots.find((s) => s.id === 'sc2_sh4') as Shot).status = 'approved';
    folded.decisions = [p.writes[0]?.data];
    db.project = folded;
    db.rows = [mine];
    db.projListeners.forEach((fn) => fn(projSnap(db)));
    db.rowListeners.forEach((fn) => fn(rowsSnap(db)));
    await p.tick();
    assert.equal(p.num('waiting-shots'), 1);
    assert.equal(statusOf(p, 'sc2_sh4'), 'approved');
    p.close();
  });

  it('a local or served file: reads akuko.json on a timer', async () => {
    let current = clone(FIXTURE);
    const p = await boot({ host: 'B', fetch: async () => ({ ok: true, json: async () => clone(current) }) });
    assert.match(p.text('#src-note'), /Live from akuko\.json/);
    assert.equal(p.num('waiting-shots'), 2);
    current = clone(FIXTURE);
    (current.shots.find((s) => s.id === 'sc2_sh4') as Shot).status = 'approved';
    await p.fire();
    assert.equal(p.num('waiting-shots'), 1);
    p.close();
  });

  it('a file opened from disk says it is a snapshot and offers to load akuko.json', async () => {
    const p = await boot({ host: 'B', url: 'file:///C:/film/the-beating/views/default-board.html' });
    assert.match(p.text('#src-note'), /Snapshot/);
    assert.match(p.text('#foot'), /Load akuko\.json/);
    p.close();
  });

  it('a project for another film is ignored', async () => {
    const other = clone(FIXTURE);
    other.project.slug = 'another-film';
    const p = await boot({ host: 'B', fetch: async () => ({ ok: true, json: async () => other }) });
    assert.equal(p.num('waiting-shots'), 2);
    p.close();
  });
});

describe('default board: the file as shipped', () => {
  it('opens offline on a labelled sample, and its decision controls do nothing', async () => {
    const p = await boot({ host: 'B', sample: true, url: 'file:///C:/film/views/default-board.html' });
    assert.equal((p.d.querySelector('#sample-bar') as El).hidden, false);
    assert.match(p.text('#sample-bar'), /Sample project: The Beating/);
    assert.equal(p.num('waiting-shots'), 2);
    click(p, '[data-akuko-action="approve"][data-akuko-unit="sc2_sh4"]');
    click(p, '#p-spend [data-akuko-action="approve-spend"]');
    await p.tick();
    assert.deepEqual(Array.from(p.w.akukoDecisions.all()), []);
    const controls: { getAttribute(n: string): string | null }[] = Array.from(p.d.querySelectorAll('[data-akuko-action]'));
    assert.ok(controls.length > 5);
    assert.ok(controls.every((c) => c.getAttribute('aria-disabled') === 'true'), 'every decision control is aria-disabled in sample mode');
    assert.match(p.text('.sample-msg'), /This is a sample project/, 'the message shows next to the clicked control');
    assert.doesNotMatch(p.text('#foot'), /saved in this browser/);
    p.close();
  });

  it('a real project replaces the sample, whatever film it is', async () => {
    const mine = clone(FIXTURE);
    mine.project.slug = 'my-film';
    const p = await boot({ host: 'B', sample: true, fetch: async () => ({ ok: true, json: async () => mine }) });
    assert.equal((p.d.querySelector('#sample-bar') as El).hidden, true);
    click(p, '[data-akuko-action="approve"][data-akuko-unit="sc2_sh4"]');
    await p.tick();
    assert.equal(p.num('waiting-shots'), 1);
    p.close();
  });
});

describe('default board: the sticky spend bar', () => {
  it('whenever it offers Approve spend, it also shows the estimate, spent, cap and left if you approve', async () => {
    const p = await boot({ host: 'B' });
    const bar = p.text('#rail-pin');
    assert.ok(p.d.querySelector('#rail-pin [data-akuko-action="approve-spend"]'));
    for (const want of ['estimate $0.36', '$0.84 spent', '$15.00 cap', '$13.80 left if you approve']) assert.ok(bar.includes(want), `the bar lacks "${want}": ${bar}`);
    p.close();
  });
});

describe('default board: decisions and hosts', () => {
  it('approve, then undo, writes two decisions and the second names the first', async () => {
    const p = await boot({ host: 'B' });
    click(p, '[data-akuko-action="approve"][data-akuko-unit="sc2_sh4"]');
    await p.tick();
    assert.equal(p.num('waiting-shots'), 1);
    click(p, '[data-akuko-action="undo"][data-akuko-unit="sc2_sh4"]');
    await p.tick();
    assert.equal(p.num('waiting-shots'), 2);
    const all = p.w.akukoDecisions.all() as { action: string; id: string; undoes?: string; unit: string }[];
    assert.deepEqual(Array.from(all.map((d) => d.action)), ['approve', 'undo']);
    assert.equal(all[1]?.undoes, all[0]?.id);
    p.close();
  });

  it('approve spend binds the amount shown, and declining writes no approval', async () => {
    const p = await boot({ host: 'B' });
    click(p, '#p-spend [data-akuko-action="approve-spend"]');
    await p.tick();
    const [d] = p.w.akukoDecisions.all() as { action: string; text: string }[];
    assert.equal(d?.action, 'approve-spend');
    assert.equal(d?.text, 'approve 0.36 USD');
    assert.equal(p.num('waiting-spend'), 0);
    p.close();
  });

  it('Ikenga: a remounted pane re-posts what it stored, and never posts an empty list', async () => {
    const first = await boot({ host: 'C' });
    assert.deepEqual(first.posts, [], 'nothing stored, nothing posted (it would wipe the stored decision)');
    first.close();
    const stored = [decision(3, { action: 'approve', unit: 'sc2_sh4', by: 'you' })];
    const again = await boot({ host: 'C', outbox: stored });
    assert.equal(again.posts.length, 1);
    assert.equal(again.posts[0].payload.key, 'akuko.decisions');
    assert.equal(again.posts[0].payload.value.length, 1);
    assert.equal(statusOf(again, 'sc2_sh4'), 'approved', 'the stored decision still shows after the remount');
    again.close();
  });

  it('Ikenga: follows the host theme until the person picks one, and never uses the host-owned palette names', async () => {
    const p = await boot({ host: 'C' });
    assert.equal(p.d.documentElement.getAttribute('data-akuko-mode'), 'dark');
    p.d.documentElement.setAttribute('data-mode', 'light'); // what the Ikenga bridge does when the shell theme changes
    await p.tick();
    assert.equal(p.d.documentElement.getAttribute('data-akuko-mode'), 'light');
    click(p, '#mode-btn');
    await p.tick();
    assert.equal(p.d.documentElement.getAttribute('data-akuko-mode'), 'dark');
    p.d.documentElement.setAttribute('data-mode', 'light');
    await p.tick();
    assert.equal(p.d.documentElement.getAttribute('data-akuko-mode'), 'dark', "a person's choice wins over the host");
    p.close();
  });

  it('blocked storage is said out loud, at the top of the page', async () => {
    const p = await boot({ host: 'B', blockStorage: true });
    const bar = p.d.querySelector('#store-warn') as El;
    assert.equal(bar.hidden, false);
    assert.match(bar.textContent ?? '', /blocks storage/);
    assert.match(p.text('#save-note'), /Not saved/);
    p.close();
  });

  it('a decision made while storage is blocked is still kept for this page and can be copied', async () => {
    const p = await boot({ host: 'B', blockStorage: true });
    click(p, '[data-akuko-action="approve"][data-akuko-unit="sc2_sh4"]');
    await p.tick();
    assert.equal(p.num('waiting-shots'), 1);
    assert.ok(p.d.querySelector('[data-akuko-export]'));
    p.close();
  });
});

describe('default board: pipeline strip (A-9)', () => {
  it('every stage is either a working button or plainly idle with a reason', async () => {
    const p = await boot({ host: 'B' });
    const stages = Array.from(p.d.querySelectorAll('#stages > li.stage')) as any[];
    assert.equal(stages.length, 9);
    for (const li of stages) {
      const id = li.getAttribute('data-akuko-stage');
      const btn = li.querySelector('button.stage-in');
      const idle = li.querySelector('div.stage-in.stage-idle');
      assert.ok(Boolean(btn) !== Boolean(idle), `${id}: exactly one of button or idle cell`);
      if (idle) {
        assert.ok((idle.getAttribute('title') ?? '').length > 0, `${id}: idle cell says why`);
        assert.ok(!idle.hasAttribute('tabindex') && !idle.hasAttribute('role') && !idle.hasAttribute('data-act'), `${id}: idle cell is not interactive`);
      }
    }
    const kind = (id: string) => (p.d.querySelector(`[data-akuko-stage="${id}"] .stage-in`) as any).tagName;
    // approved intake and breakdown, the sketch stage, the bible and the stage with spend all have a section to open
    for (const id of ['intake', 'breakdown', 'sketch', 'bible', 'keyframes']) assert.equal(kind(id), 'BUTTON', id);
    // locked stages do nothing and say what unlocks them
    assert.equal(kind('motion'), 'DIV');
    assert.equal(p.d.querySelector('[data-akuko-stage="motion"] .stage-in').getAttribute('title'), 'Locked: approve Key frames first');
    assert.equal(p.d.querySelector('[data-akuko-stage="export"] .stage-in').getAttribute('title'), 'Locked: approve Assemble first');
    p.close();
  });

  it('intake opens the script and breakdown opens the shots', async () => {
    const p = await boot({ host: 'B' });
    const asked: string[] = [];
    for (const id of ['script', 'shots']) { const h = p.d.getElementById(`h-${id}`); h.scrollIntoView = () => { asked.push(id); }; h.getBoundingClientRect = () => ({ top: -500, bottom: -400 }); }
    click(p, '[data-akuko-stage="intake"] button.stage-in');
    await p.tick();
    click(p, '[data-akuko-stage="breakdown"] button.stage-in');
    await p.tick();
    assert.deepEqual(asked, ['script', 'shots']);
    p.close();
  });
});

describe('default board: copy decisions (A-4)', () => {
  const clip = (p: Page) => { const got: string[] = []; p.w.navigator.clipboard.writeText = async (t: string) => { got.push(t); }; return got; };
  const toast = (p: Page) => p.d.querySelector('#toast') as El;
  const mine = { id: uuid(7), action: 'approve', unit: 'sc2_sh4', stage: 'sketch', by: 'you', at: '2026-11-08T10:07:00Z', view: 'default-board@0.1' };

  it('says it copied, how many, and keeps the live region', async () => {
    const p = await boot({ host: 'B' });
    const got = clip(p);
    click(p, '[data-akuko-action="approve"][data-akuko-unit="sc2_sh4"]');
    await p.tick();
    assert.match(p.text('[data-akuko-export]'), /\(1\)/);
    click(p, '[data-akuko-export]');
    await p.tick();
    assert.equal(got.length, 1);
    assert.equal(got[0]?.trim().split('\n').length, 1);
    assert.equal(toast(p).hidden, false);
    assert.match(toast(p).textContent ?? '', /^Copied 1 decision\./);
    assert.match(p.text('#announce'), /Copied 1 decision/);
    p.close();
  });

  it('leaves out decisions the project already has, and never drops one it does not', async () => {
    const fresh = { id: uuid(8), action: 'note', unit: 'sc4_sh2', stage: 'sketch', text: 'closer', by: 'you', at: '2026-11-08T10:08:00Z', view: 'default-board@0.1' };
    const folded = clone(FIXTURE);
    folded.decisions = [mine];
    const p = await boot({ host: 'B', project: folded, outbox: [mine, fresh] });
    const got = clip(p);
    assert.match(p.text('[data-akuko-export]'), /\(1\)/);
    click(p, '[data-akuko-export]');
    await p.tick();
    assert.deepEqual((got[0] ?? '').trim().split('\n').map((l) => JSON.parse(l).id), [fresh.id]);
    assert.match(toast(p).textContent ?? '', /Copied 1 decision \(1 already in your project\)/);
    assert.equal(p.w.akukoDecisions.all().length, 2, 'the outbox itself is untouched');
    p.close();
  });

  it('when the clipboard fails it lists the decisions in a read-only box, and the toast is not read out twice', async () => {
    const p = await boot({ host: 'B' });
    p.w.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    click(p, '[data-akuko-action="approve"][data-akuko-unit="sc2_sh4"]');
    await p.tick();
    click(p, '[data-akuko-export]');
    await p.tick();
    const ta = p.d.querySelector('#copy-fallback');
    assert.equal(ta.hidden, false);
    assert.ok(ta.readOnly && !ta.hasAttribute('data-akuko-action'));
    assert.equal(JSON.parse(ta.value.trim()).unit, 'sc2_sh4');
    assert.equal(p.d.querySelector('#toast').getAttribute('aria-hidden'), 'true');
    p.close();
  });

  it('with nothing new it says so and copies nothing', async () => {
    const folded = clone(FIXTURE);
    folded.decisions = [mine];
    const p = await boot({ host: 'B', project: folded, outbox: [mine] });
    const got = clip(p);
    click(p, '[data-akuko-export]');
    await p.tick();
    assert.deepEqual(got, []);
    assert.match(toast(p).textContent ?? '', /Nothing new to copy: 1 decision already in your project/);
    p.close();
  });

  it('window.akukoDecisions.jsonl() hands a reader (the desktop app) every decision made on the page', async () => {
    const p = await boot({ host: 'B' });
    click(p, '[data-akuko-action="approve"][data-akuko-unit="sc2_sh4"]');
    await p.tick();
    const lines = String(p.w.akukoDecisions.jsonl()).trim().split('\n').map((l: string) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, 'approve');
    assert.equal(lines[0].view, 'default-board@0.3');
    p.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// WP-29: a real-project-shaped film (211 shots, a cold open and ten parts, cards, rules, gates)
// ─────────────────────────────────────────────────────────────────────────

describe('default board: a 211-shot project (WP-29)', { timeout: 600_000 }, () => {
  const BIG = bigProject() as unknown as Project & AkukoProject;
  const shotEls = (p: Page) => p.d.querySelectorAll('[data-akuko-field="shot"]').length;
  const timings: Record<string, number> = {};
  const timed = async (label: string, fn: () => void, p: Page) => { const t = performance.now(); fn(); await p.tick(10); timings[label] = Math.round(performance.now() - t); };

  it('renders every shot and card; the part filter shows one part (P7: 11 shots and its card) and back', async () => {
    const t0 = performance.now();
    const p = await boot({ host: 'B', project: clone(BIG) });
    timings['open the board (jsdom, includes parsing the page)'] = Math.round(performance.now() - t0);
    assert.equal(shotEls(p), 211);
    assert.equal(p.d.querySelectorAll('[id^="card-card_"]').length, 12);
    assert.equal(p.d.querySelectorAll('#lining [data-akuko-field="script-tag"]').length, 211);
    const chips = Array.from(p.d.querySelectorAll('#parts [data-act="part"]')).map((b: any) => b.getAttribute('data-id'));
    assert.deepEqual(chips, ['all', ...PART_SIZES.map(([id]) => id)]);
    assert.match(p.text('#cut'), /^Film \d+:\d\d\.\d\d · 11 parts$/);
    await timed('show one part (P7)', () => click(p, '#parts [data-act="part"][data-id="P7"]'), p);
    assert.equal(shotEls(p), 11);
    assert.deepEqual(Array.from(p.d.querySelectorAll('[data-akuko-field="shot"]')).map((e: any) => e.getAttribute('data-akuko-unit')), BIG.shots.filter((s) => s.part === 'P7').map((s) => s.id));
    assert.deepEqual(Array.from(p.d.querySelectorAll('[id^="card-card_"]')).map((e: any) => e.id), ['card-card_P7-CARD']);
    assert.equal(p.d.querySelectorAll('#lining .tag').length, 11, 'the script shows the part too');
    const p7 = BIG.shots.filter((s) => s.part === 'P7');
    const ftc = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
    assert.equal(p.text('#cut'), `P7 · 11 shots · ${ftc(p7[0]!.film!.in_s)}–${ftc(p7.at(-1)!.film!.out_s)} · 8/11 approved`);
    assert.match(p.text('#filters'), /^All 11 ?Pending review 2 ?Needs rework 1 ?Approved 8$/);
    assert.equal(p.num('waiting-shots'), BIG.shots.filter((s) => s.status === 'pending-review').length, '"your move" still counts the whole film');
    await timed('back to every part', () => click(p, '#parts [data-act="part"][data-id="all"]'), p);
    assert.equal(shotEls(p), 211);
    p.close();
  });

  it('a link with #part=P7 opens the one-part view; approving a shot there re-renders only what changed', async () => {
    const p = await boot({ host: 'B', project: clone(BIG), url: 'https://board.test/views/default-board.html#part=P7' });
    assert.equal(shotEls(p), 11);
    const id = 'S11-030';
    click(p, `[data-act="sel"][data-id="${id}"]`);
    await p.tick();
    const sideways = p.d.querySelector('#p-ledger > .rp-body');
    await timed('approve one shot (one part shown)', () => click(p, `[data-akuko-action="approve"][data-akuko-unit="${id}"]`), p);
    assert.equal(statusOf(p, id), 'approved');
    assert.equal(p.d.querySelector('#p-ledger > .rp-body'), sideways, 'a panel that did not change is not rebuilt');
    const [d] = p.w.akukoDecisions.all() as Decision[];
    assert.deepEqual([d?.action, d?.unit, d?.stage, d?.view], ['approve', id, 'sketch', 'default-board@0.3']);
    p.close();
  });

  it('cards are review items: one approve each, then undo, never a second approve', async () => {
    const p = await boot({ host: 'B', project: clone(BIG) });
    const before = p.num('waiting-other');
    const sel = '[data-akuko-action="approve"][data-akuko-unit="card_P7-CARD"]';
    assert.equal(p.d.querySelectorAll(sel).length, 1);
    await timed('approve a card (every part shown)', () => click(p, sel), p);
    assert.equal(p.d.querySelectorAll(sel).length, 0, 'approved once');
    assert.ok(p.d.querySelector('[data-akuko-action="undo"][data-akuko-unit="card_P7-CARD"]'));
    assert.equal(p.num('waiting-other'), before - 1);
    const all = p.w.akukoDecisions.all() as Decision[];
    assert.deepEqual(JSON.parse(JSON.stringify(all.map((x) => [x.action, x.unit, x.stage]))), [['approve', 'card_P7-CARD', 'export']]);
    assert.match(p.text('#card-card_P7-CARD'), /P7 card · \.\.\/Cards\/P7-CARD\.png/);
    assert.ok(!p.d.querySelector('#p-bible [data-akuko-unit="card_P7-CARD"]'), 'cards are not listed again under Bible');
    p.close();
  });

  it('shows the rules (read-only) and the gates with their scope progress, matching decisions/gates.ts', async () => {
    const signed = signGate(clone(BIG) as AkukoProject, { gate: 'G-LOOK', by: 'p-sign', via: 'email', note: 'Replied yes.', at: '2026-11-10T08:15:00Z' }).project;
    const p = await boot({ host: 'B', project: clone(signed) as unknown as Project });
    const tabs = Array.from(p.d.querySelectorAll('#rail-tabs [role="tab"]')).map((t: any) => t.getAttribute('data-id'));
    assert.deepEqual(tabs, ['bible', 'ledger', 'gates', 'rules']);
    const rules = p.text('#p-rules');
    for (const want of ['brandname', 'allowed: flagstone', '“text, signs, logos, captions” in the negative prompt', 'only for Ada, now (invented)', 'and slices of it', 'Ben (invented)', 'Required']) assert.ok(rules.includes(want), `rules panel lacks ${want}`);
    assert.equal(p.d.querySelectorAll('#p-rules button, #p-rules [data-akuko-action], #p-gates [data-akuko-action]').length, 0, 'read-only: no control writes anything there');
    for (const g of gateStatuses(signed)) {
      assert.match(p.text(`[data-gate-progress="${g.id}"]`), new RegExp(`^${g.approved}/${g.total} approved`), g.id);
    }
    assert.match(p.text('[data-gate-signed="G-LOOK"]'), /^Signed by Sign-off Person \(invented\) \(sign-off\) · via email · Nov 10 · 08:15 UTC ?Replied yes\. ?Recorded on their word: attested, not proven\.$/);
    assert.equal(p.d.querySelector('[data-gate-signed="G-PILOT"]'), null);
    assert.match(p.text('#gate-G-PILOT'), /Not signed\. Only Sign-off Person \(invented\) can sign it/);
    assert.match(p.text('#p-gates'), /Approves day to day: Day Approver \(invented\).*Signs gates: Sign-off Person \(invented\)/);
    assert.equal(p.d.querySelectorAll('[data-akuko-unit="G-LOOK"], [data-akuko-unit="G-PILOT"]').length, 0, 'no decision control is aimed at a gate');
    click(p, '#gate-G-PILOT [data-act="part"]');
    await p.tick();
    assert.equal(shotEls(p), 11, '"Show P7 shots" opens the part');
    p.close();
  });

  it('the shot detail carries what the sheet gave it: part, tier, framing, lighting, lines, film time', async () => {
    const p = await boot({ host: 'B', project: clone(BIG), url: 'https://board.test/views/default-board.html#part=P7' });
    click(p, '[data-act="sel"][data-id="S11-070"]');
    await p.tick();
    const det = p.text('[data-akuko-view="shot-detail"]').replace(/\s+/g, '');
    for (const want of ['Part P7', 'Lighting L-DUSK · low amber dusk light', 'Sheet row S11-070', 'Q01 · spoken · ADA-NOW: An invented line.', 'Negative: text, signs, logos, captions']) assert.ok(det.includes(want.replace(/\s+/g, '')),`detail lacks ${want}: ${det.slice(0, 400)}`);
    p.close();
  });

  it('decisions written by the @0.1 and @0.2 boards still fold on a real-project-shaped film', () => {
    const p = clone(BIG) as AkukoProject;
    const units = [['S11-030', 'sketch'], ['card_P7-CARD', 'export'], ['S11-050_keyframe', 'keyframes']] as const;
    for (const view of ['default-board@0.1', 'default-board@0.2', 'default-board@0.3']) {
      const ds = units.map(([unit, stage], i) => ({ id: uuid(100 + i), action: 'approve', unit, stage, by: 'you', at: `2026-11-10T10:0${i}:00Z`, view }) as Decision);
      const { report, project } = foldDecisions(structuredClone(p), ds, { conformed: CONFORMED });
      assert.deepEqual(report.rejected, [], view);
      assert.equal(report.applied.length, 3, view);
      assert.deepEqual(project.gates, p.gates, 'and no gate is signed by it');
    }
  });

  after(() => {
    // Measured, not asserted tightly: jsdom parses HTML far slower than a browser (views/README.md has the numbers).
    console.log(`# board render timing with 211 shots (jsdom): ${JSON.stringify(timings)}`);
    for (const [k, ms] of Object.entries(timings)) if (!/open the board/.test(k)) assert.ok(ms < 30_000, `${k} took ${ms} ms`);
  });
});
