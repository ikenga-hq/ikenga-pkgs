/**
 * akuko — small helpers shared by the per-shot plan (`plan.ts`) and the master-clock plan (`master.ts`) of the
 * Resolve handoff. Kept apart so the two planners do not import each other.
 */

import type { Asset } from '../schema/akuko-project.ts';

export const ASPECT_SIZE: Record<string, [number, number]> = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };

export const pad = (n: number, w: number): string => String(n).padStart(w, '0');
export const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');
export const ext = (uri: string): string => {
  const base = uri.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
};

/** Planned but never made (status pending, no file): nothing to say about it. */
export const started = (a: Asset): boolean => a.status !== 'pending' || a.file !== undefined;

export const usable = (a: Asset | undefined): a is Asset & { file: NonNullable<Asset['file']> } => a !== undefined && a.status === 'approved' && a.file !== undefined;

export function whyNot(a: Asset, exists: (uri: string) => boolean): string {
  if (a.status !== 'approved') return `status is ${a.status}, not approved`;
  if (!a.file) return 'approved but has no file';
  if (!exists(a.file.uri)) return `approved, but its file is missing (${a.file.uri})`;
  return 'not usable';
}
