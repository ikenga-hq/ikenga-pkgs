/**
 * akuko — the file side of the importer (WP-25): read the sheet, find the
 * ready-made files and line clips, and describe the master WAV. Read-only:
 * nothing here writes, and the master's samples are never loaded.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { MasterAudio } from '../../schema/akuko-project.ts';
import type { ImportMapping } from './mapping.ts';
import { parseCsv, readXlsx, ReadError, sheetTable, tableOf, type Table } from './read.ts';
import { readWavHeader } from './wav-header.ts';

/** A path as the project stores it: relative to the project folder with `/`, or absolute when it is on another drive. */
export function projectUri(projectDir: string, file: string): string {
  const abs = resolve(file);
  const rel = relative(resolve(projectDir), abs);
  return (isAbsolute(rel) ? abs : rel).replace(/\\/g, '/');
}

export interface SheetFiles {
  shots: Table;
  tokens?: Table;
  lighting?: Table;
}

/** Read the shot sheet: an `.xlsx` (all three tables from its sheets) or a `.csv` (the shot sheet; tokens and lighting each in a CSV of their own). */
export async function loadSheet(file: string, mapping: ImportMapping, extra: { tokensCsv?: string; lightingCsv?: string } = {}): Promise<SheetFiles> {
  const csv = async (path: string, name: string): Promise<Table> => tableOf(name, parseCsv((await readFile(path)).toString('utf8')));
  if (/\.csv$/i.test(file)) {
    return {
      shots: await csv(file, basename(file)),
      ...(extra.tokensCsv !== undefined && { tokens: await csv(extra.tokensCsv, basename(extra.tokensCsv)) }),
      ...(extra.lightingCsv !== undefined && { lighting: await csv(extra.lightingCsv, basename(extra.lightingCsv)) }),
    };
  }
  const sheets = readXlsx(await readFile(file));
  const shots = sheetTable(sheets, mapping.sheets.shots) ?? (sheets.length === 1 ? tableOf(sheets[0]!.name, sheets[0]!.rows, sheets[0]!.kinds) : undefined);
  if (!shots) throw new ReadError(`the workbook has no sheet named "${mapping.sheets.shots}" (it has: ${sheets.map((s) => s.name).join(', ')}); name the shot sheet in a mapping file (sheets.shots)`);
  const tokens = sheetTable(sheets, mapping.sheets.tokens);
  const lighting = sheetTable(sheets, mapping.sheets.lighting);
  return { shots, ...(tokens && { tokens }), ...(lighting && { lighting }) };
}

export async function loadCsvTable(file: string): Promise<Table> {
  return tableOf(basename(file), parseCsv((await readFile(file)).toString('utf8')));
}

const tokensOf = (s: string): string[] => (s.toLowerCase().match(/[a-z]+|\d+/g) ?? []).map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t));
/** `want` appears in `have`, in order (not necessarily next to each other). */
const inOrder = (want: string[], have: string[]): boolean => {
  let at = 0;
  for (const w of want) { at = have.indexOf(w, at); if (at < 0) return false; at++; }
  return true;
};

/**
 * Find a ready-made row's file. In order: the mapping's `cards.files` (a name in the cards folder,
 * or a path); a file whose name holds the id's words and numbers in order, leading zeros aside
 * (`P3-CARD` finds `Show_P03_Card.png`, and never `P10`); then, when exactly one file matches,
 * one whose name holds the id's word part (`CREDITS-010` finds `Show_Credits_roll.mp4`). Anything else
 * is not found, and the row is left out.
 */
export function cardResolver(projectDir: string, cardsDir: string | undefined, files: Record<string, string>): (id: string) => string | undefined {
  const names: string[] = cardsDir && existsSync(cardsDir) ? readdirSync(cardsDir).filter((n) => /\.(png|jpe?g|webp|mp4|mov|webm)$/i.test(n)) : [];
  return (id) => {
    const named = files[id];
    if (named !== undefined) {
      const at = [cardsDir ? join(cardsDir, named) : undefined, resolve(projectDir, named), resolve(named)].filter((x): x is string => x !== undefined).find((x) => existsSync(x));
      return at !== undefined ? projectUri(projectDir, at) : undefined;
    }
    if (!cardsDir) return undefined;
    const stem = (n: string) => tokensOf(n.replace(/\.[^.]+$/, ''));
    const full = names.filter((n) => inOrder(tokensOf(id), stem(n)));
    if (full.length === 1) return projectUri(projectDir, join(cardsDir, full[0]!));
    const base = id.replace(/-\d+[A-Za-z]?$/, '');
    const word = base === id ? [] : tokensOf(base).filter((t) => /^[a-z]{4,}$/.test(t));
    if (word.length > 0) {
      const loose = names.filter((n) => inOrder(word, stem(n)));
      if (loose.length === 1) return projectUri(projectDir, join(cardsDir, loose[0]!));
    }
    return undefined;
  };
}

/** A line's clip: the name the quotes file gives, looked up in a clips folder (default `Clips` next to the quotes file). */
export function clipResolver(projectDir: string, linesFile: string, clipsDir?: string): (name: string) => string | undefined {
  const dir = clipsDir ?? join(dirname(linesFile), 'Clips');
  return (name) => {
    const f = [join(dir, name), join(dirname(linesFile), name)].find((x) => existsSync(x));
    return f !== undefined ? projectUri(projectDir, f) : undefined;
  };
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** `audio.master` for a WAV: the length and rate from its header only (never the samples); the hash only when asked for. */
export async function describeMaster(projectDir: string, wav: string, opts: { startTc?: string; hash?: boolean } = {}): Promise<MasterAudio> {
  const h = await readWavHeader(wav);
  return {
    uri: projectUri(projectDir, wav),
    duration_s: h.durationS,
    sample_rate: h.sampleRate,
    start_tc: opts.startTc ?? '00:00:00:00',
    ...(opts.hash ? { sha256: await sha256File(wav) } : {}),
  };
}
