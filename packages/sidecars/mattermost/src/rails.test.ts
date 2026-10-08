import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog, AuditUnavailableError } from './audit.js';
import type { AuditRecord } from './audit.js';
import { ModeRailError, Rails, modeRank, resolveBranchPrefix, resolveModeRails } from './rails.js';
import type { WireMode } from './rails.js';
import { resolveBridgeConfigs } from './config.js';

const WHERE = "bot 'rex'";
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'mm-b5-rails-'));
  file = path.join(dir, 'audit-rex.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const recs = () =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditRecord);
const rails = (maxMode: WireMode, over: Partial<ConstructorParameters<typeof Rails>[0]> = {}) =>
  new Rails({ bot: 'rex', maxMode, threadMode: 'plan', audit: new AuditLog({ file, bot: 'rex', log: () => undefined }), ...over });

describe('modeRank', () => {
  it('orders plan < default < auto < bypassPermissions; no mode is the daemon default; unknown is above everything', () => {
    assert.ok(modeRank('plan') < modeRank('default'));
    assert.ok(modeRank('default') < modeRank('auto'));
    assert.ok(modeRank('auto') < modeRank('bypassPermissions'));
    assert.equal(modeRank(undefined), modeRank('default'));
    assert.ok(modeRank('yolo') > modeRank('bypassPermissions'));
  });
});

describe('resolveModeRails (refused at config load)', () => {
  it('defaults maxMode to plan and the thread mode to plan', () => {
    assert.deepEqual(resolveModeRails({ chi: {} }, WHERE), { maxMode: 'plan', threadMode: 'plan', actingMode: undefined });
  });

  it('accepts plan | acceptEdits | bypassPermissions (and the daemon id `auto`), and refuses anything else', () => {
    assert.equal(resolveModeRails({ maxMode: 'acceptEdits' }, WHERE).maxMode, 'auto');
    assert.equal(resolveModeRails({ maxMode: 'auto' }, WHERE).maxMode, 'auto');
    assert.equal(resolveModeRails({ maxMode: 'bypassPermissions' }, WHERE).maxMode, 'bypassPermissions');
    for (const bad of ['default', 'yolo', '', 'PLAN']) {
      assert.throws(() => resolveModeRails({ maxMode: bad }, WHERE), /bot 'rex': maxMode must be one of plan, acceptEdits, bypassPermissions/);
    }
  });

  it('refuses chi.mode above the ceiling instead of downgrading it, and says what to set', () => {
    assert.throws(
      () => resolveModeRails({ chi: { mode: 'bypassPermissions' } }, WHERE),
      /bot 'rex': chi.mode 'bypassPermissions' is above this bot's ceiling: maxMode is 'plan' \(the default.*set maxMode/,
    );
    assert.throws(() => resolveModeRails({ maxMode: 'acceptEdits', chi: { mode: 'bypassPermissions' } }, WHERE), /above this bot's ceiling: maxMode is 'auto'/);
    assert.throws(() => resolveModeRails({ chi: { mode: 'default' } }, WHERE), /chi.mode 'default' is above/);
    assert.equal(resolveModeRails({ maxMode: 'bypassPermissions', chi: { mode: 'bypassPermissions' } }, WHERE).threadMode, 'bypassPermissions');
  });

  it('turns chi.mode acceptEdits into the id the daemon understands, and refuses a mode the daemon would silently remap', () => {
    assert.equal(resolveModeRails({ maxMode: 'acceptEdits', chi: { mode: 'acceptEdits' } }, WHERE).threadMode, 'auto');
    assert.throws(() => resolveModeRails({ maxMode: 'bypassPermissions', chi: { mode: 'yolo' } }, WHERE), /not a mode the daemon knows/);
  });

  it('refuses approvals.actingMode above the ceiling: any approvals block needs maxMode raised', () => {
    assert.throws(() => resolveModeRails({ approvals: {} }, WHERE), /approvals.actingMode 'auto' is above this bot's ceiling: maxMode is 'plan'/);
    assert.throws(() => resolveModeRails({ maxMode: 'acceptEdits', approvals: { actingMode: 'bypassPermissions' } }, WHERE), /actingMode 'bypassPermissions' is above/);
    assert.deepEqual(resolveModeRails({ maxMode: 'acceptEdits', approvals: {} }, WHERE), { maxMode: 'auto', threadMode: 'plan', actingMode: 'auto' });
  });

  it('is applied when the config file loads (this is the behaviour change for B3 configs)', () => {
    process.env.TEST_MM_B5_TOK = 'tok';
    try {
      const bot = (over: object) => ({
        mattermostToken: { env: 'TEST_MM_B5_TOK' },
        allowedUsers: ['alice'],
        allowedChannels: ['eng'],
        daemon: { url: 'http://d', auth: { kind: 'bearer' as const, token: { env: 'TEST_MM_B5_TOK' } } },
        chi: { engine: 'claude-code' },
        ...over,
      });
      const load = (b: object) => resolveBridgeConfigs({ mattermostUrl: 'http://mm', bots: { rex: b as never } });
      assert.throws(() => load(bot({ approvals: { approvers: ['alice'] } })), /bot 'rex': approvals.actingMode 'auto' is above this bot's ceiling/);
      assert.throws(() => load(bot({ chi: { engine: 'claude-code', mode: 'auto' } })), /bot 'rex': chi.mode 'auto' is above/);
      assert.throws(() => load(bot({ maxMode: 'plan', approvals: { approvers: ['alice'], actingMode: 'bypassPermissions' } })), /above this bot's ceiling/);
      assert.throws(() => load(bot({ maxMode: 'acceptEdits', approvals: { approvers: ['alice'], actingMode: 'bypassPermissions' } })), /above this bot's ceiling/);
      const [ok] = load(bot({ maxMode: 'acceptEdits', branchPrefix: 'rex/', approvals: { approvers: ['alice'] } }));
      assert.equal(ok?.maxMode, 'acceptEdits');
      assert.equal(ok?.branchPrefix, 'rex/');
      assert.throws(() => load(bot({ branchPrefix: 'Rex' })), /branchPrefix must look like 'rex\/'/);
      assert.throws(() => load(bot({ audit: { channel: 'eng' } })), /write-only/);
    } finally {
      delete process.env.TEST_MM_B5_TOK;
    }
  });
});

describe('resolveBranchPrefix', () => {
  it('accepts `rex/` shapes and refuses the rest', () => {
    assert.equal(resolveBranchPrefix(undefined, WHERE), undefined);
    assert.equal(resolveBranchPrefix('rex/', WHERE), 'rex/');
    for (const bad of ['rex', '/rex/', 'Rex/', 'rex /', '../', '', 'agents/rex/']) {
      assert.throws(() => resolveBranchPrefix(bad, WHERE), /branchPrefix must look like/);
    }
  });
});

describe('Rails.authorizeRun (the runtime assertion, at every call site)', () => {
  it('refuses a mode above maxMode: ModeRailError, a run.refused record, no *.requested record', () => {
    const r = rails('plan');
    for (const kind of ['thread', 'resume', 'act', 'schedule'] as const) {
      assert.throws(
        () => r.authorizeRun({ kind, mode: 'auto', fields: { thread_root: 't1' } }),
        (e: unknown) => e instanceof ModeRailError && /may run in plan mode at most.*asked for auto \(acceptEdits\)/.test((e as Error).message),
      );
    }
    const all = recs();
    assert.equal(all.length, 4);
    assert.ok(all.every((x) => x.event === 'run.refused' && x.reason === 'mode_exceeds_max' && x.requested_mode === 'auto' && x.max_mode === 'plan'));
    assert.deepEqual(all.map((x) => x.kind), ['thread', 'resume', 'act', 'schedule']);
  });

  it('a resume with no stored mode counts as the daemon default and is refused under plan', () => {
    assert.throws(() => rails('plan').authorizeRun({ kind: 'resume', mode: undefined, fields: {} }), ModeRailError);
    assert.doesNotThrow(() => rails('auto').authorizeRun({ kind: 'resume', mode: undefined, fields: {} }));
  });

  it('allows a mode at or below the ceiling and records *.requested BEFORE returning (schedule has its own event)', () => {
    const r = rails('auto');
    const a = r.authorizeRun({ kind: 'thread', mode: 'plan', fields: { thread_root: 't1', user_id: 'u1' } });
    const b = r.authorizeRun({ kind: 'act', mode: 'auto', fields: { thread_root: 't1' } });
    const c = r.authorizeRun({ kind: 'schedule', mode: 'plan', fields: { schedule: 'standup' } });
    assert.equal(new Set([a, b, c]).size, 3);
    const all = recs();
    assert.deepEqual(all.map((x) => x.event), ['run.requested', 'run.requested', 'schedule.requested']);
    assert.deepEqual(all.map((x) => x.request_id), [a, b, c]);
    assert.equal(all[1]?.mode, 'auto');
    assert.equal(all[0]?.max_mode, 'auto');
  });

  it('bypassPermissions is refused under acceptEdits, allowed under bypassPermissions', () => {
    assert.throws(() => rails('auto').authorizeRun({ kind: 'act', mode: 'bypassPermissions', fields: {} }), ModeRailError);
    assert.doesNotThrow(() => rails('bypassPermissions').authorizeRun({ kind: 'act', mode: 'bypassPermissions', fields: {} }));
  });

  it('an unknown mode is above every ceiling', () => {
    assert.throws(() => rails('bypassPermissions').authorizeRun({ kind: 'thread', mode: 'yolo', fields: {} }), ModeRailError);
  });

  it('fails closed when the audit log cannot be written: AuditUnavailableError and nothing recorded', () => {
    mkdirSync(file); // a directory where the log should be
    const r = rails('auto');
    assert.throws(
      () => r.authorizeRun({ kind: 'thread', mode: 'plan', fields: {} }),
      (e: unknown) => e instanceof AuditUnavailableError && /will not start a run that nobody could account for/.test((e as Error).message),
    );
  });

  it('prompt hash is off by default, and when on is a truncated hash plus a length, never the text', () => {
    assert.deepEqual(rails('plan').promptFields('deploy the thing to prod'), {});
    const f = rails('plan', { promptHash: true }).promptFields('deploy the thing to prod');
    assert.match(String(f.prompt_sha), /^[0-9a-f]{16}$/);
    assert.equal(f.prompt_len, 24);
  });
});

describe('branch note (advisory)', () => {
  it('is empty without a prefix and names the prefix with one', () => {
    assert.equal(rails('auto').branchNote(), '');
    const note = rails('auto', { branchPrefix: 'rex/' }).branchNote();
    assert.match(note, /branches whose names start with `rex\/`/);
    assert.match(note, /Never commit to or push main/);
  });
});
