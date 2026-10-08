import { readFileSync } from 'node:fs';

/**
 * Where a secret comes from. Config files only ever name a source; they never
 * carry the value. `{ value }` exists for programmatic use and tests.
 */
export type SecretSource = { env: string } | { file: string } | { value: string };

export function resolveSecret(source: SecretSource, what: string): string {
  let raw: string | undefined;
  if ('value' in source) {
    raw = source.value;
  } else if ('env' in source) {
    raw = process.env[source.env];
    if (raw === undefined || raw === '') {
      throw new Error(`${what}: environment variable ${source.env} is not set`);
    }
  } else {
    try {
      raw = readFileSync(source.file, 'utf8');
    } catch (err) {
      // Name the file, never its contents.
      throw new Error(`${what}: cannot read ${source.file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
  // A trailing newline from `echo secret > file` is not part of the secret.
  const value = raw.replace(/[\r\n]+$/, '');
  if (!value) throw new Error(`${what}: secret is empty`);
  return value;
}

/**
 * Replaces every known secret (and any cookie-looking `ikenga_session=...`
 * pair) in `text`. Applied to every string that can leave the daemon client:
 * error messages, log lines, and anything echoed into Mattermost.
 */
export class Redactor {
  private secrets = new Set<string>();

  add(secret: string | undefined): void {
    // A 1-3 character "secret" would shred ordinary text; refuse to track it.
    if (secret && secret.length >= 4) this.secrets.add(secret);
  }

  redact(text: string): string {
    let out = text;
    // Longest first, so a secret that contains another is replaced whole.
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(s).join('[redacted]');
    }
    return out.replace(/(ikenga_session=)[^;\s,]+/gi, '$1[redacted]');
  }
}
