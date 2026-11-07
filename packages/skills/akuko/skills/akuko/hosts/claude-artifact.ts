/**
 * akuko — host A, claude-artifact (claude.ai).
 *
 * INSTRUCTION-ONLY ON claude.ai. The agent in a claude.ai chat reads and
 * writes a published artifact's database and asset store through TOOL CALLS
 * (the Artifact / ArtifactData tools), not by running this file; whether
 * claude.ai's own code sandbox could execute it is unconfirmed (lib/hosts.md
 * §Host-capability note, row A — to be confirmed by §Manual host check).
 *
 * So this file is two things at once:
 *   1. The spec the agent follows on host A: each method's comment names the
 *      tool call that performs it.
 *   2. An executable adapter over injected `ArtifactBindings`, used by tests
 *      (with a fake) and by any runtime that can execute it — e.g. Claude
 *      Code holding the same ArtifactData tool, or a future page-side script.
 *
 * Store layout (PROVISIONAL — WP-07a fixes the decisions half):
 *   doc  `akuko/project`        the whole AkukoProject (export → akuko.json)
 *   coll `decisions`            one doc per Decision, id = decision id (WP-07a)
 *   asset store                 bytes; Asset.file.uri = the returned asset url
 */

import { AkukoProjectSchema, type AkukoProject, type Asset, type Decision } from '../schema/akuko-project.ts';
import { classifyHost, normalizeCapabilities } from './detect.ts';
import { assetId, buildAsset, decisionsNotImplemented, safeBasename } from './shared.ts';
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
  /** What the runtime can do beyond the DB (e.g. connected connectors). Defaults: DB only. */
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
   * On claude.ai the agent does this by inspection, not code: no Bash/fs
   * tools and no Studio MCP → level A; artifactDb is true once a board
   * artifact with the `db` capability exists. Connected connectors (e.g.
   * Canva) go in `connectedMcps`.
   */
  async detect(): Promise<{ level: HostLevel; capabilities: Capabilities }> {
    const capabilities = normalizeCapabilities({ artifactDb: true, ...this.b.capabilities });
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
    const up = await this.b.uploadAsset({ filename: safeBasename(a.filename), mime: a.mime, data: a.data });
    const now = (this.b.now ?? (() => new Date()))();
    return buildAsset(a, { uri: up.url }, a.id ?? assetId({ filename: a.filename }), now);
  }

  /** Publish the view as a Claude artifact (writing views need the `db` capability — WP-07a/07c). */
  async publishView(v: ViewArtifact): Promise<{ url?: string; path?: string }> {
    const { url } = await this.b.publish(v);
    return { url };
  }

  /** Delegates to `decisions/artifact-db.ts` (ArtifactData list of `decisions`) — WP-07a. */
  async readDecisions(_since?: string): Promise<Decision[]> {
    return decisionsNotImplemented('A');
  }
}

export function createClaudeArtifactHost(b: ArtifactBindings): ClaudeArtifactHost {
  return new ClaudeArtifactHost(b);
}
