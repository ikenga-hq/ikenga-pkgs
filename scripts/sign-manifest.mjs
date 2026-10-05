#!/usr/bin/env node
/**
 * Manifest signing — the WP-06 half of the ADR-017 trusted-pkg signature chain.
 *
 * This module reproduces, in JavaScript, the EXACT canonical bytes the Rust
 * verifier (`shell/src-tauri/src/pkg/signature.rs`) derives from a manifest, and
 * produces a `minisign` signature over those bytes that the verifier accepts.
 * It is the signing counterpart to that verifier: the two sides MUST agree
 * byte-for-byte or every signed manifest silently fails verification and drops
 * to untrusted (Community tier).
 *
 * # CANONICAL MANIFEST JSON v1 — MUST match pkg/signature.rs byte-for-byte
 *
 * The authoritative algorithm lives in the `pkg/signature.rs` module
 * doc-comment ("CANONICAL MANIFEST JSON v1"). Reproduced here so this file is
 * self-contained:
 *
 *   1. Parse manifest.json → a JSON value.
 *   2. Remove the top-level `signature` field (a signature cannot sign over
 *      itself). Unconditional — present or absent, the result has no
 *      `signature` key.
 *   3. Recursively sort every object's keys in ascending byte order of the
 *      UTF-8 key string.
 *   4. Serialize compact: no insignificant whitespace, `,` and `:` separators
 *      only.
 *   5. UTF-8 output, standard JSON string escaping (only `"`, `\`, and the C0
 *      control chars are escaped; non-ASCII is emitted as raw UTF-8 bytes, not
 *      `\u` escapes). No trailing newline.
 *
 * Array element order is preserved (arrays are ordered data). Manifests carry
 * only strings, bools, integers, arrays, and objects — no floats — so there is
 * no float-formatting ambiguity. `JSON.stringify` of a pre-sorted, sig-stripped
 * value tree gives compact separators, raw-UTF-8 escaping, and no trailing
 * newline — identical to serde_json's default `to_vec`. The recursive
 * pre-sort + sig-strip in `canonicalizeValue` supplies steps 2–3; `JSON.stringify`
 * supplies steps 4–5.
 *
 * The shared golden vector lives in the SHELL repo at
 * `shell/src-tauri/src/pkg/testdata/signature_golden_v1/`. `sign-manifest.test.mjs`
 * asserts `canonicalManifestBytes(golden manifest.json) === golden canonical.json`
 * byte-for-byte — that test is the cross-language agreement gate. The golden
 * vector is WP-02's FROZEN contract; never regenerate it from this side. If the
 * canonicalizer here disagrees with it, THIS canonicalizer is wrong.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Recursively rebuild a JSON value with sorted object keys, stripping the
 * top-level `signature` field. Mirrors `canonicalize_value` in signature.rs.
 *
 * `Object.keys(...).sort()` sorts by UTF-16 code-unit order, which for the
 * BMP-only ASCII key strings that appear in manifests is identical to the byte
 * order serde_json's `BTreeMap` uses. Manifest keys are ASCII identifiers
 * (`id`, `urlPattern`, `vault.keys`, …), so this is exact for the value space.
 *
 * @param {unknown} value
 * @param {boolean} isRoot
 * @returns {unknown}
 */
export function canonicalizeValue(value, isRoot) {
  if (Array.isArray(value)) {
    return value.map((v) => canonicalizeValue(v, false));
  }
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (isRoot && key === 'signature') continue; // a signature can't sign over itself
      out[key] = canonicalizeValue(value[key], false);
    }
    return out;
  }
  // Scalars (string / bool / number / null) verbatim. Manifest numbers are
  // integers only, so JS number formatting is canonical for this value space.
  return value;
}

/**
 * Produce the CANONICAL MANIFEST JSON v1 string for a parsed manifest value.
 * Equivalent to `canonical_manifest_bytes` in signature.rs.
 *
 * @param {unknown} manifestValue  the parsed manifest object (with or without `signature`)
 * @returns {string}  the canonical JSON string (UTF-8, no trailing newline)
 */
export function canonicalManifestJson(manifestValue) {
  return JSON.stringify(canonicalizeValue(manifestValue, true));
}

/**
 * Canonicalize directly from manifest JSON text (as read from manifest.json).
 * Equivalent to `canonical_manifest_bytes_from_str` in signature.rs.
 *
 * @param {string} manifestJson
 * @returns {string}
 */
export function canonicalManifestJsonFromString(manifestJson) {
  return canonicalManifestJson(JSON.parse(manifestJson));
}

/**
 * Sign a manifest's canonical bytes with a minisign secret key, returning the
 * full 4-line `.minisig` blob — exactly what goes into the manifest's top-level
 * `signature` string field and what `signature.rs::verify_signature_blob`
 * consumes.
 *
 * Uses the real `minisign` binary (already on PATH in the release workflow, same
 * one that signs the registry index) in its default prehashed/BLAKE2b mode —
 * the verifier runs `pk.verify(..., allow_legacy = false)`, which requires that
 * mode. We sign the CANONICAL bytes (never the raw manifest, never the tarball).
 *
 * @param {unknown} manifestValue   the parsed manifest object
 * @param {string}  secretKeyPem     the minisign secret key file CONTENTS
 * @param {string=} secretKeyPassword optional password; '' if the key is unencrypted (`-W`-generated)
 * @returns {string}  the `.minisig` blob (4 lines, no trailing-newline guarantee on the return)
 */
export function signManifest(manifestValue, secretKeyPem, secretKeyPassword = '') {
  const canonical = canonicalManifestJson(manifestValue);
  const dir = mkdtempSync(join(tmpdir(), 'ikenga-sign-'));
  try {
    const keyPath = join(dir, 'publisher.key');
    const dataPath = join(dir, 'canonical_bytes.txt');
    const sigPath = join(dir, 'manifest.minisig');
    writeFileSync(keyPath, secretKeyPem);
    // minisign wants the secret key mode 600.
    execFileSync('chmod', ['600', keyPath]);
    // Canonical bytes EXACTLY — no trailing newline (matches the golden vector).
    writeFileSync(dataPath, canonical);
    // `-S` sign, `-m` message file, `-s` secret key, `-x` output sig path.
    // Password on stdin so it never lands in argv / process listing. An
    // unencrypted (`-W`) key never prompts, and minisign may exit before
    // reading stdin, so writing an empty line there races into EPIPE —
    // only open a stdin pipe when there is a password to send.
    execFileSync('minisign', ['-S', '-s', keyPath, '-m', dataPath, '-x', sigPath], {
      ...(secretKeyPassword ? { input: `${secretKeyPassword}\n` } : {}),
      stdio: [secretKeyPassword ? 'pipe' : 'ignore', 'ignore', 'inherit'],
    });
    return readFileSync(sigPath, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Embed a signature blob into a manifest object's top-level `signature` field,
 * returning a NEW object (does not mutate the input). The signature is the
 * whole `.minisig` blob — `signature.rs` parses it with `Signature::decode`.
 *
 * @param {Record<string, unknown>} manifest
 * @param {string} signatureBlob
 * @returns {Record<string, unknown>}
 */
export function embedSignature(manifest, signatureBlob) {
  return { ...manifest, signature: signatureBlob };
}

/**
 * Extract the bare base64 payload line from a minisign `.pub` file's CONTENTS —
 * the value that goes into the signed index entry's `publisherKey` and which the
 * shell threads into `InstallSource::Registry.publisher_key`.
 *
 * A `.pub` is 2 lines: `untrusted comment: ...` then the base64 payload. The
 * Rust verifier accepts both the 2-line form and the bare payload; the index
 * carries the bare payload (compact + unambiguous).
 *
 * @param {string} pubFileContents
 * @returns {string}
 */
export function publisherKeyFromPub(pubFileContents) {
  const line = pubFileContents
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('untrusted comment:'));
  if (!line) throw new Error('sign-manifest: no base64 payload line found in publisher .pub');
  return line;
}
