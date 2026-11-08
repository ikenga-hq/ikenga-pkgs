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
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isConformedHtml, parseConformedFile, viewHash } from '../decisions/conformed.ts';

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
