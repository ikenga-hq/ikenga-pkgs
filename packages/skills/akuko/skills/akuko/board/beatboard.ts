/**
 * akuko — stage 2 (sketch): 9-panel beat boards. Free and deterministic.
 *
 * One board is a 3 x 3 sheet of framing-diagram panels, in shot order, for one
 * scene. A scene with more than nine shots spills onto a second board (and a
 * third, and so on); a short last board leaves its spare cells empty. A board
 * is a derived, regenerable page: the shots (not the board) are what a person
 * reviews, so the board shows no review status that could go stale.
 *
 * Standalone HTML: no script, no network, escaped text, light and dark.
 */

import type { AkukoProject, Shot } from '../schema/akuko-project.ts';
import { esc, panelSvg } from './panels.ts';

export const PANELS_PER_BOARD = 9;

export interface BeatBoard {
  /** File name under `board/beatboards/`. */
  file: string;
  /** Scene id the board belongs to, or `unassigned`. */
  scene: string;
  /** 1-based position among this scene's boards. */
  index: number;
  /** How many boards this scene has. */
  of: number;
  /** The shots on this board, in order. */
  shots: string[];
  html: string;
}

const PAGE_STYLE = [
  ':root{--bg:#f7f3ea;--fg:#1d1a15;--muted:#5c564d;--line:#b9b1a2}',
  '@media (prefers-color-scheme:dark){:root{--bg:#171512;--fg:#f3eee4;--muted:#b4ad9f;--line:#4a443b}}',
  '*{box-sizing:border-box}',
  'body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.45 ui-sans-serif,system-ui,sans-serif}',
  'header{max-width:960px;margin:0 auto 12px}',
  'h1{font:600 20px/1.3 ui-sans-serif,system-ui,sans-serif;margin:0}',
  '.sub{margin:2px 0 0;color:var(--muted);font-size:14px}',
  '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;max-width:960px;margin:0 auto;padding:0;list-style:none}',
  '.cell{margin:0;min-width:0}',
  '.cell svg{display:block;width:100%;height:auto}',
  '.empty{display:flex;align-items:center;justify-content:center;aspect-ratio:16/9;border:1px dashed var(--line);color:var(--muted);font-size:14px}',
  '.cap{margin:6px 0 0;font-size:14px;color:var(--muted);overflow-wrap:anywhere}',
  '.cap b{color:var(--fg);font:600 14px ui-monospace,Menlo,Consolas,monospace}',
  '.beat{display:block;color:var(--fg)}',
  '@media (max-width:560px){.grid{grid-template-columns:1fr}}',
].join('');

const sceneKey = (s: Shot): string => s.scene ?? 'unassigned';
/** A shot whose row left the shot list is kept for the record only: it gets no beat-board cell. */
const live = (s: Shot): boolean => s.source?.removed_at === undefined;

/** Build every beat board for a project. Same project, same bytes. */
export function buildBeatBoards(project: Pick<AkukoProject, 'project' | 'scenes' | 'shots' | 'script'>): BeatBoard[] {
  const aspect = project.project.aspect_ratio;
  const shotsIn = project.shots.filter(live);
  const order = [...project.scenes.map((s) => s.id), 'unassigned'];
  const extra = [...new Set(shotsIn.map(sceneKey))].filter((k) => !order.includes(k));
  const boards: BeatBoard[] = [];

  for (const key of [...order, ...extra]) {
    const shots = shotsIn.filter((s) => sceneKey(s) === key);
    if (shots.length === 0) continue;
    const scene = project.scenes.find((s) => s.id === key);
    const of = Math.ceil(shots.length / PANELS_PER_BOARD);
    for (let i = 0; i < of; i++) {
      const slice = shots.slice(i * PANELS_PER_BOARD, (i + 1) * PANELS_PER_BOARD);
      let lastBeat: string | undefined;
      const cells = slice.map((s) => {
        const beat = project.script.beats.find((b) => b.id === s.beat);
        const beatText = beat?.action ?? s.action ?? '';
        const newBeat = s.beat !== lastBeat;
        lastBeat = s.beat;
        const dur = s.duration_s !== undefined ? ` · ${esc(String(s.duration_s))} s` : '';
        return `<li class="cell" data-shot="${esc(s.id)}">${panelSvg(s, { aspect }).trim()}<p class="cap"><b>${esc(s.id)}</b> · ${esc(s.shot_type)}${dur}${newBeat && beatText !== '' ? `<span class="beat">${esc(beatText)}</span>` : ''}</p></li>`;
      });
      while (cells.length < PANELS_PER_BOARD) cells.push('<li class="cell"><div class="empty">no shot</div></li>');
      const heading = scene?.heading ?? (key === 'unassigned' ? 'Shots without a scene' : key);
      const part = of > 1 ? ` · board ${i + 1} of ${of}` : '';
      const file = `beatboard-${key}${i > 0 ? `-${i + 1}` : ''}.html`;
      const html = [
        '<!doctype html>',
        '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        `<title>${esc(project.project.title)} — beat board ${esc(key)}${of > 1 ? ` (${i + 1}/${of})` : ''}</title>`,
        `<style>${PAGE_STYLE}</style></head><body>`,
        `<header><h1>${esc(heading)}</h1><p class="sub">${esc(project.project.title)} · ${esc(key)}${part} · ${slice.length} of ${PANELS_PER_BOARD} panels · framing diagrams from each shot's blocking</p></header>`,
        `<ol class="grid">${cells.join('')}</ol>`,
        '</body></html>',
        '',
      ].join('\n');
      boards.push({ file, scene: key, index: i + 1, of, shots: slice.map((s) => s.id), html });
    }
  }
  return boards;
}
