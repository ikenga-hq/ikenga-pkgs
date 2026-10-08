import { describe, it, beforeEach, afterEach, after } from 'node:test';
import { sweepTmp, tmpDir } from './test-tmp.js';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog, AuditUnavailableError } from './audit.js';
import type { AuditRecord } from './audit.js';
import { ModeRailError, Rails, effectiveMode, engineEnforcesMode, isWireMode, modeRank, resolveBranchPrefix, resolveModeRails } from './rails.js';
import type { WireMode } from './rails.js';
import { resolveBridgeConfigs } from './config.js';

const WHERE = "bot 'rex'";
let dir: string;
let file: string;

beforeEach(() => {
  dir = tmpDir('mm-b5-rails-');
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
        () => r.authorizeRun({ kind, engine: 'claude-code', mode: 'auto', fields: { thread_root: 't1' } }),
        (e: unknown) => e instanceof ModeRailError && /may run in plan mode at most.*asked for auto \(acceptEdits\)/.test((e as Error).message),
      );
    }
    const all = recs();
    assert.equal(all.length, 4);
    assert.ok(all.every((x) => x.event === 'run.refused' && x.reason === 'mode_exceeds_max' && x.requested_mode === 'auto' && x.max_mode === 'plan'));
    assert.deepEqual(all.map((x) => x.kind), ['thread', 'resume', 'act', 'schedule']);
  });

  it('a resume with no stored mode counts as the daemon default and is refused under plan', () => {
    assert.throws(() => rails('plan').authorizeRun({ kind: 'resume', engine: 'claude-code', mode: undefined, fields: {} }), ModeRailError);
    assert.doesNotThrow(() => rails('auto').authorizeRun({ kind: 'resume', engine: 'claude-code', mode: undefined, fields: {} }));
  });

  it('allows a mode at or below the ceiling and records *.requested BEFORE returning (schedule has its own event)', () => {
    const r = rails('auto');
    const a = r.authorizeRun({ kind: 'thread', engine: 'claude-code', mode: 'plan', fields: { thread_root: 't1', user_id: 'u1' } });
    const b = r.authorizeRun({ kind: 'act', engine: 'claude-code', mode: 'auto', fields: { thread_root: 't1' } });
    const c = r.authorizeRun({ kind: 'schedule', engine: 'claude-code', mode: 'plan', fields: { schedule: 'standup' } });
    assert.equal(new Set([a.requestId, b.requestId, c.requestId]).size, 3);
    const all = recs();
    assert.deepEqual(all.map((x) => x.event), ['run.requested', 'run.requested', 'schedule.requested']);
    assert.deepEqual(all.map((x) => x.request_id), [a.requestId, b.requestId, c.requestId]);
    assert.equal(all[1]?.mode, 'auto');
    assert.equal(all[0]?.max_mode, 'auto');
  });

  it('bypassPermissions is refused under acceptEdits, allowed under bypassPermissions', () => {
    assert.throws(() => rails('auto').authorizeRun({ kind: 'act', engine: 'claude-code', mode: 'bypassPermissions', fields: {} }), ModeRailError);
    assert.doesNotThrow(() => rails('bypassPermissions').authorizeRun({ kind: 'act', engine: 'claude-code', mode: 'bypassPermissions', fields: {} }));
  });

  it('an unknown mode is above every ceiling', () => {
    assert.throws(() => rails('bypassPermissions').authorizeRun({ kind: 'thread', engine: 'claude-code', mode: 'yolo', fields: {} }), ModeRailError);
  });

  it('fails closed when the audit log cannot be written: AuditUnavailableError and nothing recorded', () => {
    mkdirSync(file); // a directory where the log should be
    const r = rails('auto');
    assert.throws(
      () => r.authorizeRun({ kind: 'thread', engine: 'claude-code', mode: 'plan', fields: {} }),
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

// ── B1: a mode only binds on an engine the daemon maps it for ────────────────

/** Names that a plain-object lookup would answer for, and that the daemon and the config must treat as unknown. */
const PROTO_NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];
/** Engines the daemon gives no permission argument (or passes a raw string to), and names it does not know. */
const NON_ENFORCING = ['pi', 'opencode', 'codex', 'antigravity-cli', 'cursor-agent', 'claude', 'Claude-Code', 'claude-code ', ''];

describe('engineEnforcesMode / effectiveMode', () => {
  it('only claude-code enforces a mode; every other engine, a near miss and an unknown engine are unrestricted', () => {
    assert.equal(engineEnforcesMode('claude-code'), true);
    for (const e of [...NON_ENFORCING, ...PROTO_NAMES, undefined, null, 7]) assert.equal(engineEnforcesMode(e), false, String(e));
    assert.equal(effectiveMode('claude-code', 'plan'), 'plan');
    assert.equal(effectiveMode('claude-code', 'auto'), 'auto');
    assert.equal(effectiveMode('claude-code', undefined), 'default');
    for (const e of ['pi', 'opencode', 'codex', 'antigravity-cli', undefined]) {
      assert.equal(effectiveMode(e, 'plan'), 'bypassPermissions', `plan on ${e} is not plan`);
      assert.equal(effectiveMode(e, undefined), 'bypassPermissions');
    }
  });
});

describe('B1 config load: an engine that ignores modes needs maxMode bypassPermissions', () => {
  it('chi.engine: refused under maxMode plan and acceptEdits, allowed under bypassPermissions; claude-code is fine everywhere', () => {
    for (const engine of ['pi', 'opencode', 'codex', 'antigravity-cli']) {
      for (const maxMode of [undefined, 'plan', 'acceptEdits']) {
        assert.throws(
          () => resolveModeRails({ maxMode, chi: { engine } }, WHERE),
          (e: unknown) =>
            e instanceof Error &&
            e.message.includes("bot 'rex': chi.engine '" + engine + "' does not enforce permission modes") &&
            /effectively bypassPermissions/.test(e.message) &&
            /set maxMode/.test(e.message),
          `${engine} under maxMode ${maxMode}`,
        );
      }
      assert.doesNotThrow(() => resolveModeRails({ maxMode: 'bypassPermissions', chi: { engine } }, WHERE));
    }
    for (const maxMode of [undefined, 'plan', 'acceptEdits', 'bypassPermissions']) {
      assert.doesNotThrow(() => resolveModeRails({ maxMode, chi: { engine: 'claude-code' } }, WHERE));
    }
  });

  it('a near-miss spelling of claude-code is an unknown engine to the daemon, so it is refused too', () => {
    for (const engine of ['Claude-Code', 'claude', ' claude-code', 'claude-code ']) {
      assert.throws(() => resolveModeRails({ chi: { engine } }, WHERE), /does not enforce permission modes/, JSON.stringify(engine));
    }
  });

  it('schedules[].engine overrides are held to the ceiling, naming the schedule', () => {
    assert.throws(
      () => resolveModeRails({ maxMode: 'plan', chi: { engine: 'claude-code' }, schedules: [{ name: 'standup', engine: 'opencode' }] }, WHERE),
      /bot 'rex': schedule 'standup' engine 'opencode' does not enforce permission modes/,
    );
    assert.throws(
      () => resolveModeRails({ maxMode: 'acceptEdits', chi: { engine: 'claude-code' }, schedules: [{ name: 'a', engine: 'claude-code' }, { name: 'b', engine: 'pi' }] }, WHERE),
      /schedule 'b' engine 'pi'/,
    );
    assert.doesNotThrow(() => resolveModeRails({ maxMode: 'plan', chi: { engine: 'claude-code' }, schedules: [{ name: 'a', engine: 'claude-code' }, { name: 'b' }] }, WHERE));
    assert.doesNotThrow(() => resolveModeRails({ maxMode: 'bypassPermissions', chi: { engine: 'claude-code' }, schedules: [{ name: 'a', engine: 'opencode' }] }, WHERE));
  });

  it('is applied by the config file loader, for chi.engine and for a schedule engine', () => {
    process.env.TEST_MM_B5_TOK2 = 'tok';
    try {
      const bot = (over: object) => ({
        mattermostToken: { env: 'TEST_MM_B5_TOK2' },
        allowedUsers: ['alice'],
        allowedChannels: ['eng'],
        daemon: { url: 'http://d', auth: { kind: 'bearer' as const, token: { env: 'TEST_MM_B5_TOK2' } } },
        chi: { engine: 'claude-code' },
        ...over,
      });
      const load = (b: object) => resolveBridgeConfigs({ mattermostUrl: 'http://mm', bots: { rex: b as never } });
      assert.throws(() => load(bot({ chi: { engine: 'pi' } })), /bot 'rex': chi.engine 'pi' does not enforce permission modes/);
      assert.throws(() => load(bot({ maxMode: 'acceptEdits', chi: { engine: 'pi' } })), /chi.engine 'pi' does not enforce/);
      const sched = { name: 'standup', cron: '0 8 * * 1', channel: 'eng', task: 'x', engine: 'opencode' };
      assert.throws(() => load(bot({ schedules: [sched] })), /schedule 'standup' engine 'opencode' does not enforce/);
      assert.equal(load(bot({ maxMode: 'bypassPermissions', chi: { engine: 'pi' }, schedules: [sched] }))[0]?.maxMode, 'bypassPermissions');
    } finally {
      delete process.env.TEST_MM_B5_TOK2;
    }
  });
});

describe('B1 Rails.authorizeRun: the engine actually sent decides the effective mode', () => {
  it('refuses a plan-mode run on an engine that ignores modes, and records the engine and the EFFECTIVE mode in run.refused', () => {
    for (const engine of ['pi', 'opencode', 'codex', 'antigravity-cli', undefined]) {
      const r = rails('plan');
      assert.throws(
        () => r.authorizeRun({ kind: 'thread', engine, mode: 'plan', fields: { thread_root: 't1' } }),
        (e: unknown) => e instanceof ModeRailError && /does not enforce permission modes.*unrestricted/.test((e as Error).message),
        String(engine),
      );
      const [x, ...rest] = recs();
      assert.equal(rest.length, 0);
      assert.equal(x?.event, 'run.refused');
      assert.equal(x?.engine, engine);
      assert.equal(x?.requested_mode, 'plan');
      assert.equal(x?.effective_mode, 'bypassPermissions', 'never claims plan for an engine that ignores it');
      assert.equal(x?.mode_enforced, false);
      rmSync(file);
    }
  });

  it('is also refused under acceptEdits, at every call site kind', () => {
    for (const kind of ['thread', 'resume', 'act', 'schedule'] as const) {
      assert.throws(() => rails('auto').authorizeRun({ kind, engine: 'codex', mode: 'plan', fields: {} }), ModeRailError, kind);
    }
  });

  it('under bypassPermissions it runs, and the *.requested record carries the engine and the effective mode, not the requested one', () => {
    const r = rails('bypassPermissions');
    const a = r.authorizeRun({ kind: 'thread', engine: 'pi', mode: 'plan', fields: { thread_root: 't1' } });
    assert.equal(a.mode, 'bypassPermissions');
    assert.equal(a.engine, 'pi');
    const c = r.authorizeRun({ kind: 'schedule', engine: 'opencode', mode: 'plan', fields: { schedule: 's' } });
    assert.equal(c.mode, 'bypassPermissions');
    const [t, s] = recs();
    assert.equal(t?.event, 'run.requested');
    assert.equal(t?.engine, 'pi');
    assert.equal(t?.mode, 'bypassPermissions');
    assert.equal(t?.requested_mode, 'plan');
    assert.equal(t?.mode_enforced, false);
    assert.equal(s?.event, 'schedule.requested');
    assert.equal(s?.engine, 'opencode');
    assert.equal(s?.mode, 'bypassPermissions');
  });

  it('claude-code keeps the mode it was given, and says it is enforced', () => {
    const r = rails('auto');
    const a = r.authorizeRun({ kind: 'act', engine: 'claude-code', mode: 'auto', fields: {} });
    assert.equal(a.mode, 'auto');
    const [x] = recs();
    assert.equal(x?.engine, 'claude-code');
    assert.equal(x?.mode, 'auto');
    assert.equal(x?.mode_enforced, true);
  });
});

// ── B2: names inherited from Object.prototype are not modes ──────────────────

describe('B2 prototype keys are not mode names, engines or ceilings', () => {
  it('maxMode: refused, never an unlimited ceiling', () => {
    for (const name of PROTO_NAMES) {
      assert.throws(() => resolveModeRails({ maxMode: name }, WHERE), /bot 'rex': maxMode must be one of plan, acceptEdits, bypassPermissions/, name);
      assert.throws(() => resolveModeRails({ maxMode: name, chi: { mode: 'bypassPermissions' } }, WHERE), /maxMode must be one of/, name);
      assert.throws(() => resolveModeRails({ maxMode: name, approvals: { actingMode: 'bypassPermissions' } }, WHERE), /maxMode must be one of/, name);
    }
  });

  it('chi.mode: refused as an unknown mode, at any ceiling', () => {
    for (const name of PROTO_NAMES) {
      assert.throws(() => resolveModeRails({ maxMode: 'bypassPermissions', chi: { mode: name } }, WHERE), /chi.mode '.*' is not a mode the daemon knows/, name);
    }
  });

  it('approvals.actingMode: refused as an unknown mode, at any ceiling', () => {
    for (const name of PROTO_NAMES) {
      assert.throws(() => resolveModeRails({ maxMode: 'bypassPermissions', approvals: { actingMode: name } }, WHERE), /actingMode '.*' is not a mode the daemon knows/, name);
    }
  });

  it('modeRank / isWireMode: above every ceiling, not a mode', () => {
    for (const name of PROTO_NAMES) {
      assert.equal(isWireMode(name), false, name);
      assert.equal(modeRank(name), Number.POSITIVE_INFINITY, name);
      assert.throws(() => rails('bypassPermissions').authorizeRun({ kind: 'thread', engine: 'claude-code', mode: name, fields: {} }), ModeRailError, name);
    }
  });

  it('engine names: a prototype key is an unknown engine, refused under a plan ceiling', () => {
    for (const name of PROTO_NAMES) {
      assert.throws(() => resolveModeRails({ chi: { engine: name } }, WHERE), /does not enforce permission modes/, name);
      assert.throws(() => rails('plan').authorizeRun({ kind: 'thread', engine: name, mode: 'plan', fields: {} }), ModeRailError, name);
    }
  });

  it('through the config loader: maxMode "constructor" / "__proto__" / "toString" refuse the load', () => {
    process.env.TEST_MM_B5_TOK3 = 'tok';
    try {
      for (const name of PROTO_NAMES) {
        const bot = {
          mattermostToken: { env: 'TEST_MM_B5_TOK3' },
          allowedUsers: ['alice'],
          allowedChannels: ['eng'],
          daemon: { url: 'http://d', auth: { kind: 'bearer' as const, token: { env: 'TEST_MM_B5_TOK3' } } },
          chi: { engine: 'claude-code', mode: 'bypassPermissions' },
          maxMode: name,
        };
        assert.throws(() => resolveBridgeConfigs({ mattermostUrl: 'http://mm', bots: { rex: bot as never } }), /maxMode must be one of/, name);
      }
    } finally {
      delete process.env.TEST_MM_B5_TOK3;
    }
  });

  it('a bot may be NAMED after a prototype key', () => {
    process.env.TEST_MM_B5_TOK3 = 'tok';
    try {
      const bot = {
        mattermostToken: { env: 'TEST_MM_B5_TOK3' },
        allowedUsers: ['alice'],
        allowedChannels: ['eng'],
        daemon: { url: 'http://d', auth: { kind: 'bearer' as const, token: { env: 'TEST_MM_B5_TOK3' } } },
        chi: { engine: 'claude-code' },
      };
      const bots = JSON.parse(JSON.stringify({ constructor: bot, toString: bot })) as Record<string, never>;
      assert.deepEqual(resolveBridgeConfigs({ mattermostUrl: 'http://mm', bots }).map((b) => b.name), ['constructor', 'toString']);
    } finally {
      delete process.env.TEST_MM_B5_TOK3;
    }
  });
});

// Remove every temp directory the file made, including ones a stopped bridge wrote into again.
after(() => sweepTmp());
