/**
 * akuko — a host-A working copy of the board's project (lib/spend.md §Host A).
 *
 * On claude.ai the project lives in the board artifact's database and its
 * files in the artifact's asset store (`/_blob/<id>` uris). The paid stage
 * commands run in the chat's code workspace on a FOLDER, so the agent makes a
 * working copy: ArtifactData `get` of `akuko/project` saved as
 * `<work>/akuko.json`, the reference files it needs fetched with Artifact
 * `read` (`path` = the asset id) into a downloads folder. This script maps
 * the uris both ways, so nothing is rewritten by hand:
 *
 *   node --experimental-strip-types hosts/workcopy.ts localize --project <work> --media <downloads>
 *       copy each downloaded `<blob id>.<ext>` into <work>/media/ and point every `uri` that names
 *       that blob at the local copy; remembers the originals in <work>/.akuko-workcopy.json
 *   node --experimental-strip-types hosts/workcopy.ts uploads --project <work>
 *       list the files the commands made (local uris with no original): upload each with
 *       Artifact `publish` (`asset: true`) and note the url it returns
 *   node --experimental-strip-types hosts/workcopy.ts restore --project <work> [--uploaded <map.json>]
 *       put the original blob uris back and the uploaded urls in ({"<local uri>": "<url>"}), and write
 *       <work>/akuko.board.json: the document to ArtifactData `set` as `akuko/project` (with if_version)
 *
 * It never contacts anything and never reads a key. No dependencies, so it
 * runs from an installed skill. The board's database stays the source of
 * truth: the working copy lasts one chat.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAP_FILE = '.akuko-workcopy.json';
export const BOARD_FILE = 'akuko.board.json';
export const MEDIA_DIR = 'media';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** The blob id in an artifact asset url (`/_blob/<id>`, absolute or not). */
export const blobId = (uri: string): string | undefined => /\/_blob\/([A-Za-z0-9_-]+)/.exec(uri)?.[1];

/** A uri the local host wrote (relative, inside the folder). */
const isLocal = (uri: string): boolean => !/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith('/') && !uri.startsWith('..');

/** Every string under a key named `uri`, rewritten by `fn` (which returns the same string to keep it). */
export function mapUris(doc: Json, fn: (uri: string) => string): Json {
  if (Array.isArray(doc)) return doc.map((x) => mapUris(x, fn));
  if (doc && typeof doc === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(doc)) out[k] = k === 'uri' && typeof v === 'string' ? fn(v) : mapUris(v, fn);
    return out;
  }
  return doc;
}

export function collectUris(doc: Json): string[] {
  const seen = new Set<string>();
  mapUris(doc, (u) => { seen.add(u); return u; });
  return [...seen];
}

const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
const writeJson = (path: string, v: unknown): void => writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`);
const readMap = (work: string): Record<string, string> => (existsSync(join(work, MAP_FILE)) ? (readJson(join(work, MAP_FILE)) as Record<string, string>) : {});

export function localize(work: string, media: string): { localized: string[]; missing: string[] } {
  const doc = readJson(join(work, 'akuko.json'));
  const files = existsSync(media) ? readdirSync(media) : [];
  const map = readMap(work);
  const localized: string[] = [];
  const missing = new Set<string>();
  mkdirSync(join(work, MEDIA_DIR), { recursive: true });
  const next = mapUris(doc, (uri) => {
    const id = blobId(uri);
    if (!id) return uri;
    const file = files.find((f) => f === id || f.startsWith(`${id}.`));
    if (!file) { missing.add(uri); return uri; }
    const local = `${MEDIA_DIR}/${basename(file)}`;
    if (!existsSync(join(work, local))) copyFileSync(join(media, file), join(work, local));
    map[local] = uri;
    localized.push(local);
    return local;
  });
  writeJson(join(work, 'akuko.json'), next);
  writeJson(join(work, MAP_FILE), map);
  return { localized: [...new Set(localized)], missing: [...missing] };
}

/** Local uris that have no original: files the commands made, to upload. */
export function pendingUploads(work: string): string[] {
  const map = readMap(work);
  return collectUris(readJson(join(work, 'akuko.json'))).filter((u) => isLocal(u) && !(u in map));
}

export function restore(work: string, uploaded: Record<string, string>): { path: string; left: string[] } {
  const map = readMap(work);
  for (const [k, v] of Object.entries(uploaded)) {
    if (!blobId(v)) throw new Error(`uploaded url for ${k} is not an artifact asset url (/_blob/<id>): ${v}`);
  }
  const left = new Set<string>();
  const next = mapUris(readJson(join(work, 'akuko.json')), (uri) => {
    if (uri in map) return map[uri] as string;
    if (uri in uploaded) return uploaded[uri] as string;
    if (isLocal(uri)) left.add(uri);
    return uri;
  });
  if (left.size) return { path: '', left: [...left] };
  const path = join(work, BOARD_FILE);
  writeJson(path, next);
  return { path, left: [] };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function run(argv: string[], out: (l: string) => void = console.log): number {
  const [cmd] = argv;
  const work = flag(argv, 'project');
  if (!work) { out('akuko: --project <working folder> is required.'); return 2; }
  if (!existsSync(join(work, 'akuko.json'))) { out(`akuko: no akuko.json in ${work}: save the board's akuko/project there first.`); return 2; }
  if (cmd === 'localize') {
    const media = flag(argv, 'media');
    if (!media) { out('akuko: --media <folder the asset files were saved to> is required.'); return 2; }
    const r = localize(resolve(work), resolve(media));
    out(`Localized ${r.localized.length} file${r.localized.length === 1 ? '' : 's'} into ${MEDIA_DIR}/.`);
    if (r.missing.length) out(`Not downloaded (fetch them with Artifact read if the step needs them): ${r.missing.join(', ')}`);
    return 0;
  }
  if (cmd === 'uploads') {
    const list = pendingUploads(resolve(work));
    out(list.length ? list.join('\n') : 'Nothing to upload.');
    return 0;
  }
  if (cmd === 'restore') {
    const mapPath = flag(argv, 'uploaded');
    const uploaded = mapPath ? (JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>) : {};
    const r = restore(resolve(work), uploaded);
    if (r.left.length) { out(`Not uploaded yet, so not restored: ${r.left.join(', ')}. Upload them and pass --uploaded.`); return 1; }
    out(`Wrote ${r.path}: set it as akuko/project on the board (ArtifactData set, with if_version).`);
    return 0;
  }
  out('akuko: command must be localize, uploads or restore.');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
