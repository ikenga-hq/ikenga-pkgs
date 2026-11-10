/**
 * akuko — project rules: the checks (WP-26).
 *
 * `checkJob(project, job)` is what the guard (`guard.ts`) runs on every job
 * before the spend gate sees it; `checkProjectRules(project)` is the free
 * preflight (`cli.ts check`) over every shot and every listed reference.
 * Both return breaches; neither writes anything. Semantics are documented in
 * `lib/state.md` §"Rules guard (WP-26)".
 */

import type { Job, JobItem, JobRef, Provider } from '../providers/contract.ts';
import type { AkukoProject, Asset, BibleEntry, RuleScope, Rules, Scene, Shot } from '../schema/akuko-project.ts';
import { RulesSchema, findUnit } from '../schema/akuko-project.ts';
import { MANUAL_PROVIDER, classifyRef, type HashCache, type RefOrigin } from './refs.ts';
import { bannedMatches, containsRequired, normalizeRequired, snippet } from './text.ts';

// ─────────────────────────────────────────────────────────────────────────
// Breaches
// ─────────────────────────────────────────────────────────────────────────

/** Which rule a breach is against. */
export type RuleName =
  | 'required'            // rules.required is true but the rules are empty or invalid
  | 'banned'              // rules.banned
  | 'require'             // rules.require
  | 'uploads'             // an external file not in rules.uploads.allow, or outside its `for`, or unverifiable
  | 'never-from-photo'    // rules.never_from_photo
  | 'generated-changed';  // a generated file whose bytes no longer match the hash recorded when it was stored

export interface Breach {
  rule: RuleName;
  /** Where: a shot id, `bible:<entry id>`, or a unit id. */
  where: string;
  unit?: string;
  shot?: string;
  entry?: string;
  /** The text field the breach is in, e.g. `prompt`, `negative`, `spoken text`. */
  field?: string;
  /** The offending (or missing) text. */
  text?: string;
  /** The offending file (uri as the project names it) and its hash, when known. */
  file?: string;
  sha256?: string;
  ref?: string;
  message: string;
}

/** Exemption names (`rules.exempt[].skip`) the checks understand. */
export const SKIP_NAMES = ['banned', 'require', 'house-style'] as const;
/** The bible style entry whose text `skip: ["house-style"]` refers to (WP-25 imports the sheet's STYLE BLOCK under this id). */
export const HOUSE_STYLE_ID = 'house-style';
/** Ref rules are hard: an exemption can't switch them off. */
export const UNSKIPPABLE = ['required', 'uploads', 'never-from-photo', 'generated-changed'] as const;
/** Outputs that are pictures made from a prompt: `require` applies to their prompt and negative. */
export const PICTURE_OUTPUTS = ['keyframe', 'clip'] as const;

// ─────────────────────────────────────────────────────────────────────────
// Rules status
// ─────────────────────────────────────────────────────────────────────────

export interface RulesStatus {
  /** The project has a `rules` block. */
  present: boolean;
  required: boolean;
  /** Present but with nothing to enforce (no banned, require, allow or never_from_photo). */
  empty: boolean;
  /** Schema problems, when the block fails `RulesSchema` (a project read through the host never does). */
  invalid?: string;
  rules: Rules;
}

export function rulesStatus(p: AkukoProject): RulesStatus {
  if (p.rules === undefined) return { present: false, required: false, empty: true, rules: RulesSchema.parse({}) };
  const parsed = RulesSchema.safeParse(p.rules);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { present: true, required: (p.rules as { required?: unknown }).required === true, empty: true, invalid: i ? `${i.path.join('.') || 'rules'}: ${i.message}` : 'invalid', rules: RulesSchema.parse({}) };
  }
  const r = parsed.data;
  const blank = r.banned.some((b) => b.term.trim() === '') || r.require.some((q) => q.text.trim() === '');
  const empty = r.banned.length + r.require.length + r.uploads.allow.length + r.never_from_photo.length === 0;
  return { present: true, required: r.required, empty, ...(blank ? { invalid: 'a banned term or required text is blank' } : {}), rules: r };
}

// ─────────────────────────────────────────────────────────────────────────
// What an item is about
// ─────────────────────────────────────────────────────────────────────────

interface Context {
  shot?: Shot;
  scene?: Scene;
  entry?: BibleEntry;
  /** Bible ids the item concerns: the shot's refs and lighting, or the bible entry it is for. */
  bibleIds: string[];
}

const bibleIdsOf = (p: AkukoProject): Set<string> =>
  new Set([...p.bible.characters, ...p.bible.locations, ...p.bible.styles].map((e) => e.id));

function shotContext(p: AkukoProject, shot: Shot): Context {
  const ids = bibleIdsOf(p);
  const scene = p.scenes.find((s) => s.id === shot.scene);
  const bibleIds = [...new Set([...shot.refs, ...(shot.lighting ? [shot.lighting] : [])])].filter((id) => ids.has(id));
  return { shot, ...(scene ? { scene } : {}), bibleIds };
}

/** The shot or bible entry a unit belongs to (a shot, a bible entry, or an asset owned by one, up to two owners up). */
export function contextOf(p: AkukoProject, unit: string): Context {
  let id: string | undefined = unit;
  for (let depth = 0; id !== undefined && depth < 3; depth++) {
    const u = findUnit(p, id);
    if (!u) break;
    if (u.kind === 'shot') return shotContext(p, u.unit);
    if (u.kind !== 'asset') return { entry: u.unit, bibleIds: [u.unit.id] };
    id = u.unit.owner;
  }
  return { bibleIds: [] };
}

function inScope(scope: RuleScope | undefined, c: Context): boolean {
  if (!scope) return true;
  const s = c.shot;
  if (!s) return false;            // a scoped rule only ever applies to shots
  const part = s.part ?? c.scene?.part;
  return (scope.shots?.includes(s.id) ?? false)
    || (s.scene !== undefined && (scope.scenes?.includes(s.scene) ?? false))
    || (part !== undefined && (scope.parts?.includes(part) ?? false));
}

function skipsFor(rules: Rules, shot: Shot | undefined): Set<string> {
  const out = new Set<string>();
  if (!shot) return out;
  for (const e of rules.exempt) if (e.shots.includes(shot.id)) for (const s of e.skip) out.add(s.trim().toLocaleLowerCase('en'));
  return out;
}

const houseStyleText = (p: AkukoProject): string | undefined => {
  const e = p.bible.styles.find((x) => x.id === HOUSE_STYLE_ID);
  return e ? [e.description ?? '', ...e.notes].join('\n') : undefined;
};

/** True when `skips` switch this banned term off for the shot. */
const skipsBanned = (skips: Set<string>, term: string): boolean =>
  skips.has('banned') || skips.has(`banned:${term.trim().toLocaleLowerCase('en')}`);

/** True when `skips` switch this required text off: `require`, `require:<text>`, or `house-style` for text that is part of the house style. */
function skipsRequire(skips: Set<string>, text: string, house: string | undefined): boolean {
  if (skips.has('require') || skips.has(`require:${normalizeRequired(text)}`)) return true;
  return skips.has('house-style') && house !== undefined && containsRequired(house, text);
}

const where = (c: Context, unit?: string): string => c.shot?.id ?? (c.entry ? `bible:${c.entry.id}` : unit ?? '(project)');
const scopeLabel = (s: RuleScope | undefined): string => {
  if (!s) return 'the whole film';
  const bits = [s.shots?.length ? `shots ${s.shots.join(', ')}` : '', s.scenes?.length ? `scenes ${s.scenes.join(', ')}` : '', s.parts?.length ? `parts ${s.parts.join(', ')}` : ''].filter(Boolean);
  return bits.join('; ');
};
const short = (h: string): string => `${h.slice(0, 12)}…`;

// ─────────────────────────────────────────────────────────────────────────
// Text rules
// ─────────────────────────────────────────────────────────────────────────

interface TextField { field: string; text: string | undefined }

function bannedIn(rules: Rules, c: Context, fields: TextField[], skips: Set<string>, unit?: string): Breach[] {
  const out: Breach[] = [];
  for (const b of rules.banned) {
    if (!inScope(b.scope, c) || skipsBanned(skips, b.term)) continue;
    for (const f of fields) {
      if (!f.text) continue;
      const hits = bannedMatches(f.text, b.term, b.except ?? []);
      if (hits.length === 0) continue;
      const text = snippet(f.text, hits[0]!);
      out.push({
        rule: 'banned', where: where(c, unit), ...(unit ? { unit } : {}), ...ids(c), field: f.field, text,
        message: `banned term "${b.term}" in the ${f.field}${hits.length > 1 ? ` (${hits.length} times)` : ''}: "${text}"${b.note ? ` (${b.note})` : ''}`,
      });
    }
  }
  return out;
}

function requireIn(rules: Rules, p: AkukoProject, c: Context, sent: { prompt: string | undefined; negative: string | undefined }, skips: Set<string>, unit?: string): Breach[] {
  const out: Breach[] = [];
  const house = houseStyleText(p);
  for (const r of rules.require) {
    if (!inScope(r.scope, c) || skipsRequire(skips, r.text, house)) continue;
    const text = r.applies_to === 'prompt' ? sent.prompt : sent.negative;
    if (containsRequired(text, r.text)) continue;
    const field = r.applies_to === 'prompt' ? 'prompt' : 'negative prompt';
    out.push({
      rule: 'require', where: where(c, unit), ...(unit ? { unit } : {}), ...ids(c), field, text: r.text,
      message: text === undefined || text.trim() === ''
        ? `required text "${r.text}" is missing: there is no ${field} (applies to ${scopeLabel(r.scope)})${r.note ? ` (${r.note})` : ''}`
        : `the ${field} lacks required text "${r.text}" (applies to ${scopeLabel(r.scope)})${r.note ? ` (${r.note})` : ''}`,
    });
  }
  return out;
}

const ids = (c: Context): Pick<Breach, 'shot' | 'entry'> => ({ ...(c.shot ? { shot: c.shot.id } : {}), ...(c.entry ? { entry: c.entry.id } : {}) });

// ─────────────────────────────────────────────────────────────────────────
// Ref rules
// ─────────────────────────────────────────────────────────────────────────

/**
 * The bible ids an external ref is a reference FOR: the entry that owns the
 * asset, else the bible entry the ref names, else everything the item
 * concerns (strict: a picture attached to a shot counts as a reference for
 * every entry in that shot).
 */
function targetsOf(p: AkukoProject, ref: Pick<JobRef, 'id'>, asset: Asset | undefined, c: Context): string[] {
  const all = bibleIdsOf(p);
  if (asset?.owner !== undefined && all.has(asset.owner)) return [asset.owner];
  if (all.has(ref.id)) return [ref.id];
  return c.bibleIds;
}

async function refBreaches(
  p: AkukoProject,
  rules: Rules,
  c: Context,
  ref: Pick<JobRef, 'id' | 'uri' | 'note'>,
  ctx: { projectDir?: string | undefined; cache?: HashCache | undefined },
  unit?: string,
): Promise<{ origin: RefOrigin; breaches: Breach[] }> {
  const origin = await classifyRef(p, ref, ctx);
  const base = { where: where(c, unit), ...(unit ? { unit } : {}), ...ids(c), ref: ref.id };
  const out: Breach[] = [];
  if (origin.kind === 'no-file' || origin.kind === 'generated') return { origin, breaches: out };
  if (origin.kind === 'generated-changed') {
    out.push({ ...base, rule: 'generated-changed', file: origin.uri, sha256: origin.actual,
      message: `ref ${ref.id} (${origin.uri}) was generated by job ${origin.job}, but the file has changed since (sha256 ${short(origin.actual)}, recorded ${short(origin.expected)}); it is treated as a different file` });
    return { origin, breaches: out };
  }
  const targets = targetsOf(p, ref, origin.asset, c);
  const forbidden = targets.filter((t) => rules.never_from_photo.includes(t));
  if (forbidden.length) {
    out.push({ ...base, rule: 'never-from-photo', file: origin.uri, ...(origin.kind === 'external' ? { sha256: origin.sha256 } : {}),
      message: `ref ${ref.id} (${origin.uri}) is not a file akuko generated, and ${forbidden.join(', ')} may only use generated references (rules.never_from_photo)` });
  }
  if (origin.kind === 'unverifiable') {
    const why = origin.reason === 'missing' ? 'the file is not there' : origin.reason === 'remote' ? 'it is not a local file, so its content cannot be checked' : `it cannot be read${origin.detail ? ` (${origin.detail})` : ''}`;
    out.push({ ...base, rule: 'uploads', file: origin.uri,
      message: `ref ${ref.id} (${origin.uri}) is not a file akuko generated and ${why}; only files whose sha256 is in rules.uploads.allow can be sent` });
    return { origin, breaches: out };
  }
  const via = origin.slice;
  const allow = via
    ? rules.uploads.allow.find((a) => a.sha256 === via.sha256 && a.slices === true)
    : rules.uploads.allow.find((a) => a.sha256 === origin.sha256);
  if (!allow) {
    out.push({ ...base, rule: 'uploads', file: origin.uri, sha256: origin.sha256,
      message: via
        ? `ref ${ref.id} (${origin.uri}) is a slice of sha256 ${short(via.sha256)}, which is not in rules.uploads.allow with slices: true`
        : `ref ${ref.id} (${origin.uri}, sha256 ${short(origin.sha256)}) is not a file akuko generated and its hash is not in rules.uploads.allow` });
    return { origin, breaches: out };
  }
  if (allow.for !== undefined) {
    const outside = targets.filter((t) => !allow.for!.includes(t));
    if (targets.length === 0 || outside.length) {
      out.push({ ...base, rule: 'uploads', file: origin.uri, sha256: origin.sha256,
        message: `ref ${ref.id} (${origin.uri}) is the allowed file "${allow.label}", which may be a reference only for ${allow.for.join(', ')}; here it is for ${targets.length ? outside.join(', ') : 'nothing named'}` });
    }
  }
  return { origin, breaches: out };
}

// ─────────────────────────────────────────────────────────────────────────
// One job
// ─────────────────────────────────────────────────────────────────────────

export interface CheckOptions {
  /** Folder that relative uris are read from (the project folder). */
  projectDir?: string | undefined;
  /** Sealed providers, for their billing. Without it, every provider but `manual` counts as paid. */
  providers?: Provider[] | undefined;
  cache?: HashCache | undefined;
}

export interface JobCheck {
  /** `rules-missing`: rules required but empty or invalid. `rules-breach`: a rule was broken. */
  outcome: 'ok' | 'rules-missing' | 'rules-breach';
  breaches: Breach[];
  /** Whether the ref rules ran (paid jobs only). */
  paid: boolean;
}

export function isPaidJob(job: Pick<Job, 'provider'>, providers?: Provider[]): boolean {
  const p = providers?.find((x) => x.id === job.provider);
  if (p) return p.billing !== 'free';
  return job.provider !== MANUAL_PROVIDER;
}

function itemFields(job: Job, item: JobItem): TextField[] {
  return [
    { field: job.kind === 'audio' ? 'spoken text' : 'prompt', text: item.prompt },
    { field: 'negative prompt', text: item.negative },
    { field: 'camera note', text: item.camera },
    ...(item.refs ?? []).map((r) => ({ field: `note on ref ${r.id}`, text: r.note })),
  ];
}

/**
 * Check one job against the project's rules. No rules block = nothing to
 * check. Text rules run on every job (a manual prompt package is what the
 * person pastes into a generator); ref rules run on paid jobs, which are the
 * ones where akuko itself sends files to a provider.
 */
export async function checkJob(p: AkukoProject, job: Job, opts: CheckOptions = {}): Promise<JobCheck> {
  const paid = isPaidJob(job, opts.providers);
  const st = rulesStatus(p);
  if (st.invalid) {
    return { outcome: 'rules-missing', paid, breaches: [{ rule: 'required', where: '(project)', message: `the project rules are not valid (${st.invalid}); nothing runs until they are fixed` }] };
  }
  if (!st.present) return { outcome: 'ok', paid, breaches: [] };
  if (st.required && st.empty && paid) {
    return { outcome: 'rules-missing', paid, breaches: [{ rule: 'required', where: '(project)', message: 'rules.required is true but the project has no rules to check (no banned terms, required text, allowed files or never-from-photo entries); a paid job can\'t run until they are recorded' }] };
  }
  const rules = st.rules;
  const ctx = { projectDir: opts.projectDir, cache: opts.cache };
  const breaches: Breach[] = [];
  for (const item of job.items) {
    const c = contextOf(p, item.unit);
    const skips = skipsFor(rules, c.shot);
    breaches.push(...bannedIn(rules, c, itemFields(job, item), skips, item.unit));
    if (c.shot && (PICTURE_OUTPUTS as readonly string[]).includes(item.output)) {
      breaches.push(...requireIn(rules, p, c, { prompt: item.prompt, negative: item.negative }, skips, item.unit));
    }
    if (!paid) continue;
    for (const ref of item.refs ?? []) breaches.push(...(await refBreaches(p, rules, c, ref, ctx, item.unit)).breaches);
  }
  return { outcome: breaches.length ? 'rules-breach' : 'ok', paid, breaches };
}

// ─────────────────────────────────────────────────────────────────────────
// Free preflight over the whole project
// ─────────────────────────────────────────────────────────────────────────

export interface ProjectCheck {
  status: RulesStatus;
  breaches: Breach[];
  /** Rule-setup problems that are not breaches (e.g. an exemption naming an unknown rule). */
  warnings: string[];
  counts: { shots: number; entries: number; refs: number };
}

const hasFile = (a: Asset): boolean => a.file?.uri !== undefined;

/** Rule-setup problems that don't break a job but probably aren't what the person meant. */
export function ruleWarnings(p: AkukoProject, rules: Rules): string[] {
  const out: string[] = [];
  for (const e of rules.exempt) {
    for (const raw of e.skip) {
      const s = raw.trim().toLocaleLowerCase('en');
      if ((UNSKIPPABLE as readonly string[]).includes(s)) out.push(`exempt names "${raw}", which can't be skipped (reference rules always apply); it has no effect`);
      else if (!(SKIP_NAMES as readonly string[]).includes(s) && !s.startsWith('banned:') && !s.startsWith('require:')) {
        out.push(`exempt names "${raw}", which is not a rule akuko knows (${SKIP_NAMES.join(', ')}, banned:<term>, require:<text>); it has no effect`);
      } else if (s === 'house-style' && !p.bible.styles.some((x) => x.id === HOUSE_STYLE_ID)) {
        out.push(`exempt names "house-style", but there is no bible style entry "${HOUSE_STYLE_ID}" holding the house style; it skips nothing`);
      } else if (s.startsWith('banned:') && !rules.banned.some((b) => `banned:${b.term.trim().toLocaleLowerCase('en')}` === s)) {
        out.push(`exempt names "${raw}", but no banned term matches it; it has no effect`);
      } else if (s.startsWith('require:') && !rules.require.some((r) => `require:${normalizeRequired(r.text)}` === s)) {
        out.push(`exempt names "${raw}", but no required text matches it; it has no effect`);
      }
    }
  }
  for (const b of rules.banned) {
    for (const x of b.except ?? []) {
      if (bannedMatches(x, b.term).length === 0) out.push(`banned "${b.term}": the exception "${x}" doesn't contain it as a whole word, so it changes nothing`);
    }
  }
  for (const id of rules.never_from_photo) {
    const allowed = rules.uploads.allow.filter((a) => a.for?.includes(id));
    if (allowed.length) out.push(`${id} is never_from_photo, but ${allowed.map((a) => `"${a.label}"`).join(', ')} is allowed for it; never_from_photo wins, so that file can't be used`);
  }
  return out;
}

/**
 * The preflight: every shot's own prompt and negative (not yet wrapped in a
 * stage's framing text), every bible entry's name, description and notes
 * (they go into prompts) against unscoped banned terms, and every listed
 * reference file as if it were about to be uploaded: each bible entry's
 * `refs[]` and the `reference` assets the person attached to an entry or a
 * shot. Free: nothing is built, priced or sent.
 */
export async function checkProjectRules(p: AkukoProject, opts: Omit<CheckOptions, 'providers'> = {}): Promise<ProjectCheck> {
  const st = rulesStatus(p);
  const counts = { shots: 0, entries: 0, refs: 0 };
  if (st.invalid) {
    return { status: st, warnings: [], counts, breaches: [{ rule: 'required', where: '(project)', message: `the project rules are not valid (${st.invalid})` }] };
  }
  if (!st.present) return { status: st, breaches: [], warnings: [], counts };
  const rules = st.rules;
  const breaches: Breach[] = [];
  if (st.required && st.empty) {
    breaches.push({ rule: 'required', where: '(project)', message: 'rules.required is true but the project has no rules to check; every paid job will be refused' });
  }
  const ctx = { projectDir: opts.projectDir, cache: opts.cache };

  for (const shot of p.shots) {
    if (shot.source?.removed_at) continue;   // a row that left the sheet is kept but never generated
    counts.shots++;
    const c = shotContext(p, shot);
    const skips = skipsFor(rules, shot);
    breaches.push(...bannedIn(rules, c, [{ field: 'prompt', text: shot.prompt }, { field: 'negative prompt', text: shot.negative }, { field: 'camera note', text: shot.camera }], skips));
    breaches.push(...requireIn(rules, p, c, { prompt: shot.prompt, negative: shot.negative }, skips));
    for (const a of p.assets) {
      if (a.kind !== 'reference' || a.owner !== shot.id || !hasFile(a)) continue;
      counts.refs++;
      breaches.push(...(await refBreaches(p, rules, c, { id: a.id, uri: a.file!.uri }, ctx)).breaches);
    }
  }

  for (const entry of [...p.bible.characters, ...p.bible.locations, ...p.bible.styles]) {
    counts.entries++;
    const c: Context = { entry, bibleIds: [entry.id] };
    breaches.push(...bannedIn(rules, c, [{ field: 'name', text: entry.name }, { field: 'description', text: entry.description }, ...entry.notes.map((n) => ({ field: 'note', text: n }))], new Set()));
    const listed = new Set(entry.refs);
    for (const a of p.assets) if (a.kind === 'reference' && a.owner === entry.id) listed.add(a.id);
    for (const id of listed) {
      const a = p.assets.find((x) => x.id === id);
      if (!a || !hasFile(a)) continue;
      counts.refs++;
      breaches.push(...(await refBreaches(p, rules, c, { id: a.id, uri: a.file!.uri }, ctx)).breaches);
    }
  }

  return { status: st, breaches, warnings: ruleWarnings(p, rules), counts };
}

/** One line per breach: `S11-070 [banned] banned term "x" in the prompt: "…"`. */
export const formatBreach = (b: Breach): string => `${b.where} [${b.rule}] ${b.message}`;
