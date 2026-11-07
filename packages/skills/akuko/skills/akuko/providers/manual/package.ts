/**
 * Manual provider — the prompt package.
 *
 * Lifted in shape from Studio's `export.prompt_package` (Track B,
 * `apps/studio/sidecars/project/src/prompt-package.ts`): one bundle per job
 * telling a person what to paste where, which references to attach, and what
 * to name the file they bring back. Per-platform phrasing is a small pure
 * shaper map, as in Studio, so a new target is one entry.
 *
 * Pure: no host, no clock unless one is passed.
 */

import type { ProviderKind, StageId } from '../../schema/akuko-project.ts';
import type { Job, JobItem, JobRef } from '../contract.ts';

export const MANUAL_PLATFORMS = ['generic', 'flow', 'higgsfield', 'veo'] as const;
export type ManualPlatform = (typeof MANUAL_PLATFORMS)[number];
export const isManualPlatform = (v: unknown): v is ManualPlatform =>
  typeof v === 'string' && (MANUAL_PLATFORMS as readonly string[]).includes(v);

/** File types the manual provider will ingest, by job kind. */
export const ACCEPT: Record<ProviderKind, string[]> = {
  image: ['image/png', 'image/jpeg', 'image/webp'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4'],
  layout: ['image/png', 'image/jpeg', 'image/svg+xml', 'application/pdf', 'text/html'],
};

const DEFAULT_EXT: Record<ProviderKind, string> = { image: 'png', video: 'mp4', audio: 'mp3', layout: 'png' };

export const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'text/html': 'html',
};

/** The basename a returned file should carry: `<unit>-<stage>.<ext>`. */
export const expectedFilename = (unit: string, stage: StageId, ext: string): string => `${unit}-${stage}.${ext}`;

export interface PromptPackageRef extends JobRef {
  attach: string;            // what to do with it in the target tool
}

export interface PromptPackageItem {
  unit: string;
  prompt: string;            // shaped for the platform
  negative?: string;
  refs: PromptPackageRef[];
  count: number;
  aspect_ratio?: string;
  duration_s?: number;
  seed?: number;
  expected_file: string;     // save the result under this name
  accept: string[];          // mime types ingest takes for this job kind
}

export interface PromptPackage {
  format: 'akuko-prompt-package';
  version: 1;
  job: string;
  label: string;
  stage: StageId;
  kind: ProviderKind;
  platform: ManualPlatform;
  created_at?: string;
  items: PromptPackageItem[];
  steps: string[];
}

const secs = (s: number | undefined): string => (s !== undefined && s > 0 ? `${s.toFixed(1)}s` : 'unspecified length');

/** Per-platform phrasing (pure). Mirrors Studio's shaper map. */
const SHAPERS: Record<ManualPlatform, (i: JobItem, refs: PromptPackageRef[]) => string> = {
  // Plain prompt with a light camera / format tail.
  generic: (i) => {
    const parts = [i.prompt.trim()];
    if (i.camera?.trim()) parts.push(i.camera.trim());
    if (i.aspect_ratio) parts.push(`Aspect ${i.aspect_ratio}`);
    return parts.join('. ') + '.';
  },
  // Google Flow frames references as "Ingredients"; scene text follows.
  flow: (i, refs) => {
    const lines = [
      refs.length ? `Ingredients: ${refs.map((r) => r.id).join(', ')} (keep characters and locations consistent).` : 'Ingredients: none (text-to-video).',
      `Scene: ${i.prompt.trim()}`,
    ];
    if (i.camera?.trim()) lines.push(`Shot: ${i.camera.trim()}.`);
    lines.push(`Format: ${i.aspect_ratio ?? 'as project'}, ${secs(i.duration_s)}.`);
    return lines.join('\n');
  },
  // Higgsfield leads with the camera move.
  higgsfield: (i) => {
    const lines: string[] = [];
    if (i.camera?.trim()) lines.push(`Camera: ${i.camera.trim()}.`);
    lines.push(i.prompt.trim());
    lines.push(`Aspect ${i.aspect_ratio ?? 'as project'}, duration ${secs(i.duration_s)}.`);
    return lines.join(' ');
  },
  // Veo generates native audio, so ask for it explicitly.
  veo: (i) => {
    const lines = [i.prompt.trim()];
    if (i.camera?.trim()) lines.push(`${i.camera.trim()}.`);
    lines.push('Audio: fitting ambient sound and light foley; no dialogue unless written above.');
    lines.push(`Aspect ${i.aspect_ratio ?? 'as project'}, ${secs(i.duration_s)}.`);
    return lines.join(' ');
  },
};

function attachNote(ref: JobRef): string {
  if (!ref.uri) return `Reference "${ref.id}" has no file yet — describe it in words or skip it.`;
  if (/^https?:/.test(ref.uri)) return `Attach ${ref.uri} as a ${ref.role ?? 'reference'} image.`;
  return `Upload the file ${ref.uri} as a ${ref.role ?? 'reference'} image.`;
}

/** Build the prompt package for a job. */
export function buildPromptPackage(job: Job, platform: ManualPlatform = 'generic', createdAt?: string): PromptPackage {
  const accept = ACCEPT[job.kind];
  const items: PromptPackageItem[] = job.items.map((i) => {
    const refs = (i.refs ?? []).map((r) => ({ ...r, attach: attachNote(r) }));
    return {
      unit: i.unit,
      prompt: SHAPERS[platform](i, refs),
      refs,
      count: i.count ?? 1,
      expected_file: expectedFilename(i.unit, job.stage, DEFAULT_EXT[job.kind]),
      accept,
      ...(i.negative !== undefined ? { negative: i.negative } : {}),
      ...(i.aspect_ratio !== undefined ? { aspect_ratio: i.aspect_ratio } : {}),
      ...(i.duration_s !== undefined ? { duration_s: i.duration_s } : {}),
      ...(i.seed !== undefined ? { seed: i.seed } : {}),
    };
  });
  const where = platform === 'generic' ? `the ${job.kind} tool you use` : platform;
  return {
    format: 'akuko-prompt-package',
    version: 1,
    job: job.id,
    label: job.label,
    stage: job.stage,
    kind: job.kind,
    platform,
    ...(createdAt ? { created_at: createdAt } : {}),
    items,
    steps: [
      `For each item below, open ${where} and paste the prompt.`,
      'Attach the listed references, if the tool takes them.',
      `Save each result under its expected file name (any of: ${accept.join(', ')}).`,
      'Bring the files back — attach them in chat, or drop them in the project folder — and akuko files each against its unit for your review. Nothing is marked approved until you approve it.',
    ],
  };
}

/** The package as text a person can follow. */
export function renderPromptPackage(pkg: PromptPackage): string {
  const out: string[] = [`# ${pkg.label}`, `Job ${pkg.job} · ${pkg.stage} · ${pkg.kind} · ${pkg.platform}`, ''];
  pkg.steps.forEach((s, k) => out.push(`${k + 1}. ${s}`));
  for (const item of pkg.items) {
    out.push('', `## ${item.unit} → save as \`${item.expected_file}\`${item.count > 1 ? ` (${item.count} takes)` : ''}`, '', '```', item.prompt, '```');
    if (item.negative) out.push(`Avoid: ${item.negative}`);
    for (const r of item.refs) out.push(`- ${r.attach}`);
    const fmt = [item.aspect_ratio, item.duration_s !== undefined ? `${item.duration_s}s` : undefined, item.seed !== undefined ? `seed ${item.seed}` : undefined].filter(Boolean);
    if (fmt.length) out.push(`Format: ${fmt.join(', ')}`);
  }
  return out.join('\n') + '\n';
}
