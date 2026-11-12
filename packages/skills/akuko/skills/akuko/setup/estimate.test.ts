// akuko — whole-film estimate (WP-30). A synthetic 211-shot, 10-part project with given prices.
// Everything is invented. No provider is called: fetch is replaced with a thrower for the whole file.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadProviderConfig, parseProviderConfig, type AkukoProviderConfig } from '../providers/config.ts';
import { AkukoProjectSchema, type AkukoProject, type AkukoProjectInput } from '../schema/akuko-project.ts';
import { DEFAULT_TREATMENT_BY_TIER, ESTIMATE_STAGES, EstimateError, estimateFilm, formatEstimate, run, treatmentOf } from './estimate.ts';
import { DEFAULT_TREATMENT, treatmentOf as motionTreatmentOf } from '../motion/treatment.ts';
import { PAD_AFTER_S, PAD_BEFORE_S, wantedSpan } from '../lipsync/plan.ts';

let fetchCalls = 0;
const realFetch = globalThis.fetch;
beforeEach(() => { fetchCalls = 0; globalThis.fetch = (async () => { fetchCalls++; throw new Error('estimate must not call the network'); }) as typeof fetch; });
afterEach(() => { globalThis.fetch = realFetch; assert.equal(fetchCalls, 0, 'the estimate made a network call'); });

// ── given prices ─────────────────────────────────────────────────────────
// images 0.10 each; clips 0.10 per second; lip-sync 0.10 per second; text-to-speech 0.0001 per character.
function givenConfig(): AkukoProviderConfig {
  const doc = structuredClone(JSON.parse(JSON.stringify(loadProviderConfig()))) as { providers: Record<string, { default_model: string; models: Record<string, { price: { amount: number } }> }> };
  const set = (provider: string, amount: number): void => { for (const m of Object.values(doc.providers[provider]!.models)) m.price.amount = amount; };
  set('gemini-image', 0.1);
  set('fal-video', 0.1);
  set('fal-lipsync', 0.1);
  set('elevenlabs', 0.0001);
  set('fal', 0.2);
  return parseProviderConfig(doc);
}
const CONFIG = givenConfig();

// ── the synthetic project ────────────────────────────────────────────────
const PART_SIZES = [22, 30, 10, 16, 31, 15, 11, 34, 19, 23]; // 211 shots in P1..P10
const SHOT_S = 6;
// Each line starts on its shot's first frame, so the lip-sync step's lead-in (PAD_BEFORE_S, 0.2 s) is clamped away by the
// shot and only the tail (PAD_AFTER_S, 0.3 s) is added (WP-32: the step's own span rule): 5.3 s, billed at 0.10 = 0.53 per shot.
const LINE_S = 5;
const PER_LINE = 0.53;

interface Built { project: AkukoProjectInput; shotIds: string[]; byPart: Map<string, string[]>; tierA: string[] }

function build(over: Partial<AkukoProjectInput> = {}, opts: { master?: boolean } = {}): Built {
  const shots: NonNullable<AkukoProjectInput['shots']> = [];
  const scenes: NonNullable<AkukoProjectInput['scenes']> = [];
  const byPart = new Map<string, string[]>();
  const tierA: string[] = [];
  let i = 0;
  PART_SIZES.forEach((n, k) => {
    const part = `P${k + 1}`;
    const scene = `S${String(k + 1).padStart(2, '0')}`;
    scenes.push({ id: scene, part });
    byPart.set(part, []);
    for (let j = 0; j < n; j++, i++) {
      const id = `${scene}-${String((j + 1) * 10).padStart(3, '0')}`;
      const tier = i % 4 === 0 ? 'A' : i % 4 === 3 ? 'C' : 'B';
      if (tier === 'A') tierA.push(id);
      shots.push({ id, stage: 'sketch', status: 'approved', scene, part, tier, duration_s: SHOT_S, film: { in_s: i * SHOT_S, out_s: (i + 1) * SHOT_S }, prompt: 'x' });
      byPart.get(part)!.push(id);
    }
  });
  // The first 30 tier-A shots carry a spoken line; the first 5 are made video, the next 2 lipsync.
  const lines: NonNullable<NonNullable<AkukoProjectInput['audio']>['lines']> = [];
  tierA.slice(0, 30).forEach((sid, ord) => {
    const s = shots.find((x) => x.id === sid)!;
    const lid = `L${String(ord + 1).padStart(2, '0')}`;
    lines.push({ id: lid, kind: 'spoken', film_in_s: s.film!.in_s, film_out_s: s.film!.in_s + LINE_S });
    s.lines = [{ id: lid, kind: 'spoken' }];
    if (ord < 5) s.treatment = 'video';
    else if (ord < 7) s.treatment = 'lipsync';
  });
  // Two thought lines: they need nothing.
  const t1 = shots[1]!;
  lines.push({ id: 'T01', kind: 'thought', film_in_s: t1.film!.in_s, film_out_s: t1.film!.in_s + 3 });
  t1.lines = [{ id: 'T01', kind: 'thought' }];

  const project: AkukoProjectInput = {
    format: 'akuko',
    schema_version: 1,
    project: { slug: 'est', title: 'Estimate fixture', profile: 'film', created_at: '2026-11-01T00:00:00Z' },
    current_stage: 'keyframes',
    scenes,
    shots,
    bible: {
      characters: [
        { id: 'ADA', stage: 'bible', status: 'approved', name: 'Ada' },
        { id: 'BEN', stage: 'bible', status: 'approved', name: 'Ben' },
      ],
      locations: [{ id: 'PLAZA', stage: 'bible', status: 'approved', name: 'Plaza' }],
      styles: [{ id: 'HOUSE', stage: 'bible', status: 'approved', name: 'House style' }],
    },
    audio: { ...(opts.master === false ? {} : { master: { uri: 'master.wav', duration_s: 2000, sample_rate: 48000, start_tc: '00:00:00:00' } }), lines },
    budget: { cap: 1000, currency: 'USD', spent: 0 },
    ...over,
  } as AkukoProjectInput;
  return { project, shotIds: shots.map((s) => s.id), byPart, tierA };
}

const parse = (b: Built): AkukoProject => AkukoProjectSchema.parse(b.project);
const near = (a: number, b: number, msg?: string): void => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} expected ${b}, got ${a}`);

// ─────────────────────────────────────────────────────────────────────────

describe('the default treatment table (a local copy of WP-27, pinned)', () => {
  it('maps tier to treatment as the plan decided', () => {
    assert.deepEqual({ ...DEFAULT_TREATMENT_BY_TIER }, { A: 'still-move', B: 'still-move', C: 'still' });
    const base = { id: 'S01-010', stage: 'sketch' as const, status: 'approved' as const };
    const mk = (x: object) => AkukoProjectSchema.parse({ ...build().project, shots: [{ ...base, ...x }], scenes: [], audio: undefined, bible: {} }).shots[0]!;
    assert.equal(treatmentOf(mk({ tier: 'A' })), 'still-move');
    assert.equal(treatmentOf(mk({ tier: 'B' })), 'still-move');
    assert.equal(treatmentOf(mk({ tier: 'C' })), 'still');
    assert.equal(treatmentOf(mk({})), undefined, 'no tier, no treatment: today\'s behaviour');
    assert.equal(treatmentOf(mk({ tier: 'C', treatment: 'video' })), 'video', 'an explicit treatment wins');
  });
});

describe('the stated breakdown', () => {
  const e = estimateFilm(parse(build()), { config: CONFIG, imageProvider: 'gemini-image' });

  it('prices the bible: 2 characters x 2 images, a plate and a lookbook', () => {
    assert.equal(e.stages.bible.units, 6);
    near(e.stages.bible.likely, 6 * 0.1 * 1.5);
  });

  it('prices key frames, one image per shot, with the 1 / 1.5 / 3 tries', () => {
    assert.equal(e.stages.keyframes.units, 211);
    near(e.stages.keyframes.low, 21.1);
    near(e.stages.keyframes.likely, 31.65);
    near(e.stages.keyframes.high, 63.3);
  });

  it('gives a clip only to video shots (5 explicit), each fitted to 10 s, and caps the high tries at 3', () => {
    assert.equal(e.stages.motion.units, 5);
    // a 6 s shot covers to a 10 s clip: 10 s x 0.10 = 1.00 per try
    near(e.stages.motion.low, 5);
    near(e.stages.motion.likely, 7.5);
    near(e.stages.motion.high, 15);
  });

  it('prices lip-sync for video-with-a-line and lipsync shots only; thought lines are skipped', () => {
    assert.equal(e.stages.lipsync.units, 7);
    near(e.stages.lipsync.low, 7 * PER_LINE);
    near(e.stages.lipsync.likely, 7 * PER_LINE * 1.5);
    assert.ok(e.notes.some((n) => /23 tier-A shots with a spoken line could be lip-synced/.test(n)), e.notes.join('\n'));
  });

  it('is 0 for text-to-speech when the master is set', () => {
    assert.equal(e.stages.sound.units, 0);
    near(e.stages.sound.likely, 0);
  });

  it('adds up per stage, per part and for the film', () => {
    const sumStages = ESTIMATE_STAGES.reduce((s, st) => s + e.stages[st].likely, 0);
    near(e.total.likely, sumStages);
    near(e.parts.reduce((s, r) => s + r.likely, 0), e.total.likely);
    assert.deepEqual(e.parts.map((r) => r.part), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', '(film-wide)']);
    assert.equal(e.parts[0]!.byStage.keyframes.units, 22);
  });

  it('counts shots by treatment', () => {
    assert.equal(e.treatments['video'], 5);
    assert.equal(e.treatments['lipsync'], 2);
    assert.equal(Object.values(e.treatments).reduce((a, b) => a + b, 0), 211);
  });

  it('prints plain lines', () => {
    const text = formatEstimate(e);
    assert.match(text, /Whole-film estimate: Estimate fixture/);
    assert.match(text, /keyframes\s+211\s+0/);
    assert.match(text, /nothing is spent by this/);
  });
});

describe('P7 alone', () => {
  it('shows only that part, and leaves the film-wide bible out', () => {
    const b = build();
    const e = estimateFilm(parse(b), { config: CONFIG, imageProvider: 'gemini-image', part: 'P7' });
    assert.deepEqual(e.parts.map((r) => r.part), ['P7']);
    assert.equal(e.stages.keyframes.units, 11);
    near(e.stages.keyframes.likely, 11 * 0.1 * 1.5);
    assert.equal(e.stages.bible.units, 0);
    assert.ok(e.notes.some((n) => /bible is film-wide/.test(n)));
    const p7 = new Set(b.byPart.get('P7'));
    const proj = parse(b);
    const video = proj.shots.filter((s) => p7.has(s.id) && s.treatment === 'video').length;
    assert.equal(e.stages.motion.units, video);
    assert.equal(e.scope.part, 'P7');
  });

  it('refuses a part the project does not have', () => {
    assert.throws(() => estimateFilm(parse(build()), { config: CONFIG, imageProvider: 'gemini-image', part: 'P99' }), EstimateError);
  });
});

describe('overrides', () => {
  it('--heroes 15 prices 15 clips: the 5 video shots, then tier A in film order (not the lipsync ones)', () => {
    const e = estimateFilm(parse(build()), { config: CONFIG, imageProvider: 'gemini-image', heroes: 15 });
    assert.equal(e.stages.motion.units, 15);
    near(e.stages.motion.low, 15);
  });

  it('--lipsync-lines 26 prices 26 spoken lines at 0.53 (one shot each)', () => {
    const e = estimateFilm(parse(build()), { config: CONFIG, imageProvider: 'gemini-image', lipsyncLines: 26 });
    assert.equal(e.stages.lipsync.units, 26);
    near(e.stages.lipsync.low, 26 * PER_LINE);
    assert.ok(!e.notes.some((n) => /could be lip-synced/.test(n)), 'with an explicit count there is no candidate note');
  });

  it('warns when the count asked for is more than exists', () => {
    const e = estimateFilm(parse(build()), { config: CONFIG, imageProvider: 'gemini-image', lipsyncLines: 99 });
    assert.equal(e.stages.lipsync.units, 30);
    assert.ok(e.warnings.some((w) => /only 30 spoken lines/.test(w)));
  });

  it('--tries changes the range, but clips stay capped at 3 attempts', () => {
    const e = estimateFilm(parse(build()), { config: CONFIG, imageProvider: 'gemini-image', tries: [1, 2, 5] });
    near(e.stages.keyframes.likely, 42.2);
    near(e.stages.keyframes.high, 105.5);
    near(e.stages.motion.high, 15, 'capped at 3 tries, not 5');
  });
});

describe('what is already done is left out', () => {
  const b = build();
  const ids = b.shotIds.slice(0, 10);
  const assets = ids.map((id) => ({ id: `${id}_keyframe`, stage: 'keyframes' as const, status: 'approved' as const, kind: 'keyframe' as const, owner: id, file: { uri: `kf/${id}.png`, mime: 'image/png' } }));
  const ledger = ids.map((id, n) => ({ id: `job_a.${id}.1`, ts: '2026-11-09T10:00:00Z', provider: 'gemini-image', unit: `${id}_keyframe`, job: 'job_a', estimate: 0.1, actual: 0.1, status: 'done' as const, n }))
    .map(({ n: _n, ...x }) => x);
  const video = b.tierA[0]!; // an explicit video shot
  const clipId = `${video}_clip`;
  const video2 = b.tierA[1]!;
  const spend = (unit: string, n: number) => Array.from({ length: n }, (_, k) => ({ id: `job_c.${unit}.${k + 1}`, ts: '2026-11-09T11:00:00Z', provider: 'fal-video', unit, job: 'job_c', estimate: 1, actual: 1, status: 'done' as const }));

  it('excludes made key frames, shows the cap and what is spent', () => {
    const p = AkukoProjectSchema.parse({ ...build().project, assets, ledger, budget: { cap: 1000, currency: 'USD', spent: 1 } });
    const e = estimateFilm(p, { config: CONFIG, imageProvider: 'gemini-image' });
    assert.equal(e.stages.keyframes.units, 201);
    assert.equal(e.stages.keyframes.done, 10);
    near(e.stages.keyframes.low, 20.1);
    assert.deepEqual(e.budget, { cap: 1000, spent: 1, sunk: 0, reserved: 0, remaining: 999 });
  });

  it('leaves out a clip that used its 3 paid attempts and counts fewer tries for one with attempts left', () => {
    const p = AkukoProjectSchema.parse({
      ...build().project,
      assets: [
        { id: clipId, stage: 'motion', status: 'needs-rework', kind: 'clip', owner: video, tags: ['clip'] },
        { id: `${video2}_clip`, stage: 'motion', status: 'needs-rework', kind: 'clip', owner: video2, tags: ['clip'] },
      ],
      ledger: [...spend(clipId, 3), ...spend(`${video2}_clip`, 1)],
      budget: { cap: 1000, currency: 'USD', spent: 4 },
    });
    const e = estimateFilm(p, { config: CONFIG, imageProvider: 'gemini-image' });
    assert.equal(e.stages.motion.units, 4, 'the capped clip is not priced');
    assert.ok(e.warnings.some((w) => w.includes(clipId) && /3 paid attempts/.test(w)));
    // 3 clips with no attempts: 1.00 x (1, 1.5, 3); one with one attempt used: 2 left, so high counts 2.
    near(e.stages.motion.low, 4);
    near(e.stages.motion.likely, 3 * 1.5 + 1.5);
    near(e.stages.motion.high, 3 * 3 + 2);
  });

  it('skips removed rows', () => {
    const p = build();
    p.project.shots![3]!.source = { kind: 'sheet', id: 'S01-040', removed_at: '2026-11-09T00:00:00Z' };
    const e = estimateFilm(AkukoProjectSchema.parse(p.project), { config: CONFIG, imageProvider: 'gemini-image' });
    assert.equal(e.stages.keyframes.units, 210);
  });
});

describe('the budget', () => {
  it('warns on every estimate that overruns the cap', () => {
    const b = build({ budget: { cap: 40, currency: 'USD', spent: 0 } });
    const e = estimateFilm(parse(b), { config: CONFIG, imageProvider: 'gemini-image' });
    assert.ok(!e.warnings.some((w) => /at the low estimate/.test(w)), 'low (about 30) fits under 40');
    assert.ok(e.warnings.some((w) => /Over budget at the likely estimate/.test(w)), e.warnings.join('\n'));
    assert.ok(e.warnings.some((w) => /Over budget at the high estimate/.test(w)));
    assert.match(formatEstimate(e), /OVER the cap/);
  });

  it('says so when there is no budget', () => {
    const e = estimateFilm(parse(build({ budget: null })), { config: CONFIG, imageProvider: 'gemini-image' });
    assert.equal(e.budget, null);
    assert.ok(e.warnings.some((w) => /No budget is set/.test(w)));
  });

  it('prices text-to-speech when there is no master', () => {
    const b = build({}, { master: false });
    b.project.shots![0]!.narration = 'x'.repeat(100);
    const e = estimateFilm(parse(b), { config: CONFIG, imageProvider: 'gemini-image' });
    assert.equal(e.stages.sound.units, 1);
    near(e.stages.sound.low, 100 * 0.0001);
  });
});

describe('the command', () => {
  it('prints JSON, and writes nothing to the project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-est-'));
    const file = join(dir, 'akuko.json');
    await writeFile(file, JSON.stringify(parse(build())), 'utf8');
    const before = await readFile(file);
    const r = await run(['--project', dir, '--image-provider', 'gemini-image', '--json', '--heroes', '3', '--part', 'P7']);
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(r.out) as { scope: { part: string; heroes: number }; stages: Record<string, { units: number }> };
    assert.equal(j.scope.part, 'P7');
    assert.equal(j.scope.heroes, 3);
    assert.equal(j.stages['keyframes']!.units, 11);
    assert.deepEqual(await readFile(file), before);
  });

  it('refuses bad flags plainly', async () => {
    assert.equal((await run([])).code, 2);
    const dir = await mkdtemp(join(tmpdir(), 'akuko-est-'));
    await writeFile(join(dir, 'akuko.json'), JSON.stringify(parse(build())), 'utf8');
    assert.match((await run(['--project', dir, '--image-provider', 'gemini-image', '--tries', '1,2'])).out, /three positive numbers/);
    assert.match((await run(['--project', dir, '--image-provider', 'gemini-image', '--heroes', 'many'])).out, /whole number/);
  });
});

// ── review fixes ─────────────────────────────────────────────────────────
const paid = (provider: string, unit: string, model?: string) => ({
  id: `job_x.${unit}.1`, ts: '2026-11-09T10:00:00Z', provider, ...(model ? { model } : {}), unit, job: 'job_x', estimate: 0.1, actual: 0.1, status: 'done' as const,
});

describe('the image provider is inferred, never defaulted', () => {
  const first = (): string => `${build().shotIds[0]}_keyframe`;

  it('refuses when nothing paid has run and no flag is given', () => {
    assert.throws(() => estimateFilm(parse(build()), { config: CONFIG }), (e: unknown) => e instanceof EstimateError && /--image-provider/.test(e.message));
  });

  it('a manual-only ledger does not count as a provider', () => {
    const p = AkukoProjectSchema.parse({ ...build().project, ledger: [paid('manual', first())] });
    assert.throws(() => estimateFilm(p, { config: CONFIG }), EstimateError);
  });

  it('takes the provider and model of the most recent paid bible or key-frame call (fal prices 0.2)', () => {
    const p = AkukoProjectSchema.parse({
      ...build().project,
      ledger: [paid('gemini-image', first()), paid('fal', first(), 'fal-ai/nano-banana-2')],
      budget: { cap: 1000, currency: 'USD', spent: 0.2 },
    });
    const e = estimateFilm(p, { config: CONFIG });
    near(e.stages.keyframes.low, 211 * 0.2);
    assert.match(e.prices.source.images, /^fal fal-ai\/nano-banana-2 from the ledger/);
    assert.ok(e.prices.lines.some((l) => /^images: fal fal-ai\/nano-banana-2/.test(l) && /from the ledger/.test(l)));
    assert.ok(!formatEstimate(e).includes('gemini-image'), 'no cheaper provider appears');
  });

  it('falls back to the provider that made a bible or key-frame asset', () => {
    const id = build().shotIds[0]!;
    const p = AkukoProjectSchema.parse({ ...build().project, assets: [{ id: `${id}_keyframe`, stage: 'keyframes', status: 'needs-rework', kind: 'keyframe', owner: id, provider: 'fal', model: 'fal-ai/nano-banana-2' }] });
    const e = estimateFilm(p, { config: CONFIG });
    assert.match(e.prices.source.images, /^fal fal-ai\/nano-banana-2 from the assets/);
    near(e.stages.keyframes.low, 211 * 0.2);
  });

  it('--image-provider wins over the ledger and is said so', () => {
    const p = AkukoProjectSchema.parse({ ...build().project, ledger: [paid('fal', first(), 'fal-ai/nano-banana-2')] });
    const e = estimateFilm(p, { config: CONFIG, imageProvider: 'gemini-image' });
    assert.match(e.prices.source.images, /from --image-provider/);
    near(e.stages.keyframes.low, 21.1);
  });

  it('the video model comes from a paid clip, else the config default, and says which', () => {
    const none = estimateFilm(parse(build()), { config: CONFIG, imageProvider: 'gemini-image' });
    assert.match(none.prices.source.video, /config default/);
    const clip = `${build().tierA[0]}_clip`;
    const p = AkukoProjectSchema.parse({ ...build().project, ledger: [paid('fal-video', clip, 'fal-ai/kling-video/v2.6/pro/image-to-video')] });
    const e = estimateFilm(p, { config: CONFIG, imageProvider: 'gemini-image' });
    assert.match(e.prices.source.video, /^fal-video fal-ai\/kling-video\/v2\.6\/pro\/image-to-video from the ledger/);
    assert.match(estimateFilm(parse(build()), { config: CONFIG, imageProvider: 'gemini-image', videoModel: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video' }).prices.source.video, /from --video-model/);
  });

  it('prices clips on a direct video provider (--video-provider, or the provider of the last paid clip), with its lengths', () => {
    const real = loadProviderConfig();
    for (const provider of ['gemini-video', 'kling-video', 'byteplus-video']) {
      const e = estimateFilm(parse(build()), { config: real, imageProvider: 'gemini-image', videoProvider: provider });
      assert.match(e.prices.source.video, new RegExp(`^${provider} .*from --video-provider`));
      assert.ok(e.stages.motion.likely > 0, `${provider} priced the clips`);
      assert.ok(!e.warnings.some((w) => /no request rules|not priced/.test(w)), e.warnings.join(' | '));
    }
    const clip = `${build().tierA[0]}_clip`;
    const kling = real.providers['kling-video']!.default_model;
    const p = AkukoProjectSchema.parse({ ...build().project, ledger: [paid('kling-video', clip, kling)] });
    assert.match(estimateFilm(p, { config: real, imageProvider: 'gemini-image' }).prices.source.video, /^kling-video .*from the ledger/);
  });

  it('refuses to estimate with a model listed as price unverified', () => {
    const real = loadProviderConfig();
    const model = Object.keys(real.providers['byteplus-video']!.unverified_models ?? {})[0]!;
    assert.throws(() => estimateFilm(parse(build()), { config: real, imageProvider: 'gemini-image', videoProvider: 'byteplus-video', videoModel: model }), (e: unknown) => e instanceof EstimateError && /price unverified/.test(e.message));
  });
});

describe('long shots, short lines, part view', () => {
  it('prices ceil(shot / longest clip) clips for a shot over 10 s, and names it', () => {
    const b = build();
    const first = b.project.shots![0]!; // an explicit video shot
    first.duration_s = 23;
    first.film = { in_s: 0, out_s: 23 };
    const e = estimateFilm(parse(b), { config: CONFIG, imageProvider: 'gemini-image' });
    near(e.stages.motion.low, 4 + 3); // four 10 s clips at 1.00, one shot needing 3 clips
    assert.ok(e.warnings.some((w) => w.startsWith(`${first.id}: 23 s needs 3 clips`)), e.warnings.join('\n'));
  });

  it('prices a line under 5 s with the 480p fabric model', () => {
    const b = build();
    const l = b.project.audio!.lines![0]!; // belongs to a video shot, so it is priced by default
    l.film_out_s = l.film_in_s + 3; // 3.0 + the 0.3 s tail = 3.3 s, below h3-max's 5 s
    const e = estimateFilm(parse(b), { config: CONFIG, imageProvider: 'gemini-image' });
    near(e.stages.lipsync.low, 3.3 * 0.1 + 6 * PER_LINE);
    assert.ok(e.prices.lines.some((x) => /veed\/fabric-1\.0#480p/.test(x)), e.prices.lines.join('\n'));
    assert.ok(e.prices.lines.some((x) => /minimax\/h3-max/.test(x)));
  });

  it('a part view leaves out the bible and the lines outside the part', () => {
    const b = build();
    const e = estimateFilm(parse(b), { config: CONFIG, imageProvider: 'gemini-image', part: 'P1', lipsyncLines: 99 });
    const p1 = new Set(b.byPart.get('P1'));
    const inP1 = parse(b).shots.filter((s) => p1.has(s.id) && (s.lines ?? []).some((x) => x.kind === 'spoken')).length;
    assert.ok(inP1 > 0 && inP1 < 30);
    assert.equal(e.stages.lipsync.units, inP1);
    assert.equal(e.stages.bible.units, 0);
    assert.ok(!e.parts.some((r) => r.part === '(film-wide)'));
  });
});

describe('the printout', () => {
  it('puts the over-budget verdict first, explains Made, and always says music and sfx are not priced', () => {
    const e = estimateFilm(parse(build({ budget: { cap: 40, currency: 'USD', spent: 0 } })), { config: CONFIG, imageProvider: 'gemini-image' });
    const lines = formatEstimate(e).split('\n');
    assert.match(lines[1]!, /^!! Over budget at the likely estimate/);
    assert.ok(lines.some((l) => /^Made = units already made/.test(l)));
    assert.ok(lines.some((l) => /Music and sound effects are not priced/.test(l)));
    assert.ok(lines.some((l) => /one span covering its spoken lines/.test(l)));
    const w = lines.indexOf('Warnings:');
    assert.equal(lines[w - 1], '', 'a blank line before Warnings');
    assert.ok(e.warnings.some((x) => x.startsWith('Over budget')), 'the verdict stays in Warnings');
  });

  it('--json carries stages, total, budget and where the prices came from', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-est-'));
    await writeFile(join(dir, 'akuko.json'), JSON.stringify(parse(build())), 'utf8');
    const r = await run(['--project', dir, '--image-provider', 'gemini-image', '--json']);
    const j = JSON.parse(r.out) as ReturnType<typeof estimateFilm>;
    assert.equal(j.stages.keyframes.units, 211);
    assert.ok(j.stages.keyframes.likely > 0);
    near(j.total.likely, ESTIMATE_STAGES.reduce((s, st) => s + j.stages[st].likely, 0));
    assert.deepEqual(j.budget, { cap: 1000, spent: 0, sunk: 0, reserved: 0, remaining: 1000 });
    assert.match(j.prices.source.images, /^gemini-image .*from --image-provider/);
    assert.ok(j.prices.source.video.length > 0);
    assert.equal(j.currency, 'USD');
  });

  it('the command refuses without a provider and says what to pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'akuko-est-'));
    await writeFile(join(dir, 'akuko.json'), JSON.stringify(parse(build())), 'utf8');
    const r = await run(['--project', dir]);
    assert.equal(r.code, 1);
    assert.match(r.out, /--image-provider/);
  });
});

describe('lip-sync uses the lip-sync step\'s own span rule (WP-32)', () => {
  it('pads a line inside its shot by the step\'s PAD_BEFORE_S and PAD_AFTER_S, imported, not re-declared', () => {
    const b = build();
    const l = b.project.audio!.lines![0]!; // a video shot's line; the shot runs 6 s from l.film_in_s
    l.film_in_s += 1; // 1.0 to 6.0 s into the shot would end at the shot's end; make it 1.0 to 4.0 s
    l.film_out_s = l.film_in_s + 3;
    const e = estimateFilm(parse(b), { config: CONFIG, imageProvider: 'gemini-image' });
    const s = 3 + PAD_BEFORE_S + PAD_AFTER_S; // 3.5 s, well inside the shot: both pads count
    near(e.stages.lipsync.low, s * 0.1 + 6 * PER_LINE);
    assert.ok(e.notes.some((n) => n.includes(`${PAD_BEFORE_S} s before the first and ${PAD_AFTER_S} s after the last`)));
  });

  it('prices a shot with two spoken lines as one span, as the step cuts it, and clamps to the shot', () => {
    const b = build();
    const first = b.project.shots!.find((x) => x.treatment === 'lipsync')!;
    const at = first.film!.in_s;
    b.project.audio!.lines!.push({ id: 'L99', kind: 'spoken', film_in_s: at + 5.5, film_out_s: at + 5.9 });
    first.lines = [...(first.lines ?? []), { id: 'L99', kind: 'spoken' }];
    const p = parse(b);
    const e = estimateFilm(p, { config: CONFIG, imageProvider: 'gemini-image' });
    assert.equal(e.stages.lipsync.units, 7, 'still one lip-sync per shot');
    // That shot: lines from at+0 to at+5.9; the span runs from the shot's start (the lead-in is clamped) to its end at
    // 6 s (the tail is clamped too): 6 s. The step's own wantedSpan gives the same length.
    near(e.stages.lipsync.low, 6 * 0.1 + 6 * PER_LINE);
    const sp = wantedSpan(p, p.shots.find((x) => x.id === first.id)!)!;
    near(sp.out_s - sp.in_s, 6);
  });

  it('the treatment table is motion\'s own (imported, not a copy)', () => {
    assert.equal(treatmentOf, motionTreatmentOf);
    assert.equal(DEFAULT_TREATMENT_BY_TIER, DEFAULT_TREATMENT);
  });
});
