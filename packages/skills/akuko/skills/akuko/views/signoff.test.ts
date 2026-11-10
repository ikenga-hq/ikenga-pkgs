// WP-29: the read-only sign-off page (views/signoff.ts, views/publish.ts --signoff). It shows exactly
// what a gate covers, passes check-view as read-only, has no decision-writing control and makes no
// network call. Synthetic project only (views/__fixtures__/big-project.ts).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decisionWriteSigns } from '../scripts/check-view/predicates.mjs';
import { gateStatus } from '../decisions/gates.ts';
import { bigProject, TINY_PNG, writeBigProject } from './__fixtures__/big-project.ts';
import { buildSignoffPage } from './signoff.ts';

const SKILL = fileURLToPath(new URL('..', import.meta.url));
const NOW = () => new Date('2026-11-10T09:00:00Z');
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const projectDir = (opts: { cards?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'akuko-signoff-page-'));
  dirs.push(root);
  const dir = join(root, 'film', 'akuko');
  writeBigProject(dir, bigProject(), opts);
  return dir;
};
const units = (html: string) => [...html.matchAll(/<li class="unit" data-akuko-unit="([^"]+)" data-akuko-status="([^"]+)"/g)].map((m) => [m[1], m[2]]);

describe('the sign-off page', () => {
  const dir = projectDir();
  const p = bigProject();

  it('lists exactly the units in the gate, with ids and approval status, and the gate text', () => {
    const page = buildSignoffPage(p, 'G-PILOT', dir, { now: NOW });
    const want = gateStatus(p, 'G-PILOT').units.map((u) => [u.id, u.status]);
    assert.deepEqual(units(page.html), want);
    assert.match(page.html, /<h1>G-PILOT · The pilot: P7 key frames<\/h1>/);
    assert.match(page.html, /Signing <b>G-PILOT<\/b> says that you have looked at the 11 items on this page/);
    assert.match(page.html, /It covers the key frames for part P7\./);
    assert.match(page.html, /4 approved · 3 waiting for review · 4 not made yet/);
    assert.match(page.html, /attested, not proven/);
    assert.match(page.html, /Who can sign G-PILOT: <b>Sign-off Person \(invented\)<\/b>/);
    assert.match(page.html, /snapshot of 10 Nov 2026, 09:00 UTC/);
  });

  it('shows the house rules', () => {
    const { html } = buildSignoffPage(p, 'G-LOOK', dir, { now: NOW });
    for (const want of ['<b>brandname</b>', 'allowed: flagstone', '“text, signs, logos, captions” in the negative prompt', 'Face crop (invented)', 'only for Ada, now (invented)', 'and slices of it', 'Ben (invented)', 'These rules are <b>required</b>']) {
      assert.ok(html.includes(want), `rules summary lacks ${want}`);
    }
  });

  it('has no decision-writing control, no script, no form and makes no network call', () => {
    const { html } = buildSignoffPage(p, 'G-LOOK', dir, { now: NOW });
    assert.deepEqual(decisionWriteSigns(html), []);
    assert.doesNotMatch(html, /data-akuko-action|<button|<form|<input|<select|<textarea|<a\s/i);
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
    assert.deepEqual(scripts, [' type="application/json" id="akuko-view"'], 'only the manifest');
    assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i);
    assert.doesNotMatch(html, /<link\b|@import|url\(/i);
    assert.match(html, /"writes_decisions":false/);
  });

  it('embeds each picture within the limits, and links it beyond them', () => {
    const embed = buildSignoffPage(p, 'G-LOOK', dir, { now: NOW });
    const files = gateStatus(p, 'G-LOOK').units.filter((u) => u.file).length;
    assert.equal(embed.images.filter((i) => i.how === 'embedded').length, files);
    assert.equal((embed.html.match(/src="data:image\/png;base64,/g) ?? []).length, files);
    assert.ok(embed.images.every((i) => /^[0-9a-f]{64}$/.test(i.sha256 ?? '')));
    const small = buildSignoffPage(p, 'G-LOOK', dir, { now: NOW, maxImageBytes: TINY_PNG.length - 1 });
    assert.equal(small.images.filter((i) => i.how === 'linked').length, files);
    assert.match(small.html, /src="\.\.\/bible\/characters\/ADA-NOW\/refs\/portrait\.png"/);
    assert.match(small.html, /too large to embed/);
    const total = buildSignoffPage(p, 'G-LOOK', dir, { now: NOW, maxTotalBytes: 300 });
    assert.ok(total.embeddedBytes <= 300);
    assert.ok(total.images.some((i) => i.how === 'linked' && /limit .* is used up/.test(i.why ?? '')));
    const none = buildSignoffPage(p, 'G-LOOK', dir, { now: NOW, images: 'none' });
    assert.doesNotMatch(none.html, /<img/);
  });

  it('a unit with no file, a missing file and a video are named, never loaded', () => {
    const q = structuredClone(p);
    q.gates!.push({ id: 'G-CARDS', scope: { stage: 'export' }, needs: 'signoff' });
    q.assets.find((a) => a.id === 'card_CREDITS-010')!.file = { uri: '../Cards/credits.mp4', mime: 'video/mp4' };
    const withCards = projectDir({ cards: true });
    writeFileSync(join(withCards, '..', 'Cards', 'credits.mp4'), Buffer.alloc(64));
    rmSync(join(withCards, '..', 'Cards', 'P3-CARD.png'));
    const page = buildSignoffPage(q, 'G-CARDS', withCards, { now: NOW });
    const how = Object.fromEntries(page.images.map((i) => [i.unit, i.how]));
    assert.equal(how['card_P1-CARD'], 'embedded', 'cards outside the project folder are read too');
    assert.equal(how['card_P3-CARD'], 'missing');
    assert.equal(how['card_CREDITS-010'], 'not-an-image');
    assert.match(page.html, /File not found: <code>\.\.\/Cards\/P3-CARD\.png<\/code>/);
    const pilot = buildSignoffPage(p, 'G-PILOT', dir, { now: NOW });
    assert.equal((pilot.html.match(/No file yet: not made\./g) ?? []).length, 4);
  });

  it('text from the project is escaped and can never look like a decision writer', () => {
    const q = structuredClone(p);
    q.project.title = 'A <b>film</b> about akuko.decisions and akukoDecisions';
    q.gates![0]!.title = '</script><script>alert(1)</script> data-akuko-action __iyke';
    const { html } = buildSignoffPage(q, 'G-LOOK', dir, { now: NOW });
    assert.deepEqual(decisionWriteSigns(html), []);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /A &lt;b&gt;film&lt;\/b&gt; about aku&#107;o\.decisions/);
  });

  it('hostile project text in every field stays text (reviewer probe so.ts)', () => {
    const q = structuredClone(p) as any;
    const X = '"><img src=x onerror="alert(1)"><script>alert(2)</script></script><form action=//e.x><button data-akuko-action="approve">akuko-decision-writer __ikenga window.claude.use writeDecision</button>';
    q.project.title = X; q.gates[0].title = X; q.people.forEach((x: any) => { x.name = X; }); q.rules.banned[0].term = X; q.rules.banned[0].note = X;
    q.rules.consent = [{ id: 'c-x', who: X, what: X, date: '2026-11-01' }];
    q.rules.uploads.allow = q.rules.uploads.allow.map((u: any) => ({ ...u, consent_ref: undefined }));
    q.assets.forEach((a: any) => { a.name = X; }); q.shots.forEach((s: any) => { s.action = X; });
    q.bible.characters.forEach((e: any) => { e.name = X; e.description = X; });
    q.gates[0].signed = { by: 'p-sign', role: 'signoff', at: '2026-11-10T08:00:00Z', via: X, note: X };
    for (const g of q.gates) {
      const { html } = buildSignoffPage(q, g.id, dir, { now: NOW });
      assert.deepEqual(decisionWriteSigns(html), [], g.id);
      assert.deepEqual(html.match(/<script[^>]*>/g), ['<script type="application/json" id="akuko-view">'], g.id);
      assert.doesNotMatch(html, /<img[^>]*onerror|<form|<button|https?:/i, g.id);
      assert.match(html, /attested, not proven/);
    }
  });

  it('reads pictures only from inside the project folder or its parent, with an image extension (review F5)', () => {
    const root = mkdtempSync(join(tmpdir(), 'akuko-signoff-roots-'));
    dirs.push(root);
    const proj = join(root, 'show', 'ep1', 'akuko');
    writeBigProject(proj);
    mkdirSync(join(root, 'show', 'ep1', 'Cards'), { recursive: true });
    writeFileSync(join(root, 'show', 'ep1', 'Cards', 'ok.png'), TINY_PNG); // the project's parent: allowed
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    writeFileSync(join(root, 'elsewhere', 'far.png'), TINY_PNG); // two levels up: not
    writeFileSync(join(proj, 'secret.bin'), TINY_PNG); // inside, but not an image extension
    const q = structuredClone(p);
    const pick = (id: string) => q.assets.find((a) => a.id === id)!;
    pick('ADA_portrait').file = { uri: '../Cards/ok.png', mime: 'image/png' };
    pick('ADA_turnaround').file = { uri: '../../../elsewhere/far.png', mime: 'image/png' };
    pick('GULLS_portrait').file = { uri: join(root, 'elsewhere', 'far.png').split('\\').join('/'), mime: 'image/png' };
    pick('house-style_lookbook').file = { uri: 'secret.bin', mime: 'image/png' };
    const page = buildSignoffPage(q, 'G-LOOK', proj, { now: NOW });
    const how = Object.fromEntries(page.images.map((i) => [i.unit, i.how]));
    assert.equal(how['ADA_portrait'], 'embedded');
    assert.equal(how['ADA_turnaround'], 'outside');
    assert.equal(how['GULLS_portrait'], 'outside', 'an absolute path outside is refused too');
    assert.equal(how['house-style_lookbook'], 'not-an-image', 'the extension decides, not only the MIME type');
    assert.match(page.html, /Not loaded: <code>\.\.\/\.\.\/\.\.\/elsewhere\/far\.png<\/code> is outside the project folder/);
  });

  it('a link that would cross drives is not loaded (review F7)', { skip: process.platform !== 'win32' }, () => {
    const other = /^[cC]:/.test(dir) ? 'Z:/share' : 'C:/share';
    const page = buildSignoffPage(p, 'G-LOOK', dir, { now: NOW, images: 'link', outDir: other });
    assert.ok(page.images.length > 0);
    assert.ok(page.images.every((i) => i.how === 'outside'), JSON.stringify(page.images.map((i) => i.how)));
    assert.match(page.html, /is on another drive than this page/);
  });

  it('a signed gate says who signed, how and when', () => {
    const q = structuredClone(p);
    q.gates![0]!.signed = { by: 'p-sign', role: 'signoff', at: '2026-11-10T08:15:00Z', via: 'email', note: 'Replied yes.' };
    const { html } = buildSignoffPage(q, 'G-LOOK', dir, { now: NOW });
    assert.match(html, /Already recorded as signed by <b>Sign-off Person \(invented\)<\/b>, via email, 10 Nov 2026, 08:15 UTC\. Note: Replied yes\./);
  });

  it('passes check-view: SKIP, read-only (not applicable)', { timeout: 300_000 }, async () => {
    const { html } = buildSignoffPage(p, 'G-PILOT', dir, { now: NOW });
    const file = join(dir, 'views', 'signoff-check.html');
    mkdirSync(join(dir, 'views'), { recursive: true });
    writeFileSync(file, html);
    const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, [join(SKILL, 'scripts', 'check-view.mjs'), file, '--json'], { cwd: SKILL, timeout: 280_000, maxBuffer: 64 * 1024 * 1024 }, (e, o) => (e && typeof (e as { code?: unknown }).code !== 'number' ? reject(e) : resolve(o))));
    const [r] = JSON.parse(out) as { ok: boolean; skipped?: boolean; view: string; failures: unknown[] }[];
    assert.ok(r);
    assert.deepEqual(r.failures, []);
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(r.view, 'signoff-page@1');
  });
});

describe('views/publish.ts --signoff', { timeout: 120_000 }, () => {
  const run = (args: string[]) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(SKILL, 'views', 'publish.ts'), ...args], { cwd: SKILL, timeout: 60_000 }, (e, out, err) => resolve({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out, err }));
  });

  it('writes <project>/views/signoff-<gate>.html through the host and prints what it did', async () => {
    const dir = projectDir();
    const r = await run(['--project', dir, '--signoff', 'G-PILOT']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.path, join(dir, 'views', 'signoff-G-PILOT.html'));
    assert.deepEqual([out.gate, out.state, out.approved, out.total], ['G-PILOT', 'open', 4, 11]);
    assert.deepEqual(out.images, { embedded: 7, linked: 0, other: 0 });
    assert.match(readFileSync(out.path, 'utf8'), /"id":"signoff-page"/);
  });

  it('--out and --images link; an unknown gate fails with exit 1', async () => {
    const dir = projectDir();
    const outDir = join(dir, '..', 'share');
    mkdirSync(outDir, { recursive: true });
    const r = await run(['--project', dir, '--signoff', 'G-LOOK', '--out', join(outDir, 'look.html'), '--images', 'link']);
    assert.equal(r.code, 0, r.err);
    assert.match(readFileSync(join(outDir, 'look.html'), 'utf8'), /src="\.\.\/aku&#107;o\/bible\/style\/house-style\/refs\/lookbook\.png"/, 'relative to --out (the word akuko is written as an entity)');
    const bad = await run(['--project', dir, '--signoff', 'G-NOPE']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /no gate "G-NOPE"/);
    assert.equal((await run(['--project', dir, '--signoff', 'G-LOOK', '--images', 'all'])).code, 1);
  });
});
