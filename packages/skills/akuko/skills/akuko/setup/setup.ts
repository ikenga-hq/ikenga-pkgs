/**
 * akuko — `setup` (WP-08).
 *
 * `applySetup()` takes the person's answers and
 *   - records the REQUIRED budget cap in `akuko.json.budget` through the host
 *     adapter's `writeState()` (schema-validated), in the provider-config
 *     currency so the spend gate never refuses a job for currency mismatch;
 *   - builds the instance manifest (`.atelier/akuko/manifest.json`).
 *
 * There is no default cap: without an explicit number from the person it
 * throws `SetupError` and writes nothing. Keys are only ever reported as
 * present / absent; their values are never put in any output. Environment
 * changes (HYPERFRAMES_BROWSER_PATH) are returned as instructions, never made.
 */

import { existsSync } from 'node:fs';
import type { AkukoProject, Host } from '../schema/akuko-project.ts';
import { createProject } from '../breakdown/intake.ts';
import type { HostAdapter } from '../hosts/types.ts';
import type { AkukoProviderConfig } from '../providers/config.ts';
import { loadProviderConfig, providerKeyEnv, providerKeyEnvs } from '../providers/config.ts';
import { committedFromLedger } from '../spend/ledger.ts';
import {
  BrandSchema,
  MANIFEST_TEMPLATE_VERSION,
  ManifestSchema,
  type Brand,
  type BrandInput,
  type Manifest,
} from './manifest.ts';
import { detectHostRecord } from './host-record.ts';

export class SetupError extends Error {
  override name = 'SetupError';
}

export const HYPERFRAMES_BROWSER_ENV = 'HYPERFRAMES_BROWSER_PATH';

export type AspectRatio = AkukoProject['project']['aspect_ratio'];

export interface SetupAnswers {
  /** The budget cap, in the provider-config currency. Required; there is no default. */
  cap: number;
  defaults?: { aspect_ratio?: AspectRatio; runtime_s?: number };
  /** Palette, fonts, logo — from the person only. Omit / null for none. */
  brand?: BrandInput | null;
  /** Provider id → env var name, that override the config's `key_env`. */
  keyEnvNames?: Record<string, string>;
  /** Title for the project setup creates when there is no `akuko.json` yet. The agent asks the person for the title first and passes it here; "Untitled film" is only a fallback and nothing renames it later. */
  title?: string;
}

export interface SetupDeps {
  host: Pick<HostAdapter, 'readState' | 'writeState'>;
  config?: AkukoProviderConfig;
  env?: Record<string, string | undefined>;
  platform?: string;
  now?: () => string;
  /** Existence check for the HyperFrames browser path; tests replace it. */
  exists?: (path: string) => boolean;
  /** The `host` record written when setup creates the project; tests replace it. Defaults to host detection. */
  hostRecord?: Host;
}

export interface BrowserAdvice {
  /** True on Windows, where HyperFrames' bundled headless shell can crash (R-9). */
  applies: boolean;
  set: boolean;
  /** The variable is set and points at a file that exists (always true where it does not apply). */
  ok: boolean;
  /** What to tell the person. Instructions only: setup never edits the environment or registry. */
  instructions: string[];
}

export interface SetupResult {
  project: AkukoProject;
  manifest: Manifest;
  browser: BrowserAdvice;
}

/** Fallback env var name when neither the answers nor the provider's `key_env` in config.json name one. */
export function defaultKeyEnvName(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/**
 * Providers that need a key: paid, non-example entries. Example entries are
 * placeholders the gate refuses outside tests, so they are not asked about.
 */
export function providersNeedingKeys(config: AkukoProviderConfig): string[] {
  return Object.entries(config.providers)
    .filter(([, p]) => p.billing !== 'free' && !p.example)
    .map(([id]) => id);
}

/** provider id → env var name + whether it is set. Values are never returned. */
export function keyPresence(
  config: AkukoProviderConfig,
  env: Record<string, string | undefined>,
  names: Record<string, string> = {},
): Record<string, { env: string; present: boolean }> {
  const out: Record<string, { env: string; present: boolean }> = {};
  for (const id of providersNeedingKeys(config)) {
    // A provider that needs two variables (Kling: access key + secret key) is present only when both are set.
    const listed = providerKeyEnvs(config, id);
    const vars = names[id] !== undefined ? [names[id]] : listed.length ? listed : [providerKeyEnv(config, id) ?? defaultKeyEnvName(id)];
    out[id] = { env: vars.join(' + '), present: vars.every((v) => (env[v] ?? '') !== '') };
  }
  return out;
}

export function browserAdvice(
  platform: string,
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean = existsSync,
): BrowserAdvice {
  if (platform !== 'win32') return { applies: false, set: false, ok: true, instructions: [] };
  const value = env[HYPERFRAMES_BROWSER_ENV] ?? '';
  const set = value !== '';
  const ok = set && exists(value);
  const instructions: string[] = [];
  if (!ok) {
    if (set) instructions.push(`${HYPERFRAMES_BROWSER_ENV} is set but the file it points to does not exist.`);
    instructions.push(
      'HyperFrames needs a working Chrome on Windows (its bundled headless shell can crash on launch).',
      `Set ${HYPERFRAMES_BROWSER_ENV} to your Chrome executable, for example in PowerShell:`,
      `  setx ${HYPERFRAMES_BROWSER_ENV} "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`,
      'then open a new terminal. akuko does not change your environment for you. Until then rendering is unavailable; storyboards and prompt packages still work.',
    );
  }
  return { applies: true, set, ok, instructions };
}

function validateCap(cap: unknown): number {
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) {
    throw new SetupError(
      'A budget cap is required and has no default: tell me the most you are willing to spend on this film, as a number (0 means nothing paid may run). Nothing was saved.',
    );
  }
  return cap;
}

export async function applySetup(answers: SetupAnswers, deps: SetupDeps): Promise<SetupResult> {
  const cap = validateCap((answers as { cap?: unknown }).cap);
  const config = deps.config ?? loadProviderConfig();
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')))();
  const platform = deps.platform ?? process.platform;

  let brand: Brand | null = null;
  if (answers.brand) {
    const parsed = BrandSchema.safeParse(answers.brand);
    if (!parsed.success) throw new SetupError(`The brand answers are not usable: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    brand = parsed.data;
  }

  // Setup may run before intake (SKILL.md), so there may be no akuko.json yet. Create the
  // same minimal project `breakdown/cli.ts new` does (intake open, later stages locked),
  // with the detected host recorded, so the cap has somewhere to live.
  let current: AkukoProject;
  try {
    current = await deps.host.readState();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    current = { ...createProject({ title: answers.title ?? 'Untitled film', now: () => new Date(now) }), host: deps.hostRecord ?? detectHostRecord() };
  }
  const prev = current.budget;
  const currency = config.currency;
  const committed = committedFromLedger(current);
  if (prev && prev.currency !== currency && committed > 0) {
    throw new SetupError(
      `This project already has spend recorded in ${prev.currency}, but providers are priced in ${currency}. Changing currency would misstate the ledger; nothing was saved.`,
    );
  }
  if (cap < committed) {
    throw new SetupError(`The cap ${cap} ${currency} is below the ${committed} ${currency} already spent or reserved on this project. Nothing was saved.`);
  }

  const meta = { ...current.project };
  if (answers.defaults?.aspect_ratio) meta.aspect_ratio = answers.defaults.aspect_ratio;
  if (answers.defaults?.runtime_s !== undefined) meta.runtime_s = answers.defaults.runtime_s;
  meta.updated_at = now;
  const project: AkukoProject = {
    ...current,
    project: meta,
    budget: { cap, currency, spent: prev?.spent ?? 0 },
  };
  await deps.host.writeState(project);

  const browser = browserAdvice(platform, env, deps.exists);
  const manifest: Manifest = ManifestSchema.parse({
    format: 'akuko-instance',
    template_version: MANIFEST_TEMPLATE_VERSION,
    skill: 'akuko',
    updated_at: now,
    settings: {
      keys_present: keyPresence(config, env, answers.keyEnvNames),
      defaults: {
        ...(answers.defaults?.aspect_ratio ? { aspect_ratio: answers.defaults.aspect_ratio } : {}),
        ...(answers.defaults?.runtime_s !== undefined ? { runtime_s: answers.defaults.runtime_s } : {}),
      },
      brand,
      hyperframes_browser: browser.applies ? { env: HYPERFRAMES_BROWSER_ENV, set: browser.ok } : null,
    },
  });
  return { project, manifest, browser };
}
