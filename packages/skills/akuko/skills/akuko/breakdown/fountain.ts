/**
 * akuko — a small Fountain reader, as much as breakdown needs.
 *
 * It splits a script into blocks (the paragraphs between blank lines), names
 * each block's kind, and numbers the scenes by order of appearance. It does not
 * try to be a full Fountain implementation: no dual dialogue, no boneyard, no
 * page numbering. It never rewrites text; `tags.ts` edits lines by index.
 *
 * Scene numbering: the first scene heading is scene 1 and the scene id is
 * `sc1`, matching `scenes[].id` and the `sc<N>_sh<M>` shot ids.
 */

export type BlockKind = 'title' | 'scene-heading' | 'action' | 'dialogue' | 'transition' | 'section' | 'prose';

export interface Block {
  kind: BlockKind;
  /** 0-based index among all blocks. */
  index: number;
  /** Scene number (1-based) this block sits in; 0 before the first heading. */
  scene: number;
  /** First and last line of the block, 0-based and inclusive. */
  startLine: number;
  endLine: number;
  /** The block's text with `[[notes]]` removed, lines joined by a space. */
  text: string;
}

export interface SceneInfo {
  n: number;
  id: string;
  heading: string;
  /** Block index of the heading. */
  block: number;
}

export interface FountainDoc {
  lines: string[];
  eol: '\n' | '\r\n';
  blocks: Block[];
  scenes: SceneInfo[];
}

const HEADING = /^(?:\.(?!\.)|(?:INT|EXT|EST|INT\.?\/EXT|EXT\.?\/INT|I\/E)[. ])/i;
const NOTE = /\[\[[^\]]*\]\]/g;
const TRANSITION = /^(?:>\s*\S.*|[A-Z0-9 .'-]+ TO:)$/;
const CUE = /^@?[A-Z0-9][A-Z0-9 .'\-#]*(?:\s*\([^)]*\))?\s*\^?$/;

/** Remove `[[notes]]` and collapse whitespace. */
export function plainText(s: string): string {
  return s.replace(NOTE, ' ').replace(/\s+/g, ' ').trim();
}

function classify(lines: string[], first: boolean): BlockKind {
  const head = (lines[0] ?? '').trim();
  if (first && /^[A-Za-z][A-Za-z ]*:/.test(head) && lines.every((l) => /^(?:[A-Za-z][A-Za-z ]*:.*|\s+\S.*)$/.test(l))) {
    return 'title';
  }
  if (head.startsWith('#') || head.startsWith('=')) return 'section';
  if (lines.length === 1 && HEADING.test(head)) return 'scene-heading';
  if (head.startsWith('!')) return 'action';
  if (lines.length === 1 && TRANSITION.test(head)) return 'transition';
  if (lines.length > 1 && head.startsWith('@')) return 'dialogue';
  if (lines.length > 1 && CUE.test(head) && head === head.toUpperCase() && /[A-Z]/.test(head)) return 'dialogue';
  return 'action';
}

/** Parse Fountain text. Pass `prose: true` for plain prose: every paragraph is a `prose` block and there are no scenes. */
export function parseFountain(text: string, opts: { prose?: boolean } = {}): FountainDoc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  const scenes: SceneInfo[] = [];
  let scene = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim() === '') { i++; continue; }
    const start = i;
    while (i < lines.length && lines[i]!.trim() !== '') i++;
    const chunk = lines.slice(start, i);
    const kind: BlockKind = opts.prose ? 'prose' : classify(chunk, blocks.length === 0);
    if (kind === 'scene-heading') {
      scene++;
      const heading = plainText(chunk[0]!).replace(/^\./, '').replace(/\s*#[^#]*#\s*$/, '').trim();
      scenes.push({ n: scene, id: `sc${scene}`, heading, block: blocks.length });
    }
    blocks.push({
      kind,
      index: blocks.length,
      scene,
      startLine: start,
      endLine: i - 1,
      text: plainText(chunk.join(' ')),
    });
  }
  return { lines, eol, blocks, scenes };
}

/** Lower-case, de-styled text for matching a quoted line against a block. */
export function normalize(s: string): string {
  return plainText(s)
    .replace(/[*_]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
