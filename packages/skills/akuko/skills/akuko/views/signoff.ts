/**
 * akuko — the read-only sign-off page (WP-29, R9-11).
 *
 * One self-contained HTML page that shows a person who does not run akuko
 * exactly what a gate covers: every unit in its scope (images with ids and
 * approval status), the project rules, and what signing it means. It is built
 * once from `akuko.json`, at publish time:
 *
 *   - no executable script, no form, no button: nothing on it can approve,
 *     sign or write anything (its manifest says `writes_decisions: false`, and
 *     check-view reports it SKIP: read-only);
 *   - no network: system fonts, no external stylesheet, and images either
 *     embedded as `data:` URIs or referenced by a relative path (never http);
 *   - it can be sent as a file or published as a private link.
 *
 * Images (`images`): `embed` (default) inlines each image file as a `data:`
 * URI while it is at most `maxImageBytes` (default 3 MiB) and the page's
 * embedded total stays within `maxTotalBytes` (default 12 MB of base64, so the
 * page fits a 16 MB artifact). An image over either limit, and every image
 * with `link`, is referenced by its path relative to the page (it shows when
 * the page sits in the project's `views/` folder; the page says so). `none`
 * shows no pictures. A video, a file that is missing or a remote URI is never
 * loaded: its path is printed instead. akuko adds no image codec, so it can't
 * shrink a picture; for a large gate use `link` and share the folder, or make
 * smaller previews first.
 *
 * Only pictures inside the project folder or its parent (where a sheet's
 * `../Cards-and-Credits` sits) are read, judged after resolving links
 * (realpath), and only with an image extension (and an image MIME type when
 * the asset names one). Anything else is listed as not loaded, as is a link
 * that would cross drives.
 *
 * How the sign-off comes back (R9-11): the signer tells the person who sent
 * the page, in their own words; that person records it with `decisions/cli.ts
 * signoff`. Attested, not proven.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesOf, STAGE_LABEL, type AkukoProject, type StageId } from '../schema/akuko-project.ts';
import { gateStatus, type GateStatus, type GateUnit } from '../decisions/gates.ts';

export const SIGNOFF_VIEW = { id: 'signoff-page', version: '1' } as const;
export const DEFAULT_MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 12 * 1000 * 1000;

export interface SignoffPageOptions {
  images?: 'embed' | 'link' | 'none';
  maxImageBytes?: number;
  /** Total size of embedded data: URIs (base64 characters). */
  maxTotalBytes?: number;
  /** The folder the page will be written to, for relative image paths. Default `<project>/views`. */
  outDir?: string;
  now?: () => Date;
}

export interface SignoffPageImage { unit: string; uri: string; how: 'embedded' | 'linked' | 'missing' | 'not-an-image' | 'remote' | 'outside' | 'none'; bytes?: number; sha256?: string; why?: string }

export interface SignoffPage {
  html: string;
  status: GateStatus;
  images: SignoffPageImage[];
  embeddedBytes: number;
}

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif' };

/** HTML-escape, then break the few words a decision-writing page is recognised by (they render the same). */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
    .replace(/(aku)(k)(o)/gi, (_m, a: string, k: string, o: string) => `${a}&#${k.charCodeAt(0)};${o}`)
    .replace(/__iy(k)e/gi, (m) => m.replace(/k/i, (k) => `&#${k.charCodeAt(0)};`));
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** Film time as m:ss.ss. */
export const filmTime = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const when = (t: string | Date): string => { const d = new Date(t); return Number.isNaN(d.getTime()) ? String(t) : `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`; };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STATUS_TXT: Record<string, string> = { approved: 'Approved', 'pending-review': 'Waiting for review', 'needs-rework': 'Sent back', pending: 'Not made yet', draft: 'Being made' };
const KIND_TXT: Record<string, string> = { portrait: 'Portrait', turnaround: 'Turnaround', plate: 'Location plate', lookbook: 'Lookbook', keyframe: 'Key frame', clip: 'Clip', lipsync: 'Lip-sync clip', card: 'Card', vo: 'Voice-over', shot: 'Shot', character: 'Character', location: 'Location', style: 'Style', reference: 'Reference', sheet: 'Character sheet', panel: 'Sketch panel' };

/** Where a project-relative URI is on disk (it may go up out of the folder, like `../Cards/x.png`); undefined for a remote one. */
function onDisk(projectDir: string, uri: string): string | undefined {
  if (/^file:/i.test(uri)) return fileURLToPath(uri);
  if (/^[a-z]:[\\/]/i.test(uri)) return resolve(uri); // a Windows absolute path, not a URI scheme
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('/_blob/')) return undefined;
  return isAbsolute(uri) ? uri : resolve(projectDir, ...uri.split('/'));
}

function picture(projectDir: string, outDir: string, u: GateUnit, mime: string | undefined, o: Required<Pick<SignoffPageOptions, 'images' | 'maxImageBytes' | 'maxTotalBytes'>>, budget: { used: number }): { img: SignoffPageImage; html: string } {
  const uri = u.file!;
  const path = onDisk(projectDir, uri);
  const ext = extname(path ?? uri).toLowerCase();
  const type = IMAGE_MIME[ext] !== undefined && (mime === undefined || mime.startsWith('image/')) ? IMAGE_MIME[ext] : undefined;
  const label = `${esc(KIND_TXT[u.kind] ?? u.kind)} ${esc(u.id)}`;
  const box = (inner: string) => `<div class="pic">${inner}</div>`;
  const note = (t: string) => box(`<p class="pic-none">${t}</p>`);
  if (!path) return { img: { unit: u.id, uri, how: 'remote' }, html: note(`Stored at <code>${esc(uri)}</code>: not loaded here (this page makes no network calls).`) };
  if (!existsSync(path)) return { img: { unit: u.id, uri, how: 'missing' }, html: note(`File not found: <code>${esc(uri)}</code>.`) };
  const real = realpathSync(path);
  const roots = [projectDir, dirname(resolve(projectDir))].map((r) => { try { return realpathSync(r); } catch { return resolve(r); } });
  const inside = (r: string) => { const rel = relative(r, real); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
  if (!roots.some(inside)) return { img: { unit: u.id, uri, how: 'outside' }, html: note(`Not loaded: <code>${esc(uri)}</code> is outside the project folder.`) };
  const bytes = statSync(real).size;
  if (!type) return { img: { unit: u.id, uri, how: 'not-an-image', bytes }, html: note(`Not a picture (${esc(extname(path) || 'no extension')}): <code>${esc(uri)}</code>, ${mb(bytes)}.`) };
  const data = readFileSync(real);
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (o.images === 'none') return { img: { unit: u.id, uri, how: 'none', bytes, sha256 }, html: note(`Picture not included: <code>${esc(uri)}</code>.`) };
  const encoded = o.images === 'embed' ? Math.ceil(bytes / 3) * 4 + `data:${type};base64,`.length : Infinity;
  if (o.images === 'embed' && bytes <= o.maxImageBytes && budget.used + encoded <= o.maxTotalBytes) {
    budget.used += encoded;
    return { img: { unit: u.id, uri, how: 'embedded', bytes, sha256 }, html: box(`<img src="data:${type};base64,${data.toString('base64')}" alt="${label}" loading="lazy">`) };
  }
  const why = o.images === 'link' ? 'linked' : bytes > o.maxImageBytes ? `too large to embed (${mb(bytes)}, limit ${mb(o.maxImageBytes)})` : `the page's embedding limit (${mb(o.maxTotalBytes)}) is used up`;
  const rel = relative(outDir, path).split(sep).join('/');
  if (isAbsolute(rel) || /^[a-z]:/i.test(rel)) return { img: { unit: u.id, uri, how: 'outside', bytes, sha256, why }, html: note(`Not loaded: <code>${esc(uri)}</code> is on another drive than this page (${esc(why)}).`) };
  return {
    img: { unit: u.id, uri, how: 'linked', bytes, sha256, why },
    html: box(`<img src="${esc(encodeURI(rel))}" alt="${label}" loading="lazy"><p class="pic-cap">Shown from <code>${esc(uri)}</code> (${esc(why)}): it appears when this page sits next to the project.</p>`),
  };
}

const mb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

function scopeText(p: AkukoProject, s: GateStatus): string {
  const sc = s.scope;
  const bits: string[] = [];
  if (sc.parts?.length) bits.push(`part${sc.parts.length > 1 ? 's' : ''} ${sc.parts.join(', ')}`);
  if (sc.scenes?.length) bits.push(`scene${sc.scenes.length > 1 ? 's' : ''} ${sc.scenes.join(', ')}`);
  if (sc.shots?.length) bits.push(sc.shots.length > 4 ? plural(sc.shots.length, 'named shot') : `shot${sc.shots.length > 1 ? 's' : ''} ${sc.shots.join(', ')}`);
  const where = bits.length ? bits.join(' and ') : 'the whole film';
  const stage = sc.stage ? STAGE_LABEL[sc.stage as StageId] ?? sc.stage : undefined;
  return stage ? `the ${stage.toLowerCase()} for ${where}` : `everything in ${where}`;
}

function unitCard(p: AkukoProject, u: GateUnit, pic: string): string {
  const shot = p.shots.find((x) => x.id === (u.type === 'shot' ? u.id : u.owner));
  const asset = u.type === 'asset' ? p.assets.find((a) => a.id === u.id) : undefined;
  const entry = [...p.bible.characters, ...p.bible.locations, ...p.bible.styles].find((e) => e.id === (u.type === 'entry' ? u.id : u.owner));
  const facts: string[] = [];
  if (shot) {
    if (shot.film) facts.push(`<span class="mono">${filmTime(shot.film.in_s)}–${filmTime(shot.film.out_s)}</span>`);
    if (shot.framing) facts.push(esc(shot.framing));
    if (shot.part) facts.push(esc(shot.part));
  }
  if (asset?.film && asset.kind === 'card') facts.push(`<span class="mono">${filmTime(asset.film.in_s)}–${filmTime(asset.film.out_s)}</span>`);
  if (entry && u.type !== 'entry') facts.push(esc(entry.name));
  const desc = u.type === 'shot' ? shot?.action : u.type === 'entry' ? entry?.description : asset?.kind === 'card' ? asset.name : undefined;
  return `<li class="unit" data-akuko-unit="${esc(u.id)}" data-akuko-status="${esc(u.status)}">${pic}` +
    `<div class="u-body"><p class="u-top"><span class="u-id mono">${esc(u.id)}</span><span class="chip" data-st="${esc(u.status)}">${esc(STATUS_TXT[u.status] ?? u.status)}</span></p>` +
    `<p class="u-kind">${esc(KIND_TXT[u.kind] ?? u.kind)}${facts.length ? ` · ${facts.join(' · ')}` : ''}</p>` +
    (desc ? `<p class="u-desc">${esc(desc)}</p>` : '') + '</div></li>';
}

function rulesHtml(p: AkukoProject): string {
  if (!p.rules) return '<p class="muted">This project has no house rules recorded.</p>';
  const r = rulesOf(p);
  const name = (id: string) => [...p.bible.characters, ...p.bible.locations, ...p.bible.styles].find((e) => e.id === id)?.name ?? id;
  const scope = (s?: { shots?: string[]; scenes?: string[]; parts?: string[] }) => {
    if (!s) return '';
    const b = [s.parts?.length ? `parts ${s.parts.join(', ')}` : '', s.scenes?.length ? `scenes ${s.scenes.join(', ')}` : '', s.shots?.length ? plural(s.shots.length, 'shot') : ''].filter(Boolean);
    return b.length ? ` <span class="muted">(only in ${esc(b.join(', '))})</span>` : '';
  };
  const li = (items: string[]) => (items.length ? `<ul class="rl">${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<p class="muted">None.</p>');
  const rows: [string, string][] = [
    ['Never in a prompt', li(r.banned.map((b) => `<b>${esc(b.term)}</b>${b.except?.length ? ` <span class="muted">(allowed: ${esc(b.except.join(', '))})</span>` : ''}${scope(b.scope)}${b.note ? ` · ${esc(b.note)}` : ''}`))],
    ['Always in a prompt', li(r.require.map((q) => `“${esc(q.text)}” in the ${q.applies_to === 'negative' ? 'negative prompt' : 'prompt'}${scope(q.scope)}${q.note ? ` · ${esc(q.note)}` : ''}`))],
    ['Outside files akuko may upload', li(r.uploads.allow.map((u) => `${esc(u.label)} <span class="mono muted">${esc(u.sha256.slice(0, 12))}…</span>${u.for?.length ? ` · only for ${esc(u.for.map(name).join(', '))}` : ''}${u.slices ? ' · and slices of it' : ''}${u.consent_ref ? ` · consent ${esc(u.consent_ref)}` : ''}`))],
    ['Never from a photo', li(r.never_from_photo.map((id) => esc(name(id))))],
    ['Exceptions', li(r.exempt.map((e) => `${plural(e.shots.length, 'shot')} skip ${esc(e.skip.join(', '))}${e.note ? ` · ${esc(e.note)}` : ''}`))],
    ['Consent on record', li(r.consent.map((c) => `${esc(c.who)}: ${esc(c.what)} <span class="muted">(${esc(c.date)})</span>`))],
  ];
  return `<p>${r.required ? 'These rules are <b>required</b>: akuko refuses any paid job that breaks one, or when they are missing.' : 'akuko checks every paid job against these rules before anything is spent.'}</p>` +
    `<dl class="rules">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

/** Build the page for one gate. Throws (GateError) for an unknown gate. */
export function buildSignoffPage(project: AkukoProject, gateId: string, projectDir: string, opts: SignoffPageOptions = {}): SignoffPage {
  const status = gateStatus(project, gateId);
  const o = { images: opts.images ?? 'embed', maxImageBytes: opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES, maxTotalBytes: opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES } as const;
  const outDir = resolve(opts.outDir ?? resolve(projectDir, 'views'));
  const now = (opts.now ?? (() => new Date()))();
  const budget = { used: 0 };
  const images: SignoffPageImage[] = [];
  const cardFor = (u: GateUnit) => {
    if (!u.file) return unitCard(project, u, `<div class="pic"><p class="pic-none">${u.type === 'asset' ? 'No file yet: not made.' : esc(KIND_TXT[u.kind] ?? u.kind)}</p></div>`);
    const mime = project.assets.find((a) => a.id === u.id)?.file?.mime;
    const r = picture(projectDir, outDir, u, mime, o, budget);
    images.push(r.img);
    return unitCard(project, u, r.html);
  };
  // Group: by owner (a bible entry or a shot), else by kind.
  const groups = new Map<string, GateUnit[]>();
  for (const u of status.units) {
    const key = u.type === 'asset' && u.owner ? u.owner : u.type === 'shot' ? (u.part ?? 'Shots') : KIND_TXT[u.kind] ?? u.kind;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  const ownerName = (k: string) => [...project.bible.characters, ...project.bible.locations, ...project.bible.styles].find((e) => e.id === k)?.name;
  const signers = (project.people ?? []).filter((x) => x.role === status.needs);
  const counts = [
    `${status.approved} approved`,
    status.pending_review ? `${status.pending_review} waiting for review` : '',
    status.needs_rework ? `${status.needs_rework} sent back` : '',
    status.not_ready ? `${status.not_ready} not made yet` : '',
  ].filter(Boolean).join(' · ');
  const title = `${status.id}${status.title ? ` · ${status.title}` : ''}`;
  const signed = status.signed;
  const manifest = JSON.stringify({ contract: 'akuko-view@1', id: SIGNOFF_VIEW.id, version: SIGNOFF_VIEW.version, title: 'sign-off page (read-only)', writes_decisions: false, views: [] });

  const body = [
    `<header class="top"><p class="eyebrow">Sign-off page · read-only</p><h1>${esc(title)}</h1>`,
    `<p class="sub">${esc(project.project.title)} · snapshot of ${esc(when(now))}</p></header>`,
    '<main>',
    `<section class="what" aria-labelledby="h-what"><h2 id="h-what">What you are signing</h2>`,
    `<p class="lead">Signing <b>${esc(status.id)}</b> says that you have looked at the ${plural(status.total, 'item')} on this page, as they are in this snapshot, and that the film can move on past ${esc(status.id)}. It covers ${esc(scopeText(project, status))}.</p>`,
    `<p class="tally" data-akuko-field="gate-progress">${status.total ? `${esc(counts)} <span class="muted">(of ${status.total}, by the day-to-day approver)</span>` : 'Nothing is in scope yet.'}</p>`,
    signed
      ? `<p class="signed">Already recorded as signed by <b>${esc(status.signer?.name ?? signed.by)}</b>, via ${esc(signed.via)}, ${esc(when(signed.at))}.${signed.note ? ` Note: ${esc(signed.note)}` : ''} Recorded on their word: attested, not proven.</p>`
      : '',
    status.notes.length ? `<ul class="notes">${status.notes.map((n) => `<li>${esc(n.charAt(0).toUpperCase() + n.slice(1))}.</li>`).join('')}</ul>` : '',
    `<div class="how"><h3>How to sign</h3><p>This page cannot sign or approve anything: it has no buttons and sends nothing. To sign, tell the person who sent it to you, in your own words (for example by email): <q>${esc(status.id)} is signed</q>. They record it as signed by you, with how you said it. That record is attested, not proven.</p>`,
    signers.length ? `<p>Who can sign ${esc(status.id)}: ${signers.map((x) => `<b>${esc(x.name)}</b>`).join(', ')}.</p>` : `<p>No one with the sign-off role is listed for this project yet.</p>`,
    '</div></section>',
    `<section aria-labelledby="h-items"><h2 id="h-items">In scope <span class="count">${status.total}</span></h2>`,
    status.total === 0 ? '<p class="muted">Nothing to look at yet.</p>' : [...groups].map(([k, us]) => `<section class="group" aria-label="${esc(ownerName(k) ?? k)}"><h3>${esc(ownerName(k) ?? k)}${ownerName(k) ? ` <span class="mono muted">${esc(k)}</span>` : ''}</h3><ul class="units">${us.map(cardFor).join('')}</ul></section>`).join(''),
    status.removed.length ? `<p class="muted">Left the shot list since it was imported (not counted): ${esc(status.removed.join(', '))}.</p>` : '',
    '</section>',
    `<section aria-labelledby="h-rules"><h2 id="h-rules">House rules</h2>${rulesHtml(project)}</section>`,
    '</main>',
    `<footer class="foot"><p>Made by akuko from <span class="mono">${esc(project.project.slug)}</span> on ${esc(when(now))}. A read-only page: no scripts, no buttons, no network calls.${images.some((i) => i.how === 'linked') ? ' Some pictures are shown from files next to the project (see each one).' : ''}</p></footer>`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Sign-off: ${esc(status.id)} · ${esc(project.project.title)}</title>
<style>
:root { color-scheme: light dark; --bg: hsl(36,22%,96%); --surface: hsl(36,18%,92%); --raised: hsl(36,26%,99%); --fg: hsl(28,30%,14%); --muted: hsl(28,14%,36%); --line: hsl(32,16%,78%); --wait: hsl(42,60%,88%); --back: hsl(8,60%,91%); --ok: hsl(142,40%,90%); --accent: hsl(20,50%,34%); }
@media (prefers-color-scheme: dark) { :root { --bg: hsl(28,18%,6%); --surface: hsl(28,14%,9%); --raised: hsl(28,11%,12%); --fg: hsl(36,28%,90%); --muted: hsl(32,14%,66%); --line: hsl(28,14%,22%); --wait: hsl(42,48%,20%); --back: hsl(8,50%,20%); --ok: hsl(142,30%,18%); --accent: hsl(20,55%,62%); } }
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 400 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
.top, main, .foot { max-width: 1100px; margin: 0 auto; padding: 0 20px; }
.top { padding-top: 28px; padding-bottom: 8px; }
.eyebrow { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
h1 { margin: 4px 0 0; font: 600 30px/1.2 ui-serif, Georgia, serif; }
h2 { margin: 32px 0 12px; font: 600 22px/1.25 ui-serif, Georgia, serif; }
h3 { margin: 20px 0 8px; font-size: 16px; }
.sub, .muted { color: var(--muted); }
.sub { margin: 6px 0 0; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 14px; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 14px; overflow-wrap: anywhere; }
.what { margin-top: 16px; padding: 4px 20px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
.lead { font-size: 18px; }
.tally { font-weight: 600; }
.signed { padding: 10px 12px; background: var(--ok); border-radius: 6px; }
.notes { padding-left: 20px; }
.how { border-top: 1px solid var(--line); margin-top: 12px; }
.count { font: 600 14px/1 ui-monospace, Menlo, monospace; padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px; vertical-align: middle; }
.units { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.unit { display: flex; flex-direction: column; background: var(--raised); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.pic { aspect-ratio: 16 / 9; display: grid; place-items: center; background: var(--surface); border-bottom: 1px solid var(--line); }
.pic img { width: 100%; height: 100%; object-fit: contain; display: block; }
.pic-none, .pic-cap { margin: 0; padding: 10px; font-size: 14px; color: var(--muted); text-align: center; }
.pic:has(.pic-cap) { display: block; aspect-ratio: auto; }
.pic:has(.pic-cap) img { aspect-ratio: 16 / 9; height: auto; }
.u-body { padding: 10px 12px 12px; }
.u-top { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; margin: 0; }
.u-id { font-weight: 600; }
.u-kind, .u-desc { margin: 4px 0 0; font-size: 14px; }
.u-kind { color: var(--muted); }
.chip { font-size: 13px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap; }
.chip[data-st="approved"] { background: var(--ok); border-color: transparent; }
.chip[data-st="pending-review"] { background: var(--wait); border-color: transparent; }
.chip[data-st="needs-rework"] { background: var(--back); border-color: transparent; }
.rules { display: grid; grid-template-columns: minmax(160px, 220px) 1fr; gap: 10px 20px; }
.rules dt { font-weight: 600; }
.rules dd { margin: 0; }
.rl { margin: 0; padding-left: 18px; }
.foot { margin-top: 40px; padding-top: 12px; padding-bottom: 32px; border-top: 1px solid var(--line); font-size: 14px; color: var(--muted); }
@media (max-width: 640px) { .rules { grid-template-columns: 1fr; } h1 { font-size: 24px; } }
@media print { body { background: #fff; color: #000; } .unit { break-inside: avoid; } }
</style>
</head>
<body>
${body}
<script type="application/json" id="akuko-view">${manifest.replace(/</g, '\\u003c')}</script>
</body>
</html>
`;
  return { html, status, images, embeddedBytes: budget.used };
}

/** Default output path for a gate's page: `<project>/views/signoff-<gate>.html`. */
export const signoffFileName = (gateId: string) => `signoff-${gateId}`;
export const defaultOutDir = (projectDir: string) => resolve(projectDir, 'views');
