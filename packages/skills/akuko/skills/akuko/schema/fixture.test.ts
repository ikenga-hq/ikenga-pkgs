// The Beating — the reference board fixture converted to akuko.json.
// The committed akuko.json must be exactly what the converter produces.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { AkukoProjectSchema } from './akuko-project.ts';
import { checkIntegrity } from './integrity.ts';
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  convertBoardFixture,
  serialize,
} from '../fixtures/convert-fixture.ts';

const board = JSON.parse(readFileSync(DEFAULT_INPUT, 'utf8'));
const committed = readFileSync(DEFAULT_OUTPUT, 'utf8');

describe('board fixture conversion', () => {
  const p = convertBoardFixture(board);

  it('re-running the converter reproduces the committed akuko.json byte for byte', () => {
    assert.equal(serialize(p), committed);
  });

  it('the result is a schema-valid, internally consistent project', () => {
    assert.equal(AkukoProjectSchema.safeParse(JSON.parse(committed)).success, true);
    assert.deepEqual(checkIntegrity(p), []);
  });

  it('keeps every shot, scene and bible entry', () => {
    assert.equal(p.shots.length, 12);
    assert.equal(p.scenes.length, 4);
    assert.deepEqual(p.shots.map((s) => s.id), board.shots.map((s: { id: string }) => s.id));
    assert.deepEqual(p.bible.characters.map((c) => c.id), ['char_narrator', 'char_oldman', 'char_officers']);
    assert.deepEqual(p.bible.styles[0]?.notes.length, 4);
  });

  it('carries the review state: statuses, the change request, the spend gate and the ledger', () => {
    assert.equal(p.current_stage, 'sketch');
    assert.equal(p.stages.keyframes.state, 'waiting-spend');
    const sh3 = p.shots.find((s) => s.id === 'sc2_sh3');
    assert.equal(sh3?.status, 'needs-rework');
    assert.equal(sh3?.comments[0]?.text.startsWith('He should bolt up'), true);
    assert.deepEqual(p.shots.filter((s) => s.status === 'pending-review').map((s) => s.id), ['sc2_sh4', 'sc4_sh2']);
    assert.equal(p.bible.characters[2]?.status, 'pending', 'not-started bible entries are pending');
    assert.deepEqual(p.pending_spend.map((j) => [j.id, j.estimate, j.status]), [['job_kf_sc1', 0.36, 'awaiting-approval']]);
    assert.equal(p.ledger.length, 6);
    assert.equal(p.ledger[0]?.unit, 'char_narrator_portrait');
    assert.equal(p.budget?.spent, 0.84);
  });

  it('gives each bible asset an id and lists it on its entry', () => {
    assert.deepEqual(p.bible.characters[1]?.refs, ['char_oldman_portrait', 'char_oldman_turnaround']);
    const turn = p.assets.find((a) => a.id === 'char_oldman_turnaround');
    assert.deepEqual([turn?.kind, turn?.owner, turn?.status], ['turnaround', 'char_oldman', 'pending-review']);
  });

  it('maps board shot types and moves', () => {
    const byId = new Map(p.shots.map((s) => [s.id, s]));
    assert.equal(byId.get('sc1_sh1')?.shot_type, 'ws');
    assert.equal(byId.get('sc3_sh1')?.shot_type, 'overhead');
    assert.equal(byId.get('sc1_sh3')?.camera_move, 'push-in');
    assert.equal(byId.get('sc4_sh4')?.camera_move, 'whip-pan');
    assert.equal(byId.get('sc1_sh1')?.camera_move, 'unset');
  });

  it('fails loudly on a field the mapping does not know', () => {
    const extra = structuredClone(board);
    extra.shots[0].lens = '35mm';
    assert.throws(() => convertBoardFixture(extra));
    const move = structuredClone(board);
    move.shots[0].move = 'barrel-roll';
    assert.throws(() => convertBoardFixture(move), /unknown camera move/);
  });
});
