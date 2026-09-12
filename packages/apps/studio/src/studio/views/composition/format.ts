// com.ikenga.studio · Composition formatting + record helpers
//
// Small pure helpers shared by the Composition cockpit subcomponents. Time
// math for the transport still lives in lib/time.ts — these are the
// presentation-only formatters (clock strings, relative "Ns ago", fidelity
// labels) plus the record→clip resolution the playback + records table share.

import type { RenderRecord, RenderStatus, Rung } from '../../mcp-types';

/** ms → "M:SS.d" (matches the transport timecode + C-A concept). */
export function fmtClock(ms: number): string {
  const totalS = Math.max(0, ms) / 1000;
  const m = Math.floor(totalS / 60);
  const s = totalS - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/** ms → "5.00s" seconds label. */
export function fmtSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

/** ISO-8601 (or epoch-ms number) → "just now" / "42s ago" / "6m ago" / clock.
 *  `now` is injected so a single render pass is internally consistent. */
export function fmtRelative(iso: string | number | undefined, now: number): string {
  if (iso === undefined || iso === null || iso === '') return '—';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const deltaS = Math.max(0, Math.round((now - t) / 1000));
  if (deltaS < 3) return 'just now';
  if (deltaS < 60) return `${deltaS}s ago`;
  if (deltaS < 3600) return `${Math.floor(deltaS / 60)}m ago`;
  if (deltaS < 86_400) return `${Math.floor(deltaS / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

/** ISO/epoch → local wall-clock "HH:MM:SS" (records-table "Finished" column). */
export function fmtClockTime(iso: string | number | undefined): string {
  if (iso === undefined || iso === null || iso === '') return '—';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleTimeString(undefined, { hour12: false });
}

/** Rung enum → plain-language fidelity label (no "rung"/enum jargon leaking to
 *  the user — closes `composition-hf-rung-jargon-leak`). */
export function fidelityLabel(rung: Rung | undefined): string {
  if (rung === '2_hifi') return 'Hi-fi';
  if (rung === '1_lofi') return 'Lo-fi';
  if (rung === '0_beat_sheet') return 'Beat sheet';
  return 'Draft';
}

/** Human engine name (strip internal ids). */
export function engineLabel(engine: string | undefined): string {
  if (!engine) return 'HyperFrames';
  const e = engine.toLowerCase();
  if (e.startsWith('hf') || e.includes('hyperframe')) return 'HyperFrames';
  if (e.includes('remotion')) return 'Remotion';
  if (e.includes('excalidraw')) return 'Excalidraw';
  if (e.includes('blender')) return 'Blender';
  if (e.includes('fal')) return 'fal.ai';
  return engine;
}

/** Basename of an output path (visible + copyable export/record path). */
export function baseName(p: string | undefined): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Latest render record per cell uid. Prefers a `done` record (the one with a
 * real mp4 to preview); among same-tier records the most-recently-finished (or,
 * lacking timestamps, the later list position) wins. Mirrors foldRenderStatus's
 * recency intent but keeps the full record (id/output/finished_at/engine) the
 * records table + byte-playback need.
 *
 * This is a BEST-EVER-STATUS pick (done > running > queued > failed), not a
 * most-recent-attempt one — exactly what the filmstrip poster / byte-playback
 * want (the best mp4 we have, even a stale one). It is deliberately NOT used
 * for the "N / M rendered" banner any more (G-106) — see `latestRecordByUid`
 * below for that.
 */
export function recordByUid(records: RenderRecord[]): Record<string, RenderRecord> {
  const out: Record<string, RenderRecord> = {};
  const rank = (s: RenderStatus): number =>
    s === 'done' ? 3 : s === 'running' ? 2 : s === 'queued' ? 1 : 0;
  const finishedMs = (r: RenderRecord): number => {
    const v = r.finished_at ?? r.started_at;
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  for (const r of records) {
    if (!r || !r.cell_uid) continue;
    const prev = out[r.cell_uid];
    if (!prev) {
      out[r.cell_uid] = r;
      continue;
    }
    const better =
      rank(r.status) > rank(prev.status) ||
      (rank(r.status) === rank(prev.status) && finishedMs(r) >= finishedMs(prev));
    if (better) out[r.cell_uid] = r;
  }
  return out;
}

/**
 * Latest render record per cell uid, by RECENCY ALONE — finished_at (or,
 * lacking that, started_at) most-recent wins; among ties, or when neither
 * timestamp parses, the later list-position wins. NEVER ranks by status, so
 * a cell that failed after an earlier success reports the FAILED record here,
 * unlike `recordByUid` above.
 *
 * Mirrors the recency rule `lib/canvas-model.ts`'s `doneRecordIdByUid` uses
 * (most-recent-finished-wins, `>=` so a tie favours the later list entry) —
 * reimplemented rather than imported because that module filters to `done`
 * records only and keeps its timestamp helper (`recordTimeMs`) private, and
 * the banner below needs every status, failed included.
 *
 * Fixes G-106: the "N / M rendered" banner was built on `recordByUid`'s
 * best-EVER-status pick, so a cell that failed after once succeeding kept
 * reporting its old `done` record and the banner could never show a
 * regression. This reports what the cell's MOST RECENT render attempt
 * actually did.
 */
export function latestRecordByUid(records: RenderRecord[]): Record<string, RenderRecord> {
  const out: Record<string, RenderRecord> = {};
  const bestT: Record<string, number> = {};
  for (const r of records) {
    if (!r || !r.cell_uid) continue;
    const v = r.finished_at ?? r.started_at;
    const t = v ? Date.parse(v) : NaN;
    const tm = Number.isFinite(t) ? t : 0;
    const prev = bestT[r.cell_uid];
    if (prev === undefined || tm >= prev) {
      bestT[r.cell_uid] = tm;
      out[r.cell_uid] = r;
    }
  }
  return out;
}

/** Counts backing the Composition "N / M rendered" banner (G-106): how many
 *  cells' LATEST render attempt is done, and how many are failed — never a
 *  best-ever-status pick. `latestByUid` should come from `latestRecordByUid`
 *  above; `clips` supplies the fallback `status` (itself `foldRenderStatus`'d,
 *  active-over-terminal) for a cell with no render record at all yet. */
export interface RenderCounts {
  rendered: number;
  failed: number;
  total: number;
}

export function renderCounts(
  clips: readonly { uid: string; status?: RenderStatus }[],
  latestByUid: Record<string, RenderRecord>,
): RenderCounts {
  let rendered = 0;
  let failed = 0;
  for (const c of clips) {
    const st = latestByUid[c.uid]?.status ?? c.status;
    if (st === 'done') rendered += 1;
    else if (st === 'failed') failed += 1;
  }
  return { rendered, failed, total: clips.length };
}

/** Copy text to the clipboard, with an execCommand fallback for the sandboxed
 *  srcdoc pane where navigator.clipboard may be unavailable. Resolves to
 *  whether the copy succeeded. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** base64 → Blob (for bytes-over-bridge → objectURL playback). */
export function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'video/mp4' });
}
