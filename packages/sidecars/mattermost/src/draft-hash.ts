import { createHash } from 'node:crypto';

/**
 * The approvals contract's canonical draft hash (contract v1, section 3), as the Mattermost bridge implements it.
 *
 * The bridge does NOT use this to decide what to approve at run time: it holds neither the draft row nor the sender's
 * credential environment (the send-time identity, 3.3), so it approves the hash the SENDER announced for the text the
 * approver was shown (contract 3.3, 4.2). This module exists so the bridge can prove it computes the same value as the
 * sender: `draft-hash.test.ts` re-computes every vector of the contract's `approvals-contract-vectors.json`
 * (pinned at royalti-co 71fef38f, copied to `src/fixtures/`). A change to the contract that alters a hash bumps the
 * contract version and the vectors, and this file follows.
 */

export const APPROVALS_CONTRACT_VERSION = 1;

/** The slice of a `pa_action_drafts` row that the hash covers (and nothing else: not status, attempts, timestamps). */
export interface DraftRowForHash {
  id: string;
  channel: string;
  payload_json: string;
  edited_json?: string | null;
  scheduled_at?: string | null;
}

/** The sender's credential environment, as far as the send-time identity reads it. */
export type SendEnv = Record<string, string | undefined>;

/** The row cannot be canonicalized (contract 3.2 / 3.4 rule 4): it is not approvable and must never be approved. */
export class NotApprovableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotApprovableError';
  }
}

/**
 * Contract 3.4: JSON text without insignificant whitespace, object members sorted by UTF-16 code unit (the default
 * `Array.sort` on strings), safe integers only. String escaping is `JSON.stringify`'s, which is what the contract
 * specifies (lone surrogates as lowercase `\udxxx`, everything else raw).
 */
export function canonicalize(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new NotApprovableError(`number ${String(value)} is outside the canonical contract (safe integers only)`);
    }
    return JSON.stringify(value); // -0 is 0
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

type Item = Record<string, unknown>;

/** Contract 3.3: values the adapters read from the sender's credentials at send time, folded into the hash. */
export function deriveSendIdentity(channel: string, item: Item, env: SendEnv = {}): Record<string, string> {
  switch (channel) {
    case 'smtp':
      return { smtpFrom: env.RUBY_IMAP_USER ?? '' };
    case 'listmonk':
      return { listmonkTemplateId: env.LISTMONK_TEMPLATE_ID ? env.LISTMONK_TEMPLATE_ID : '1' };
    case 'buffer':
      return item.channelId
        ? { bufferChannelId: String(item.channelId) }
        : { bufferChannelLookupByRecipientName: String(item.recipient ?? '') };
    default:
      return {};
  }
}

/** Contract 3.2: the document `H` that is hashed. Throws `NotApprovableError` for a row that cannot be approved. */
export function canonicalHashInput(row: DraftRowForHash, env: SendEnv = {}): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    throw new NotApprovableError('payload_json is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NotApprovableError('payload_json is not an object');
  }
  const wrapped = parsed as { item?: unknown };
  const payload = (wrapped.item ? wrapped.item : parsed) as Item;

  let edited: unknown;
  if (row.edited_json) {
    try {
      edited = JSON.parse(row.edited_json);
    } catch {
      edited = undefined; // not valid JSON: the key is omitted
    }
  }
  return {
    draftId: row.id,
    payload,
    edited, // undefined is dropped by `canonicalize`
    scheduledAt: row.scheduled_at ?? null,
    channel: row.channel,
    sendIdentity: deriveSendIdentity(row.channel, payload, env),
  };
}

/** `lowercase_hex(SHA-256(UTF-8 bytes of canonical(H)))`. */
export function canonicalDraftHash(row: DraftRowForHash, env: SendEnv = {}): string {
  return createHash('sha256').update(canonicalize(canonicalHashInput(row, env)), 'utf8').digest('hex');
}

export const isPayloadHash = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
