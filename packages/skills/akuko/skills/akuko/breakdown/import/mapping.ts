/**
 * akuko — which column means what (WP-25).
 *
 * Columns are found by **header name** (case and spacing aside; a header that
 * starts with the name also matches), never by position, so a sheet that moves
 * or adds a column still imports. A mapping JSON passed with `--mapping`
 * overrides any of these keys; what it leaves out keeps the default, which is
 * the layout of the first real project (E01).
 *
 * A value may be one header or a list of alternatives.
 */

type Name = string | string[];

export interface ShotColumns {
  id: Name;
  scene: Name;
  coreExt?: Name;
  /** The line of the story the shot sits under (stored as `script_line`). */
  cue: Name;
  /** Length in seconds, cross-checked against the film times. */
  seconds?: Name;
  tier: Name;
  framing: Name;
  /** The prompt with `[TOKENS]`, before expansion. */
  prompt: Name;
  motion: Name;
  characters: Name;
  location: Name;
  /** A cell equal to `readyStatus` marks a ready-made row (a card). */
  status: Name;
  notes: Name;
  filmIn: Name;
  filmOut: Name;
  part: Name;
  lighting: Name;
  /** The dialogue lines the shot covers, e.g. `Q55 Jared (spoken); Q56 Raven (thought)`. */
  lines: Name;
  refMoment: Name;
}

export interface ImportMapping {
  sheets: { shots: string; tokens: string; lighting: string };
  shot: ShotColumns;
  tokens: { token: Name; expands: Name; type: Name; negative: string; style: string };
  lighting: { code: Name; phrase: Name };
  lines: { id: Name; character: Name; kind: Name; filmIn: Name; filmOut: Name; text: Name; clip: Name; words: Name };
  /** Value of the status column that marks a ready-made row. */
  readyStatus: string;
  /** A shot whose lighting cell is this, or whose ref-moment cell starts with `refPrefix`, carries its own style: no house style. */
  refLighting: string;
  refPrefix: string;
  /** Part names that are not valid ids (`Cold open`) to the id to use (`P0`). Anything else is cleaned (`Cold open` becomes `Cold-open`). */
  partIds: Record<string, string>;
  /** Ready-made rows: the file for a sheet id (a name in the cards folder, or a path relative to the project). */
  cards: { files: Record<string, string> };
}

export const DEFAULT_MAPPING: ImportMapping = {
  sheets: { shots: 'Shot List', tokens: 'Tokens', lighting: 'Lighting' },
  shot: {
    id: 'Shot ID',
    scene: 'Scene',
    coreExt: 'Core/Ext',
    cue: 'Narration cue',
    seconds: 'Sec (film)',
    tier: 'Tier',
    framing: 'Framing',
    prompt: 'Shot prompt (with tokens)',
    motion: 'Motion',
    characters: 'Characters',
    location: 'Location',
    status: 'Status',
    notes: 'Notes',
    filmIn: 'Film In',
    filmOut: 'Film Out',
    part: 'Part',
    lighting: 'Lighting',
    lines: 'Lip-sync lines',
    refMoment: 'Ref moment',
  },
  tokens: { token: 'Token', expands: 'Expands to', type: 'Type/note', negative: 'NEGATIVE', style: 'STYLE BLOCK' },
  lighting: { code: 'Code', phrase: 'Phrase' },
  lines: { id: 'id', character: 'character', kind: 'kind', filmIn: 'film_in', filmOut: 'film_out', text: 'line', clip: 'clip', words: 'word_times' },
  readyStatus: 'n/a',
  refLighting: 'REF',
  refPrefix: 'REF-',
  partIds: {},
  cards: { files: {} },
};

export type MappingOverride = {
  [K in keyof ImportMapping]?: ImportMapping[K] extends Record<string, unknown> ? Partial<ImportMapping[K]> : ImportMapping[K];
};

/** The default mapping with a person's overrides laid on (one level deep: a key replaces the key). */
export function resolveMapping(override: MappingOverride | undefined): ImportMapping {
  const out = structuredClone(DEFAULT_MAPPING) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(override ?? {})) {
    if (!(k in out)) throw new Error(`mapping: unknown key "${k}" (known: ${Object.keys(out).join(', ')})`);
    const cur = out[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object') {
      for (const [kk, vv] of Object.entries(v)) {
        if (!(kk in (cur as object)) && k !== 'partIds' && k !== 'cards') throw new Error(`mapping: unknown key "${k}.${kk}"`);
        (cur as Record<string, unknown>)[kk] = vv;
      }
    } else out[k] = v;
  }
  return out as unknown as ImportMapping;
}
