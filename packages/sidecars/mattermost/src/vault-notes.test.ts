import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { MattermostBridge } from './bridge.js';
import { MattermostClient } from './client.js';
import { MockMattermostServer } from './mock-server.js';
import { cardField } from './outreach.js';
import { resolveOutboxApprovals } from './outbox-approvals.js';
import { SenderSocket } from './sender-socket.js';
import type { VaultEvent } from './sender-socket.js';
import { sweepTmp, tmpDir } from './test-tmp.js';
import type { AuditLog } from './audit.js';
import type { MattermostBridgeConfig } from './types.js';
import { VaultNotesManager, VaultNotesStore, resolveVaultNotes, vaultNoteText } from './vault-notes.js';
import type { ResolvedVaultNotes } from './vault-notes.js';

after(() => sweepTmp());

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await pause(10);
  }
}

// ── fake sender with vault.events support ───────────────────────────────────

class FakeVaultSender {
  readonly received: Array<Record<string, unknown>> = [];
  events: VaultEvent[] = [];
  hangUp: boolean | string = false;
  failCode: string | undefined;
  /** Replace the vault.events answer wholesale (for hostile or buggy senders). */
  vaultOverride?: (since: number) => { events: VaultEvent[]; cursor: number };
  announcements: Array<{
    draftId: string;
    payloadHash: string;
    renderedText: string;
  }> = [];
  private server = net.createServer((c) => this.serve(c));
  socketPath = '';

  async listen(dir: string): Promise<string> {
    this.socketPath = path.join(dir, 'vault-test.sock');
    await new Promise<void>((r) => this.server.listen(this.socketPath, r));
    return this.socketPath;
  }

  ofAction(action: string): Array<Record<string, unknown>> {
    return this.received.filter((m) => m.action === action);
  }

  private serve(c: net.Socket): void {
    let buf = '';
    c.on('error', () => {});
    c.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      this.received.push(msg);
      if (this.hangUp === true || this.hangUp === msg.action) return void c.destroy();
      c.end(`${JSON.stringify(this.answer(msg))}\n`);
    });
  }

  private answer(msg: Record<string, unknown>): Record<string, unknown> {
    if (this.failCode) return { ok: false, error: this.failCode };
    switch (msg.action) {
      case 'vault.events': {
        const since = typeof msg.since === 'number' ? msg.since : 0;
        const limit = typeof msg.limit === 'number' ? msg.limit : 100;
        if (this.vaultOverride) return { ok: true, ...this.vaultOverride(since) };
        const matched = this.events.filter((e) => e.id > since).slice(0, limit);
        const cursor = matched.length > 0 ? matched[matched.length - 1]!.id : since;
        return { ok: true, events: matched, cursor };
      }
      case 'pull_announcements':
        return { ok: true, announcements: this.announcements };
      case 'ack_announcement':
        return { ok: true };
      default:
        return { ok: false, error: 'unknown_action' };
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const makeEvent = (id: number, over: Partial<VaultEvent> = {}): VaultEvent => ({
  id,
  at: '2026-10-30T10:00:00.000Z',
  actor: 'ada',
  group: 'outreach:ADAUGO',
  label: 'Outreach mailbox (ADAUGO)',
  action: 'set',
  names: ['OUTREACH_ADAUGO_SMTP_HOST', 'OUTREACH_ADAUGO_SMTP_PASS'],
  ...over,
});

// ── rig ─────────────────────────────────────────────────────────────────────

interface Rig {
  mm: MockMattermostServer;
  sender: FakeVaultSender;
  dir: string;
  logs: string[];
  audit: Array<{ event: string; fields: Record<string, unknown> }>;
  storeFile: string;
  endpoints: () => Promise<{ url: string; socketPath: string }>;
  manager: (over?: { config?: Partial<ResolvedVaultNotes>; storeFile?: string }) => Promise<VaultNotesManager>;
  posts: () => Array<{ id?: string; channel_id: string; message: string }>;
}

function createRig(): Rig {
  const dir = tmpDir('vault-notes-');
  const mm = new MockMattermostServer();
  mm.channels.set('royalti-co', 'c-royalti');
  const sender = new FakeVaultSender();
  const logs: string[] = [];
  const audit: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const storeFile = path.join(dir, 'vault-notes.json');
  let url: string | undefined;
  let socketPath: string | undefined;

  const endpoints = async () => {
    if (!url) url = await mm.listen();
    if (!socketPath) socketPath = await sender.listen(dir);
    return { url, socketPath };
  };

  const fakeAudit: AuditLog = {
    record(event: string, fields: Record<string, unknown>) {
      audit.push({ event, fields });
    },
    must(event: string, fields: Record<string, unknown>) {
      audit.push({ event, fields });
    },
    setSink() {},
    rotate() {},
  } as unknown as AuditLog;

  const manager = async (over?: { config?: Partial<ResolvedVaultNotes>; storeFile?: string }) => {
    const ep = await endpoints();
    const client = new MattermostClient({
      mattermostUrl: ep.url,
      mattermostToken: 'token',
      allowedUsers: ['alice'],
      allowedChannels: ['royalti-co'],
    });
    const s = new SenderSocket({ socketPath: ep.socketPath });
    return new VaultNotesManager({
      bot: 'outbox',
      client,
      store: new VaultNotesStore(over?.storeFile ?? storeFile),
      config: { channel: 'royalti-co', pollMs: 30000, ...over?.config },
      sender: s,
      audit: fakeAudit,
      log: (m) => logs.push(m),
    });
  };

  return {
    mm,
    sender,
    dir,
    logs,
    audit,
    storeFile,
    endpoints,
    manager,
    posts: () => mm.receivedPosts,
  };
}

describe('vault notes', () => {
  let R: Rig;

  beforeEach(() => {
    R = createRig();
  });

  afterEach(async () => {
    await R.sender.close();
    await R.mm.close();
  });

  describe('config resolution', () => {
    it('returns undefined when block is absent or not enabled', () => {
      assert.equal(resolveVaultNotes(undefined, 'bot', 'c1', 5000), undefined);
      assert.equal(resolveVaultNotes({ enabled: false }, 'bot', 'c1', 5000), undefined);
    });

    it('resolves defaults when enabled is true', () => {
      const res = resolveVaultNotes({ enabled: true }, 'bot', 'c1', 5000);
      assert.deepEqual(res, { channel: 'c1', pollMs: 5000 });
    });

    it('applies explicit channel and pollMs', () => {
      const res = resolveVaultNotes({ enabled: true, channel: '#founder-notes', pollMs: 15000 }, 'bot', 'c1', 5000);
      assert.deepEqual(res, { channel: 'founder-notes', pollMs: 15000 });
    });

    it('is off when the block is present but enabled is omitted', () => {
      assert.equal(resolveVaultNotes({}, 'bot', 'c1', 5000), undefined);
      assert.equal(resolveVaultNotes({ channel: 'x', pollMs: 2000 }, 'bot', 'c1', 5000), undefined);
    });

    it('refuses unknown fields', () => {
      assert.throws(() => resolveVaultNotes({ enabled: true, bogus: 123 }, 'bot', 'c1', 5000), /unknown field 'bogus'/);
    });

    it('refuses invalid enabled or pollMs', () => {
      assert.throws(() => resolveVaultNotes({ enabled: 'yes' }, 'bot', 'c1', 5000), /enabled must be true or false/);
      assert.throws(() => resolveVaultNotes({ enabled: true, pollMs: 500 }, 'bot', 'c1', 5000), /pollMs/);
    });
  });

  describe('escaping and note formatting', () => {
    it('escapes mentions, markdown links, HTML tags, and addresses', () => {
      assert.equal(cardField('@channel'), '@\u200bchannel');
      assert.equal(cardField('<!here>'), ' !here ');
      assert.equal(cardField('[x](http://evil)'), ' x (http://evil)');
      assert.equal(cardField('user@example.com'), '(address removed)');
    });

    it('collapses newlines in actor and label onto one line', () => {
      const text = vaultNoteText(makeEvent(1, { actor: 'ada\n\nHACK', label: 'line1\r\nline2\tx' }));
      assert.ok(!/[\r\n\t]/.test(text), 'no control whitespace');
      assert.equal(text, "Sender vault: ada HACK performed 'set' on line1 line2 x (2026-10-30T10:00:00.000Z).");
    });

    it('truncates an overlong field', () => {
      const text = vaultNoteText(makeEvent(1, { label: 'L'.repeat(500) }));
      assert.ok(text.includes(`${'L'.repeat(80)}...`));
      assert.ok(!text.includes('L'.repeat(81)));
      assert.ok(text.length < 200);
    });

    it('formats a concise founder note without key values or names list', () => {
      const ev = makeEvent(1, {
        actor: '@ada',
        group: 'outreach:ADAUGO',
        label: '[Mailbox](http://bad) <ADAUGO>',
        action: 'replace',
      });
      const text = vaultNoteText(ev);
      assert.equal(
        text,
        "Sender vault: @\u200bada performed 'replace' on  Mailbox (http://bad)  ADAUGO  (2026-10-30T10:00:00.000Z).",
      );
      assert.ok(!text.includes('OUTREACH_ADAUGO'));
      assert.ok(!text.includes('@ada\b'));
      assert.ok(!text.includes('[Mailbox]'));
    });
  });

  describe('no replay on first run', () => {
    it(
      'establishes the current cursor on first run without posting historical events',
      { timeout: 20000 },
      async () => {
        R.sender.events = [makeEvent(1), makeEvent(2), makeEvent(3)];
        const m = await R.manager();
        await m.runCycle();

        assert.equal(R.posts().length, 0, 'no notes posted on first run');
        const store = new VaultNotesStore(R.storeFile);
        assert.equal(store.state.cursor, 3, 'cursor initialized to newest event');

        // Next cycle with a new event: only the new event is posted
        R.sender.events.push(makeEvent(4, { action: 'clear' }));
        await m.runCycle();

        assert.equal(R.posts().length, 1, 'only new event is posted');
        assert.ok(R.posts()[0]!.message.includes("'clear'"));
        assert.equal(new VaultNotesStore(R.storeFile).state.cursor, 4);
      },
    );

    it('handles first run when sender has zero events', { timeout: 20000 }, async () => {
      R.sender.events = [];
      const m = await R.manager();
      await m.runCycle();

      assert.equal(R.posts().length, 0);
      assert.equal(new VaultNotesStore(R.storeFile).state.cursor, 0);

      R.sender.events.push(makeEvent(1));
      await m.runCycle();

      assert.equal(R.posts().length, 1);
      assert.equal(new VaultNotesStore(R.storeFile).state.cursor, 1);
    });
  });

  describe('notes posted once per event and cursor persistence across restart', () => {
    it('posts notes once per event and advances cursor', async () => {
      const m = await R.manager();
      // First run with empty history
      await m.runCycle();
      assert.equal(R.posts().length, 0);

      // Emit two events
      R.sender.events.push(makeEvent(1, { action: 'set' }));
      R.sender.events.push(makeEvent(2, { action: 'replace', actor: 'chinedum' }));
      await m.runCycle();

      assert.equal(R.posts().length, 2);
      assert.ok(R.posts()[0]!.message.includes("'set'"));
      assert.ok(R.posts()[1]!.message.includes("chinedum performed 'replace'"));
      assert.equal(new VaultNotesStore(R.storeFile).state.cursor, 2);

      // Second cycle without new events does not post anything again
      await m.runCycle();
      assert.equal(R.posts().length, 2);
    });

    it('persists cursor across restart and does not duplicate notes', async () => {
      const m1 = await R.manager();
      await m1.runCycle(); // first run

      R.sender.events.push(makeEvent(1));
      await m1.runCycle();
      assert.equal(R.posts().length, 1);
      m1.stop();

      // Restart: new manager instance reading the same store file
      const m2 = await R.manager();
      await m2.runCycle();
      assert.equal(R.posts().length, 1, 'did not repost event 1 on restart');

      // Emit event 2
      R.sender.events.push(makeEvent(2, { action: 'clear' }));
      await m2.runCycle();
      assert.equal(R.posts().length, 2, 'posted event 2');
      assert.ok(R.posts()[1]!.message.includes("'clear'"));
      m2.stop();
    });

    it('retry after partial failure does not double-post', async () => {
      const m = await R.manager();
      await m.runCycle(); // first run

      R.sender.events.push(makeEvent(1), makeEvent(2));
      // Simulate post failure on event 2
      R.mm.failPostsMatching = /performed 'replace'/;
      R.sender.events[1]!.action = 'replace';

      await assert.rejects(async () => {
        await m.runCycle();
      });

      // Event 1 was posted and saved in posted map
      assert.equal(R.posts().length, 1);
      const store = new VaultNotesStore(R.storeFile);
      assert.ok(store.state.posted['1']);
      // Cursor did not advance past 0 because batch failed
      assert.equal(store.state.cursor, 0);

      // Fix failure and rerun
      R.mm.failPostsMatching = undefined;
      await m.runCycle();

      assert.equal(R.posts().length, 2, 'event 1 not reposted; event 2 posted');
      assert.equal(new VaultNotesStore(R.storeFile).state.cursor, 2);
    });
  });

  describe('fail soft', () => {
    it('handles unreachable sender: logs once, retries next poll, never crashes bridge or posts error', async () => {
      R.sender.hangUp = true;
      const m = await R.manager();

      await m.runCycle();
      assert.equal(R.posts().length, 0);
      assert.ok(R.logs.some((l) => l.includes('sender unavailable')));

      const logCount = R.logs.length;
      await m.runCycle();
      // Should not log duplicate "sender unavailable" lines
      assert.equal(R.logs.length, logCount);

      // Sender comes back up
      R.sender.hangUp = false;
      await m.runCycle();
      assert.ok(R.logs.some((l) => l.includes('sender reachable')));
      assert.equal(R.posts().length, 0);
    });

    it('handles vault_unconfigured error gracefully', async () => {
      R.sender.failCode = 'vault_unconfigured';
      const m = await R.manager();

      await m.runCycle();
      assert.equal(R.posts().length, 0);
      assert.ok(R.logs.some((l) => l.includes('vault_unconfigured')));

      // Clear failure
      R.sender.failCode = undefined;
      R.sender.events.push(makeEvent(1));
      await m.runCycle(); // first run initializes cursor
      R.sender.events.push(makeEvent(2));
      await m.runCycle(); // posts event 2
      assert.equal(R.posts().length, 1);
    });
  });

  describe('hostile or buggy sender', () => {
    it('rejects a huge cursor and keeps the old one', async () => {
      const m = await R.manager();
      await m.runCycle();
      R.sender.vaultOverride = () => ({ events: [], cursor: 1e300 });
      await m.runCycle();
      await m.runCycle();
      assert.equal(new VaultNotesStore(R.storeFile).state.cursor, 0);
      assert.equal(R.logs.filter((l) => l.includes('unusable cursor')).length, 1, 'logged once');

      // A sane sender afterwards still works
      R.sender.vaultOverride = undefined;
      R.sender.events.push(makeEvent(1));
      await m.runCycle();
      assert.equal(R.posts().length, 1);
      assert.equal(new VaultNotesStore(R.storeFile).state.cursor, 1);
    });

    it('rejects a backwards cursor', async () => {
      R.sender.events = [makeEvent(1), makeEvent(2), makeEvent(3)];
      const m = await R.manager();
      await m.runCycle();
      assert.equal(new VaultNotesStore(R.storeFile).state.cursor, 3);
      R.sender.vaultOverride = () => ({ events: [], cursor: 1 });
      await m.runCycle();
      assert.equal(new VaultNotesStore(R.storeFile).state.cursor, 3);
      assert.ok(R.logs.some((l) => l.includes('unusable cursor')));
    });

    it('skips events whose id is at or below the cursor, or not a safe integer', async () => {
      const m = await R.manager();
      R.sender.events = [makeEvent(5)];
      await m.runCycle(); // first run: cursor 5
      R.sender.vaultOverride = () => ({
        events: [makeEvent(5), makeEvent(2), makeEvent(1e300), makeEvent(Number.NaN), makeEvent(6)],
        cursor: 6,
      });
      await m.runCycle();
      assert.equal(R.posts().length, 1, 'only id 6 posted');
      assert.equal(Object.keys(new VaultNotesStore(R.storeFile).state.posted).join(), '6');
    });

    it('does not finish the first run on an unusable cursor (no replay from 0)', async () => {
      R.sender.vaultOverride = () => ({ events: [], cursor: 1e300 });
      const m = await R.manager();
      await m.runCycle();
      assert.equal(new VaultNotesStore(R.storeFile).state.cursor, null);
    });

    it('bounds the first-run drain against a sender whose cursor keeps changing', { timeout: 20000 }, async () => {
      let calls = 0;
      R.sender.vaultOverride = (since) => {
        calls++;
        const events = Array.from({ length: 100 }, (_, i) => makeEvent(since + i + 1));
        return { events, cursor: since + 100 };
      };
      const m = await R.manager();
      await m.runCycle();
      assert.ok(calls <= 50, `drain made ${calls} calls`);
      assert.ok(R.logs.some((l) => l.includes('first-run drain stopped')));
      assert.equal(R.posts().length, 0, 'drain posts nothing');
      assert.equal(new VaultNotesStore(R.storeFile).state.cursor, 5000);
    });

    it('stops the first-run drain when the cursor does not increase', { timeout: 20000 }, async () => {
      let calls = 0;
      R.sender.vaultOverride = () => {
        calls++;
        return {
          events: Array.from({ length: 100 }, (_, i) => makeEvent(i + 1)),
          cursor: 0,
        };
      };
      const m = await R.manager();
      await m.runCycle();
      assert.ok(calls <= 2, `drain made ${calls} calls`);
    });
  });

  describe('through the bridge', () => {
    it('disabled by default: when vaultNotes is not configured, no events polled or posted', async () => {
      const ep = await R.endpoints();
      const cfg: MattermostBridgeConfig = {
        mattermostUrl: ep.url,
        mattermostToken: 'token',
        allowedUsers: ['alice'],
        allowedChannels: ['royalti-co'],
        dataDir: R.dir,
        outboxApprovals: {
          channel: 'royalti-co',
          approvers: ['buay4kf99bbk7cjtbeupd5rxow'],
          socketPath: ep.socketPath,
        },
      };

      const bridge = new MattermostBridge(cfg);
      assert.equal(bridge.vaultNotes, undefined);
      await bridge.start();

      R.sender.events.push(makeEvent(1));
      await pause(50);

      assert.equal(R.posts().length, 0);
      assert.equal(R.sender.ofAction('vault.events').length, 0);
      bridge.stop();
    });

    it('runs through bridge when enabled, posting notes and surviving restart', async () => {
      const ep = await R.endpoints();
      const cfg: MattermostBridgeConfig = {
        mattermostUrl: ep.url,
        mattermostToken: 'token',
        allowedUsers: ['alice'],
        allowedChannels: ['royalti-co'],
        dataDir: R.dir,
        outboxApprovals: {
          channel: 'royalti-co',
          approvers: ['buay4kf99bbk7cjtbeupd5rxow'],
          socketPath: ep.socketPath,
          vaultNotes: {
            enabled: true,
            channel: 'royalti-co',
            pollMs: 1000,
          },
        },
      };

      const bridge = new MattermostBridge(cfg);
      assert.ok(bridge.vaultNotes);
      await bridge.start();

      // First run drains existing history
      await waitFor(() => R.sender.ofAction('vault.events').length > 0, 'first poll');
      assert.equal(R.posts().length, 0);

      // Emit an event
      R.sender.events.push(makeEvent(1, { actor: 'ada', action: 'set' }));
      await waitFor(() => R.posts().length === 1, 'vault note posted');
      assert.ok(R.posts()[0]!.message.includes("ada performed 'set'"));

      bridge.stop();

      // Restart bridge
      const bridge2 = new MattermostBridge(cfg);
      await bridge2.start();

      await waitFor(() => R.sender.ofAction('vault.events').length >= 2, 'second bridge polled');
      assert.equal(R.posts().length, 1, 'no duplicate note on restart');

      R.sender.events.push(makeEvent(2, { actor: 'chinedum', action: 'clear' }));
      await waitFor(() => R.posts().length === 2, 'second note posted');
      assert.ok(R.posts()[1]!.message.includes("chinedum performed 'clear'"));

      bridge2.stop();
    });
  });
});
