#!/usr/bin/env node
/**
 * build-plugin.mjs — build the self-contained Claude Code delivery for mcp-iyke
 * (WP-07; fixes ikenga#150).
 *
 * ikenga#150: installs that ran `dist/index.js` straight out of the package
 * died with ERR_MODULE_NOT_FOUND whenever the install location had no
 * node_modules (the server imports @modelcontextprotocol/sdk and
 * @ikenga/contract at runtime). This script bundles every dependency into one
 * ESM file, so the server needs only `node` (>=20) — no install step, no
 * node_modules, no bun.
 *
 * Emits (all under dist/, gitignored, shipped in the npm tarball):
 *
 *   dist/plugin/
 *   ├── package.json                {name, version} — index.ts reads its own
 *   │                               version via createRequire('../package.json')
 *   └── server/index.js             bun-bundled server, all deps inlined
 *   dist/iyke.mcpb                  MCPB bundle (a zip, manifest_version 0.3):
 *                                   manifest.json + the two files above. For
 *                                   Claude Desktop, and for plugins that bundle
 *                                   mcp-iyke (WP-09) via
 *                                   `"mcpServers": "./iyke.mcpb"`.
 *
 * The MCPB manifest.json is written only into a temp staging dir, never under
 * packages/: the repo's manifest tooling (validate-manifests, sign-manifests)
 * treats every packages/** /manifest.json as an Ikenga pkg manifest.
 *
 * This package's own .claude-plugin/plugin.json declares the server INLINE,
 * pointing at dist/plugin/server/index.js, rather than at the .mcpb: Claude
 * Code skips .mcpb servers in project-scope plugins (plugins/loading docs),
 * while an inline stdio entry loads in every scope. Both run the same file.
 *
 * Usage: node ./scripts/build-plugin.mjs   (run by `pnpm build`, after tsc)
 */

import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(PKG_ROOT, 'dist', 'plugin');
const MCPB = join(PKG_ROOT, 'dist', 'iyke.mcpb');
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { cwd: PKG_ROOT, stdio: 'inherit', ...opts });
	if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

rmSync(OUT, { recursive: true, force: true });
rmSync(MCPB, { force: true });
mkdirSync(join(OUT, 'server'), { recursive: true });

// 1. One self-contained ESM file. --target=node so the output runs on plain
//    node (not compiled bun — see packages/apps/studio/mcp/build.sh for why
//    stdio MCP servers avoid `bun --compile`).
const entry = join(OUT, 'server', 'index.js');
run('bun', ['build', '--target=node', '--format=esm', 'src/index.ts', '--outfile', entry]);
let code = readFileSync(entry, 'utf8');
if (!code.startsWith('#!')) code = '#!/usr/bin/env node\n' + code;
writeFileSync(entry, code);
chmodSync(entry, 0o755);

// 2. package.json beside server/ — resolves index.ts's
//    createRequire(import.meta.url)('../package.json') from server/index.js.
writeFileSync(
	join(OUT, 'package.json'),
	JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', private: true }, null, 2) + '\n',
);

// 3. MCPB manifest (https://github.com/modelcontextprotocol/mcpb, MANIFEST.md v0.3).
//    The server's name in Claude Code comes from `name` here.
const manifest = {
	manifest_version: '0.3',
	name: 'iyke',
	display_name: 'Ikenga iyke (control bridge)',
	version: pkg.version,
	description:
		'Drive a running Ikenga desktop app from Claude: state, navigation, panes, DOM, screenshots, agents.',
	author: { name: 'Royalti, Inc.', url: 'https://ikenga.dev' },
	homepage: pkg.homepage,
	repository: { type: 'git', url: 'https://github.com/ikenga-hq/ikenga-pkgs' },
	license: pkg.license,
	keywords: ['ikenga', 'iyke', 'desktop', 'control-bridge'],
	server: {
		type: 'node',
		entry_point: 'server/index.js',
		mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] },
	},
	tools_generated: false,
	compatibility: { runtimes: { node: pkg.engines?.node ?? '>=20' } },
};
const STAGE = mkdtempSync(join(tmpdir(), 'iyke-mcpb-'));
cpSync(OUT, STAGE, { recursive: true });
writeFileSync(join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// 4. Zip into the .mcpb. Fixed mtimes + -X so rebuilds of the same input are
//    byte-identical (no build time or uid/gid extra fields in the archive).
const EPOCH = new Date('2020-01-01T00:00:00Z');
(function touchAll(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) touchAll(p);
		utimesSync(p, EPOCH, EPOCH);
	}
	utimesSync(dir, EPOCH, EPOCH);
})(STAGE);
// An MCPB is a zip. Use Info-ZIP where it exists (Linux, macOS). Windows
// runners have no `zip`, which failed the v0.20.0 desktop release; Windows 10+
// ships bsdtar as System32\tar.exe, which writes zip archives. It must be the
// System32 one: Git for Windows puts GNU tar first on PATH, and GNU tar
// cannot write zip.
const MCPB_FILES = ['manifest.json', 'package.json', 'server'];
const haveZip = existsSync('/usr/bin/zip') || spawnSync('zip', ['-v']).status === 0;
const winTar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : null;
if (!haveZip && !(winTar && existsSync(winTar))) {
	throw new Error('`zip` (or, on Windows, System32\\tar.exe) is required to pack dist/iyke.mcpb');
}
try {
	if (haveZip) {
		run('zip', ['-q', '-X', '-r', MCPB, ...MCPB_FILES], { cwd: STAGE });
	} else {
		// bsdtar picks the archive format from the .zip suffix (-a).
		const asZip = MCPB.replace(/\.mcpb$/, '.zip');
		rmSync(asZip, { force: true });
		run(winTar, ['-a', '-c', '-f', asZip, ...MCPB_FILES], { cwd: STAGE });
		renameSync(asZip, MCPB);
	}
} finally {
	rmSync(STAGE, { recursive: true, force: true });
}

const kb = (p) => `${Math.round(statSync(p).size / 1024)} KB`;
console.log(`[iyke-plugin] ${kb(entry)} dist/plugin/server/index.js (self-contained)`);
console.log(`[iyke-plugin] ${kb(MCPB)} dist/iyke.mcpb (MCPB ${manifest.manifest_version}, ${pkg.version})`);
