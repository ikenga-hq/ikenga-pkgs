/**
 * akuko — intake helpers: start a project, tell a screenplay from prose, and
 * record the script files so a person can approve them.
 *
 * What is LLM-driven (see `actions/intake.md`): adapting prose into a Fountain
 * screenplay. What is code (here, tested): creating a valid empty project,
 * detecting Fountain, and registering the script files as reviewable units.
 */

import {
  AkukoProjectSchema,
  defaultStages,
  type AkukoProject,
  type Asset,
} from '../schema/akuko-project.ts';
import { parseFountain } from './fountain.ts';

/** How the person chose to handle prose (Q-06 / R2-6). */
export type IntakeRoute =
  | 'screenplay'  // the source already is a screenplay: keep it as-is
  | 'adapt'       // prose adapted to a Fountain screenplay, then broken down
  | 'direct'      // prose broken down as it stands; no screenplay is written
  | 'import';     // the person's own shot list is imported (breakdown/import/); no source text is required

/** `fountain` when the text has scene headings; otherwise `prose`. */
export function detectSourceKind(text: string): 'fountain' | 'prose' {
  return parseFountain(text).scenes.length > 0 ? 'fountain' : 'prose';
}

export function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'film';
}

export interface NewProject {
  title: string;
  slug?: string;
  logline?: string;
  /** Credit line for the source work. */
  source?: string;
  runtime_s?: number;
  now?: () => Date;
}

/** A valid empty project: intake open, every later stage locked. */
export function createProject(n: NewProject): AkukoProject {
  const now = (n.now ?? (() => new Date()))().toISOString();
  const stages = defaultStages('locked');
  stages.intake = { state: 'in-progress' };
  return AkukoProjectSchema.parse({
    format: 'akuko',
    schema_version: 1,
    project: {
      slug: n.slug ?? slugify(n.title),
      title: n.title,
      ...(n.logline !== undefined && { logline: n.logline }),
      ...(n.source !== undefined && { source: n.source }),
      ...(n.runtime_s !== undefined && { runtime_s: n.runtime_s }),
      aspect_ratio: '16:9',
      profile: 'film',
      created_at: now,
    },
    stages,
    current_stage: 'intake',
  });
}

export const SOURCE_PATH = 'script/source.md';
export const SCREENPLAY_PATH = 'script/screenplay.fountain';

function scriptAsset(id: string, name: string, uri: string, mime: string, tag: string, now: string): Asset {
  return {
    id,
    stage: 'intake',
    status: 'pending-review',
    comments: [],
    by_stage: { intake: { status: 'pending-review' } },
    kind: 'other',
    name,
    file: { uri, mime },
    tags: [tag],
    updated_at: now,
  };
}

export interface CompleteIntake {
  route: IntakeRoute;
  /** Where the source text was stored; default `script/source.md`. On the `import` route there is no default: only a film script that was given is recorded. */
  sourceUri?: string;
  /** `import` route: the shot-list file as given, recorded as the asset `script-sheet` that the person approves. */
  sheetUri?: string;
  sheetMime?: string;
  /** Where the screenplay was stored; default `script/screenplay.fountain`. Required unless route is `direct`. */
  screenplayUri?: string;
  now?: () => Date;
}

/**
 * Record the script files on the project and put the intake stage in review.
 * The files become two assets at `pending-review` (source, and screenplay when
 * there is one); intake is approved when a person approves them. Re-running
 * with the same files changes nothing.
 */
export function completeIntake(project: AkukoProject, c: CompleteIntake): AkukoProject {
  const now = (c.now ?? (() => new Date()))().toISOString();
  const out = structuredClone(project);
  const sourceUri = c.route === 'import' ? c.sourceUri : (c.sourceUri ?? SOURCE_PATH);
  if (sourceUri !== undefined) out.script.source = sourceUri;
  const upsert = (a: Asset) => {
    if (!out.assets.some((x) => x.id === a.id)) out.assets.push(a);
  };
  if (sourceUri !== undefined) {
    upsert(scriptAsset('script-source', c.route === 'import' ? 'Film script' : 'Source text', sourceUri, 'text/markdown', 'source', now));
  }
  if (c.route === 'import') {
    delete out.script.screenplay;
    if (c.sheetUri !== undefined) upsert(scriptAsset('script-sheet', 'Shot list', c.sheetUri, c.sheetMime ?? 'application/octet-stream', 'sheet', now));
  } else if (c.route === 'direct') {
    delete out.script.screenplay;
  } else {
    const uri = c.screenplayUri ?? SCREENPLAY_PATH;
    out.script.screenplay = uri;
    upsert(scriptAsset('script-screenplay', 'Screenplay', uri, 'text/plain', 'screenplay', now));
  }
  if (out.stages.intake.state === 'in-progress' || out.stages.intake.state === 'not-started') {
    out.stages.intake = { state: 'in-review' };
  }
  out.current_stage = 'intake';
  out.project.updated_at = now;
  return AkukoProjectSchema.parse(out);
}
