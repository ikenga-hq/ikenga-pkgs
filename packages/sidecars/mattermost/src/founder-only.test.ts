import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MattermostClient } from './client.js';
import { isCompanyUpdateDraft } from './founder-only.js';
import { MockMattermostServer } from './mock-server.js';
import { OutboxApprovals, OutboxCardStore, resolveOutboxApprovals } from './outbox-approvals.js';
import { isOutreachDraft } from './outreach.js';
import { SenderSocket } from './sender-socket.js';
import { sweepTmp, tmpDir } from './test-tmp.js';
import type { AuditLog } from './audit.js';

after(() => sweepTmp());

const ADA = ('ada' + 'x'.repeat(26)).slice(0, 26);
/** A figure that must never reach Mattermost, a log, a store file or an audit record. */
const FIGURE = 'ARR $4,812,330';
const hashOf = (n: number) => String(n).padStart(64, '0');

const textOf = (id: string, body = 'Thanks for the note.') =>
  ['**Outbox Action Draft Approval Required**', `• **Draft ID:** ${id}`, '• **Channel:** listmonk', '• **Subject:** Update', '', '**Body:**', `> ${body}`].join('\n');
const companyText = (id = 'company-update:2026-11') => textOf(id, `${FIGURE}, runway 19 months`);

type Offer = Record<string, unknown>;
const offer = (draftId: string, n: number, over: Offer = {}): Offer => ({ draftId, payloadHash: hashOf(n), renderedText: textOf(draftId), ...over });

// ── the predicate ────────────────────────────────────────────────────────────

describe('isCompanyUpdateDraft', () => {
  it('matches the company-update id in any casing, with whitespace, underscores or spaces', () => {
    for (const id of ['company-update:2026-11', 'Company-Update:2026-11', 'COMPANY-UPDATE:2026-11', '  company-update:2026-11 \n', 'company_update:2026-11', 'company update:2026-11', 'Company Update 2026-11', 'company--update:2026-11', 'company-updates:2026-11']) {
      assert.equal(isCompanyUpdateDraft({ draftId: id }), true, id);
    }
  });

  it('reads actionId and sourceKind too, in the same spellings', () => {
    const ok = { draftId: 'newsletter:2026-11' };
    assert.equal(isCompanyUpdateDraft({ ...ok, actionId: 'box/company-update' }), true);
    assert.equal(isCompanyUpdateDraft({ ...ok, actionId: ' Company_Update ' }), true);
    assert.equal(isCompanyUpdateDraft({ ...ok, sourceKind: 'company update' }), true);
    assert.equal(isCompanyUpdateDraft({ ...ok, sourceKind: 'COMPANY-UPDATE' }), true);
  });

  it('leaves the newsletter, a reply and an outreach draft alone', () => {
    assert.equal(isCompanyUpdateDraft({ draftId: 'newsletter:2026-11' }), false);
    assert.equal(isCompanyUpdateDraft({ draftId: 'ruby-reply:em-1001' }), false);
    assert.equal(isCompanyUpdateDraft({ draftId: 'outreach:5aa8df94a4d25f16' }), false);
    assert.equal(isCompanyUpdateDraft({ draftId: 'newsletter:2026-11', actionId: 'box/newsletter', sourceKind: 'newsletter' }), false);
    // Not at the start of the id: not the company update.
    assert.equal(isCompanyUpdateDraft({ draftId: 'newsletter:company-update-notes' }), false);
  });

  it('never reads the text: a body that talks about a company update is not one', () => {
    const d = { draftId: 'ruby-reply:em-1', renderedText: textOf('ruby-reply:em-1', 'the company-update draft is ready') };
    assert.equal(isCompanyUpdateDraft(d), false);
    assert.equal(isCompanyUpdateDraft({ draftId: 'x-1', renderedText: companyText('x-1') }), false, 'text alone decides nothing');
  });

  it('fails towards yes on a missing or oddly typed field', () => {
    assert.equal(isCompanyUpdateDraft({}), true);
    assert.equal(isCompanyUpdateDraft({ draftId: 7 }), true);
    assert.equal(isCompanyUpdateDraft({ draftId: null }), true);
    assert.equal(isCompanyUpdateDraft({ draftId: 'newsletter:2026-11', actionId: 5 }), true);
    assert.equal(isCompanyUpdateDraft({ draftId: 'newsletter:2026-11', sourceKind: null }), true);
  });

  it('is independent of the outreach rule: each claims its own drafts', () => {
    const co = { draftId: 'company-update:2026-11', renderedText: companyText() };
    assert.equal(isCompanyUpdateDraft(co), true);
    assert.equal(isOutreachDraft(co), false, 'the outreach rule does not claim it');
    const out = { draftId: 'outreach:5aa8df94a4d25f16', renderedText: textOf('outreach:5aa8df94a4d25f16') };
    assert.equal(isOutreachDraft(out), true);
    assert.equal(isCompanyUpdateDraft(out), false, 'and this rule does not claim an outreach draft');
  });
});

// ── a fake sender: pull_announcements, ack_announcement, get_draft ───────────

class FakeSender {
  readonly received: Array<Record<string, unknown>> = [];
  announcements: Offer[] = [];
  private readonly acked = new Set<string>();
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

  private serve(c: net.Socket): void {
    let buf = '';
    c.on('error', () => {});
    c.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      this.received.push(msg);
      c.end(`${JSON.stringify(this.answer(msg))}\n`);
    });
  }

  private answer(msg: Record<string, unknown>): Record<string, unknown> {
    switch (msg.action) {
      case 'pull_announcements':
        return { ok: true, announcements: this.announcements.filter((a) => !this.acked.has(`${a.draftId}:${a.payloadHash}`)) };
      case 'ack_announcement':
        this.acked.add(`${msg.draftId}:${msg.payloadHash}`);
        return { ok: true, draftId: msg.draftId };
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
  storeFile: string;
  logs: string[];
  audit: Array<{ event: string; fields: Record<string, unknown> }>;
  manager: () => Promise<OutboxApprovals>;
  /** One poll, however an earlier one interleaves. */
  tick: (m: OutboxApprovals) => Promise<void>;
  cards: () => Array<{ id?: string; channel_id: string; message: string }>;
  /** Everything the bridge did to Mattermost that a person could read. */
  everything: () => string;
}

let rig: Rig;

function makeRig(): Rig {
  const mm = new MockMattermostServer();
  const sender = new FakeSender();
  const dir = tmpDir('mm-founder-');
  const logs: string[] = [];
  const audit: Rig['audit'] = [];
  const storeFile = path.join(dir, 'outbox-approvals-ruby.json');
  mm.channels.set('royalti-co', 'c-royalti');
  mm.users.set(ADA, 'ada');
  let url: string | undefined;
  let socketPath: string | undefined;

  return {
    mm,
    sender,
    dir,
    storeFile,
    logs,
    audit,
    manager: async () => {
      url ??= await mm.listen();
      socketPath ??= await sender.listen(dir);
      return new OutboxApprovals({
        bot: 'ruby',
        client: new MattermostClient({ mattermostUrl: url, mattermostToken: 'mm-token', allowedUsers: [], allowedChannels: [] }),
        store: new OutboxCardStore(storeFile, 'ruby'),
        config: resolveOutboxApprovals({ channel: 'royalti-co', approvers: [ADA], socketPath, pollMs: 3_600_000 }, 'bot ruby'),
        sender: new SenderSocket({ socketPath, timeoutMs: 2000 }),
        audit: { record: (event: string, fields: Record<string, unknown> = {}) => (audit.push({ event, fields }), true), must() {}, recordCoalesced: () => true } as unknown as AuditLog,
        log: (l) => logs.push(l),
      });
    },
    tick: async (m) => {
      await m.whenIdle();
      await m.runCycle();
      await m.whenIdle();
    },
    cards: () => mm.receivedPosts.filter((p) => p.channel_id === 'c-royalti'),
    everything: () => JSON.stringify([mm.receivedPosts, mm.patches, mm.deletes, [...mm.posts.values()]]),
  };
}

beforeEach(() => {
  rig = makeRig();
});
afterEach(async () => {
  await rig.mm.close();
  await rig.sender.close();
});

const acked = () => rig.sender.ofAction('ack_announcement').map((a) => a.draftId);
const stored = () => (existsSync(rig.storeFile) ? readFileSync(rig.storeFile, 'utf8') : '');

// ── the card flow ────────────────────────────────────────────────────────────

describe('a company-update draft gets no card', () => {
  it('company-update:2026-11 alone: no card, no store record, no ack, no post, edit or delete of any kind', async () => {
    rig.sender.announcements = [offer('company-update:2026-11', 1, { renderedText: companyText() })];
    const m = await rig.manager();
    await rig.tick(m);
    await rig.tick(m);
    assert.equal(rig.mm.receivedPosts.length, 0, 'nothing posted anywhere');
    assert.equal(rig.mm.patches.length + rig.mm.deletes.length + rig.mm.posts.size + rig.mm.uploads.size, 0);
    assert.deepEqual(acked(), [], 'never acked, so the sender keeps offering it');
    assert.equal(rig.sender.ofAction('pull_announcements').length, 2, 'it was offered again on the second poll');
    assert.equal(rig.sender.ofAction('get_draft').length + rig.sender.ofAction('approve').length, 0);
    assert.equal(stored(), '', 'nothing remembered');
    assert.equal(m.pendingCount(), 0);
    assert.deepEqual(rig.audit, [], 'no audit record, so nothing for an audit mirror to post');
  });

  it('the newsletter and a normal reply draft still get their card, and are acked', async () => {
    rig.sender.announcements = [offer('newsletter:2026-11', 2), offer('ruby-reply:em-1001', 3)];
    const m = await rig.manager();
    await rig.tick(m);
    const cards = rig.cards();
    assert.equal(cards.length, 2);
    assert.ok(cards[0]?.message.includes('newsletter:2026-11'));
    assert.ok(cards[1]?.message.includes('ruby-reply:em-1001'));
    assert.deepEqual(acked(), ['newsletter:2026-11', 'ruby-reply:em-1001']);
    assert.equal(m.pendingCount(), 2);
  });

  for (const [label, id, extra] of [
    ['upper case', 'COMPANY-UPDATE:2026-11', {}],
    ['surrounding whitespace', '  company-update:2026-11\t', {}],
    ['underscore', 'company_update:2026-11', {}],
    ['space', 'company update:2026-11', {}],
    ['by actionId', 'cu-2026-11', { actionId: 'box/company-update' }],
    ['by sourceKind', 'cu-2026-11', { sourceKind: 'Company_Update' }],
  ] as const) {
    it(`is skipped by ${label}`, async () => {
      rig.sender.announcements = [offer(id, 4, { renderedText: companyText(id), ...extra })];
      const m = await rig.manager();
      await rig.tick(m);
      assert.equal(rig.mm.receivedPosts.length, 0);
      assert.deepEqual(acked(), []);
      assert.equal(stored(), '');
      assert.ok(!rig.everything().includes('4,812,330'));
    });
  }

  it('malformed announcements post nothing: an item with no usable id never leaves the socket client, and the rule is the backstop', async () => {
    rig.sender.announcements = [
      { payloadHash: hashOf(5), renderedText: companyText() },
      { draftId: 7, payloadHash: hashOf(6), renderedText: companyText() },
      { draftId: '', payloadHash: hashOf(7), renderedText: companyText() },
      { draftId: 'company-update:2026-11', payloadHash: 'not-a-hash', renderedText: companyText() },
    ];
    const m = await rig.manager();
    await rig.tick(m);
    assert.equal(rig.mm.receivedPosts.length, 0);
    assert.deepEqual(acked(), []);
    assert.equal(stored(), '');
    for (const bad of [{}, { draftId: 7 }, { draftId: 'x', actionId: 5 }]) assert.equal(isCompanyUpdateDraft(bad), true);
  });

  it('in a batch with other drafts, only the others get cards; the card cap counts cards, not skipped drafts', async () => {
    const plain = Array.from({ length: 22 }, (_, i) => offer(`ruby-reply:em-${100 + i}`, 10 + i));
    rig.sender.announcements = [offer('company-update:2026-11', 1, { renderedText: companyText() }), ...plain.slice(0, 10), offer('company-update:2026-12', 2, { renderedText: companyText('company-update:2026-12') }), ...plain.slice(10)];
    const m = await rig.manager();
    await rig.tick(m);
    assert.equal(rig.cards().length, 20, 'the cap of 20 is spent entirely on real cards');
    assert.equal(acked().length, 20);
    assert.ok(!acked().some((id) => String(id).startsWith('company-update')));
    assert.ok(!rig.everything().includes('4,812,330'));
    await rig.tick(m);
    assert.equal(rig.cards().length, 22, 'the next poll carries the rest');
    assert.equal(new Set(rig.cards().map((c) => c.message)).size, 22, 'no card twice');
    assert.equal(m.pendingCount(), 22);
    assert.ok(!stored().includes('company-update'));
  });

  it('the newsletter and the company update announced together: only the newsletter is carded', async () => {
    rig.sender.announcements = [offer('company-update:2026-11', 1, { renderedText: companyText() }), offer('newsletter:2026-11', 2)];
    const m = await rig.manager();
    await rig.tick(m);
    assert.equal(rig.cards().length, 1);
    assert.ok(rig.cards()[0]?.message.includes('newsletter:2026-11'));
    assert.deepEqual(acked(), ['newsletter:2026-11']);
  });

  it('the log note carries a count and nothing else, and is not repeated while the count stands', async () => {
    rig.sender.announcements = [offer('company-update:2026-11', 1, { renderedText: companyText() })];
    const m = await rig.manager();
    await rig.tick(m);
    await rig.tick(m);
    const notes = rig.logs.filter((l) => /founder-only/.test(l));
    assert.deepEqual(notes, ['1 founder-only draft is announced; they are approved in the Ikenga Outbox and get no card']);
    const all = rig.logs.join('\n');
    assert.ok(!/2026-11|company-update|4,812|Subject|Update/.test(all.replace(/founder-only/g, '')), 'no id, subject or text in the log');
    rig.sender.announcements.push(offer('company-update:2026-12', 2, { renderedText: companyText('company-update:2026-12') }));
    await rig.tick(m);
    assert.deepEqual(rig.logs.filter((l) => /founder-only/.test(l)).at(-1), '2 founder-only drafts are announced; they are approved in the Ikenga Outbox and get no card');
  });
});

// ── the outreach rule is unchanged ───────────────────────────────────────────

describe('the outreach rule still works beside it', () => {
  it('outreach drafts are skipped and counted as outreach, a company update is counted apart, a plain draft is carded', async () => {
    rig.sender.announcements = [
      offer('outreach:5aa8df94a4d25f16', 1, { renderedText: textOf('outreach:5aa8df94a4d25f16').replace('• **Subject:** Update', '• **Outreach assignee:** ada') }),
      offer('outreach-fu:5aa8df94a4d25f16', 2),
      offer('company-update:2026-11', 3, { renderedText: companyText() }),
      offer('ruby-reply:em-1001', 4),
    ];
    const m = await rig.manager();
    await rig.tick(m);
    assert.equal(rig.cards().length, 1);
    assert.ok(rig.cards()[0]?.message.includes('ruby-reply:em-1001'));
    assert.deepEqual(acked(), ['ruby-reply:em-1001']);
    assert.ok(rig.logs.includes('2 outreach drafts are announced; they are approved in the Ikenga Outbox and get no card'));
    assert.ok(rig.logs.includes('1 founder-only draft is announced; they are approved in the Ikenga Outbox and get no card'));
    assert.ok(!rig.everything().includes('4,812,330'));
  });
});
