/**
 * akuko — network probe: can this machine reach a provider's API host?
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/probe.ts <provider id>... [--json] [--timeout <ms>]
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/probe.ts --all
 *
 * Free and keyless: one GET per provider to the `network.probe` url in
 * providers/config.json (a models list or a task that does not exist), with
 * no key, no body and no paid endpoint. Any HTTP answer, even 401 or 404,
 * means the host is reachable; a network error or a timeout means it is not.
 *
 * Why: claude.ai's code workspace reaches the internet only as far as the
 * person's settings allow (Settings, code execution network access). Run this
 * BEFORE asking for a key on host A (lib/spend.md R-11): if it is blocked,
 * tell the person which domains to allow and stop. It works on every host,
 * and `doctor --probe` runs it for every keyed provider.
 *
 * No dependencies (reads config.json directly), so it runs from an installed
 * skill with no node_modules. Exit 0 when every probed host is reachable, 1
 * when one is blocked, 2 on a usage error.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface NetworkEntry { probe: string; domains: string[]; note?: string }
interface ConfigDoc { providers: Record<string, { label?: string; billing?: string; example?: boolean; network?: NetworkEntry }> }

export interface ProbeResult {
  provider: string;
  url: string;
  reachable: boolean;
  /** HTTP status when an answer came back. */
  status?: number;
  /** Why it is not reachable (network error, timeout, a proxy refusal). */
  reason?: string;
  /** Domains to allow (API host first). */
  domains: string[];
  note?: string;
}

export const CONFIG_URL = new URL('../providers/config.json', import.meta.url);
export const readConfig = (): ConfigDoc => JSON.parse(readFileSync(CONFIG_URL, 'utf8')) as ConfigDoc;

/** Provider ids that have a network entry: the paid, real ones. */
export const probeableProviders = (c: ConfigDoc): string[] =>
  Object.entries(c.providers).filter(([, p]) => p.network && p.billing !== 'free' && !p.example).map(([id]) => id);

/** A proxy that refuses a host answers with its own page, not the provider's; these words mark one (best effort). */
const PROXY_REFUSAL = /host[_ ]not[_ ]allowed|not (in|on) (the )?allow ?list|egress|blocked by (the )?(network|proxy|policy)|domain is not allowed/i;

export async function probeProvider(
  provider: string,
  opts: { config?: ConfigDoc; fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const c = opts.config ?? readConfig();
  const net = c.providers[provider]?.network;
  if (!net) throw new Error(`provider "${provider}" has no network entry in providers/config.json`);
  const base = { provider, url: net.probe, domains: net.domains, ...(net.note ? { note: net.note } : {}) };
  const f = opts.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  try {
    // No key, no body, no redirect followed: nothing here can be billed.
    const res = await f(net.probe, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'akuko-probe' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    let text = '';
    try { text = (await res.text()).slice(0, 2000); } catch { /* the status is enough */ }
    const proxy = (res.status === 403 || res.status === 407) && (PROXY_REFUSAL.test(text) || res.headers.has('x-deny-reason'));
    if (proxy) return { ...base, reachable: false, status: res.status, reason: `a network proxy refused the host (HTTP ${res.status})` };
    return { ...base, reachable: true, status: res.status };
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const reason = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : e.cause?.code ?? e.cause?.message ?? e.message ?? String(err);
    return { ...base, reachable: false, reason };
  }
}

/** One line per result; for a blocked host, what to allow and where. */
export function formatProbe(r: ProbeResult): string[] {
  const host = new URL(r.url).host;
  if (r.reachable) return [`  ${r.provider.padEnd(16)} ${host}: reachable (HTTP ${r.status}, no key sent)`];
  return [
    `  ${r.provider.padEnd(16)} ${host}: BLOCKED (${r.reason})`,
    `    allow these domains: ${r.domains.join(', ')}`,
    '    on claude.ai: Settings, then the code execution and network access setting; add the domains (or allow all), then start a new chat or retry.',
    ...(r.note ? [`    note: ${r.note}`] : []),
  ];
}

export async function run(argv: string[], deps: { fetch?: typeof globalThis.fetch; out?: (l: string) => void; config?: ConfigDoc } = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const config = deps.config ?? readConfig();
  const json = argv.includes('--json');
  const ti = argv.indexOf('--timeout');
  const timeoutMs = ti >= 0 ? Number(argv[ti + 1]) : undefined;
  if (timeoutMs !== undefined && !(timeoutMs > 0)) { out('akuko: --timeout takes milliseconds, e.g. --timeout 8000'); return 2; }
  const named = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--timeout');
  const ids = argv.includes('--all') ? probeableProviders(config) : named;
  if (ids.length === 0) { out(`akuko: name a provider (${probeableProviders(config).join(', ')}) or pass --all.`); return 2; }
  const unknown = ids.filter((id) => !config.providers[id]?.network);
  if (unknown.length) { out(`akuko: no network entry for ${unknown.join(', ')} (known: ${probeableProviders(config).join(', ')}).`); return 2; }
  const results: ProbeResult[] = [];
  for (const id of ids) results.push(await probeProvider(id, { config, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(timeoutMs ? { timeoutMs } : {}) }));
  if (json) out(JSON.stringify(results, null, 2));
  else {
    out('network probe (a keyless GET, nothing billed):');
    for (const r of results) for (const l of formatProbe(r)) out(l);
  }
  return results.every((r) => r.reachable) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
