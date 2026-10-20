import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import net from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { MattermostBridge } from './bridge.js';
import { resolveBridgeConfigs } from './config.js';
import { canonicalDraftHash } from './draft-hash.js';
import type { DraftRowForHash } from './draft-hash.js';
import { MockMattermostServer } from './mock-server.js';
import { longestBacktickRun, resolveOutboxApprovals, shortenRenderedText } from './outbox-approvals.js';
import { SenderSocket } from './sender-socket.js';
import { sweepTmp, tmpDir } from './test-tmp.js';
import type { MattermostBridgeConfig, OutboxApprovalsConfig } from './types.js';

after(() => sweepTmp());

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await pause(10);
  }
}

/** A 26-character Mattermost-style id for a test person. */
const uid = (name: string) => (name + 'x'.repeat(26)).slice(0, 26);
const ADA = uid('ada');
const FOUNDER = uid('founder');
const ONYE = uid('onyedikachi');
const MALLORY = uid('mallory');
const BOT_CHILD = uid('ikrubybot');
const ENV = { RUBY_IMAP_USER: 'ruby@royalti.io' };
const SECRET = 'button-secret-0123456789-abcdefgh';

// ── a fake sender: the contract's socket, on a temp Unix socket ──────────────

interface FakeDraft {
  row: DraftRowForHash;
  status: string;
  renderedText: string;
}

function rowFor(id: string, over: { subject?: string; body?: string; to?: string } = {}): DraftRowForHash {
  const item = {
    id,
    recipient: 'Pat Customer',
    recipientEmail: over.to ?? 'pat@example.com',
    subject: over.subject ?? 'Re: Invoice 42',
    body: over.body ?? 'Hi Pat,\n\nThanks for the note.\n\nRuby',
    channel: 'smtp',
    senderAddress: 'ruby@royalti.io',
  };
  return { id, channel: 'smtp', payload_json: JSON.stringify({ item, meta: { agent: 'Ruby' } }), edited_json: null, scheduled_at: null };
}

/** What the sender's approver text looks like (shape only: header fields, then `**Body:**` and a block quote). */
function render(row: DraftRowForHash): string {
  const item = (JSON.parse(row.payload_json) as { item: Record<string, string> }).item;
  return [
    '**Outbox Action Draft Approval Required**',
    `• **Draft ID:** ${row.id}`,
    `• **Channel:** ${row.channel}`,
    `• **To:** ${item.recipient} <${item.recipientEmail}>`,
    `• **Subject:** ${item.subject}`,
    '',
    '**Body:**',
    ...(item.body as string).split('\n').map((l) => `> ${l}`),
  ].join('\n');
}

class FakeSender {
  readonly drafts = new Map<string, FakeDraft>();
  readonly announced = new Set<string>();
  readonly received: Array<Record<string, unknown>> = [];
  /** Reply to `approve`. */
  approveReply: (msg: Record<string, unknown>) => { ok: boolean; error?: string } = () => ({ ok: true });
  /** Refuse to ack (the ack is lost). */
  dropAcks = false;
  /** Answer nothing and hang up (the sender is down): every action, or just the named one. */
  hangUp: boolean | string = false;
  private server = net.createServer((c) => this.serve(c));
  socketPath = '';

  async listen(dir: string): Promise<string> {
    this.socketPath = path.join(dir, 's.sock');
    await new Promise<void>((r) => this.server.listen(this.socketPath, r));
    return this.socketPath;
  }

  /** Put (or replace, as an operator edit does) a committed draft. */
  put(row: DraftRowForHash, status = 'committed'): string {
    this.drafts.set(row.id, { row, status, renderedText: render(row) });
    return canonicalDraftHash(row, ENV);
  }

  hashOf(id: string): string {
    return canonicalDraftHash((this.drafts.get(id) as FakeDraft).row, ENV);
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
    const id = msg.draftId as string;
    switch (msg.action) {
      case 'pull_announcements':
        return {
          ok: true,
          announcements: [...this.drafts.entries()]
            .filter(([k, d]) => d.status === 'committed' && !this.announced.has(`${k}:${this.hashOf(k)}`))
            .map(([k, d]) => ({ draftId: k, payloadHash: this.hashOf(k), renderedText: d.renderedText })),
        };
      case 'ack_announcement':
        if (this.dropAcks) return { ok: false, error: 'ledger_error: disk full' };
        this.announced.add(`${id}:${msg.payloadHash}`);
        return { ok: true, draftId: id };
      case 'get_draft': {
        const d = this.drafts.get(id);
        if (!d) return { ok: false, error: 'draft_not_found' };
        return { ok: true, draftId: id, status: d.status, payloadHash: this.hashOf(id), renderedText: d.renderedText };
      }
      case 'approve':
        return this.approveReply(msg);
      default:
        return { ok: false, error: 'unknown_action' };
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

// ── rig ──────────────────────────────────────────────────────────────────────

interface Rig {
  mm: MockMattermostServer;
  sender: FakeSender;
  dir: string;
  bridges: MattermostBridge[];
  boot: (over?: Partial<OutboxApprovalsConfig>, cfg?: Partial<MattermostBridgeConfig>) => Promise<MattermostBridge>;
  /** One poll, however the immediate one at start interleaves. */
  announce: (b: MattermostBridge) => Promise<void>;
  /** The card posts, oldest first. */
  cards: () => Array<{ id?: string; channel_id: string; message: string; props?: Record<string, unknown> }>;
  current: (postId: string) => string;
  react: (postId: string, user: string, emoji?: string) => void;
  auditLines: () => Array<Record<string, unknown>>;
}

let rig: Rig;

function makeRig(): Rig {
  const mm = new MockMattermostServer();
  const sender = new FakeSender();
  const dir = tmpDir('mm-outbox-');
  const bridges: MattermostBridge[] = [];
  mm.channels.set('royalti-co', 'c-royalti');
  for (const [id, name] of [[ADA, 'ada'], [FOUNDER, 'chinedum'], [ONYE, 'onyedikachi'], [MALLORY, 'ada'], [BOT_CHILD, 'ik-ruby']]) mm.users.set(id as string, name as string);
  let url: string | undefined;
  let socketPath: string | undefined;

  const boot: Rig['boot'] = async (over = {}, cfg = {}) => {
    url ??= await mm.listen();
    socketPath ??= await sender.listen(dir);
    const b = new MattermostBridge({
      name: 'ruby',
      mattermostUrl: url,
      mattermostToken: 'mm-token',
      allowedUsers: [],
      allowedChannels: [],
      dataDir: dir,
      outboxApprovals: { channel: 'royalti-co', approvers: [ADA, FOUNDER, ONYE], socketPath, pollMs: 3_600_000, ...over },
      ...cfg,
    });
    await b.start();
    bridges.push(b);
    await waitFor(() => mm.clientCount > 0, 'websocket');
    return b;
  };

  const announce: Rig['announce'] = async (b) => {
    const o = b.outbox as NonNullable<MattermostBridge['outbox']>;
    await o.whenIdle();
    await o.runCycle();
    await o.whenIdle();
  };

  return {
    mm,
    sender,
    dir,
    bridges,
    boot,
    announce,
    cards: () => mm.receivedPosts.filter((p) => p.channel_id === 'c-royalti'),
    current: (id) => mm.posts.get(id)?.message ?? '',
    react: (postId, user, emoji = '+1') => mm.broadcastReaction({ user_id: user, post_id: postId, emoji_name: emoji }),
    auditLines: () =>
      readFileSync(path.join(dir, 'audit-ruby.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

beforeEach(() => {
  rig = makeRig();
});
afterEach(async () => {
  for (const b of rig.bridges) b.stop();
  await rig.mm.close();
  await rig.sender.close();
});

const D1 = 'ruby-reply:em-1001';
const approvesSent = () => rig.sender.ofAction('approve');

// ── config ───────────────────────────────────────────────────────────────────

describe('outboxApprovals config', () => {
  const ok: OutboxApprovalsConfig = { channel: '#royalti-co', approvers: [ADA] };

  it('applies defaults and strips the # from the channel', () => {
    const r = resolveOutboxApprovals(ok, "bot 'ruby'");
    assert.equal(r.channel, 'royalti-co');
    assert.equal(r.socketPath, '/run/ikenga-sender/approvals.sock');
    assert.equal(r.pollMs, 30_000);
    assert.equal(r.bodyMaxChars, 1500);
    assert.equal(r.buttons, undefined);
  });

  it('refuses a bad block, naming the bot and the field', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ approvers: [ADA] }, /bot 'ruby': outboxApprovals.channel is required/],
      [{ channel: 'x' }, /approvers must be a list/],
      [{ channel: 'x', approvers: [] }, /at least one approver/],
      [{ channel: 'x', approvers: ['ada'] }, /must be Mattermost user ids.*usernames are never matched/],
      [{ channel: 'x', approvers: ['@ada'] }, /must be Mattermost user ids/],
      [{ ...ok, extra: 1 }, /unknown field 'extra'/],
      [{ ...ok, socketPath: 'relative.sock' }, /socketPath must be an absolute path/],
      [{ ...ok, pollMs: 10 }, /pollMs/],
      [{ ...ok, bodyMaxChars: 5 }, /bodyMaxChars/],
      [{ ...ok, outboxUrl: 'ftp://x' }, /outboxUrl/],
      [{ ...ok, buttons: { callbackUrl: 'http://127.0.0.1:9/cb', listenPort: 9 } }, /buttons.secret is required/],
      [{ ...ok, buttons: { callbackUrl: 'http://127.0.0.1:9/cb', listenPort: 9, secret: 'short' } }, /at least 12 characters/],
      [{ ...ok, buttons: { callbackUrl: 'nope', listenPort: 9, secret: SECRET } }, /buttons.callbackUrl/],
      [{ ...ok, buttons: { callbackUrl: 'http://x/cb', listenPort: 0, secret: SECRET } }, /buttons.listenPort/],
      [{ ...ok, buttons: { callbackUrl: 'http://x/cb', listenPort: 9, secret: SECRET, x: 1 } }, /buttons: unknown field 'x'/],
    ];
    for (const [cfg, re] of bad) assert.throws(() => resolveOutboxApprovals(cfg as OutboxApprovalsConfig, "bot 'ruby'"), re);
  });

  it('a bad block fails the bridge config load (secret resolved first), and the bridge constructor', () => {
    const file = (o: unknown) => ({
      mattermostUrl: 'http://mm.example',
      dataDir: '/nonexistent',
      bots: {
        ruby: {
          mattermostToken: { value: 'tok' },
          allowedUsers: [],
          allowedChannels: [],
          daemon: { url: 'http://d', auth: { kind: 'bearer' as const, token: { value: 'bt' } } },
          chi: { engine: 'claude-code' },
          outboxApprovals: o as never,
        },
      },
    });
    assert.throws(() => resolveBridgeConfigs(file({ channel: 'royalti-co', approvers: ['ada'] })), /bot 'ruby': outboxApprovals.approvers entries must be Mattermost user ids/);
    assert.throws(
      () => resolveBridgeConfigs(file({ channel: 'x', approvers: [ADA], buttons: { callbackUrl: 'http://x/cb', listenPort: 9, secret: { env: 'MM_NO_SUCH_SECRET_VAR' } } })),
      /outboxApprovals.buttons.secret: environment variable MM_NO_SUCH_SECRET_VAR is not set/,
    );
    const good = resolveBridgeConfigs(file({ channel: 'royalti-co', approvers: [ADA], buttons: { callbackUrl: 'http://x/cb', listenPort: 9, secret: { value: SECRET } } }));
    assert.equal(good[0]?.outboxApprovals?.buttons?.secret, SECRET);
    assert.throws(
      () => new MattermostBridge({ mattermostUrl: 'http://x', mattermostToken: 't', allowedUsers: [], allowedChannels: [], outboxApprovals: { channel: 'x', approvers: [] } }),
      /at least one approver/,
    );
  });
});

describe('card text', () => {
  it('shortens only the body, keeps every field above it, and keeps the block quote', () => {
    const text = render(rowFor('d', { body: 'x'.repeat(5000) }));
    const out = shortenRenderedText(text, 500);
    assert.ok(out.includes('• **Subject:** Re: Invoice 42'));
    assert.ok(out.includes('• **To:** Pat Customer <pat@example.com>'));
    assert.match(out, /truncated: 4502 more characters; the full text is in the Ikenga Outbox/);
    assert.ok(out.length < 900);
    for (const line of out.split('\n').slice(out.split('\n').indexOf('**Body:**') + 1)) assert.ok(line.startsWith('> '), line);
  });

  it('leaves a short body whole, and defangs @channel / @all / @here', () => {
    const out = shortenRenderedText(render(rowFor('d', { body: 'hi @channel and @here and @all' })), 500);
    assert.ok(!/@(channel|here|all)/.test(out), 'no live broadcast mention survives');
    assert.ok(out.includes('@​channel'));
    assert.ok(!out.includes('truncated'));
  });
});

// ── announcing ───────────────────────────────────────────────────────────────

describe('announcing drafts', () => {
  it('posts one card per draft to the channel, as the bot, then acks it with the post id', async () => {
    const hash = rig.sender.put(rowFor(D1));
    const b = await rig.boot({ outboxUrl: 'https://box.example/outbox' });
    await rig.announce(b);
    const cards = rig.cards();
    assert.equal(cards.length, 1);
    const text = (cards[0] as { message: string }).message;
    for (const part of ['Pat Customer <pat@example.com>', 'Re: Invoice 42', 'Hi Pat,', '• **Channel:** smtp', 'Ikenga Outbox', 'https://box.example/outbox', '👍']) {
      assert.ok(text.includes(part), `card has ${part}`);
    }
    assert.equal((cards[0] as { props?: unknown }).props, undefined, 'no buttons configured, no props');
    const acks = rig.sender.ofAction('ack_announcement');
    assert.equal(acks.length, 1);
    assert.deepEqual(acks[0], { v: 1, action: 'ack_announcement', draftId: D1, payloadHash: hash, postId: (cards[0] as { id: string }).id });
  });

  it('truncates a long body with a note and posts nothing the sender did not render', async () => {
    rig.sender.put(rowFor(D1, { body: 'long line '.repeat(400) }));
    const b = await rig.boot({ bodyMaxChars: 300 });
    await rig.announce(b);
    const text = (rig.cards()[0] as { message: string }).message;
    assert.match(text, /truncated: \d+ more characters/);
    assert.ok(text.length < 1400);
  });

  it('is idempotent: a second poll, a lost ack and a restart never post a second card for the same draft and hash', async () => {
    rig.sender.put(rowFor(D1));
    rig.sender.dropAcks = true;
    const b = await rig.boot();
    await rig.announce(b);
    await rig.announce(b);
    await rig.announce(b);
    assert.equal(rig.cards().length, 1, 'the sender kept offering it (acks lost) but only one card exists');
    assert.equal(rig.sender.ofAction('ack_announcement').length, 3, 'the ack is retried every poll');
    b.stop();
    const b2 = await rig.boot();
    await rig.announce(b2);
    assert.equal(rig.cards().length, 1, 'still one card after a restart');
    rig.sender.dropAcks = false;
    await rig.announce(b2);
    assert.equal(rig.cards().length, 1);
    assert.equal(rig.sender.announced.size, 1, 'the ack finally went through');
  });

  it('does not fall over when the sender is down, and announces once it is back', async () => {
    rig.sender.put(rowFor(D1));
    rig.sender.hangUp = true;
    const b = await rig.boot();
    await rig.announce(b);
    assert.equal(rig.cards().length, 0);
    assert.ok(rig.auditLines().some((l) => l.event === 'outbox.sender_unavailable'));
    rig.sender.hangUp = false;
    await rig.announce(b);
    assert.equal(rig.cards().length, 1);
  });

  it('refuses to start on a channel Mattermost does not know', async () => {
    await assert.rejects(rig.boot({ channel: 'no-such-channel' }), /bot 'ruby': outboxApprovals.channel: channel '#no-such-channel' not found/);
  });

  it('works without Chi: an echo bot (no daemon) can run the cards', async () => {
    const b = await rig.boot();
    assert.ok(b.outbox);
    assert.equal(b.router, undefined);
  });
});

// ── approving ────────────────────────────────────────────────────────────────

describe('approve', () => {
  async function withCard(over: Partial<OutboxApprovalsConfig> = {}) {
    const hash = rig.sender.put(rowFor(D1));
    const b = await rig.boot(over);
    await rig.announce(b);
    const post = rig.cards()[0] as { id: string };
    return { b, post: post.id, hash };
  }

  it('a 👍 from an approver sends the contract approve message, checks the draft first, and marks the card', async () => {
    const { post, hash } = await withCard();
    rig.react(post, ADA, '+1::skin-tone-3');
    await waitFor(() => approvesSent().length === 1, 'approve message');
    assert.deepEqual(approvesSent()[0], {
      v: 1,
      action: 'approve',
      draftId: D1,
      payloadHash: hash,
      source: 'mattermost',
      approver: { kind: 'mattermost', id: ADA },
    });
    // the hash on the wire is the contract's canonical hash of the row (the vectors prove the implementation)
    assert.equal(hash, canonicalDraftHash(rowFor(D1), ENV));
    const order = rig.sender.received.map((m) => m.action);
    assert.ok(order.lastIndexOf('get_draft') < order.lastIndexOf('approve'), 'get_draft before approve');
    await waitFor(() => rig.current(post).includes('Approved by @ada — sending'), 'card marked approved');
    assert.ok(!rig.current(post).includes('React 👍'), 'no longer asks for a decision');
  });

  it('thumbsup works too, and the Mattermost lookup is by id: the displayed name is the looked-up one', async () => {
    const { post } = await withCard();
    rig.react(post, FOUNDER, 'thumbsup');
    await waitFor(() => approvesSent().length === 1, 'approve');
    await waitFor(() => rig.current(post).includes('Approved by @chinedum'), 'name from GET /users/{id}');
  });

  it('only the listed ids decide: a lookalike username, a stranger and the bot itself change nothing', async () => {
    const { post } = await withCard();
    rig.react(post, MALLORY); // username "ada", a different id
    rig.react(post, uid('stranger'));
    rig.react(post, rig.mm.botId);
    rig.react(post, ADA, 'heart'); // not a decision emoji
    await pause(250);
    assert.equal(approvesSent().length, 0);
    assert.ok(rig.current(post).includes('React 👍'), 'card unchanged');
    const refused = rig.auditLines().filter((l) => l.event === 'outbox.refused');
    assert.ok(refused.some((l) => l.reason === 'not_approver' && l.user_id === MALLORY));
    assert.ok(refused.some((l) => l.reason === 'self'));
  });

  it('refuses a bot account even when it is (wrongly) on the list, and an ik-* username', async () => {
    rig.mm.bots.add(ONYE); // misconfigured: a bot on the approver list
    rig.mm.users.set(ONYE, 'looksfine');
    const hash = rig.sender.put(rowFor(D1));
    void hash;
    const b = await rig.boot({ approvers: [ONYE, BOT_CHILD] });
    await rig.announce(b);
    const post = (rig.cards()[0] as { id: string }).id;
    rig.react(post, ONYE);
    rig.react(post, BOT_CHILD);
    await waitFor(() => rig.auditLines().filter((l) => l.event === 'outbox.refused' && l.reason === 'bot').length === 2, 'both refused as bots');
    assert.equal(approvesSent().length, 0);
  });

  it('an unverifiable user (Mattermost lookup fails) decides nothing', async () => {
    const { post } = await withCard();
    rig.mm.failUserLookups = true;
    rig.react(post, ADA);
    await waitFor(() => rig.auditLines().some((l) => l.reason === 'unverifiable_user'), 'refused');
    assert.equal(approvesSent().length, 0);
  });

  it('a duplicate 👍 (and a second approver) is idempotent: exactly one approve message', async () => {
    const { post } = await withCard();
    rig.react(post, ADA);
    rig.react(post, ADA);
    rig.react(post, FOUNDER);
    await waitFor(() => approvesSent().length >= 1, 'approve');
    await pause(250);
    assert.equal(approvesSent().length, 1);
    rig.react(post, ONYE, '+1'); // after approval
    await pause(100);
    assert.equal(approvesSent().length, 1);
  });

  it('surfaces the sender\'s refusal code on the card and keeps the card open for a valid approver', async () => {
    const { post } = await withCard();
    rig.sender.approveReply = () => ({ ok: false, error: 'approver_is_owner' });
    rig.react(post, ADA);
    await waitFor(() => rig.current(post).includes('`approver_is_owner`'), 'refusal on card');
    assert.match(rig.current(post), /Approval by @ada refused: `approver_is_owner`/);
    assert.ok(rig.current(post).includes('React 👍'), 'still open');
    rig.sender.approveReply = () => ({ ok: true });
    rig.react(post, FOUNDER);
    await waitFor(() => rig.current(post).includes('Approved by @chinedum — sending'), 'second approver approves');
    assert.ok(!rig.current(post).includes('approver_is_owner'), 'the stale refusal is gone once approved');
  });

  it('a ledger refusal (consumed approval) or a vanished draft closes the card', async () => {
    const { post } = await withCard();
    rig.sender.approveReply = () => ({ ok: false, error: 'ledger_error: cannot re-arm consumed approval for ruby-reply:em-1001' });
    rig.react(post, ADA);
    await waitFor(() => rig.current(post).includes('**Closed.**'), 'closed');
    assert.match(rig.current(post), /ledger_error: cannot re-arm consumed approval/);
    rig.react(post, FOUNDER);
    await pause(150);
    assert.equal(approvesSent().length, 1, 'a closed card is never approved again');
  });

  it('a draft that is no longer approvable (rejected in the Outbox) closes the card with a plain reason', async () => {
    const { post } = await withCard();
    rig.sender.approveReply = () => ({ ok: false, error: 'draft_not_approvable' });
    rig.react(post, ADA);
    await waitFor(() => rig.current(post).includes('**Closed.**'), 'closed');
    assert.match(rig.current(post), /no longer awaiting approval/);
    rig.react(post, FOUNDER);
    await pause(150);
    assert.equal(approvesSent().length, 1, 'a closed card is never approved again');
  });

  it('says so when the sender cannot be reached (checking the draft, or approving), and decides nothing', async () => {
    const { post } = await withCard();
    rig.sender.hangUp = true;
    rig.react(post, ADA);
    await waitFor(() => rig.current(post).includes('could not reach the sender'), 'transport note');
    assert.equal(approvesSent().length, 0, 'it never got as far as approving');
    assert.ok(rig.current(post).includes('Nothing was approved'));
    assert.ok(rig.current(post).includes('React 👍'), 'still open');

    rig.sender.hangUp = 'approve'; // the draft check works, the approve line drops
    rig.react(post, FOUNDER);
    await waitFor(() => approvesSent().length === 1, 'approve attempted');
    await waitFor(() => rig.current(post).includes('Approval by @chinedum did not go through'), 'second transport note');
    assert.ok(rig.current(post).includes('React 👍'), 'still open: nothing was recorded');
    rig.sender.hangUp = false;
    rig.react(post, ONYE);
    await waitFor(() => rig.current(post).includes('Approved by @onyedikachi — sending'), 'approves once the sender is back');
  });

  it('refuses to approve a draft that changed under the card, and marks the card superseded', async () => {
    const { post } = await withCard();
    rig.sender.put(rowFor(D1, { body: 'Hi Pat, different text now.' })); // edited in the Outbox, not yet re-announced
    rig.react(post, ADA);
    await waitFor(() => rig.current(post).includes('**Superseded.**'), 'superseded');
    assert.equal(approvesSent().length, 0);
    assert.match(rig.current(post), /nothing was approved/i);
  });

  it('a draft already sent closes the card instead of approving', async () => {
    const { post } = await withCard();
    (rig.sender.drafts.get(D1) as FakeDraft).status = 'sent';
    rig.react(post, ADA);
    await waitFor(() => rig.current(post).includes('already sent'), 'closed as sent');
    assert.equal(approvesSent().length, 0);
  });

  it('writes the approval request to the audit log before the sender hears of it, and records no draft content', async () => {
    const { post } = await withCard();
    rig.react(post, ADA);
    await waitFor(() => rig.auditLines().some((l) => l.event === 'outbox.decided'), 'decided');
    const lines = rig.auditLines();
    const events = lines.map((l) => l.event);
    assert.ok(events.indexOf('outbox.card_posted') < events.indexOf('outbox.approve_requested'));
    assert.ok(events.indexOf('outbox.approve_requested') < events.indexOf('outbox.decided'));
    const decided = lines.find((l) => l.event === 'outbox.decided') as Record<string, unknown>;
    assert.equal(decided.decision, 'approved');
    assert.equal(decided.approver_id, ADA);
    assert.equal(decided.approver_name, 'ada');
    const raw = readFileSync(path.join(rig.dir, 'audit-ruby.jsonl'), 'utf8');
    for (const secretish of ['Pat Customer', 'pat@example.com', 'Invoice 42', 'Thanks for the note', 'mm-token']) assert.ok(!raw.includes(secretish), `audit has no ${secretish}`);
  });
});

// ── rejecting ────────────────────────────────────────────────────────────────

describe('reject', () => {
  it('a 👎 from an approver marks the card rejected, sends nothing, and later 👍 cannot revive it', async () => {
    rig.sender.put(rowFor(D1));
    const b = await rig.boot();
    await rig.announce(b);
    const post = (rig.cards()[0] as { id: string }).id;
    rig.react(post, ONYE, '-1');
    await waitFor(() => rig.current(post).includes('Rejected by @onyedikachi'), 'rejected');
    assert.match(rig.current(post), /stays in the Ikenga Outbox/);
    rig.react(post, ADA, '+1');
    rig.react(post, MALLORY, '-1');
    await pause(200);
    assert.equal(approvesSent().length, 0);
    assert.ok(rig.auditLines().some((l) => l.event === 'outbox.decided' && l.decision === 'rejected' && l.approver_id === ONYE));
  });

  it('a non-approver\'s 👎 does nothing', async () => {
    rig.sender.put(rowFor(D1));
    const b = await rig.boot();
    await rig.announce(b);
    const post = (rig.cards()[0] as { id: string }).id;
    rig.react(post, MALLORY, 'thumbsdown');
    await pause(200);
    assert.ok(rig.current(post).includes('React 👍'));
  });
});

// ── edited drafts ────────────────────────────────────────────────────────────

describe('an edited draft', () => {
  it('gets a new card and the old one is marked superseded', async () => {
    const h1 = rig.sender.put(rowFor(D1));
    const b = await rig.boot();
    await rig.announce(b);
    const old = (rig.cards()[0] as { id: string }).id;
    const h2 = rig.sender.put(rowFor(D1, { body: 'Hi Pat, corrected.' }));
    assert.notEqual(h1, h2);
    await rig.announce(b);
    assert.equal(rig.cards().length, 2);
    const fresh = (rig.cards()[1] as { id: string }).id;
    assert.match(rig.current(old), /\*\*Superseded\.\*\*/);
    assert.match(rig.current(fresh), /React 👍/);
    // the superseded card can no longer approve; the new one can, with the NEW hash
    rig.react(old, ADA);
    await pause(150);
    assert.equal(approvesSent().length, 0);
    rig.react(fresh, ADA);
    await waitFor(() => approvesSent().length === 1, 'approve');
    assert.equal((approvesSent()[0] as { payloadHash: string }).payloadHash, h2);
    assert.ok(rig.auditLines().some((l) => l.event === 'outbox.superseded' && l.post_id === old && l.by_post_id === fresh));
  });

  it('an approved card whose draft is then edited is superseded, and says the approval no longer applies', async () => {
    rig.sender.put(rowFor(D1));
    const b = await rig.boot();
    await rig.announce(b);
    const old = (rig.cards()[0] as { id: string }).id;
    rig.react(old, ADA);
    await waitFor(() => rig.current(old).includes('Approved by @ada'), 'approved');
    rig.sender.put(rowFor(D1, { to: 'someone-else@example.com' }));
    await rig.announce(b);
    await waitFor(() => rig.current(old).includes('**Superseded.**'), 'superseded');
    assert.match(rig.current(old), /that approval no longer applies/);
    assert.equal(rig.cards().length, 2);
  });
});

// ── restart ──────────────────────────────────────────────────────────────────

describe('restart', () => {
  it('keeps pending cards (file mode 0600), does not repost them, and applies a 👍 made while the bridge was down', async () => {
    rig.sender.put(rowFor(D1));
    const b = await rig.boot();
    await rig.announce(b);
    const post = (rig.cards()[0] as { id: string }).id;
    const file = path.join(rig.dir, 'outbox-approvals-ruby.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).cards[post], 'card persisted');
    b.stop();
    await pause(50);

    rig.mm.addReaction({ user_id: ADA, post_id: post, emoji_name: '+1' }); // made while down
    rig.sender.announced.clear(); // the sender forgot it announced: would offer the draft again
    const b2 = await rig.boot();
    await waitFor(() => approvesSent().length === 1, 'recovered approval');
    await rig.announce(b2);
    assert.equal(rig.cards().length, 1, 'no second card');
    await waitFor(() => rig.current(post).includes('Approved by @ada'), 'card updated');
  });

  it('a decision already applied is not applied again after another restart', async () => {
    rig.sender.put(rowFor(D1));
    const b = await rig.boot();
    await rig.announce(b);
    const post = (rig.cards()[0] as { id: string }).id;
    rig.react(post, ADA);
    await waitFor(() => rig.current(post).includes('Approved by @ada'), 'approved');
    b.stop();
    await pause(50);
    const b2 = await rig.boot();
    await rig.announce(b2);
    await pause(150);
    assert.equal(approvesSent().length, 1);
  });

  it('does not replay a refused attempt on every restart', async () => {
    rig.sender.put(rowFor(D1));
    const b = await rig.boot();
    await rig.announce(b);
    const post = (rig.cards()[0] as { id: string }).id;
    rig.sender.approveReply = () => ({ ok: false, error: 'unauthorized_approver' });
    rig.react(post, ADA);
    await waitFor(() => approvesSent().length === 1, 'attempt');
    await waitFor(() => rig.current(post).includes('unauthorized_approver'), 'note');
    b.stop();
    await pause(50);
    const b2 = await rig.boot();
    await rig.announce(b2);
    await pause(150);
    assert.equal(approvesSent().length, 1, 'the old reaction is not tried again');
    assert.equal(b2.outbox?.pendingCount(), 1);
  });
});

// ── buttons ──────────────────────────────────────────────────────────────────

describe('Approve / Reject buttons', () => {
  const CALLBACK_PATH = '/outbox-approvals/ruby';

  async function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
  }

  async function withButtons() {
    const port = await freePort();
    const hash = rig.sender.put(rowFor(D1));
    const b = await rig.boot({ buttons: { callbackUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}`, listenPort: port, secret: SECRET } });
    await rig.announce(b);
    const card = rig.cards()[0] as { id: string; props?: { attachments: Array<{ actions: Array<{ id: string; integration: { url: string; context: { action: string; sig: string } } }> }> } };
    const call = (body: unknown, p = CALLBACK_PATH) =>
      fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    return { b, card, hash, call, port };
  }

  it('the card carries Approve and Reject buttons whose callback is signed over draft, hash and action', async () => {
    const { card, hash, port } = await withButtons();
    const actions = card.props?.attachments[0]?.actions ?? [];
    assert.deepEqual(actions.map((a) => a.id), ['approve', 'reject']);
    for (const a of actions) {
      assert.equal(a.integration.url, `http://127.0.0.1:${port}${CALLBACK_PATH}`);
      const want = createHmac('sha256', SECRET).update(`${D1}\n${hash}\n${a.id}`).digest('hex');
      assert.equal(a.integration.context.sig, want);
    }
    assert.ok(!JSON.stringify(card.props).includes(SECRET), 'the secret itself is never on the card');
  });

  it('Approve from an approver approves; the buttons come off the card', async () => {
    const { card, call, hash } = await withButtons();
    const approve = (card.props as NonNullable<typeof card.props>).attachments[0]?.actions[0] as NonNullable<typeof card.props>['attachments'][0]['actions'][0];
    const res = await call({ user_id: ADA, user_name: 'whoever-the-event-says', post_id: card.id, context: approve.integration.context });
    assert.equal(res.status, 200);
    assert.match(((await res.json()) as { ephemeral_text: string }).ephemeral_text, /Approved/);
    assert.equal(approvesSent().length, 1);
    assert.equal((approvesSent()[0] as { payloadHash: string }).payloadHash, hash);
    assert.deepEqual((approvesSent()[0] as { approver: unknown }).approver, { kind: 'mattermost', id: ADA });
    await waitFor(() => rig.current(card.id).includes('Approved by @ada — sending'), 'edited');
    const last = rig.mm.patches[rig.mm.patches.length - 1] as { props?: { attachments: unknown[] } };
    assert.deepEqual(last.props, { attachments: [] }, 'buttons removed');
  });

  it('Reject from an approver rejects without contacting the sender\'s approve', async () => {
    const { card, call } = await withButtons();
    const reject = (card.props as NonNullable<typeof card.props>).attachments[0]?.actions[1] as NonNullable<typeof card.props>['attachments'][0]['actions'][0];
    const res = await call({ user_id: FOUNDER, post_id: card.id, context: reject.integration.context });
    assert.match(((await res.json()) as { ephemeral_text: string }).ephemeral_text, /Rejected/);
    assert.equal(approvesSent().length, 0);
    await waitFor(() => rig.current(card.id).includes('Rejected by @chinedum'), 'rejected');
  });

  it('refuses a callback with a bad or missing signature, a signature for another action, or a forged approver', async () => {
    const { card, call } = await withButtons();
    const approve = (card.props as NonNullable<typeof card.props>).attachments[0]?.actions[0] as NonNullable<typeof card.props>['attachments'][0]['actions'][0];
    const reject = (card.props as NonNullable<typeof card.props>).attachments[0]?.actions[1] as NonNullable<typeof card.props>['attachments'][0]['actions'][0];
    assert.equal((await call({ user_id: ADA, post_id: card.id, context: { action: 'approve', sig: 'f'.repeat(64) } })).status, 403);
    assert.equal((await call({ user_id: ADA, post_id: card.id, context: { action: 'approve' } })).status, 403);
    // the reject signature does not authorise an approve
    assert.equal((await call({ user_id: ADA, post_id: card.id, context: { action: 'approve', sig: reject.integration.context.sig } })).status, 403);
    assert.equal((await call({ user_id: ADA, post_id: card.id, context: { action: 'bogus', sig: approve.integration.context.sig } })).status, 400);
    assert.equal((await call('not an object')).status, 400);
    assert.equal(approvesSent().length, 0);
    assert.equal(rig.auditLines().filter((l) => l.event === 'outbox.refused' && l.reason === 'bad_signature').length, 3);
  });

  it('a validly signed click from a non-approver or a lookalike decides nothing', async () => {
    const { card, call } = await withButtons();
    const approve = (card.props as NonNullable<typeof card.props>).attachments[0]?.actions[0] as NonNullable<typeof card.props>['attachments'][0]['actions'][0];
    for (const user_id of [MALLORY, uid('stranger'), rig.mm.botId]) {
      const res = await call({ user_id, user_name: 'ada', post_id: card.id, context: approve.integration.context });
      assert.equal(res.status, 200);
    }
    assert.equal(approvesSent().length, 0);
    assert.ok(rig.current(card.id).includes('React 👍'));
  });

  it('a click on a card that is gone, or on the wrong path, is answered without acting', async () => {
    const { card, call } = await withButtons();
    const approve = (card.props as NonNullable<typeof card.props>).attachments[0]?.actions[0] as NonNullable<typeof card.props>['attachments'][0]['actions'][0];
    const gone = await call({ user_id: ADA, post_id: 'no-such-post', context: approve.integration.context });
    assert.match(((await gone.json()) as { ephemeral_text: string }).ephemeral_text, /no longer active/);
    assert.equal((await call({ user_id: ADA, post_id: card.id, context: approve.integration.context }, '/elsewhere')).status, 404);
    assert.equal(approvesSent().length, 0);
  });

  it('a button and a reaction racing on one card approve once', async () => {
    const { card, call } = await withButtons();
    const approve = (card.props as NonNullable<typeof card.props>).attachments[0]?.actions[0] as NonNullable<typeof card.props>['attachments'][0]['actions'][0];
    rig.react(card.id, ADA);
    await call({ user_id: FOUNDER, post_id: card.id, context: approve.integration.context });
    await waitFor(() => approvesSent().length >= 1, 'approve');
    await pause(200);
    assert.equal(approvesSent().length, 1);
  });

  it('listens on loopback by default and stops listening when the bridge stops', async () => {
    const { b, port } = await withButtons();
    assert.equal(b.outbox?.buttonsPort(), port);
    b.stop();
    await pause(100);
    await assert.rejects(fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}`, { method: 'POST', body: '{}' }));
  });
});

// ── what the approver sees is what the hash covers ───────────────────────────

describe('the card is bound to what is approved', () => {
  async function withCard(over: Partial<OutboxApprovalsConfig> = {}, row = rowFor(D1, { body: 'wire the refund to 999-ATTACKER' })) {
    const hash = rig.sender.put(row);
    const b = await rig.boot(over);
    await rig.announce(b);
    const post = rig.cards()[0] as { id: string; message: string; props?: unknown };
    return { b, post, hash };
  }

  it('a card edited after it was posted (by whoever holds the bot token) cannot be approved', async () => {
    const { post } = await withCard();
    const original = rig.current(post.id);
    rig.mm.tamper(post.id, original.replace('wire the refund to 999-ATTACKER', 'Thanks for your note.'));
    rig.react(post.id, ADA);
    await waitFor(() => rig.auditLines().some((l) => l.event === 'outbox.decided' && l.reason === 'card_edited'), 'refusal audited');
    assert.equal(approvesSent().length, 0, 'nothing reached the sender');
    assert.equal(rig.sender.ofAction('approve').length, 0);
    await waitFor(() => rig.current(post.id).includes('edited after the bridge posted it'), 'card says why');
    assert.ok(rig.current(post.id).includes('999-ATTACKER'), 'the true text is put back on the card');
    assert.ok(!rig.current(post.id).includes('Thanks for your note.'));
    // and it stays dead: a second 👍 does nothing
    rig.react(post.id, FOUNDER);
    await pause(150);
    assert.equal(approvesSent().length, 0);
  });

  it('an edit that is put back before the approval is checked is still refused (edit_at is stamped)', async () => {
    const { post } = await withCard();
    const original = rig.current(post.id);
    rig.mm.tamper(post.id, 'Thanks for your note.');
    rig.mm.tamper(post.id, original);
    assert.equal(rig.current(post.id), original);
    rig.react(post.id, ADA);
    await waitFor(() => rig.auditLines().some((l) => l.reason === 'card_edited'), 'refusal audited');
    assert.equal(approvesSent().length, 0);
  });

  it('a post whose text differs from the card, with no edit stamp, is refused as well', async () => {
    const { post } = await withCard();
    (rig.mm.posts.get(post.id) as { message: string }).message = 'Thanks for your note.';
    rig.react(post.id, ADA);
    await waitFor(() => rig.auditLines().some((l) => l.reason === 'card_edited'), 'refusal audited');
    assert.equal(approvesSent().length, 0);
  });

  it('if Mattermost cannot be asked about the card, nothing is approved and the card stays open for a retry', async () => {
    const { post } = await withCard();
    rig.mm.failPostReads = true;
    rig.react(post.id, ADA);
    await waitFor(() => rig.current(post.id).includes('card_unverifiable'), 'card says it could not check');
    assert.equal(approvesSent().length, 0);
    rig.mm.failPostReads = false;
    rig.react(post.id, ADA, '-1'); // not a retry of the approval; the card is still pending, so a fresh 👍 is
    await waitFor(() => rig.current(post.id).includes('Rejected'), 'still pending, so it could be decided');
  });

  it('a failed refusal note during a Mattermost outage does not make the next, real approval read as a tampered card', async () => {
    const { post } = await withCard();
    rig.mm.failPostReads = true;
    rig.mm.failPatches = true;
    rig.react(post.id, ADA);
    await waitFor(() => rig.auditLines().some((l) => l.event === 'outbox.decided' && String(l.reason).startsWith('card_unverifiable')), 'unverifiable refusal');
    rig.mm.failPostReads = false;
    rig.mm.failPatches = false;
    rig.react(post.id, FOUNDER);
    await waitFor(() => approvesSent().length === 1, 'the retry is approved, not refused as card_edited');
    assert.ok(!rig.auditLines().some((l) => l.reason === 'card_edited'));
  });

  it('an untouched card is still approved (the check does not get in the way)', async () => {
    const { post } = await withCard();
    rig.react(post.id, ADA);
    await waitFor(() => approvesSent().length === 1, 'approve message');
  });

  it('hashed fields that do not fit on the card are never cut: the card is posted closed, with no way to approve it', async () => {
    const row = rowFor(D1, { subject: 'S'.repeat(15_000), body: 'Hi' });
    const b0 = rig.sender.put(row);
    const b = await rig.boot({ buttons: { callbackUrl: 'http://127.0.0.1:9/x', listenPort: await freePortNum(), secret: SECRET } });
    await rig.announce(b);
    const post = rig.cards()[0] as { id: string; message: string; props?: { attachments: unknown[] } };
    assert.ok(post, 'a card was posted');
    assert.ok(post.message.length <= 15_000, 'it fits in one post');
    assert.match(post.message, /cannot be approved here/);
    assert.match(post.message, /Closed|\*\*Closed\.\*\*/);
    assert.ok(!post.message.includes('(card shortened)'));
    assert.deepEqual(post.props, { attachments: [] }, 'no buttons');
    rig.react(post.id, ADA);
    await pause(200);
    assert.equal(approvesSent().length, 0, 'a 👍 on it approves nothing');
    assert.ok(rig.auditLines().some((l) => l.event === 'outbox.refused' && l.reason === 'card_too_long'));
    assert.equal(rig.sender.announced.has(`${D1}:${b0}`), true, 'it was acked, so the sender stops offering it');
  });

  it('a long To list or recipient cannot push a Cc or later field off an approvable card either', async () => {
    const row = rowFor(D1, { to: `${'a'.repeat(15_000)}@example.com`, body: 'Hi' });
    rig.sender.put(row);
    const b = await rig.boot();
    await rig.announce(b);
    const post = rig.cards()[0] as { id: string; message: string };
    assert.match(post.message, /cannot be approved here/);
    rig.react(post.id, ADA);
    await pause(200);
    assert.equal(approvesSent().length, 0);
  });

  it('when only the body is long, the body is squeezed to make the whole card fit, and the fields stay whole and approvable', async () => {
    const subject = 'T'.repeat(13_800);
    const { post } = await withCard({}, rowFor(D1, { subject, body: 'long line '.repeat(800) }));
    assert.ok(post.message.includes(subject), 'the subject is shown whole');
    assert.match(post.message, /truncated: \d+ more characters/);
    assert.ok(post.message.length <= 15_000);
    assert.ok(!/cannot be approved here/.test(post.message));
    rig.react(post.id, ADA);
    await waitFor(() => approvesSent().length === 1, 'approve message');
  });

  it('markdown in agent-controlled fields cannot hide a hashed line: the card is a code fence, rendered literally', async () => {
    const row: DraftRowForHash = {
      id: D1,
      channel: 'smtp',
      payload_json: JSON.stringify({
        item: {
          id: D1,
          recipient: 'Pat Customer',
          recipientEmail: 'pat@example.com',
          subject: 'Re: Invoice ![',
          cc: ['evil@attacker.example'],
          references: ['](https://example.com/1x1.png)'],
          body: 'thanks! ![\nPlease wire the refund to 999-ATTACKER today.\n](https://example.com/1x1.png)',
          channel: 'smtp',
          senderAddress: 'ruby@royalti.io',
        },
        meta: { agent: 'Ruby' },
      }),
      edited_json: null,
      scheduled_at: null,
    };
    const item = (JSON.parse(row.payload_json) as { item: Record<string, unknown> }).item;
    // What the sender's approver text looks like for this draft: every hashed field on its own line, then the body.
    const rendered = [
      '**Outbox Action Draft Approval Required**',
      `• **Draft ID:** ${D1}`,
      `• **Subject:** ${item.subject as string}`,
      `• **Cc:** evil@attacker.example`,
      `• **References:** ${(item.references as string[]).join(' ')}`,
      '',
      '**Body:**',
      ...(item.body as string).split('\n').map((l) => `> ${l}`),
    ].join('\n');
    rig.sender.put(row);
    rig.sender.drafts.set(D1, { row, status: 'committed', renderedText: rendered });
    const b = await rig.boot();
    await rig.announce(b);
    const post = rig.cards()[0] as { id: string; message: string };
    // Render the way Mattermost does (a marked fork) and look at what a human would actually see.
    const html = new Marked().parse(post.message, { async: false }) as string;
    const visible = html.replace(/<img[^>]*>/g, '').replace(/<[^>]+>/g, '');
    for (const must of ['Cc:** evil@attacker.example', 'Please wire the refund to 999-ATTACKER today.', '](https://example.com/1x1.png)']) {
      assert.ok(visible.includes(must), `visible after rendering: ${must}`);
    }
    assert.ok(!/<img/.test(html), 'no image is produced from the draft text');
    assert.ok(!/<a /.test(html), 'no link is produced from the draft text');
  });

  it('a backtick run in the draft cannot close the fence early: the fence is always longer', () => {
    for (const n of [1, 3, 4, 7]) {
      const shown = `before\n${'`'.repeat(n)}\n![ hidden ](http://x/y.png)`;
      assert.equal(longestBacktickRun(shown), n);
    }
    assert.equal(longestBacktickRun('no ticks'), 0);
  });

  it('text with no body marker is never cut', () => {
    const text = `**Draft**\n${'x'.repeat(10_000)}\nCc: evil@attacker.example`;
    const out = shortenRenderedText(text, 200);
    assert.ok(out.endsWith('Cc: evil@attacker.example'));
    assert.equal(out.length, text.length);
  });

  it('a button signature with multibyte characters is a 403, not a crash', async () => {
    const port = await freePortNum();
    rig.sender.put(rowFor(D1));
    const b = await rig.boot({ buttons: { callbackUrl: `http://127.0.0.1:${port}/cb`, listenPort: port, secret: SECRET } });
    await rig.announce(b);
    const card = rig.cards()[0] as { id: string };
    const res = await fetch(`http://127.0.0.1:${port}/cb`, {
      method: 'POST',
      body: JSON.stringify({ user_id: ADA, post_id: card.id, context: { action: 'approve', sig: 'é'.repeat(64) } }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 403);
    assert.ok(rig.auditLines().some((l) => l.event === 'outbox.refused' && l.reason === 'bad_signature'));
    assert.equal(approvesSent().length, 0);
  });
});

describe('an approvals-only bot', () => {
  const file = (bot: Record<string, unknown>) => ({
    mattermostUrl: 'http://mm.example',
    dataDir: '/nonexistent',
    bots: { outbox: { mattermostToken: { value: 'tok' }, allowedUsers: [], allowedChannels: [], ...bot } as never },
  });
  const block = { channel: 'royalti-co', approvers: [ADA] };

  it('loads with only outboxApprovals: no daemon, no chi', () => {
    const [bot] = resolveBridgeConfigs(file({ outboxApprovals: block }));
    assert.equal(bot?.daemon, undefined);
    assert.equal(bot?.chi, undefined);
    assert.deepEqual(bot?.outboxApprovals?.approvers, [ADA]);
  });

  it('a bot without outboxApprovals still needs daemon and chi, and a half of the pair is refused', () => {
    assert.throws(() => resolveBridgeConfigs(file({})), /daemon.url is required/);
    assert.throws(() => resolveBridgeConfigs(file({ outboxApprovals: block, chi: { engine: 'claude-code' } })), /daemon.url is required/);
    assert.throws(() => resolveBridgeConfigs(file({ outboxApprovals: block, daemon: { url: 'http://d', auth: { kind: 'bearer', token: { value: 't' } } } })), /chi.engine is required/);
  });

  it('cannot carry Chi-side features', () => {
    assert.throws(() => resolveBridgeConfigs(file({ outboxApprovals: block, approvals: { approvers: ['alice'] } })), /need daemon and chi/);
  });
});

async function freePortNum(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// ── the socket client on its own ─────────────────────────────────────────────

describe('SenderSocket', () => {
  it('speaks v1, one line per request, and maps replies and transport trouble to codes', async () => {
    const dir = tmpDir('mm-outbox-sock-');
    const sender = new FakeSender();
    const sock = await sender.listen(dir);
    const client = new SenderSocket({ socketPath: sock, timeoutMs: 500 });
    sender.put(rowFor(D1));
    const items = await client.pullAnnouncements();
    assert.equal(items.length, 1);
    assert.deepEqual((await client.getDraft(D1)).draftId, D1);
    sender.approveReply = () => ({ ok: false, error: 'unauthorized_approver' });
    await assert.rejects(client.approve(D1, 'a'.repeat(64), { kind: 'mattermost', id: ADA }), (e: { code: string; refused: boolean }) => e.code === 'unauthorized_approver' && e.refused === true);
    await assert.rejects(client.getDraft('nope'), (e: { code: string }) => e.code === 'draft_not_found');
    sender.hangUp = true;
    await assert.rejects(client.getDraft(D1), (e: { code: string; refused: boolean }) => e.code === 'socket_closed' && e.refused === false);
    await sender.close();
    await assert.rejects(client.getDraft(D1), (e: { code: string; refused: boolean }) => e.code.startsWith('socket_unreachable:') && e.refused === false);
    assert.ok(sender.received.every((m) => m.v === 1));
  });
});
