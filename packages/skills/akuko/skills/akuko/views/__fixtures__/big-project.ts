// A synthetic real-project-shaped film for WP-29's tests: 211 shots in 20
// scenes over a cold open and ten parts (P1…P10), placed on a master clock,
// with 12 cards, dialogue lines, imported bible tokens and lighting styles,
// project rules, two people (an approver and a signoff) and two gates
// (G-LOOK on the bible images, G-PILOT on the P7 key frames).
//
// Every id, name, prompt and time is invented; only the shape follows a real
// imported shot list (part sizes, scene-start gaps, part cards before parts).
// No real production material is used.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AkukoProjectSchema, type AkukoProject } from '../../schema/akuko-project.ts';
import { checkIntegrity } from '../../schema/integrity.ts';

/** Shots per part, in film order (211 in all). */
export const PART_SIZES: [string, number][] = [
  ['COLD-OPEN', 1], ['P1', 22], ['P2', 31], ['P3', 10], ['P4', 16], ['P5', 31],
  ['P6', 15], ['P7', 11], ['P8', 34], ['P9', 17], ['P10', 23],
];
/** Scenes per part. P7 is exactly one scene, S11 (the pilot). */
export const PART_SCENES: Record<string, string[]> = {
  'COLD-OPEN': ['S00'], P1: ['S01', 'S02'], P2: ['S03', 'S04'], P3: ['S05'], P4: ['S06', 'S07'], P5: ['S08', 'S09'],
  P6: ['S10'], P7: ['S11'], P8: ['S12', 'S13', 'S14'], P9: ['S15', 'S16', 'S16b'], P10: ['S17', 'S18'],
};

const CHARS = [
  ['ADA-NOW', 'Ada, now (invented)', 'Principal'], ['ADA', 'Ada, young (invented)', 'Principal'], ['BEN', 'Ben (invented)', 'Principal'],
  ['GUESTS', 'Party guests (invented)', 'Background'], ['GULLS', 'Two gulls (invented)', 'Supporting'],
] as const;
const LOCS = [['HARBOUR', 'Harbour wall'], ['KITCHEN', 'Small kitchen'], ['PARK', 'Winter park'], ['STATION', 'Night station'], ['ROOF', 'Flat roof']] as const;
const LIGHT = [
  ['L-DAWN', 'cool blue dawn light'], ['L-NOON', 'flat white noon light'], ['L-DUSK', 'low amber dusk light'], ['L-NIGHT', 'sodium street light at night'],
  ['L-LAMP', 'one warm table lamp, deep shadow'], ['L-RAIN', 'grey rain light'], ['L-SNOW', 'bright overcast snow light'], ['L-STILL', 'even studio light'], ['REF', 'matches its reference frame'],
] as const;
const FRAMING = ['WS', 'MS', 'CU', 'Insert', '2-shot', 'EWS', 'ECU', 'OTS'];
const MOTION = ['Slow push-in', 'Hold', 'Lateral drift', 'Slow pull-back'];
const TIERS = ['B', 'B', 'C', 'B', 'A', 'B'] as const;

/** A 1×1 PNG, for tests that need real image files. */
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const cs = (n: number) => n / 100; // centiseconds → seconds, exact enough and never accumulated as floats

/** The project, validated (schema + integrity). Deterministic. */
export function bigProject(): AkukoProject {
  const at = '2026-11-09T12:00:00Z';
  const scenes: any[] = [];
  const shots: any[] = [];
  const assets: any[] = [];
  const lines: any[] = [];
  let t = 0; // centiseconds
  let n = 0; // shot counter across the film
  const card = (sheetId: string, name: string, lenCs: number) => {
    assets.push({
      id: `card_${sheetId}`, kind: 'card', stage: 'export', status: 'pending-review', comments: [], tags: [], name,
      file: { uri: `../Cards/${sheetId}.png`, mime: 'image/png' }, film: { in_s: cs(t), out_s: cs(t + lenCs) },
      source: { kind: 'sheet', id: sheetId },
    });
    t += lenCs;
  };
  card('S00-020', 'Title card', 300);
  t += 46;
  for (const [part, size] of PART_SIZES) {
    if (part !== 'COLD-OPEN') { card(`${part}-CARD`, `${part} card`, 400); t += 46; }
    const sc = PART_SCENES[part]!;
    sc.forEach((sceneId, k) => {
      scenes.push({ id: sceneId, heading: `${sceneId} (invented scene)`, part, source: { kind: 'sheet', id: sceneId } });
      const count = Math.floor(size / sc.length) + (k < size % sc.length ? 1 : 0);
      if (k > 0) t += 50 + (k % 3) * 12; // a short gap at each scene start
      for (let i = 1; i <= count; i++, n++) {
        const id = `${sceneId}-${String(i * 10).padStart(3, '0')}`;
        const len = n % 15 === 7 ? 1800 : 200 + ((n * 7) % 13) * 75; // 2–11 s, and some long SPLIT shots
        const ch = CHARS[n % 3]!;
        const loc = LOCS[n % LOCS.length]!;
        const light = part === 'P7' ? 'L-DUSK' : n % 23 === 5 ? 'REF' : LIGHT[n % 8]![0];
        const status = part === 'P7' ? (i === 3 || i === 9 ? 'pending-review' : i === 5 ? 'needs-rework' : 'approved') : n % 37 === 11 ? 'pending-review' : 'approved';
        shots.push({
          id, stage: 'sketch', status, comments: [], scene: sceneId, part,
          shot_type: 'unset', camera_move: 'unset', blocking: [],
          source: { kind: 'sheet', id, row: n + 2 },
          film: { in_s: cs(t), out_s: cs(t + len) }, duration_s: cs(len),
          tier: TIERS[n % TIERS.length], framing: FRAMING[n % FRAMING.length], motion_note: MOTION[n % MOTION.length], lighting: light,
          action: `${ch[1]} at the ${loc[1].toLowerCase()} (invented).`,
          prompt: `${ch[1]} at the ${loc[1].toLowerCase()}, ${FRAMING[n % FRAMING.length]}, invented test prompt ${n + 1}`,
          negative: 'text, signs, logos, captions',
          refs: [ch[0], loc[0], light, 'house-style'],
          ...(len >= 1500 ? { notes: 'SPLIT' } : {}),
        });
        t += len;
      }
    });
  }
  card('CREDITS-010', 'End credits', 4200);
  const master = cs(t + 100);

  // Two lines in P7: one spoken, one thought.
  const s7 = shots.find((s) => s.id === 'S11-070');
  const s10 = shots.find((s) => s.id === 'S11-100');
  lines.push({ id: 'Q01', character: 'ADA-NOW', kind: 'spoken', film_in_s: s7.film.in_s + 0.2, film_out_s: s7.film.in_s + 1.6, text: 'An invented line.', words: [{ w: 'An', t_s: s7.film.in_s + 0.2 }, { w: 'invented', t_s: s7.film.in_s + 0.5 }, { w: 'line.', t_s: s7.film.in_s + 1.1 }] });
  lines.push({ id: 'Q02', character: 'ADA-NOW', kind: 'thought', film_in_s: s10.film.in_s + 0.3, film_out_s: s10.film.in_s + 1.3, text: 'An invented thought.' });
  s7.lines = [{ id: 'Q01', kind: 'spoken' }];
  s10.lines = [{ id: 'Q02', kind: 'thought' }];

  // Bible: imported tokens and lighting codes, plus the house style; images at stage bible.
  const entry = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, stage: 'breakdown', status: 'approved', comments: [], name, notes: [], refs: [], source: { kind: 'sheet', id }, ...extra });
  const characters = CHARS.map(([id, name, role]) => entry(id, name, { role }));
  const locations = LOCS.map(([id, name]) => entry(id, name));
  const styles = [...LIGHT.map(([id, phrase]) => entry(id, `Lighting ${id}`, { description: phrase })), { ...entry('house-style', 'House style', { description: 'invented house style block' }), source: undefined }];
  delete (styles[styles.length - 1] as any).source;
  const img = (owner: string, kind: string, status: string, file: boolean, dir: string) => ({
    id: `${owner}_${kind}`, kind, stage: 'bible', status, comments: [], tags: [], owner,
    ...(file ? { file: { uri: `bible/${dir}/${owner}/refs/${kind}.png`, mime: 'image/png' } } : {}),
  });
  assets.push(
    img('house-style', 'lookbook', 'approved', true, 'style'),
    img('ADA-NOW', 'portrait', 'approved', true, 'characters'), img('ADA-NOW', 'turnaround', 'pending-review', true, 'characters'),
    img('ADA', 'portrait', 'approved', true, 'characters'), img('ADA', 'turnaround', 'approved', true, 'characters'),
    img('BEN', 'portrait', 'pending-review', true, 'characters'), img('BEN', 'turnaround', 'pending', false, 'characters'),
    img('GULLS', 'portrait', 'approved', true, 'characters'),
    ...LOCS.map(([id], i) => img(id, 'plate', i < 3 ? 'approved' : 'pending-review', true, 'locations')),
  );
  // Key frames for the P7 pilot.
  shots.filter((s) => s.part === 'P7').forEach((s, i) => {
    const status = i < 4 ? 'approved' : i < 7 ? 'pending-review' : 'pending';
    assets.push({ id: `${s.id}_keyframe`, kind: 'keyframe', stage: 'keyframes', status, comments: [], tags: [], owner: s.id, ...(status !== 'pending' ? { file: { uri: `keyframes/${s.id}.png`, mime: 'image/png' } } : {}) });
  });

  const refShots = shots.filter((s) => s.lighting === 'REF').map((s) => s.id);
  const raw = {
    format: 'akuko', schema_version: 1,
    project: { slug: 'big-sheet', title: 'Big Sheet (synthetic)', profile: 'film', fps: '24', aspect_ratio: '16:9', created_at: at, updated_at: at, notes: 'Synthetic test project: every name and prompt is invented.' },
    stages: {
      intake: { state: 'approved' }, breakdown: { state: 'approved' }, sketch: { state: 'in-review' }, bible: { state: 'in-review' },
      keyframes: { state: 'in-progress' }, motion: { state: 'locked' }, sound: { state: 'locked' }, assemble: { state: 'locked' }, export: { state: 'locked' },
    },
    current_stage: 'sketch',
    scenes, shots,
    bible: { characters, locations, styles },
    assets,
    audio: { master: { uri: '../Audio/master.wav', duration_s: master, sample_rate: 48000, start_tc: '00:00:00:00' }, lines },
    budget: { cap: 100, currency: 'USD', spent: 0 },
    pending_spend: [],
    ledger: [],
    decisions: [],
    rules: {
      required: true,
      banned: [
        { term: 'brandname', note: 'no brand, film, studio or artist names (invented term)' },
        { term: 'flag', except: ['flagstone'], note: 'no flags or insignia' },
        { term: 'mask', scope: { parts: ['P5'] }, note: 'no masks in P5 (invented)' },
      ],
      require: [
        { text: 'text, signs, logos, captions', applies_to: 'negative', note: 'no text in any generation' },
        { text: 'seen only from behind', applies_to: 'prompt', scope: { scenes: ['S15'] }, note: 'guests: silhouettes, no faces' },
      ],
      uploads: {
        allow: [
          { sha256: 'ab'.repeat(32), label: 'Face crop (invented)', consent_ref: 'consent-1', for: ['ADA-NOW'] },
          { sha256: 'cd'.repeat(32), label: 'Two gulls photo (invented)', for: ['GULLS'] },
          { sha256: 'ef'.repeat(32), label: 'Master mix', slices: true, note: 'line slices for lip-sync' },
        ],
      },
      never_from_photo: ['BEN'],
      exempt: refShots.length ? [{ shots: refShots, skip: ['house-style'], note: 'REF shots carry their own style' }] : [],
      consent: [{ id: 'consent-1', who: 'The face in the crop (invented)', what: 'use of one face crop as a reference', date: '2026-11-06' }],
    },
    people: [
      { id: 'p-day', name: 'Day Approver (invented)', role: 'approver' },
      { id: 'p-sign', name: 'Sign-off Person (invented)', role: 'signoff' },
    ],
    gates: [
      { id: 'G-LOOK', title: 'The look: every bible image', scope: { stage: 'bible' }, needs: 'signoff' },
      { id: 'G-PILOT', title: 'The pilot: P7 key frames', scope: { stage: 'keyframes', parts: ['P7'] }, needs: 'signoff' },
    ],
  };
  const p = AkukoProjectSchema.parse(raw);
  const issues = checkIntegrity(p);
  if (issues.length) throw new Error(`big-project fixture has integrity issues: ${issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  return p;
}

/** Write the project to `<dir>/akuko.json`, plus a tiny PNG for every asset file inside the folder (cards sit outside it, in `../Cards`). */
export function writeBigProject(dir: string, p: AkukoProject = bigProject(), opts: { cards?: boolean } = {}): AkukoProject {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'akuko.json'), `${JSON.stringify(p, null, 2)}\n`);
  for (const a of p.assets) {
    if (!a.file || /^[a-z]+:/i.test(a.file.uri)) continue;
    if (a.file.uri.startsWith('../') && !opts.cards) continue;
    const f = join(dir, ...a.file.uri.split('/'));
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, TINY_PNG);
  }
  return p;
}
