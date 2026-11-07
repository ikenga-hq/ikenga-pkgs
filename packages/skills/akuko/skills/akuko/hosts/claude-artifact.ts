/**
 * akuko — host A, claude-artifact (claude.ai).
 *
 * claude.ai's chat CAN run code (Bash + Node in a remote cloud workspace —
 * manual check A2, 2026-11-07), but that workspace lasts one chat and code
 * there cannot call the Artifact / ArtifactData tools. So the project's
 * source of truth is the board artifact's database, and every state / asset
 * method below is performed by the agent as a TOOL CALL. (ArtifactData is a
 * deferred tool on claude.ai: load it with ToolSearch first.)
 *
 * So this file is two things at once:
 *   1. The spec the agent follows on host A: each method's comment names the
 *      tool call that performs it.
 *   2. An executable adapter over injected `ArtifactBindings`, used by tests
 *      (with a fake) and by any runtime whose bindings can reach the tools —
 *      e.g. Claude Code holding the same ArtifactData tool, or a page script.
 *
 * Store layout (PROVISIONAL — WP-07a fixes the decisions half):
 *   doc  `akuko/project`        the whole AkukoProject (export → akuko.json)
 *   coll `decisions`            one doc per Decision (WP-07a). A page's `add()`
 *                               assigns its own row id (e.g. `dg54snl36ulb16eig8hp`);
 *                               ArtifactData returns rows as {id, data, version, updatedAt}
 *   asset store                 bytes; Asset.file.uri = the returned `/_blob/<id>` url.
 *                               The page must declare the `assets` capability.
 */

import { AkukoProjectSchema, type AkukoProject, type Asset, type Decision } from '../schema/akuko-project.ts';
import { classifyHost, normalizeCapabilities } from './detect.ts';
import { readArtifactDbStore } from '../decisions/artifact-db.ts';
import { assetId, buildAsset, safeBasename } from './shared.ts';
import type { AssetInput, Capabilities, HostAdapter, HostLevel, ViewArtifact } from './types.ts';

/** Doc path that holds the project (collection `akuko`, doc `project`). */
export const PROJECT_DOC = 'akuko/project';
/** Collection the review surface writes decisions to (owned by WP-07a). */
export const DECISIONS_COLLECTION = 'decisions';

/** What the host gives the adapter. On claude.ai each one is a tool call the agent makes. */
export interface ArtifactBindings {
  /** The board artifact whose DB/asset store holds the project, e.g. `https://claude.ai/artifact/…`. */
  artifactUrl: string;
  /** ArtifactData `get` { url, collection: 'akuko', doc_id: 'project' }. Resolves undefined when absent. */
  getDoc(path: string): Promise<Record<string, unknown> | undefined>;
  /** ArtifactData `set` { url, collection: 'akuko', doc_id: 'project', data }. */
  setDoc(path: string, data: Record<string, unknown>): Promise<void>;
  /** Artifact `publish` { url, file_path, asset: true } → `{ id, url }`. */
  uploadAsset(a: { filename: string; mime: string; data: Uint8Array }): Promise<{ id: string; url: string }>;
  /** Artifact `publish` { file_path } of the view's HTML (new or same path) → `{ url }`. */
  publish(v: ViewArtifact): Promise<{ url: string }>;
  /** ArtifactData `list` { url, collection } → the tool's result (rows `{id, data, version, updatedAt}`). Needed by `readDecisions`. */
  listCollection?(collection: string): Promise<unknown>;
  /** What the runtime can do (normally `detect.ts --tools` output). Defaults: the DB plus code execution, no durable fs (claude.ai, A2 2026-11-07). */
  capabilities?: Partial<Capabilities>;
  /** Clock for `updated_at`. */
  now?: () => Date;
}

export class ClaudeArtifactHost implements HostAdapter {
  private readonly b: ArtifactBindings;

  constructor(b: ArtifactBindings) {
    this.b = b;
  }

  /**
   * On claude.ai the agent runs `hosts/detect.ts --tools <its full tool
   * list>` in its workspace (→ level A, `fs: false`, `codeExec: true`) and
   * passes the result as `capabilities`. artifactDb is true once a board
   * artifact with the `db` capability exists.
   */
  async detect(): Promise<{ level: HostLevel; capabilities: Capabilities }> {
    const capabilities = normalizeCapabilities({ artifactDb: true, codeExec: true, fs: false, ...this.b.capabilities });
    const level = classifyHost(capabilities);
    return { level, capabilities };
  }

  /** ArtifactData get `akuko/project`, then validate. Throws when the doc is missing or invalid. */
  async readState(): Promise<AkukoProject> {
    const doc = await this.b.getDoc(PROJECT_DOC);
    if (doc === undefined) throw new Error(`akuko: no project in ${this.b.artifactUrl} (${PROJECT_DOC})`);
    return AkukoProjectSchema.parse(doc);
  }

  /** Validate, then ArtifactData set `akuko/project`. Only actions call this — never a view. */
  async writeState(p: AkukoProject): Promise<void> {
    const valid = AkukoProjectSchema.parse(p);
    await this.b.setDoc(PROJECT_DOC, valid as unknown as Record<string, unknown>);
  }

  /** Upload bytes to the artifact's asset store; `file.uri` is the returned url. Not added to the project. */
  async storeAsset(a: AssetInput): Promise<Asset> {
    // Validate the id and the record before uploading, so a bad input never leaves an orphaned asset.
    const base = assetId({ id: a.id, filename: a.filename });
    const now = (this.b.now ?? (() => new Date()))();
    buildAsset(a, { uri: 'pending' }, base, now);
    const up = await this.b.uploadAsset({ filename: safeBasename(a.filename), mime: a.mime, data: a.data });
    // A requested id is honoured; otherwise the store's unique id is appended so
    // two uploads of the same file name never share an akuko id.
    const id = a.id ?? `${base}-${up.id.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
    return buildAsset(a, { uri: up.url }, id, now);
  }

  /** Publish the view as a Claude artifact (writing views need the `db` capability — WP-07a/07c). */
  async publishView(v: ViewArtifact): Promise<{ url?: string; path?: string }> {
    const { url } = await this.b.publish(v);
    return { url };
  }

  /**
   * Delegates to `decisions/artifact-db.ts`: ArtifactData `list` of the
   * `decisions` collection, one row per decision. `since` is a `db:<updatedAt>`
   * cursor. On claude.ai the agent makes the list call itself and folds with
   * `decisions/cli.ts fold-file` (actions/review.md §Host A).
   */
  async readDecisions(since?: string): Promise<Decision[]> {
    const list = this.b.listCollection;
    if (!list) {
      throw new Error('akuko: this host binding cannot list the artifact DB; list the `decisions` collection with ArtifactData (load it with ToolSearch) and fold with decisions/cli.ts fold-file');
    }
    return (await readArtifactDbStore((c) => list.call(this.b, c), since)).decisions;
  }
}

export function createClaudeArtifactHost(b: ArtifactBindings): ClaudeArtifactHost {
  return new ClaudeArtifactHost(b);
}
