import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVALS_CONTRACT_VERSION, NotApprovableError, canonicalDraftHash, canonicalHashInput, canonicalize, isPayloadHash } from './draft-hash.js';
import type { DraftRowForHash, SendEnv } from './draft-hash.js';

/**
 * The bridge's hash against the contract's shared vectors (royalti-co `scripts/cron/docs/approvals-contract-vectors.json`,
 * pinned at 71fef38f, contract v1). Each vector is `{name, about, row, env, canonical, sha256}`: building H from `row` +
 * `env` must serialize to exactly `canonical`, and its SHA-256 must be `sha256`.
 */
interface Vector {
  name: string;
  about: string;
  row: DraftRowForHash;
  env: SendEnv;
  canonical: string;
  sha256: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const file = JSON.parse(readFileSync(path.join(here, 'fixtures', 'approvals-contract-vectors.json'), 'utf8')) as { contract: number; vectors: Vector[] };

describe('approvals contract vectors', () => {
  it('are the contract version this implementation targets, and all nine are present', () => {
    assert.equal(file.contract, APPROVALS_CONTRACT_VERSION);
    assert.deepEqual(
      file.vectors.map((v) => v.name),
      [
        'smtp-ruby-reply',
        'smtp-ruby-reply-edited-subject-body',
        'smtp-ruby-reply-edited-recipients',
        'smtp-ruby-reply-recipient-changed-in-payload',
        'smtp-from-identity-changed',
        'unicode-escapes-and-key-order',
        'listmonk-default-template',
        'buffer-thread',
        'unwrapped-payload',
      ],
    );
  });

  for (const v of file.vectors) {
    it(`${v.name}: canonical text and SHA-256 match`, () => {
      const canonical = canonicalize(canonicalHashInput(v.row, v.env));
      assert.equal(canonical, v.canonical);
      assert.equal(createHash('sha256').update(canonical, 'utf8').digest('hex'), v.sha256);
      assert.equal(canonicalDraftHash(v.row, v.env), v.sha256);
      assert.ok(isPayloadHash(v.sha256));
    });
  }

  it('the worked example in the contract (smtp-ruby-reply) is 7ef7b6c4...ab28', () => {
    const v = file.vectors.find((x) => x.name === 'smtp-ruby-reply') as Vector;
    assert.equal(canonicalDraftHash(v.row, v.env), '7ef7b6c4eef08fde8fa02fc7901227ba949c8d8f64c698fbd2b5eaff1ff3ab28');
  });
});

describe('what is not approvable', () => {
  const row = (payload: string, edited: string | null = null): DraftRowForHash => ({ id: 'd', channel: 'resend', payload_json: payload, edited_json: edited, scheduled_at: null });

  it('refuses a payload that is not valid JSON or not an object', () => {
    assert.throws(() => canonicalDraftHash(row('{nope')), NotApprovableError);
    assert.throws(() => canonicalDraftHash(row('[1,2]')), NotApprovableError);
    assert.throws(() => canonicalDraftHash(row('"text"')), NotApprovableError);
  });

  it('refuses numbers outside the contract (non-integers, exponents past 2^53, non-finite)', () => {
    assert.throws(() => canonicalDraftHash(row('{"item":{"n":1.5}}')), NotApprovableError);
    assert.throws(() => canonicalDraftHash(row('{"item":{"n":9007199254740993}}')), NotApprovableError);
    assert.throws(() => canonicalDraftHash(row('{"item":{"n":1e999}}')), NotApprovableError);
    assert.doesNotThrow(() => canonicalDraftHash(row('{"item":{"n":9007199254740991}}')));
  });

  it('omits `edited` when edited_json is empty or not valid JSON, and the last duplicate key wins', () => {
    const plain = canonicalDraftHash(row('{"item":{"a":1}}'));
    assert.equal(canonicalDraftHash(row('{"item":{"a":1}}', '')), plain);
    assert.equal(canonicalDraftHash(row('{"item":{"a":1}}', '{broken')), plain);
    assert.notEqual(canonicalDraftHash(row('{"item":{"a":1}}', '{"subject":"x"}')), plain);
    assert.equal(canonicalDraftHash(row('{"item":{"a":0,"a":1}}')), plain);
  });
});
