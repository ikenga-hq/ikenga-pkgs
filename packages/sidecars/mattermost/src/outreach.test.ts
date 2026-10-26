import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MattermostBridge } from './bridge.js';
import { MattermostClient } from './client.js';
import { MockMattermostServer } from './mock-server.js';
import { resolveOutboxApprovals } from './outbox-approvals.js';
import { OutreachManager, OutreachStore, cardField, isOutreachDraft, localDayParts, resolveOutreach } from './outreach.js';
import type { ResolvedOutreach } from './outreach.js';
import { SenderSocket } from './sender-socket.js';
import type { OutreachEvent, OutreachPause } from './sender-socket.js';
import { sweepTmp, tmpDir } from './test-tmp.js';
import type { AuditLog } from './audit.js';
import type { MattermostReaction, OutboxApprovalsConfig } from './types.js';

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
const CHINEDUM = uid('chinedum');
const ADA = uid('ada');
const ONYE = uid('onyedikachi');
const MALLORY = uid('mallory');
const RUBY_BOT = uid('ikruby');
const FLAGGED_BOT = uid('flaggedbot');
const ADDRESS = 'pat.secret@prospect-label.example';
const HASH = 'a'.repeat(64);

// ── a fake sender: the contract's outreach actions on a temp Unix socket ─────

class FakeSender {
  readonly received: Array<Record<string, unknown>> = [];
  pause: OutreachPause | null = null;
  counts = { lagosDay: '2026-10-27', total: 12, cap: 15, pauseAt: 30, today: { ada: 5, chinedum: 7 } };
  summary: { replies: number; bounces: number; states: Record<string, number> } | undefined = { replies: 2, bounces: 1, states: { draft: 150, sent: 12, replied: 2, bounced: 1 } };
  /** The reply and bounce log: `outreach_replies` serves slices of it, and its cursor is how many were served. */
  events: OutreachEvent[] = [];
  /** Per action: answer nothing and hang up (the sender is down). `true` hangs up on everything. */
  hangUp: boolean | string = false;
  /** Per action: never answer, never hang up (a wedged sender). */
  stall: string | undefined;
  /** Drafts `pull_announcements` offers. */
  announcements: Array<{ draftId: string; payloadHash: string; renderedText: string }> = [];
  /** Who may opt a lead out. */
  optoutAllowed: (approverId: string) => boolean = () => true;
  private server = net.createServer((c) => this.serve(c));
  socketPath = '';

  async listen(dir: string): Promise<string> {
    this.socketPath = path.join(dir, 's.sock');
    await new Promise<void>((r) => this.server.listen(this.socketPath, r));
    return this.socketPath;
  }

  ofAction(action: string): Array<Record<string, unknown>> {
    return this.received.filter((m) => m.action === action);
  }

  openPause(id = 1, sentCount = 30): void {
    this.pause = { id, at: '2026-10-27T05:00:00Z', sentCount, threshold: 30, cardPostId: null };
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
      if (this.stall === msg.action) return;
      if (this.hangUp === true || this.hangUp === msg.action) return void c.destroy();
      c.end(`${JSON.stringify(this.answer(msg))}\n`);
    });
  }

  private answer(msg: Record<string, unknown>): Record<string, unknown> {
    switch (msg.action) {
      case 'outreach_status':
        return { ok: true, outreach: { pause: this.pause, counts: this.counts, rows: {}, ...(this.summary ? { summary: this.summary } : {}) } };
      case 'outreach_pause_ack':
        if (!this.pause || msg.pauseId !== this.pause.id) return { ok: false, error: 'no_such_pause' };
        this.pause.cardPostId = msg.postId as string;
        return { ok: true };
      case 'outreach_resume': {
        const approver = msg.approver as { id: string };
        if (approver.id !== CHINEDUM) return { ok: false, error: 'not_chinedum' };
        if (!this.pause) return { ok: false, error: 'no_open_pause' };
        if (msg.pauseId !== this.pause.id) return { ok: false, error: 'stale_pause_id' };
        this.pause = null;
        return { ok: true, source: 'mattermost' };
      }
      case 'outreach_replies': {
        const since = msg.since as number;
        const limit = msg.limit as number;
        const slice = this.events.slice(since, since + limit);
        return { ok: true, replies: slice, cursor: since + slice.length };
      }
      case 'outreach_optout': {
        const approver = msg.approver as { id: string };
        if (!this.optoutAllowed(approver.id)) return { ok: false, error: 'approver_not_assignee' };
        // The real reply carries the address; the bridge must never let it reach a post, a log or a file.
        return { ok: true, draftId: msg.draftId, address: ADDRESS, added: true, source: 'mattermost' };
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

const reply = (company: string, at: string, over: Partial<OutreachEvent> = {}): OutreachEvent => ({
  draftId: `outreach:${company.toLowerCase().replace(/\W/g, '').padEnd(16, '0').slice(0, 16)}`,
  company,
  assignee: 'ada',
  kind: 'reply',
  at,
  ...over,
});
const bounce = (company: string, at: string) => reply(company, at, { kind: 'bounce' });

// ── rig: a mock Mattermost, a fake sender, and managers built over them ─────

interface Rig {
  mm: MockMattermostServer;
  sender: FakeSender;
  dir: string;
  logs: string[];
  audit: Array<{ event: string; fields: Record<string, unknown> }>;
  clock: { ms: number };
  /** Start the mock Mattermost and the fake sender once; later calls return the same endpoints. */
  endpoints: () => Promise<{ url: string; socketPath: string }>;
  /** A manager over the shared store file; call again for a "restart". */
  manager: (over?: { config?: Partial<ResolvedOutreach>; botUserId?: string; timeoutMs?: number; storeFile?: string }) => Promise<OutreachManager>;
  storeFile: string;
  /** One poll, however an earlier one interleaves. */
  tick: (m: OutreachManager) => Promise<void>;
  /** The posts in the channel, oldest first. */
  posts: () => Array<{ id?: string; channel_id: string; message: string; root_id?: string; file_ids?: string[] }>;
  react: (m: OutreachManager, postId: string, user: string, emoji?: string) => Promise<void>;
}

let rig: Rig;
const T_EARLY = Date.UTC(2026, 9, 27, 5, 0); // 06:00 in Lagos: before the daily post is due

function makeRig(): Rig {
  const mm = new MockMattermostServer();
  const sender = new FakeSender();
  const dir = tmpDir('mm-outreach-');
  const logs: string[] = [];
  const audit: Rig['audit'] = [];
  const clock = { ms: T_EARLY };
  mm.channels.set('royalti-co', 'c-royalti');
  for (const [id, name] of [[CHINEDUM, 'chinedum'], [ADA, 'ada'], [ONYE, 'onyedikachi'], [MALLORY, 'mallory'], [RUBY_BOT, 'ik-ruby'], [FLAGGED_BOT, 'plainbot'], [mm.botId, 'ikenga-bot']]) mm.users.set(id as string, name as string);
  mm.bots.add(FLAGGED_BOT);
  let url: string | undefined;
  let socketPath: string | undefined;
  const storeFile = path.join(dir, 'outreach-ruby.json');

  const endpoints: Rig['endpoints'] = async () => {
    url ??= await mm.listen();
    socketPath ??= await sender.listen(dir);
    return { url, socketPath };
  };

  const manager: Rig['manager'] = async (over = {}) => {
    const { url, socketPath } = await endpoints();
    const m = new OutreachManager({
      bot: 'ruby',
      client: new MattermostClient({ mattermostUrl: url, mattermostToken: 'mm-token', allowedUsers: [], allowedChannels: [] }),
      store: new OutreachStore(over.storeFile ?? storeFile),
      config: { exportMinutes: 8 * 60, timezone: 'Africa/Lagos', pollMs: 3_600_000, ...over.config },
      channel: 'royalti-co',
      sender: new SenderSocket({ socketPath, timeoutMs: over.timeoutMs ?? 2000 }),
      audit: { record: (event: string, fields: Record<string, unknown> = {}) => (audit.push({ event, fields }), true), must() {}, recordCoalesced: () => true } as unknown as AuditLog,
      now: () => clock.ms,
      log: (l) => logs.push(l),
    });
    if (over.botUserId) m.setBotUserId(over.botUserId);
    return m;
  };

  return {
    mm,
    sender,
    dir,
    logs,
    audit,
    clock,
    endpoints,
    manager,
    storeFile,
    tick: async (m) => {
      await m.whenIdle();
      await m.runCycle();
      await m.whenIdle();
    },
    posts: () => mm.receivedPosts.filter((p) => p.channel_id === 'c-royalti'),
    react: (m, postId, user, emoji = '+1') => m.handleReaction({ user_id: user, post_id: postId, emoji_name: emoji } as MattermostReaction),
  };
}

beforeEach(() => {
  rig = makeRig();
});
afterEach(async () => {
  await rig.mm.close();
  await rig.sender.close();
});

const stored = () => JSON.parse(readFileSync(rig.storeFile, 'utf8')) as { pause: { pause_id: number; post_id: string; acked: boolean } | null; reply_cursor: number; posted: Record<string, string>; reply_cards: Record<string, { draft_id: string; done?: boolean }>; last_export_day: string | null };
/** Everything the bridge wrote down or said that must stay free of prospect data. */
const everythingSaid = () => [...rig.logs, JSON.stringify(rig.audit), JSON.stringify(rig.mm.receivedPosts), JSON.stringify([...rig.mm.posts.values()]), existsSync(rig.storeFile) ? readFileSync(rig.storeFile, 'utf8') : ''].join('\n');

// ── the pause card ───────────────────────────────────────────────────────────

describe('pause card', () => {
  it('posts one card with counts only, acks it, and does neither again on later ticks', async () => {
    rig.sender.openPause(3, 30);
    const m = await rig.manager();
    await rig.tick(m);
    await rig.tick(m);
    await rig.tick(m);
    assert.equal(rig.posts().length, 1, 'one card across three ticks');
    assert.equal(rig.posts()[0]?.message, 'Outreach sending is paused after 30 sends. 2 replies, 1 bounces so far. React with :+1: to resume. Only Chinedum can resume.');
    const acks = rig.sender.ofAction('outreach_pause_ack');
    assert.equal(acks.length, 1);
    assert.deepEqual({ ...acks[0] }, { v: 1, action: 'outreach_pause_ack', pauseId: 3, postId: rig.posts()[0]?.id });
    assert.equal(stored().pause?.acked, true);
    assert.equal(rig.audit.filter((a) => a.event === 'outreach.pause_card_posted').length, 1);
  });

  it('after a restart the card is not posted again and a 👍 on the existing card still works', async () => {
    rig.sender.openPause(1);
    const first = await rig.manager();
    await rig.tick(first);
    const cardId = rig.posts()[0]?.id as string;
    first.stop();

    const second = await rig.manager();
    await rig.tick(second);
    assert.equal(rig.posts().length, 1, 'no second card after a restart');
    assert.equal(rig.sender.ofAction('outreach_pause_ack').length, 1, 'no second ack');
    await rig.react(second, cardId, CHINEDUM);
    assert.equal(rig.sender.ofAction('outreach_resume').length, 1);
  });

  it('rebuilds the card mapping from outreach_status when the bridge has lost its own store', async () => {
    rig.sender.openPause(1);
    const first = await rig.manager();
    await rig.tick(first);
    const cardId = rig.posts()[0]?.id as string;
    first.stop();

    const fresh = await rig.manager({ storeFile: path.join(rig.dir, 'a-different-store.json') });
    await rig.react(fresh, cardId, CHINEDUM); // nothing is known yet: the card is not the current one as far as this store goes
    assert.equal(rig.sender.ofAction('outreach_resume').length, 0);
    await rig.tick(fresh);
    assert.equal(rig.posts().length, 1, 'rebuilt from pause.cardPostId, not re-posted');
    await rig.react(fresh, cardId, CHINEDUM);
    assert.equal(rig.sender.ofAction('outreach_resume').length, 1);
  });

  it('if the ack fails after the post it does not post a second card; only the ack is retried', async () => {
    rig.sender.openPause(1);
    rig.sender.hangUp = 'outreach_pause_ack';
    const m = await rig.manager();
    await rig.tick(m);
    await rig.tick(m);
    assert.equal(rig.posts().length, 1, 'still one card');
    assert.equal(rig.sender.ofAction('outreach_pause_ack').length, 2, 'the ack was retried on the next tick');
    assert.equal(stored().pause?.acked, false);
    assert.equal(stored().pause?.post_id, rig.posts()[0]?.id, 'the post id is remembered');

    // A restart in between changes nothing either.
    m.stop();
    const again = await rig.manager();
    rig.sender.hangUp = false;
    await rig.tick(again);
    assert.equal(rig.posts().length, 1);
    assert.equal(rig.sender.ofAction('outreach_pause_ack').length, 3);
    assert.equal(rig.sender.pause?.cardPostId, rig.posts()[0]?.id);
    assert.equal(stored().pause?.acked, true);
  });

  it('a failed post is not recorded and is retried, still once', async () => {
    rig.sender.openPause(1);
    rig.mm.failPostsMatching = /paused/;
    const m = await rig.manager();
    await rig.tick(m);
    assert.equal(rig.posts().length, 0);
    assert.equal(rig.sender.ofAction('outreach_pause_ack').length, 0);
    rig.mm.failPostsMatching = undefined;
    await rig.tick(m);
    await rig.tick(m);
    assert.equal(rig.posts().length, 1);
    assert.equal(rig.sender.ofAction('outreach_pause_ack').length, 1);
  });

  it('leaves out the tally when the sender sends no summary', async () => {
    rig.sender.openPause(1, 30);
    rig.sender.summary = undefined;
    const m = await rig.manager();
    await rig.tick(m);
    assert.equal(rig.posts()[0]?.message, 'Outreach sending is paused after 30 sends. React with :+1: to resume. Only Chinedum can resume.');
  });
});

describe('a reaction on the pause card', () => {
  async function paused(): Promise<{ m: OutreachManager; cardId: string }> {
    rig.sender.openPause(1);
    const m = await rig.manager({ botUserId: 'bot-12345' });
    await rig.tick(m);
    return { m, cardId: rig.posts()[0]?.id as string };
  }

  it('forwards the reactor id from the event, with the contract shape, and resumes', async () => {
    const { m, cardId } = await paused();
    await rig.react(m, cardId, CHINEDUM);
    const sent = rig.sender.ofAction('outreach_resume');
    assert.equal(sent.length, 1);
    assert.deepEqual({ ...sent[0] }, { v: 1, action: 'outreach_resume', pauseId: 1, source: 'mattermost', approver: { kind: 'mattermost', id: CHINEDUM } });
    assert.equal(rig.sender.pause, null);
    assert.deepEqual(rig.mm.thread(cardId), ['Outreach sending resumed.']);
  });

  it('forwards a non-Chinedum 👍 as it is and respects the sender refusal: log the code, nothing else', async () => {
    const { m, cardId } = await paused();
    const postsBefore = rig.mm.receivedPosts.length;
    await rig.react(m, cardId, ADA);
    const sent = rig.sender.ofAction('outreach_resume');
    assert.equal(sent.length, 1, 'the bridge does not decide who may resume');
    assert.equal((sent[0]?.approver as { id: string }).id, ADA);
    assert.ok(rig.sender.pause, 'the sender refused, so the pause stands');
    assert.ok(rig.logs.some((l) => l.includes('refused: not_chinedum')));
    assert.equal(rig.mm.receivedPosts.length, postsBefore, 'no reply, no new card');
    assert.equal(rig.mm.patches.length, 0, 'the card is not edited');
    assert.ok(!rig.logs.some((l) => l.includes(ADA)), 'the log does not say who tried');
    await rig.tick(m);
    assert.equal(rig.sender.ofAction('outreach_resume').length, 1, 'no retry on the next tick');
  });

  it('a 👍 with the thumbsup name or a skin tone counts', async () => {
    const { m, cardId } = await paused();
    await rig.react(m, cardId, ADA, 'thumbsup');
    await rig.react(m, cardId, ADA, '+1::skin-tone-3');
    assert.equal(rig.sender.ofAction('outreach_resume').length, 2);
  });

  it('a reaction on an old card does nothing: a later pause has its own card', async () => {
    const { m, cardId: oldCard } = await paused();
    rig.sender.pause = null; // resumed in the shell
    await rig.tick(m);
    rig.sender.openPause(2);
    await rig.tick(m);
    const cards = rig.posts();
    assert.equal(cards.length, 2);
    const newCard = cards[1]?.id as string;
    await rig.react(m, oldCard, CHINEDUM);
    assert.equal(rig.sender.ofAction('outreach_resume').length, 0, 'the old card is not the current pause card');
    await rig.react(m, newCard, CHINEDUM);
    assert.equal(rig.sender.ofAction('outreach_resume').length, 1);
    assert.equal(rig.sender.ofAction('outreach_resume')[0]?.pauseId, 2);
  });

  it('a reaction on a card that was never a pause card does nothing', async () => {
    const { m } = await paused();
    await rig.react(m, 'some-other-post', CHINEDUM);
    assert.equal(rig.sender.ofAction('outreach_resume').length, 0);
  });

  it('ignores bots: the bridge itself, a flagged bot account, an ik-* account', async () => {
    const { m, cardId } = await paused();
    await rig.react(m, cardId, 'bot-12345'); // the bridge's own reaction
    await rig.react(m, cardId, FLAGGED_BOT);
    await rig.react(m, cardId, RUBY_BOT);
    assert.equal(rig.sender.ofAction('outreach_resume').length, 0);
  });

  it('ignores a reactor Mattermost cannot verify', async () => {
    const { m, cardId } = await paused();
    await rig.react(m, cardId, uid('nobody')); // unknown id: 404
    rig.mm.failUserLookups = true;
    await rig.react(m, cardId, CHINEDUM);
    assert.equal(rig.sender.ofAction('outreach_resume').length, 0);
  });

  it('ignores every emoji but the two named, each only on its own card', async () => {
    const { m, cardId } = await paused();
    for (const emoji of ['heart', '-1', 'thumbsdown', 'white_check_mark', 'no_entry_sign', 'eyes']) await rig.react(m, cardId, CHINEDUM, emoji);
    assert.equal(rig.sender.ofAction('outreach_resume').length, 0);

    // And a 👍 on a reply card is not a resume.
    rig.sender.events = [reply('Acme Records', '2026-10-27T04:00:00Z')];
    await rig.tick(m);
    const replyCard = rig.posts()[1]?.id as string;
    await rig.react(m, replyCard, CHINEDUM, '+1');
    assert.equal(rig.sender.ofAction('outreach_resume').length, 0);
    assert.equal(rig.sender.ofAction('outreach_optout').length, 0);
  });
});

// ── reply and bounce cards ───────────────────────────────────────────────────

describe('reply and bounce cards', () => {
  it('posts a card per event with exactly the allowed words, and asks for events after the cursor it saved', async () => {
    rig.sender.events = [reply('Acme Records', '2026-10-27T04:00:00Z'), bounce('Globex Music', '2026-10-27T04:05:00Z', ), reply('Initech Publishing', '2026-10-27T04:10:00Z', { assignee: 'chinedum' })];
    const m = await rig.manager();
    await rig.tick(m);
    assert.deepEqual(
      rig.posts().map((p) => p.message),
      [
        'Reply from Acme Records (assigned to ada). React with :no_entry_sign: to mark do-not-contact.',
        'Bounce: Globex Music (ada)',
        'Reply from Initech Publishing (assigned to chinedum). React with :no_entry_sign: to mark do-not-contact.',
      ],
    );
    const asks = rig.sender.ofAction('outreach_replies');
    assert.equal(asks[0]?.since, 0);
    assert.equal(asks[0]?.limit, 100);
    assert.equal(stored().reply_cursor, 3);

    await rig.tick(m);
    assert.equal(rig.posts().length, 3, 'nothing new, nothing posted');
    assert.equal(rig.sender.ofAction('outreach_replies').at(-1)?.since, 3);
  });

  it('keeps the cursor across a restart: nothing is posted twice', async () => {
    rig.sender.events = [reply('Acme Records', '2026-10-27T04:00:00Z')];
    const first = await rig.manager();
    await rig.tick(first);
    first.stop();
    const second = await rig.manager();
    await rig.tick(second);
    assert.equal(rig.posts().length, 1);
    assert.equal(rig.sender.ofAction('outreach_replies').at(-1)?.since, 1);
  });

  it('a partial failure does not advance the cursor, and the retry does not double-post what was already posted', async () => {
    rig.sender.events = [reply('Acme Records', '2026-10-27T04:00:00Z'), reply('Globex Music', '2026-10-27T04:05:00Z'), reply('Initech Publishing', '2026-10-27T04:10:00Z')];
    rig.mm.failPostsMatching = /Globex/;
    const m = await rig.manager();
    await rig.tick(m);
    assert.equal(rig.posts().length, 1, 'only the first card went up');
    assert.equal(stored().reply_cursor, 0, 'the cursor stays until the whole batch is posted');
    assert.equal(Object.keys(stored().posted).length, 1);

    rig.mm.failPostsMatching = undefined;
    await rig.tick(m);
    assert.deepEqual(rig.posts().map((p) => /Reply from (\w+)/.exec(p.message)?.[1]), ['Acme', 'Globex', 'Initech'], 'each exactly once');
    assert.equal(stored().reply_cursor, 3);
    assert.equal(rig.sender.ofAction('outreach_replies').filter((a) => a.since === 0).length, 2, 'the failed batch was asked for again');
  });

  it('a restart after a partial failure does not double-post either', async () => {
    rig.sender.events = [reply('Acme Records', '2026-10-27T04:00:00Z'), reply('Globex Music', '2026-10-27T04:05:00Z')];
    rig.mm.failPostsMatching = /Globex/;
    const first = await rig.manager();
    await rig.tick(first);
    first.stop();
    rig.mm.failPostsMatching = undefined;
    const second = await rig.manager();
    await rig.tick(second);
    assert.equal(rig.posts().length, 2);
    assert.equal(new Set(rig.posts().map((p) => p.message)).size, 2);
  });

  it('a socket failure never throws out of the poll and never causes a repost storm', async () => {
    rig.sender.openPause(1);
    rig.sender.events = [reply('Acme Records', '2026-10-27T04:00:00Z')];
    const m = await rig.manager();
    await rig.tick(m);
    const posted = rig.posts().length;
    assert.equal(posted, 2);
    rig.sender.hangUp = true;
    for (let i = 0; i < 4; i++) await rig.tick(m); // must resolve, not throw
    rig.sender.hangUp = false;
    await rig.tick(m);
    await rig.tick(m);
    assert.equal(rig.posts().length, posted, 'nothing posted again after the sender came back');
  });

  it('a wedged sender times out instead of hanging the poll', async () => {
    rig.sender.stall = 'outreach_status';
    const m = await rig.manager({ timeoutMs: 150 });
    const t0 = Date.now();
    await rig.tick(m);
    assert.ok(Date.now() - t0 < 3000);
    assert.ok(rig.logs.some((l) => l.includes('socket_timeout')));
  });

  it('a reply failing in one step does not stop the others', async () => {
    rig.sender.openPause(1);
    rig.sender.events = [reply('Acme Records', '2026-10-27T04:00:00Z')];
    rig.sender.hangUp = 'outreach_replies';
    const m = await rig.manager();
    await rig.tick(m);
    assert.equal(rig.posts().length, 1, 'the pause card was posted although replies failed');
    assert.ok(rig.logs.some((l) => l.includes('reply cards failed')));
  });

  it('puts only names on a card: no address, no mention that pages the room', () => {
    assert.equal(cardField('Acme @channel Records\nsecond line'), 'Acme @​channel Records second line');
    assert.ok(!/@[a-z0-9-]+\.[a-z]/i.test(cardField(`Acme ${ADDRESS} Records`)));
    assert.ok(!cardField(`Acme ${ADDRESS}`).includes('pat.secret'));
    assert.equal(cardField('Click [here](http://x) <b>'), 'Click  here (http://x)  b ');
    assert.ok(cardField('x'.repeat(500)).length < 100);
  });

  it('keeps an address inside an event out of the channel, the store, the audit log and the logs', async () => {
    rig.sender.events = [reply(`Acme ${ADDRESS} Records`, '2026-10-27T04:00:00Z')];
    const m = await rig.manager();
    await rig.tick(m);
    assert.equal(rig.posts().length, 1);
    assert.ok(!everythingSaid().includes('pat.secret'));
  });
});

describe('the opt-out reaction', () => {
  async function withReplyCard(): Promise<{ m: OutreachManager; cardId: string; draftId: string }> {
    const ev = reply('Acme Records', '2026-10-27T04:00:00Z');
    rig.sender.events = [ev];
    const m = await rig.manager({ botUserId: 'bot-12345' });
    await rig.tick(m);
    return { m, cardId: rig.posts()[0]?.id as string, draftId: ev.draftId };
  }

  it('sends outreach_optout with the draft id and no address field, then confirms in the thread without one', async () => {
    const { m, cardId, draftId } = await withReplyCard();
    await rig.react(m, cardId, ADA, 'no_entry_sign');
    const sent = rig.sender.ofAction('outreach_optout');
    assert.equal(sent.length, 1);
    assert.deepEqual({ ...sent[0] }, { v: 1, action: 'outreach_optout', draftId, source: 'mattermost', approver: { kind: 'mattermost', id: ADA } });
    assert.ok(!('address' in (sent[0] as object)));
    assert.deepEqual(rig.mm.thread(cardId), ['Marked do-not-contact.']);
    assert.ok(!everythingSaid().includes('pat.secret'), 'the address the sender replied with went nowhere');
    assert.equal(stored().reply_cards[cardId]?.done, true);
  });

  it('a second reaction does not confirm or ask again', async () => {
    const { m, cardId } = await withReplyCard();
    await Promise.all([rig.react(m, cardId, ADA, 'no_entry_sign'), rig.react(m, cardId, CHINEDUM, 'no_entry_sign')]);
    await rig.react(m, cardId, ADA, 'no_entry_sign');
    assert.equal(rig.sender.ofAction('outreach_optout').length, 1);
    assert.equal(rig.mm.thread(cardId).length, 1);
  });

  it('a refusal is logged by its code only, posts nothing, and leaves the card usable by someone who may', async () => {
    const { m, cardId } = await withReplyCard();
    rig.sender.optoutAllowed = (id) => id === ADA;
    const postsBefore = rig.mm.receivedPosts.length;
    await rig.react(m, cardId, ONYE, 'no_entry_sign');
    assert.ok(rig.logs.some((l) => l.includes('refused: approver_not_assignee')));
    assert.equal(rig.mm.receivedPosts.length, postsBefore);
    assert.ok(!rig.logs.some((l) => l.includes(ONYE)));
    await rig.react(m, cardId, ADA, 'no_entry_sign');
    assert.deepEqual(rig.mm.thread(cardId), ['Marked do-not-contact.']);
  });

  it('ignores bots, unverifiable reactors and every other emoji', async () => {
    const { m, cardId } = await withReplyCard();
    await rig.react(m, cardId, 'bot-12345', 'no_entry_sign');
    await rig.react(m, cardId, FLAGGED_BOT, 'no_entry_sign');
    await rig.react(m, cardId, RUBY_BOT, 'no_entry_sign');
    await rig.react(m, cardId, uid('nobody'), 'no_entry_sign');
    for (const emoji of ['+1', 'thumbsup', '-1', 'heart', 'no_entry']) await rig.react(m, cardId, ADA, emoji);
    assert.equal(rig.sender.ofAction('outreach_optout').length, 0);
    assert.equal(rig.sender.ofAction('outreach_resume').length, 0);
  });

  it('works on a reply card after a restart: the mapping is persisted', async () => {
    const { m, cardId, draftId } = await withReplyCard();
    m.stop();
    const again = await rig.manager();
    await rig.react(again, cardId, ADA, 'no_entry_sign');
    assert.equal(rig.sender.ofAction('outreach_optout')[0]?.draftId, draftId);
  });

  it('a bounce card offers no opt-out: no instruction on it, and a reaction on it does nothing', async () => {
    rig.sender.events = [bounce('Globex Music', '2026-10-27T04:05:00Z')];
    const m = await rig.manager();
    await rig.tick(m);
    const card = rig.posts()[0];
    assert.equal(card?.message, 'Bounce: Globex Music (ada)');
    assert.ok(!/React|no_entry_sign|do-not-contact/.test(card?.message ?? ''));
    await rig.react(m, card?.id as string, ADA, 'no_entry_sign');
    assert.equal(rig.sender.ofAction('outreach_optout').length, 0);
    assert.equal(Object.keys(stored().reply_cards).length, 0);
  });

  it('a reaction on a post that is not a reply card does nothing', async () => {
    const { m } = await withReplyCard();
    await rig.react(m, 'a-random-post', ADA, 'no_entry_sign');
    assert.equal(rig.sender.ofAction('outreach_optout').length, 0);
  });
});

// ── the daily post ───────────────────────────────────────────────────────────

describe('daily export post', () => {
  const at = (iso: string) => (rig.clock.ms = Date.parse(iso));
  const summaries = () => rig.posts().filter((p) => p.message.startsWith('**Outreach summary'));

  it('is posted once per Lagos day, at the configured time or after, and never before', async () => {
    const m = await rig.manager();
    at('2026-10-27T06:59:00Z'); // 07:59 in Lagos
    await rig.tick(m);
    assert.equal(summaries().length, 0, 'not yet due');

    at('2026-10-27T07:00:00Z'); // 08:00 in Lagos
    await rig.tick(m);
    assert.equal(summaries().length, 1);
    at('2026-10-27T22:30:00Z'); // 23:30, same Lagos day
    await rig.tick(m);
    await rig.tick(m);
    assert.equal(summaries().length, 1, 'once for the day');

    at('2026-10-27T23:30:00Z'); // 00:30 on the 28th in Lagos: a new day, but before 08:00
    await rig.tick(m);
    assert.equal(summaries().length, 1);

    at('2026-10-28T07:00:00Z');
    await rig.tick(m);
    assert.equal(summaries().length, 2, 'the next day');
    assert.equal(stored().last_export_day, '2026-10-28');
  });

  it('a restart on the same day does not post again', async () => {
    const first = await rig.manager();
    at('2026-10-27T09:00:00Z');
    await rig.tick(first);
    first.stop();
    const second = await rig.manager();
    await rig.tick(second);
    assert.equal(summaries().length, 1);
  });

  it('reports counts only: sends per sender, total, replies, bounces and the status counts', async () => {
    rig.sender.events = [reply('Acme Records', '2026-10-27T04:00:00Z')];
    const m = await rig.manager();
    at('2026-10-27T07:00:00Z');
    await rig.tick(m);
    assert.equal(
      summaries()[0]?.message,
      [
        '**Outreach summary for 2026-10-27**',
        'Sent today: Ada 5, Chinedum 7.',
        'Sent in total: 12 (pause at 30).',
        'Replies: 2. Bounces: 1.',
        'By status: draft 150, sent 12, replied 2, bounced 1.',
      ].join('\n'),
    );
    assert.ok(!summaries()[0]?.message.includes('Acme'), 'no company, no address');
  });

  it('says when sending is paused', async () => {
    rig.sender.openPause(1, 30);
    const m = await rig.manager();
    at('2026-10-27T07:00:00Z');
    await rig.tick(m);
    assert.match(summaries()[0]?.message ?? '', /Sending is paused after 30 sends\./);
  });

  it('honours a configured time and time zone', async () => {
    const m = await rig.manager({ config: { exportMinutes: 9 * 60 + 30, timezone: 'UTC' } });
    at('2026-10-27T09:29:00Z');
    await rig.tick(m);
    assert.equal(summaries().length, 0);
    at('2026-10-27T09:30:00Z');
    await rig.tick(m);
    assert.equal(summaries().length, 1);
    assert.match(summaries()[0]?.message ?? '', /for 2026-10-27/);
    assert.deepEqual(localDayParts(Date.parse('2026-10-27T23:30:00Z'), 'Africa/Lagos'), { day: '2026-10-28', minutes: 30 });
  });

  describe('the export file', () => {
    const exportDir = () => path.join(rig.dir, 'export');
    function writeExport(name: string): string {
      mkdirSync(exportDir(), { recursive: true });
      const p = path.join(exportDir(), name);
      writeFileSync(p, 'company,sender,sent_at,status,replied_at\nAcme Records,Ada,2026-10-26T09:00:00Z,sent,\n');
      return p;
    }

    it('is attached when it exists and is readable', async () => {
      const file = writeExport('outreach-status.csv');
      const m = await rig.manager({ config: { exportPath: file } });
      at('2026-10-27T07:00:00Z');
      await rig.tick(m);
      assert.equal(rig.mm.uploads.size, 1);
      const [id, up] = [...rig.mm.uploads.entries()][0] as [string, { channel_id: string; filename: string }];
      assert.equal(up.filename, 'outreach-status.csv');
      assert.equal(up.channel_id, 'c-royalti');
      assert.deepEqual(summaries()[0]?.file_ids, [id]);
    });

    it('takes {day} to mean the local day, because the sender names its files by day', async () => {
      writeExport('outreach-status-2026-10-27.csv');
      const m = await rig.manager({ config: { exportPath: path.join(exportDir(), 'outreach-status-{day}.csv') } });
      at('2026-10-27T07:00:00Z');
      await rig.tick(m);
      assert.equal([...rig.mm.uploads.values()][0]?.filename, 'outreach-status-2026-10-27.csv');
    });

    it('is not attached when it is missing or unreadable: the summary still goes up, the log says why, the channel does not', async () => {
      const m = await rig.manager({ config: { exportPath: path.join(exportDir(), 'missing.csv') } });
      at('2026-10-27T07:00:00Z');
      await rig.tick(m);
      assert.equal(summaries().length, 1);
      assert.equal(summaries()[0]?.file_ids, undefined);
      assert.equal(rig.mm.uploads.size, 0);
      assert.ok(rig.logs.some((l) => l.includes('export file not attached (ENOENT)')));
      assert.ok(!summaries()[0]?.message.includes('not attached'));

      mkdirSync(path.join(exportDir(), 'is-a-directory.csv'), { recursive: true }); // present but not a readable file
      const m2 = await rig.manager({ config: { exportPath: path.join(exportDir(), 'is-a-directory.csv') }, storeFile: path.join(rig.dir, 'second.json') });
      at('2026-10-28T07:00:00Z');
      await rig.tick(m2);
      assert.equal(summaries().length, 2);
      assert.equal(summaries()[1]?.file_ids, undefined);
      assert.ok(rig.logs.some((l) => l.includes('export file not attached (not_a_file)')));
    });

    it('still posts the summary when the upload fails, and never logs the file contents', async () => {
      const file = writeExport('outreach-status.csv');
      rig.mm.failUploads = true;
      const m = await rig.manager({ config: { exportPath: file } });
      at('2026-10-27T07:00:00Z');
      await rig.tick(m);
      assert.equal(summaries().length, 1);
      assert.equal(summaries()[0]?.file_ids, undefined);
      assert.ok(rig.logs.some((l) => l.includes('export file not attached')));
      assert.ok(!everythingSaid().includes('Acme Records'), 'the file contents are not read into logs or posts');
    });
  });

  it('a failed post is not counted as posted: it is retried, and goes up once', async () => {
    const m = await rig.manager();
    at('2026-10-27T07:00:00Z');
    rig.mm.failPostsMatching = /Outreach summary/;
    await rig.tick(m);
    assert.equal(summaries().length, 0);
    assert.equal(existsSync(rig.storeFile) ? stored().last_export_day : null, null);
    rig.mm.failPostsMatching = undefined;
    await rig.tick(m);
    await rig.tick(m);
    assert.equal(summaries().length, 1);
  });
});

// ── no per-draft cards for outreach ──────────────────────────────────────────

const plainText = (id: string, body = 'Thanks for the note.') =>
  ['**Outbox Action Draft Approval Required**', `• **Draft ID:** ${id}`, '• **Channel:** smtp', '• **To:** Pat Customer <pat@example.com>', '• **Subject:** Re: Invoice 42', '', '**Body:**', `> ${body}`].join('\n');
const outreachText = (id: string) =>
  ['**Outbox Action Draft Approval Required**', `• **Draft ID:** ${id}`, '• **Channel:** smtp', `• **To:** Someone <${ADDRESS}>`, '• **Subject:** Hello', '• **Outreach assignee:** ada', '• **Outreach template:** A', '', '**Body:**', '> Hi'].join('\n');

describe('outreach drafts get no per-draft card', () => {
  it('isOutreachDraft: the id prefixes, the action, the source kind, the field labels, and anything doubtful', () => {
    const ok = { draftId: 'ruby-reply:em-1', renderedText: plainText('ruby-reply:em-1') };
    assert.equal(isOutreachDraft(ok), false);
    assert.equal(isOutreachDraft({ ...ok, renderedText: plainText('ruby-reply:em-1', 'we run outreach campaigns; Outreach assignee: ada') }), false, 'talking about outreach in the body is not outreach');

    assert.equal(isOutreachDraft({ draftId: 'outreach:5aa8df94a4d25f16', renderedText: plainText('x') }), true);
    assert.equal(isOutreachDraft({ draftId: 'outreach-fu:5aa8df94a4d25f16', renderedText: plainText('x') }), true);
    assert.equal(isOutreachDraft({ draftId: ' OUTREACH:5aa8df94a4d25f16', renderedText: plainText('x') }), true);
    assert.equal(isOutreachDraft({ ...ok, actionId: 'ruby/outreach-email' }), true);
    assert.equal(isOutreachDraft({ ...ok, sourceKind: 'outreach_email' }), true);
    assert.equal(isOutreachDraft({ draftId: 'd-1', renderedText: outreachText('d-1') }), true, 'by its field labels, whatever its id');
    assert.equal(isOutreachDraft({ draftId: 'd-1', renderedText: plainText('d-1').replace('• **Channel:** smtp', '• **Sender address:** outreach:adaugo') }), true);

    // In doubt, it is outreach.
    assert.equal(isOutreachDraft({ renderedText: plainText('x') }), true);
    assert.equal(isOutreachDraft({ draftId: 7, renderedText: plainText('x') }), true);
    assert.equal(isOutreachDraft({ draftId: 'd-1' }), true);
    assert.equal(isOutreachDraft({ draftId: 'd-1', renderedText: 42 }), true);
    assert.equal(isOutreachDraft({ ...ok, actionId: 5 }), true);
    assert.equal(isOutreachDraft({ ...ok, sourceKind: null }), true);
  });

  async function boot(outreach: OutboxApprovalsConfig['outreach'] | undefined): Promise<MattermostBridge> {
    const { url, socketPath } = await rig.endpoints();
    const b = new MattermostBridge({
      name: 'ruby',
      mattermostUrl: url,
      mattermostToken: 'mm-token',
      allowedUsers: [],
      allowedChannels: [],
      dataDir: rig.dir,
      outboxApprovals: { channel: 'royalti-co', approvers: [ADA, CHINEDUM], socketPath, pollMs: 3_600_000, ...(outreach ? { outreach } : {}) },
    });
    await b.start();
    bridges.push(b);
    await waitFor(() => rig.mm.clientCount > 0, 'websocket');
    return b;
  }
  const bridges: MattermostBridge[] = [];
  afterEach(() => {
    for (const b of bridges.splice(0)) b.stop();
  });
  async function announce(b: MattermostBridge): Promise<void> {
    const o = b.outbox as NonNullable<MattermostBridge['outbox']>;
    await o.whenIdle();
    await o.runCycle();
    await o.whenIdle();
  }

  const offered = () => [
    { draftId: 'outreach:5aa8df94a4d25f16', payloadHash: HASH, renderedText: outreachText('outreach:5aa8df94a4d25f16') },
    { draftId: 'outreach-fu:5aa8df94a4d25f16', payloadHash: 'b'.repeat(64), renderedText: outreachText('outreach-fu:5aa8df94a4d25f16') },
    { draftId: 'odd-id-1', payloadHash: 'c'.repeat(64), renderedText: outreachText('odd-id-1') },
    { draftId: 'ruby-reply:em-1001', payloadHash: 'd'.repeat(64), renderedText: plainText('ruby-reply:em-1001') },
  ];

  for (const [label, outreach] of [['no outreach block', undefined], ['outreach disabled', { enabled: false }], ['outreach enabled', { enabled: true }]] as const) {
    it(`posts the plain Ruby draft and none of the outreach drafts (${label}), and never puts a prospect address in the channel`, async () => {
      rig.sender.announcements = offered();
      const b = await boot(outreach);
      await announce(b);
      const cards = rig.posts();
      assert.equal(cards.length, 1, 'one card, for the plain draft');
      assert.ok(cards[0]?.message.includes('ruby-reply:em-1001'));
      assert.ok(!JSON.stringify(rig.mm.receivedPosts).includes('prospect-label'));
      const acked = rig.sender.ofAction('ack_announcement').map((a) => a.draftId);
      assert.deepEqual(acked, ['ruby-reply:em-1001'], 'outreach drafts are not acked, so the sender keeps offering them');
      assert.ok(!existsSync(path.join(rig.dir, 'outbox-approvals-ruby.json')) || !readFileSync(path.join(rig.dir, 'outbox-approvals-ruby.json'), 'utf8').includes('prospect-label'));
    });
  }
});

// ── disabled means unchanged ─────────────────────────────────────────────────

describe('outreach disabled', () => {
  const ok: OutboxApprovalsConfig = { channel: 'royalti-co', approvers: [ADA] };

  it('resolves to no outreach at all when the block is absent or not enabled', () => {
    assert.equal(resolveOutboxApprovals(ok, "bot 'ruby'").outreach, undefined);
    assert.equal(resolveOutboxApprovals({ ...ok, outreach: {} }, "bot 'ruby'").outreach, undefined);
    assert.equal(resolveOutboxApprovals({ ...ok, outreach: { enabled: false, exportPath: '/x/y.csv' } }, "bot 'ruby'").outreach, undefined);
    assert.ok(resolveOutboxApprovals({ ...ok, outreach: { enabled: true } }, "bot 'ruby'").outreach);
    assert.deepEqual(Object.keys(resolveOutboxApprovals(ok, "bot 'ruby'")).sort(), ['approvers', 'bodyMaxChars', 'channel', 'pollMs', 'requestTimeoutMs', 'socketPath']);
  });

  async function run(outreach: OutboxApprovalsConfig['outreach'] | undefined): Promise<{ actions: string[]; cards: Array<{ message: string; props?: unknown }>; files: string[]; hasOutreach: boolean }> {
    const r = makeRig();
    try {
      r.sender.openPause(1);
      r.sender.events = [reply('Acme Records', '2026-10-27T04:00:00Z')];
      r.sender.announcements = [{ draftId: 'ruby-reply:em-1001', payloadHash: 'd'.repeat(64), renderedText: plainText('ruby-reply:em-1001') }];
      const url = await r.mm.listen();
      const socketPath = await r.sender.listen(r.dir);
      const b = new MattermostBridge({
        name: 'ruby',
        mattermostUrl: url,
        mattermostToken: 'mm-token',
        allowedUsers: [],
        allowedChannels: [],
        dataDir: r.dir,
        outboxApprovals: { channel: 'royalti-co', approvers: [ADA], socketPath, pollMs: 3_600_000, ...(outreach ? { outreach } : {}) },
      });
      await b.start();
      const o = b.outbox as NonNullable<MattermostBridge['outbox']>;
      await o.whenIdle();
      await o.runCycle();
      await o.whenIdle();
      await b.outreach?.whenIdle();
      await b.outreach?.runCycle();
      b.stop();
      const { readdirSync } = await import('node:fs');
      return {
        actions: [...new Set(r.sender.received.map((m) => m.action as string))].sort(),
        cards: r.posts().map((p) => ({ message: p.message, props: (p as { props?: unknown }).props })),
        files: readdirSync(r.dir).filter((f) => !f.endsWith('.sock')).sort(),
        hasOutreach: Boolean(b.outreach),
      };
    } finally {
      await r.mm.close();
      await r.sender.close();
    }
  }

  it('absent and enabled:false behave the same as before: same socket actions, same cards, same files, no outreach manager', async () => {
    const absent = await run(undefined);
    const off = await run({ enabled: false, exportPath: '/var/lib/x/{day}.csv' });
    assert.deepEqual(absent.actions, ['ack_announcement', 'pull_announcements']);
    assert.deepEqual(off, absent);
    assert.equal(absent.hasOutreach, false);
    assert.ok(!absent.files.some((f) => f.startsWith('outreach')), 'no outreach state file');
    assert.equal(absent.cards.length, 1);
  });

  it('enabled adds the outreach actions and leaves the draft card as it was', async () => {
    const absent = await run(undefined);
    const on = await run({ enabled: true });
    assert.equal(on.hasOutreach, true);
    for (const a of ['outreach_status', 'outreach_replies', 'outreach_pause_ack']) assert.ok(on.actions.includes(a), a);
    const draftCard = on.cards.find((c) => c.message.includes('ruby-reply:em-1001'));
    assert.deepEqual(draftCard, absent.cards[0], 'the plain draft card is byte for byte the same');
  });
});

// ── config ───────────────────────────────────────────────────────────────────

describe('outreach config', () => {
  const where = "bot 'ruby'";

  it('applies the defaults when enabled', () => {
    const r = resolveOutreach({ enabled: true }, where, 30_000);
    assert.deepEqual(r, { exportMinutes: 480, timezone: 'Africa/Lagos', pollMs: 30_000 });
  });

  it('takes its own values', () => {
    const r = resolveOutreach({ enabled: true, exportPath: '/srv/export/outreach-status-{day}.csv', exportLocalTime: '17:45', timezone: 'Europe/London', pollMs: 60_000 }, where, 30_000);
    assert.deepEqual(r, { exportPath: '/srv/export/outreach-status-{day}.csv', exportMinutes: 17 * 60 + 45, timezone: 'Europe/London', pollMs: 60_000 });
  });

  it('refuses a malformed block, naming the bot and the field, even when it is not enabled', () => {
    const bad: Array<[unknown, RegExp]> = [
      ['yes', /outreach must be an object/],
      [[], /outreach must be an object/],
      [{ enabled: 'yes' }, /outreach.enabled must be true or false/],
      [{ enabled: true, extra: 1 }, /unknown field 'extra'/],
      [{ enabled: false, mattermost: 'x' }, /unknown field 'mattermost'/],
      [{ exportPath: 'relative/export.csv' }, /exportPath must be an absolute path/],
      [{ exportPath: 5 }, /exportPath must be an absolute path/],
      [{ exportLocalTime: '8am' }, /exportLocalTime must be a 24-hour time/],
      [{ exportLocalTime: '24:00' }, /exportLocalTime must be a 24-hour time/],
      [{ exportLocalTime: '08:60' }, /exportLocalTime must be a 24-hour time/],
      [{ timezone: 'Mars/Olympus' }, /timezone 'Mars\/Olympus' is not a known time zone/],
      [{ timezone: '' }, /timezone must be an IANA time zone/],
      [{ pollMs: 10 }, /pollMs must be a whole number/],
      [{ pollMs: 1.5 }, /pollMs must be a whole number/],
      [{ pollMs: 'fast' }, /pollMs must be a whole number/],
    ];
    for (const [cfg, re] of bad) assert.throws(() => resolveOutreach(cfg, where, 30_000), re, JSON.stringify(cfg));
    assert.throws(() => resolveOutboxApprovals({ channel: 'x', approvers: [ADA], outreach: { exportLocalTime: 'noon' } }, where), /bot 'ruby': outboxApprovals.outreach.exportLocalTime/);
  });

  it('inherits pollMs from the outbox block unless it sets its own', () => {
    assert.equal(resolveOutboxApprovals({ channel: 'x', approvers: [ADA], pollMs: 45_000, outreach: { enabled: true } }, where).outreach?.pollMs, 45_000);
    assert.equal(resolveOutboxApprovals({ channel: 'x', approvers: [ADA], pollMs: 45_000, outreach: { enabled: true, pollMs: 5000 } }, where).outreach?.pollMs, 5000);
  });
});

// ── the wiring: reactions arrive over the websocket ──────────────────────────

describe('through the bridge', () => {
  const bridges: MattermostBridge[] = [];
  afterEach(() => {
    for (const b of bridges.splice(0)) b.stop();
  });

  async function boot(): Promise<MattermostBridge> {
    const { url, socketPath } = await rig.endpoints();
    const b = new MattermostBridge({
      name: 'ruby',
      mattermostUrl: url,
      mattermostToken: 'mm-token',
      allowedUsers: [],
      allowedChannels: [],
      dataDir: rig.dir,
      outboxApprovals: { channel: 'royalti-co', approvers: [ADA], socketPath, pollMs: 3_600_000, outreach: { enabled: true } },
    });
    await b.start();
    bridges.push(b);
    await waitFor(() => rig.mm.clientCount > 0, 'websocket');
    return b;
  }

  it('a 👍 on the pause card and a :no_entry_sign: on a reply card reach the sender; the bridge restarts without reposting', async () => {
    rig.sender.openPause(1);
    const ev = reply('Acme Records', '2026-10-27T04:00:00Z');
    rig.sender.events = [ev];
    const b = await boot();
    await b.outreach?.whenIdle();
    await b.outreach?.runCycle();
    await b.outreach?.whenIdle();
    const [pauseCard, replyCard] = rig.posts();
    assert.ok(pauseCard && replyCard);

    rig.mm.broadcastReaction({ user_id: CHINEDUM, post_id: pauseCard.id as string, emoji_name: '+1' });
    await waitFor(() => rig.sender.ofAction('outreach_resume').length === 1, 'resume');
    assert.equal((rig.sender.ofAction('outreach_resume')[0]?.approver as { id: string }).id, CHINEDUM);

    rig.mm.broadcastReaction({ user_id: ADA, post_id: replyCard.id as string, emoji_name: 'no_entry_sign' });
    await waitFor(() => rig.sender.ofAction('outreach_optout').length === 1, 'opt-out');
    assert.equal(rig.sender.ofAction('outreach_optout')[0]?.draftId, ev.draftId);

    // Restart: same data dir, nothing new to say.
    b.stop();
    const postsBefore = rig.mm.receivedPosts.length;
    rig.sender.openPause(2);
    const again = await boot();
    await again.outreach?.whenIdle();
    await again.outreach?.runCycle();
    await again.outreach?.whenIdle();
    const fresh = rig.mm.receivedPosts.slice(postsBefore).filter((p) => p.channel_id === 'c-royalti');
    assert.equal(fresh.length, 1, 'only the new pause got a card; the reply was not posted again');
    assert.match(fresh[0]?.message ?? '', /^Outreach sending is paused/);
  });

  it('the bridge reaction listener ignores its own reactions (botUserId from getMe)', async () => {
    rig.sender.openPause(1);
    const b = await boot();
    await b.outreach?.whenIdle();
    await b.outreach?.runCycle();
    await b.outreach?.whenIdle();
    const card = rig.posts()[0]?.id as string;
    rig.mm.broadcastReaction({ user_id: rig.mm.botId, post_id: card, emoji_name: '+1' });
    await pause(200);
    assert.equal(rig.sender.ofAction('outreach_resume').length, 0);
  });
});
