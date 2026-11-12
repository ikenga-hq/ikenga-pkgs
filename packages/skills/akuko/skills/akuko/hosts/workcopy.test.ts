// akuko — host-A working copy (hosts/workcopy.ts): uris mapped to local files and back, nothing else changed.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BOARD_FILE, blobId, localize, pendingUploads, restore, run } from './workcopy.ts';

const BLOB = 'a'.repeat(32);
const doc = () => ({
  format: 'akuko',
  assets: [
    { id: 'sc1_sh1_keyframe', file: { uri: `/_blob/${BLOB}`, mime: 'image/png' } },
    { id: 'char_n_portrait', file: { uri: `https://claude.ai/_blob/${'b'.repeat(32)}`, mime: 'image/png' } },
  ],
  shots: [{ id: 'sc1_sh1', by_stage: { keyframes: { output: { uri: `/_blob/${BLOB}` } } } }],
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'akuko-workcopy-'));
  const work = join(root, 'work');
  const media = join(root, 'downloads');
  mkdirSync(work);
  mkdirSync(media);
  writeFileSync(join(work, 'akuko.json'), JSON.stringify(doc()));
  writeFileSync(join(media, `${BLOB}.png`), 'png-bytes');
  return { work, media };
}

describe('host-A working copy', () => {
  it('reads blob ids from relative and absolute asset urls', () => {
    assert.equal(blobId(`/_blob/${BLOB}`), BLOB);
    assert.equal(blobId(`https://claude.ai/_blob/${BLOB}?x=1`), BLOB);
    assert.equal(blobId('keyframes/sc1.png'), undefined);
  });

  it('localize points every uri of a downloaded blob at its local copy and says which were not downloaded', () => {
    const { work, media } = setup();
    const r = localize(work, media);
    assert.deepEqual(r.localized, [`media/${BLOB}.png`]);
    assert.equal(r.missing.length, 1);
    const p = JSON.parse(readFileSync(join(work, 'akuko.json'), 'utf8'));
    assert.equal(p.assets[0].file.uri, `media/${BLOB}.png`);
    assert.equal(p.shots[0].by_stage.keyframes.output.uri, `media/${BLOB}.png`);
    assert.equal(readFileSync(join(work, `media/${BLOB}.png`), 'utf8'), 'png-bytes');
  });

  it('uploads lists only the files the commands made; restore puts originals and uploaded urls back', () => {
    const { work, media } = setup();
    localize(work, media);
    const p = JSON.parse(readFileSync(join(work, 'akuko.json'), 'utf8'));
    p.assets.push({ id: 'sc1_sh1_clip', file: { uri: 'motion/sc1_sh1_clip.mp4', mime: 'video/mp4' } });
    writeFileSync(join(work, 'akuko.json'), JSON.stringify(p));
    assert.deepEqual(pendingUploads(work), ['motion/sc1_sh1_clip.mp4']);

    const blocked = restore(work, {});
    assert.deepEqual(blocked.left, ['motion/sc1_sh1_clip.mp4'], 'nothing written while a new file is not uploaded');
    assert.throws(() => restore(work, { 'motion/sc1_sh1_clip.mp4': 'motion/sc1_sh1_clip.mp4' }), /artifact asset url/);

    const ok = restore(work, { 'motion/sc1_sh1_clip.mp4': `/_blob/${'c'.repeat(32)}` });
    assert.equal(ok.path, join(work, BOARD_FILE));
    const board = JSON.parse(readFileSync(ok.path, 'utf8'));
    assert.equal(board.assets[0].file.uri, `/_blob/${BLOB}`);
    assert.equal(board.assets[1].file.uri, `https://claude.ai/_blob/${'b'.repeat(32)}`);
    assert.equal(board.assets[2].file.uri, `/_blob/${'c'.repeat(32)}`);
    assert.equal(board.shots[0].by_stage.keyframes.output.uri, `/_blob/${BLOB}`);
  });

  it('the command refuses without a working copy', () => {
    assert.equal(run(['localize'], () => {}), 2);
    assert.equal(run(['localize', '--project', mkdtempSync(join(tmpdir(), 'akuko-wc-'))], () => {}), 2);
  });
});
