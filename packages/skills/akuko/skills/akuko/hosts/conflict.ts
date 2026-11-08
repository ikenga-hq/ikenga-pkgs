/**
 * akuko — the error a host's `writeState` throws when the project changed
 * since that host last read or wrote it (another akuko process, an editor).
 * Nothing was written. The spend gate catches it by `code` and redoes its
 * read → check → write from a fresh read (spend/gate.ts#locked), so two
 * processes cannot overrun the cap or lose each other's ledger entries.
 *
 * No imports: the gate depends on this without pulling in a host.
 */

export const STATE_CONFLICT = 'AKUKO_STATE_CONFLICT' as const;

export class StateConflictError extends Error {
  override name = 'StateConflictError';
  readonly code = STATE_CONFLICT;
}

export const isStateConflict = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === STATE_CONFLICT;
