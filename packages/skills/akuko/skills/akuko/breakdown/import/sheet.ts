/**
 * akuko — turn an existing shot list into akuko's breakdown (WP-25).
 *
 * `importSheet(project, input)` is pure: the files are read by the caller
 * (`files.ts`, `../cli.ts`) and handed in as tables. It
 *   - rebuilds each shot's full prompt (the sheet's formula column has no saved
 *     value): the shot's own text with `[TOKENS]` expanded, then the lighting
 *     phrase, then the house style block; a reference shot skips the house
 *     style, and a text that starts with "(" is used as written;
 *   - writes the bible (tokens, lighting codes, the house style), scenes, parts,
 *     shots with film times, ready-made rows as `card` assets, and the dialogue
 *     lines linked to shots by film time;
 *   - sets the master clock when it is given;
 *   - on a re-import, updates text and timing by sheet id and **never** touches
 *     status, approvals, other assets, the ledger, or what a later stage added
 *     (`treatment`, `move`, ...); a row that left the sheet is flagged
 *     (`source.removed_at`), never deleted.
 *
 * Nothing here approves anything: every new unit is `pending-review`.
 */

import {
  AkukoProjectSchema,
  FpsSchema,
  SHEET_ID_PATTERN,
  type AkukoProject,
  type Asset,
  type AudioLine,
  type BibleEntry,
  type FpsLabel,
  type MasterAudio,
  type Scene,
  type SheetSource,
  type Shot,
} from '../../schema/akuko-project.ts';
import { checkIntegrity, type IntegrityIssue } from '../../schema/integrity.ts';
import { completeIntake } from '../intake.ts';
import { lintShots, lintSheetIdsInScript, type LintIssue } from '../lint.ts';
import { columnOf, formatFilmTime, parseFilmTime, type Table, type TableRow } from './read.ts';
import { DEFAULT_MAPPING, type ImportMapping } from './mapping.ts';

export class ImportError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`akuko: the shot list can't be imported:\n- ${problems.join('\n- ')}`);
    this.name = 'ImportError';
    this.problems = problems;
  }
}

// ── input ────────────────────────────────────────────────────────────────

export interface ImportInput {
  /** The shot sheet. */
  shots: Table;
  tokens?: Table;
  lighting?: Table;
  /** The dialogue lines (the quotes file). */
  lines?: Table;
  mapping?: ImportMapping;
  /** Set as `audio.master` (paths relative to the project). */
  master?: MasterAudio;
  fps?: FpsLabel;
  /** The film script: recorded as `script.source`; its text is searched for each sheet id. */
  filmScript?: { uri: string; text?: string };
  /** The sheet file itself, recorded as the intake asset the person approves. */
  sheetFile?: { uri: string; mime: string };
  /** The file for a ready-made row's sheet id (a path relative to the project). Not found: the row is left out with a warning. */
  cardFile?: (sheetId: string) => string | undefined;
  /** A line's own clip, by the name the quotes file gives (a path relative to the project). */
  clipUri?: (name: string) => string | undefined;
}

export interface ImportOptions {
  now?: () => Date;
}

// ── output ───────────────────────────────────────────────────────────────

export type ChangeKind = 'shot' | 'scene' | 'card' | 'character' | 'location' | 'style' | 'line';

export interface Change {
  kind: ChangeKind;
  id: string;
  /** Fields that differ (a re-import). */
  fields?: string[];
  /** The unit is approved: it changed, and its approval stands. */
  approved?: boolean;
}

export interface ImportSummary {
  firstImport: boolean;
  /** What the project holds from the sheet now (rows that left it not counted). */
  counts: { shots: number; cards: number; scenes: number; lines: number; characters: number; locations: number; styles: number; shotsWithLines: number };
  added: Change[];
  changed: Change[];
  removed: Change[];
  unchanged: number;
  /** Per part, in sheet order: shots and the film span they cover. */
  parts: { part: string; shots: number; in_s: number; out_s: number }[];
  /** Rows that were left out, with why. */
  skipped: string[];
}

export interface ImportResult {
  project: AkukoProject;
  summary: ImportSummary;
  warnings: string[];
  lint: LintIssue[];
  /** Empty when the project is consistent. A non-empty list means "do not write". */
  integrity: IntegrityIssue[];
}

// ── small helpers ────────────────────────────────────────────────────────

const norm = (s: string): string => s.trim().toLowerCase();
const cell = (r: TableRow, i: number): string => (i >= 0 ? (r.cells[i] ?? '').trim() : '');
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A sheet id is letters, digits, "." and "-" (no "_"); anything else becomes "-". */
export function cleanSheetId(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+$/, '');
}

const SHOT_TYPE: Record<string, Shot['shot_type']> = {
  ews: 'ews', ws: 'ws', ls: 'ls', fs: 'fs', ms: 'ms', cu: 'cu', ecu: 'ecu', ots: 'ots', pov: 'pov', insert: 'insert', aerial: 'aerial',
};

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4', wav: 'audio/wav', mp3: 'audio/mpeg',
};
export const mimeOf = (path: string): string => MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

interface ShotRow {
  row: number;
  id: string;
  scene: string;
  cue: string;
  tier: string;
  framing: string;
  prompt: string;
  motion: string;
  characters: string[];
  location: string;
  notes: string;
  filmIn: number;
  filmOut: number;
  part: string;
  lighting: string;
  lineIds: string[];
  refMoment: string;
}

const splitList = (s: string): string[] => s.split(/[,;]/).map((x) => x.trim()).filter((x) => x !== '' && x !== '—' && x !== '-');

// ── the importer ─────────────────────────────────────────────────────────

export function importSheet(project: AkukoProject, input: ImportInput, opts: ImportOptions = {}): ImportResult {
  const nowIso = (opts.now ?? (() => new Date()))().toISOString();
  const m = input.mapping ?? DEFAULT_MAPPING;
  const warnings: string[] = [];
  const skipped: string[] = [];
  const warn = (s: string) => warnings.push(s);

  const existingShots = project.shots;
  if (existingShots.some((s) => s.source?.kind !== 'sheet')) {
    throw new ImportError(['this project already has shots from a breakdown; a shot list is imported into a project of its own']);
  }

  // ── tokens and lighting ──
  const tokenTable = input.tokens;
  interface Token { name: string; id: string; expands: string; type: string; row: number }
  const tokens = new Map<string, Token>();
  let negative: string | undefined;
  let styleBlock: string | undefined;
  if (tokenTable) {
    const cT = columnOf(tokenTable, m.tokens.token);
    const cE = columnOf(tokenTable, m.tokens.expands);
    const cY = columnOf(tokenTable, m.tokens.type);
    if (cT < 0 || cE < 0) throw new ImportError([`the Tokens table needs the columns "${String(m.tokens.token)}" and "${String(m.tokens.expands)}"`]);
    for (const r of tokenTable.rows) {
      const name = cell(r, cT).replace(/^\[|\]$/g, '').trim();
      if (name === '') continue;
      const expands = cell(r, cE);
      if (norm(name) === norm(m.tokens.negative)) { negative = expands; continue; }
      if (norm(name) === norm(m.tokens.style)) { styleBlock = expands; continue; }
      tokens.set(norm(name), { name, id: cleanSheetId(name), expands, type: cell(r, cY), row: r.row });
    }
    if (negative === undefined) warn(`the Tokens table has no "${m.tokens.negative}" row; shots get no negative prompt`);
    if (styleBlock === undefined) warn(`the Tokens table has no "${m.tokens.style}" row; prompts get no house style`);
  } else {
    warn('no Tokens table: prompts are used as written, with no expansion, lighting phrase or house style');
  }

  interface Light { code: string; id: string; phrase: string; useFor: string; row: number }
  const lights = new Map<string, Light>();
  if (input.lighting) {
    const cC = columnOf(input.lighting, m.lighting.code);
    const cP = columnOf(input.lighting, m.lighting.phrase);
    const cU = columnOf(input.lighting, 'Use for');
    if (cC < 0 || cP < 0) throw new ImportError([`the Lighting table needs the columns "${String(m.lighting.code)}" and "${String(m.lighting.phrase)}"`]);
    for (const r of input.lighting.rows) {
      const code = cell(r, cC);
      if (code === '') continue;
      lights.set(norm(code), { code, id: cleanSheetId(code), phrase: cell(r, cP), useFor: cell(r, cU), row: r.row });
    }
  }

  // ── shot rows ──
  const t = input.shots;
  const col = {
    id: columnOf(t, m.shot.id), scene: columnOf(t, m.shot.scene), cue: columnOf(t, m.shot.cue), seconds: columnOf(t, m.shot.seconds),
    tier: columnOf(t, m.shot.tier), framing: columnOf(t, m.shot.framing), prompt: columnOf(t, m.shot.prompt), motion: columnOf(t, m.shot.motion),
    characters: columnOf(t, m.shot.characters), location: columnOf(t, m.shot.location), status: columnOf(t, m.shot.status), notes: columnOf(t, m.shot.notes),
    filmIn: columnOf(t, m.shot.filmIn), filmOut: columnOf(t, m.shot.filmOut), part: columnOf(t, m.shot.part), lighting: columnOf(t, m.shot.lighting),
    lines: columnOf(t, m.shot.lines), refMoment: columnOf(t, m.shot.refMoment),
  };
  const missing = (['id', 'scene', 'prompt', 'filmIn', 'filmOut'] as const).filter((k) => col[k] < 0).map((k) => `${k} ("${String(m.shot[k])}")`);
  if (missing.length > 0) {
    throw new ImportError([`the shot sheet "${t.name}" has no column for: ${missing.join(', ')}. Its headers are: ${t.headers.filter((h) => h !== '').join(' | ')}. Name the right ones in a mapping file (--mapping).`]);
  }

  const partId = (raw: string): string => m.partIds[raw] ?? cleanSheetId(raw);
  const rows: ShotRow[] = [];
  const cardRows: { row: number; id: string; filmIn: number; filmOut: number; label: string }[] = [];
  const seenIds = new Set<string>();
  for (const r of t.rows) {
    const rawId = cell(r, col.id);
    if (rawId === '') { skipped.push(`row ${r.row}: no shot id`); continue; }
    const id = rawId;
    if (!SHEET_ID_PATTERN.test(id)) { skipped.push(`row ${r.row} (${id}): the id must be letters, digits, "." or "-" (no "_")`); continue; }
    if (seenIds.has(id)) { skipped.push(`row ${r.row} (${id}): the id is already used by an earlier row`); continue; }
    seenIds.add(id);
    const a = parseFilmTime(cell(r, col.filmIn));
    const b = parseFilmTime(cell(r, col.filmOut));
    if (a === undefined || b === undefined) { skipped.push(`row ${r.row} (${id}): the film times "${cell(r, col.filmIn)}" and "${cell(r, col.filmOut)}" are not mm:ss.ss`); continue; }
    if (!(b > a)) { skipped.push(`row ${r.row} (${id}): film out ${formatFilmTime(b)} is not after film in ${formatFilmTime(a)}`); continue; }
    if (col.status >= 0 && norm(cell(r, col.status)) === norm(m.readyStatus)) {
      cardRows.push({ row: r.row, id, filmIn: a, filmOut: b, label: cell(r, col.cue) });
      continue;
    }
    const scene = cell(r, col.scene);
    if (scene === '' || !SHEET_ID_PATTERN.test(scene)) { skipped.push(`row ${r.row} (${id}): the scene "${scene}" is not usable as an id`); continue; }
    const secs = col.seconds >= 0 ? Number(cell(r, col.seconds)) : NaN;
    if (Number.isFinite(secs) && Math.abs(secs - (b - a)) > 0.06) {
      warn(`${id}: the "${String(m.shot.seconds)}" column says ${secs} s but the film times span ${round6(b - a)} s; the film times are used`);
    }
    rows.push({
      row: r.row, id, scene,
      cue: cell(r, col.cue), tier: cell(r, col.tier), framing: cell(r, col.framing), prompt: cell(r, col.prompt), motion: cell(r, col.motion),
      characters: splitList(cell(r, col.characters)), location: cell(r, col.location), notes: cell(r, col.notes),
      filmIn: a, filmOut: b, part: cell(r, col.part), lighting: cell(r, col.lighting),
      lineIds: cell(r, col.lines).split(';').map((x) => x.trim().split(/\s+/)[0] ?? '').filter((x) => x !== ''),
      refMoment: cell(r, col.refMoment),
    });
  }

  // ── bible: which token is a character, which a location ──
  const usedAsChar = new Set<string>();
  const usedAsLoc = new Set<string>();
  for (const r of rows) {
    r.characters.forEach((c) => usedAsChar.add(norm(c)));
    splitList(r.location).forEach((l) => usedAsLoc.add(norm(l)));
  }
  const kindOfToken = (k: string, tk: Token): 'characters' | 'locations' => {
    if (usedAsLoc.has(k) && !usedAsChar.has(k)) return 'locations';
    if (usedAsChar.has(k) && !usedAsLoc.has(k)) return 'characters';
    if (/loc|place|setting|interior|exterior/i.test(tk.type)) return 'locations';
    return 'characters';
  };

  const bibleOf = (name: string, id: string, description: string, notes: string[], row: number | undefined, sheetId: string): BibleEntry => ({
    id, stage: 'breakdown', status: 'pending-review', comments: [],
    by_stage: { breakdown: { status: 'pending-review', ...(description !== '' && { content: description }) } },
    name, ...(description !== '' && { description }), notes, refs: [],
    source: { kind: 'sheet', id: sheetId, ...(row !== undefined && { row }) },
  });

  const wantChars: BibleEntry[] = [];
  const wantLocs: BibleEntry[] = [];
  const wantStyles: BibleEntry[] = [];
  const tokenIds = new Map<string, { id: string; kind: 'characters' | 'locations' }>();
  for (const [k, tk] of tokens) {
    const kind = kindOfToken(k, tk);
    const e = bibleOf(tk.name, tk.id, tk.expands, tk.type !== '' ? [tk.type] : [], tk.row, tk.id);
    (kind === 'characters' ? wantChars : wantLocs).push(e);
    tokenIds.set(k, { id: tk.id, kind });
  }
  for (const l of lights.values()) {
    if (l.phrase === '') { if (norm(l.code) !== norm(m.refLighting)) warn(`lighting ${l.code} has no phrase; it is left out`); continue; }
    wantStyles.push(bibleOf(l.code, l.id, l.phrase, l.useFor !== '' ? [`Use for: ${l.useFor}`] : [], l.row, l.id));
  }
  const HOUSE = 'house-style';
  if (styleBlock !== undefined && styleBlock !== '') {
    wantStyles.push(bibleOf('House style', HOUSE, styleBlock, negative !== undefined && negative !== '' ? [`Negative prompt: ${negative}`] : [], undefined, 'STYLE-BLOCK'));
  }

  // ── shots ──
  const expand = (text: string, id: string): string =>
    text.replace(/\[([^[\]]+)\]/g, (whole, name: string) => {
      const tk = tokens.get(norm(name));
      if (!tk) { warn(`${id}: the token [${name}] is not in the Tokens table; left as written`); return whole; }
      return tk.expands;
    });

  const wantShots: Shot[] = [];
  const wantScenes = new Map<string, Scene>();
  const parts = new Map<string, { shots: number; in_s: number; out_s: number }>();
  for (const r of rows) {
    const isRef = norm(r.lighting) === norm(m.refLighting) || (m.refPrefix !== '' && r.refMoment.toUpperCase().startsWith(m.refPrefix.toUpperCase()));
    const light = lights.get(norm(r.lighting));
    let prompt: string | undefined;
    if (r.prompt === '') warn(`${r.id}: no prompt text`);
    else if (r.prompt.startsWith('(')) prompt = r.prompt;
    else {
      const bits = [expand(r.prompt, r.id)];
      if (light && light.phrase !== '') bits.push(light.phrase);
      else if (r.lighting !== '' && !isRef) warn(`${r.id}: lighting "${r.lighting}" is not in the Lighting table`);
      if (!isRef && styleBlock !== undefined && styleBlock !== '') bits.push(styleBlock);
      prompt = bits.join(', ');
    }

    const refs: string[] = [];
    for (const c of r.characters) {
      const tk = tokenIds.get(norm(c));
      if (tk) refs.push(tk.id);
      else warn(`${r.id}: character "${c}" is not in the Tokens table`);
    }
    for (const loc of splitList(r.location)) {
      const tk = tokenIds.get(norm(loc));
      if (tk) refs.push(tk.id);
      else warn(`${r.id}: location "${loc}" is not in the Tokens table`);
    }
    const lightingId = light && light.phrase !== '' ? light.id : undefined;
    if (lightingId !== undefined) refs.push(lightingId);
    if (!isRef && styleBlock !== undefined && styleBlock !== '') refs.push(HOUSE);

    if (r.tier !== '' && !/^[ABC]$/.test(r.tier)) warn(`${r.id}: tier "${r.tier}" is not A, B or C; left out`);
    const part = r.part !== '' ? partId(r.part) : undefined;
    const notes = [r.notes, isRef && r.refMoment !== '' ? `Ref moment: ${r.refMoment}` : ''].filter((x) => x !== '').join('\n');
    const shotType = SHOT_TYPE[norm(r.framing)];
    const duration = round6(r.filmOut - r.filmIn);
    wantShots.push({
      id: r.id, stage: 'breakdown', status: 'pending-review', comments: [],
      by_stage: { breakdown: { status: 'pending-review', ...(r.prompt !== '' && { content: r.prompt }) } },
      scene: r.scene,
      shot_type: shotType ?? 'unset',
      camera_move: 'unset',
      ...(r.prompt !== '' && { action: r.prompt }),
      duration_s: duration,
      ...(prompt !== undefined && { prompt }),
      ...(negative !== undefined && negative !== '' && { negative }),
      refs: [...new Set(refs)],
      ...(r.cue !== '' && { script_line: r.cue }),
      ...(notes !== '' && { notes }),
      blocking: [],
      source: { kind: 'sheet', id: r.id, row: r.row },
      film: { in_s: r.filmIn, out_s: r.filmOut },
      ...(part !== undefined && { part }),
      ...(lightingId !== undefined && { lighting: lightingId }),
      ...(/^[ABC]$/.test(r.tier) && { tier: r.tier as 'A' | 'B' | 'C' }),
      ...(r.framing !== '' && r.framing !== '—' && { framing: r.framing }),
      ...(r.motion !== '' && { motion_note: r.motion }),
    });
    if (!wantScenes.has(r.scene)) {
      wantScenes.set(r.scene, { id: r.scene, ...(part !== undefined && { part }), source: { kind: 'sheet', id: r.scene, row: r.row } });
    } else if (part !== undefined && wantScenes.get(r.scene)!.part === undefined) wantScenes.get(r.scene)!.part = part;
    else if (part !== undefined && wantScenes.get(r.scene)!.part !== part) warn(`${r.id}: scene ${r.scene} has shots in parts ${wantScenes.get(r.scene)!.part} and ${part}; the scene keeps ${wantScenes.get(r.scene)!.part}`);
    if (part !== undefined) {
      const p = parts.get(part) ?? { shots: 0, in_s: r.filmIn, out_s: r.filmOut };
      p.shots++; p.in_s = Math.min(p.in_s, r.filmIn); p.out_s = Math.max(p.out_s, r.filmOut);
      parts.set(part, p);
    }
  }

  // ── cards ──
  const wantCards: Asset[] = [];
  for (const c of cardRows) {
    const file = input.cardFile?.(c.id);
    if (file === undefined) {
      skipped.push(`row ${c.row} (${c.id}): a ready-made row, but no file was found for it; left out. Point at its folder with --cards-dir, or name the file in the mapping (cards.files)`);
      continue;
    }
    wantCards.push({
      id: `card_${c.id}`, stage: 'export', status: 'pending-review', comments: [],
      by_stage: { export: { status: 'pending-review' } },
      kind: 'card', name: c.id, file: { uri: file, mime: mimeOf(file) }, tags: ['card'],
      film: { in_s: c.filmIn, out_s: c.filmOut },
      source: { kind: 'sheet', id: c.id, row: c.row },
    });
  }

  // ── lines ──
  const wantLines: AudioLine[] = [];
  if (input.lines) {
    const L = input.lines;
    const lc = {
      id: columnOf(L, m.lines.id), character: columnOf(L, m.lines.character), kind: columnOf(L, m.lines.kind), filmIn: columnOf(L, m.lines.filmIn),
      filmOut: columnOf(L, m.lines.filmOut), text: columnOf(L, m.lines.text), clip: columnOf(L, m.lines.clip), words: columnOf(L, m.lines.words),
    };
    const lmiss = (['id', 'kind', 'filmIn', 'filmOut'] as const).filter((k) => lc[k] < 0);
    if (lmiss.length > 0) throw new ImportError([`the lines file needs the columns: ${lmiss.map((k) => `"${String(m.lines[k])}"`).join(', ')}`]);
    const ids = new Set<string>();
    for (const r of L.rows) {
      const id = cell(r, lc.id);
      const kind = norm(cell(r, lc.kind));
      const a = parseFilmTime(cell(r, lc.filmIn));
      const b = parseFilmTime(cell(r, lc.filmOut));
      if (id === '' || ids.has(id)) { skipped.push(`lines row ${r.row}: ${id === '' ? 'no id' : `id ${id} is used twice`}`); continue; }
      if (kind !== 'spoken' && kind !== 'thought') { skipped.push(`lines row ${r.row} (${id}): the kind "${kind}" is not spoken or thought`); continue; }
      if (a === undefined || b === undefined || !(b > a)) { skipped.push(`lines row ${r.row} (${id}): the film times are not usable`); continue; }
      ids.add(id);
      const words: { w: string; t_s: number }[] = [];
      for (const tok of cell(r, lc.words).split(/\s+/).filter((x) => x !== '')) {
        const at = tok.lastIndexOf('@');
        const ts = at > 0 ? Number(tok.slice(at + 1)) : NaN;
        if (Number.isFinite(ts) && ts >= 0) words.push({ w: tok.slice(0, at), t_s: ts });
        else warn(`line ${id}: the word timing "${tok}" is not word@seconds; skipped`);
      }
      const clipName = cell(r, lc.clip);
      const clip = clipName !== '' ? input.clipUri?.(clipName) : undefined;
      if (clipName !== '' && clip === undefined && input.clipUri) warn(`line ${id}: the clip "${clipName}" was not found; clip_uri is left out`);
      const character = cell(r, lc.character);
      const text = cell(r, lc.text);
      wantLines.push({
        id, ...(character !== '' && { character }), kind, film_in_s: a, film_out_s: b,
        ...(clip !== undefined && { clip_uri: clip }),
        ...(text !== '' && { text }),
        ...(words.length > 0 && { words }),
      });
    }
    // link by film time: a line belongs to the shot it STARTS in (a cut mid-line leaves it with the first shot,
    // as a sheet's own lines column does); a line that starts in a gap goes to the shot it overlaps most.
    const EPS = 0.0005;
    const OVERLAP = 0.05;
    for (const l of wantLines) {
      const startsIn = wantShots.find((s) => s.film!.in_s <= l.film_in_s + EPS && l.film_in_s < s.film!.out_s - EPS);
      let home = startsIn;
      if (!home) {
        let best = OVERLAP;
        for (const s of wantShots) {
          const o = Math.min(s.film!.out_s, l.film_out_s) - Math.max(s.film!.in_s, l.film_in_s);
          if (o > best) { best = o; home = s; }
        }
      }
      if (home) (home.lines ??= []).push({ id: l.id, kind: l.kind });
    }
    const startOf = new Map(wantLines.map((l) => [l.id, l.film_in_s]));
    for (const s of wantShots) s.lines?.sort((x, y) => startOf.get(x.id)! - startOf.get(y.id)!);
    const lineById = new Map(wantLines.map((l) => [l.id, l]));
    for (const r of rows) {
      const byTime = new Set((wantShots.find((s) => s.id === r.id)?.lines ?? []).map((l) => l.id));
      const bySheet = new Set(r.lineIds);
      for (const id of bySheet) if (!lineById.has(id)) warn(`${r.id}: column "${String(m.shot.lines)}" names ${id}, which is not in the lines file`);
      const a = [...byTime].filter((x) => !bySheet.has(x));
      const b = [...bySheet].filter((x) => !byTime.has(x) && lineById.has(x));
      if (a.length > 0 || b.length > 0) {
        warn(`${r.id}: lines by film time [${[...byTime].join(', ')}] differ from the sheet's column [${[...bySheet].join(', ')}]`);
      }
    }
  }

  // ── merge into the project ──
  const out = structuredClone(project);
  const firstImport = !out.shots.some((s) => s.source?.kind === 'sheet');
  const added: Change[] = [];
  const changed: Change[] = [];
  const removed: Change[] = [];
  let unchanged = 0;

  type Unit = { id: string; status?: string | undefined; updated_at?: string | undefined; source?: SheetSource | undefined };
  /**
   * Update `list` from `want`: matched by sheet id, in place; new ones are appended;
   * only `owned` keys are refreshed. Returns the matched ids.
   */
  function merge<T extends Unit>(list: T[], want: T[], kind: ChangeKind, owned: (keyof T)[], opts2: { keepFile?: boolean; touchContent?: boolean; noStamp?: boolean } = {}): void {
    const bySource = new Map<string, number>();
    list.forEach((x, i) => { if (x.source?.kind === 'sheet') bySource.set(x.source.id, i); });
    const matched = new Set<number>();
    for (const w of want) {
      const sid = w.source!.id;
      let at = bySource.get(sid);
      if (at === undefined) {
        const byId = list.findIndex((x, i) => x.id === w.id && !matched.has(i));
        if (byId >= 0) at = byId;
      }
      if (at === undefined) {
        list.push(opts2.noStamp ? { ...w } : { ...w, updated_at: nowIso });
        added.push({ kind, id: w.id });
        continue;
      }
      matched.add(at);
      const cur = list[at]!;
      const next: T = { ...cur };
      const fields: string[] = [];
      for (const k of owned) {
        if (opts2.keepFile && k === ('file' as keyof T) && (cur as { file?: unknown }).file !== undefined) continue;
        const nv = w[k];
        const ov = cur[k];
        if (!same(ov, nv)) { fields.push(String(k)); if (nv === undefined) delete next[k]; else next[k] = nv; }
      }
      // the source: refresh the row, clear a removal mark
      const src: SheetSource = { kind: 'sheet', id: sid, ...(w.source!.row !== undefined && { row: w.source!.row }) };
      if (!same(cur.source, src)) { next.source = src; if (cur.source?.removed_at !== undefined) fields.push('restored'); }
      // the stage's text record follows the text, never the status
      const wb = (w as unknown as { by_stage?: { breakdown?: { content?: string } } }).by_stage?.breakdown;
      const nb = (next as unknown as { by_stage?: { breakdown?: { status: string; content?: string } } }).by_stage;
      if (opts2.touchContent && nb?.breakdown && !same(nb.breakdown.content, wb?.content)) {
        nb.breakdown = { ...nb.breakdown, ...(wb?.content !== undefined ? { content: wb.content } : {}) };
        if (wb?.content === undefined) delete nb.breakdown.content;
      }
      if (fields.length === 0) { unchanged++; continue; }
      if (!opts2.noStamp) next.updated_at = nowIso;
      list[at] = next;
      changed.push({ kind, id: w.id, fields, ...(cur.status === 'approved' && { approved: true }) });
    }
    // rows that left the sheet
    list.forEach((x, i) => {
      if (matched.has(i) || x.source?.kind !== 'sheet' || !want.every((w) => w.source!.id !== x.source!.id)) return;
      if (x.source.removed_at !== undefined) return;
      list[i] = { ...x, source: { ...x.source, removed_at: nowIso }, ...(opts2.noStamp ? {} : { updated_at: nowIso }) };
      removed.push({ kind, id: x.id });
    });
  }

  const hasLines = input.lines !== undefined;
  const shotOwned: (keyof Shot)[] = ['scene', 'shot_type', 'action', 'duration_s', 'prompt', 'negative', 'refs', 'script_line', 'notes', 'film', 'part', 'lighting', 'tier', 'framing', 'motion_note', ...(hasLines ? (['lines'] as const) : [])];
  // shot_type: only set from a framing the sheet names; never reset what a person chose to "unset"
  for (const w of wantShots) {
    const cur = out.shots.find((x) => x.source?.id === w.id);
    if (cur && w.shot_type === 'unset') w.shot_type = cur.shot_type;
  }
  merge(out.shots, wantShots, 'shot', shotOwned, { touchContent: true });
  // a shot that left the sheet no longer sits on the clock: its film time would clash with what replaced it
  for (const s of out.shots) if (s.source?.removed_at !== undefined && s.film !== undefined) delete s.film;
  // sheet order for the shots still in the sheet, then the removed ones
  const rank = new Map(wantShots.map((s, i) => [s.id, i]));
  out.shots.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));

  merge(out.scenes, [...wantScenes.values()], 'scene', ['part'], { noStamp: true });
  merge(out.bible.characters, wantChars, 'character', ['name', 'description', 'notes'], { touchContent: true });
  merge(out.bible.locations, wantLocs, 'location', ['name', 'description', 'notes'], { touchContent: true });
  merge(out.bible.styles, wantStyles, 'style', ['name', 'description', 'notes'], { touchContent: true });
  merge(out.assets, wantCards, 'card', ['name', 'film', 'file'], { keepFile: true });

  // lines
  if (hasLines) {
    const lines = (out.audio.lines ??= []);
    for (const w of wantLines) {
      const at = lines.findIndex((l) => l.id === w.id);
      if (at < 0) { lines.push(w); added.push({ kind: 'line', id: w.id }); }
      else if (!same(lines[at], w)) {
        const fields = (Object.keys({ ...lines[at], ...w }) as (keyof AudioLine)[]).filter((k) => !same(lines[at]![k], w[k])).map(String);
        lines[at] = w;
        changed.push({ kind: 'line', id: w.id, fields });
      } else unchanged++;
    }
    for (const l of lines) if (!wantLines.some((w) => w.id === l.id)) warn(`line ${l.id} is no longer in the lines file; it is kept`);
  }

  // master clock, fps
  if (input.master && !same(out.audio.master, input.master)) {
    out.audio.master = input.master;
  }
  const fps = input.fps !== undefined ? FpsSchema.parse(input.fps) : out.project.fps ?? '24';
  if (out.project.fps !== fps) out.project.fps = fps;

  // script and intake
  if (input.filmScript) out.script.source = input.filmScript.uri;
  if (out.stages.intake.state === 'in-progress' || out.stages.intake.state === 'not-started') {
    const done = completeIntake(out, {
      route: 'import',
      ...(input.filmScript && { sourceUri: input.filmScript.uri }),
      ...(input.sheetFile && { sheetUri: input.sheetFile.uri, sheetMime: input.sheetFile.mime }),
      now: () => new Date(nowIso),
    });
    Object.assign(out, done);
  }
  if (firstImport && out.stages.breakdown.state !== 'locked') {
    out.stages.breakdown = { state: 'in-review' };
    out.current_stage = 'breakdown';
  }

  const anyChange = added.length + changed.length + removed.length > 0 || !same(out.audio, project.audio) || !same(out.project, project.project) || !same(out.script, project.script);
  if (anyChange) out.project.updated_at = nowIso;

  const valid = AkukoProjectSchema.parse(out);
  const integrity = checkIntegrity(valid);

  // what the project holds from the sheet now
  const live = <T extends { source?: SheetSource | undefined }>(xs: T[]) => xs.filter((x) => x.source?.kind === 'sheet' && x.source.removed_at === undefined);
  const liveShots = live(valid.shots);
  const summary: ImportSummary = {
    firstImport,
    counts: {
      shots: liveShots.length,
      cards: live(valid.assets.filter((a) => a.kind === 'card')).length,
      scenes: live(valid.scenes).length,
      lines: (valid.audio.lines ?? []).length,
      characters: live(valid.bible.characters).length,
      locations: live(valid.bible.locations).length,
      styles: live(valid.bible.styles).length,
      shotsWithLines: liveShots.filter((s) => (s.lines ?? []).length > 0).length,
    },
    added, changed, removed, unchanged,
    parts: [...parts].map(([part, v]) => ({ part, ...v })),
    skipped,
  };
  const lint = [
    ...lintShots(valid),
    ...(input.filmScript?.text !== undefined ? lintSheetIdsInScript(valid, input.filmScript.text) : []),
  ];
  return { project: valid, summary, warnings, lint, integrity };
}

// ── printing ─────────────────────────────────────────────────────────────

export function formatSummary(r: ImportResult, opts: { dryRun?: boolean; maxWarnings?: number } = {}): string {
  const s = r.summary;
  const c = s.counts;
  const out: string[] = [];
  out.push(`${opts.dryRun ? 'Dry run, nothing written. ' : ''}${s.firstImport ? 'Imported' : 'Re-imported'}: ${c.shots} shots, ${c.cards} cards, ${c.scenes} scenes, ${c.lines} lines (${c.shotsWithLines} shots carry a line); bible: ${c.characters} characters, ${c.locations} locations, ${c.styles} styles.`);
  if (!s.firstImport || s.changed.length + s.removed.length > 0) {
    const n = (xs: Change[], k: ChangeKind) => xs.filter((x) => x.kind === k).length;
    out.push(`Diff: ${s.added.length} added, ${s.changed.length} changed, ${s.removed.length} left the sheet (kept, flagged), ${s.unchanged} unchanged.`);
    const list = (title: string, xs: Change[]) => {
      if (xs.length === 0) return;
      out.push(`  ${title}:`);
      for (const x of xs.slice(0, 40)) out.push(`    ${x.kind} ${x.id}${x.fields ? ` (${x.fields.join(', ')})` : ''}${x.approved ? ' [approved: its approval stands; re-check it]' : ''}`);
      if (xs.length > 40) out.push(`    ... and ${xs.length - 40} more`);
    };
    list('added', s.added);
    list('changed', s.changed);
    list('left the sheet', s.removed);
    void n;
  }
  if (s.parts.length > 0) {
    out.push('Parts: ' + s.parts.map((p) => `${p.part} ${p.shots} (${formatFilmTime(p.in_s)}-${formatFilmTime(p.out_s)})`).join('; '));
  }
  if (s.skipped.length > 0) { out.push(`Left out (${s.skipped.length}):`); s.skipped.forEach((x) => out.push(`  ${x}`)); }
  const max = opts.maxWarnings ?? 25;
  if (r.warnings.length > 0) {
    out.push(`Warnings (${r.warnings.length}):`);
    r.warnings.slice(0, max).forEach((x) => out.push(`  ${x}`));
    if (r.warnings.length > max) out.push(`  ... and ${r.warnings.length - max} more`);
  }
  if (r.integrity.length > 0) {
    out.push(`Integrity: ${r.integrity.length} problems:`);
    r.integrity.slice(0, 20).forEach((x) => out.push(`  ${x.path}: ${x.message}`));
  } else out.push('Integrity: clean.');
  const errs = r.lint.filter((i) => i.severity === 'error').length;
  out.push(`Lint: ${errs} errors, ${r.lint.length - errs} warnings.`);
  return out.join('\n');
}
