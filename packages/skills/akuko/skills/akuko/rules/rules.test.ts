// WP-26 — project rules: matching, every rule type, references by hash, and
// the guard in front of the spend gate. Synthetic rules and files only.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Job, JobHandle } from '../providers/contract.ts';
import type { QuoteResult, RunResult, SpendGate } from '../spend/gate.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { checkJob, checkProjectRules, type Breach } from './check.ts';
import { RULES_BREACH, RULES_MISSING, guardGate, guardedGate } from './guard.ts';
import { SLICE_PROVIDER, mediaKind, parseSliceTag, sliceTag, wavSeconds } from './refs.ts';
import { bannedHits, bannedMatches, containsRequired, foldText, snippet } from './text.ts';
import { FILES, HASH, MASTER_S, STYLE, job, rulesFolder, rulesProject } from './__fixtures__/project.ts';
import { createLocalHost } from '../hosts/local.ts';
import { createManualProvider } from '../providers/manual/index.ts';

const rulesOf = (bs: Breach[]): string[] => bs.map((b) => b.rule);

describe('text matching', () => {
  it('whole words, any case; hyphens, apostrophes and punctuation are boundaries', () => {
    assert.equal(bannedMatches('An ACME sign.', 'acme').length, 1);
    assert.equal(bannedMatches("Acme's van", 'acme').length, 1);
    assert.equal(bannedMatches('acme-brand van', 'acme').length, 1);
    assert.equal(bannedMatches('acmeville, acmes', 'acme').length, 0);
    assert.equal(bannedMatches('notacme', 'acme').length, 0);
  });

  it('is Unicode-aware: letters with accents are word characters', () => {
    assert.equal(bannedMatches('the Ünïcorn badge', 'ünïcorn').length, 1);
    assert.equal(bannedMatches('Ünïcorns', 'ünïcorn').length, 0);
    assert.equal(bannedMatches('café', 'caf').length, 0, 'é is part of the word');
  });

  it('a multi-word term matches across any whitespace', () => {
    assert.equal(bannedMatches('a Blue  Star\nline poster', 'blue star line').length, 1);
  });

  it('an exception allows the longer word and nothing else', () => {
    assert.deepEqual(bannedMatches('a Gore-Tex jacket', 'gore', ['Gore-Tex']), []);
    assert.equal(bannedMatches('a Gore-Tex jacket, no gore', 'gore', ['Gore-Tex']).length, 1);
    assert.equal(bannedMatches('a gore-tex jacket', 'gore').length, 1, 'without the exception the hyphen is a boundary');
  });

  it('required text: any case, collapsed whitespace, its own closing full stop ignored', () => {
    assert.ok(containsRequired('… Silhouettes   ONLY, hands …', 'silhouettes only.'));
    assert.ok(!containsRequired('silhouette only', 'silhouettes only'));
    assert.ok(!containsRequired(undefined, 'x'));
  });
});

describe('text normalisation (review probes)', () => {
  const caught = (text: string, term: string, except: string[] = []) => bannedMatches(text, term, except).length > 0;

  it('zero-width characters and soft hyphens inside a word do not hide it', () => {
    assert.ok(caught('Zor​bex sign', 'zorbex'));
    assert.ok(caught('Zor­bex sign', 'zorbex'));
    assert.ok(caught('Zor⁠bex', 'zorbex'));
  });

  it('fullwidth letters, a no-break space and NFD vs NFC compare equal', () => {
    assert.ok(caught('Ｚｏｒｂｅｘ fullwidth', 'zorbex'));
    assert.ok(caught('café decomposed', 'café'));
    assert.ok(caught('café precomposed', 'café'));
    assert.ok(caught('Kelvo Dyne', 'kelvo dyne'));
  });

  it('full case folding: ß / SS and dotted capital I', () => {
    assert.ok(caught('STRASSE', 'straße'));
    assert.ok(caught('straße', 'strasse'));
    assert.ok(caught('İSTANBUL', 'istanbul'));
  });

  it('a multi-word term matches across dashes of any kind, underscores and line breaks', () => {
    for (const t of ['Kelvo–Dyne', 'Kelvo—Dyne', 'Kelvo-Dyne', 'Kelvo_Dyne', 'Kelvo\nDyne']) assert.ok(caught(t, 'kelvo dyne'), t);
    assert.ok(caught('a Kelvo–Dyne van', 'Kelvo-Dyne'), 'an en dash matches a hyphen in the term');
  });

  it('known limits: accents still count, plurals are separate terms, look-alike letters are not mapped', () => {
    assert.ok(!caught('café', 'cafe'));
    assert.ok(!caught('Zorbexes', 'zorbex'));
    assert.ok(caught('Zorbexes', 'zorbexes'));
    assert.ok(!caught('Zоrbex', 'zorbex'));
  });

  it('exceptions are normalised too, and snippets quote the folded text', () => {
    assert.deepEqual(bannedMatches('a GORE–TEX jacket', 'gore', ['Gore-Tex']), []);
    assert.ok(caught('zorbex silk and zorbex', 'zorbex', ['zorbex silk']));
    const h = bannedHits('An  Ａｃｍｅ​ sign', 'acme');
    assert.equal(foldText('Ａｃｍｅ​'), 'acme');
    assert.equal(snippet(h.folded, h.spans[0]!), 'an acme sign');
  });

  it('required text is folded the same way', () => {
    assert.ok(containsRequired('Silhouettes­Only', 'silhouettesonly'));
    assert.ok(containsRequired('ＳＩＬＨＯＵＥＴＴＥＳ only', 'silhouettes only'));
  });
});

describe('media sniffing', () => {
  it('knows audio and video by their first bytes, and a WAV\'s length from its header', () => {
    assert.equal(mediaKind(FILES.master.data), 'wav');
    assert.equal(mediaKind(FILES.photoAsWav.data), undefined);
    assert.equal(mediaKind(new Uint8Array([0x49, 0x44, 0x33, 4])), 'mp3');
    assert.equal(mediaKind(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])), 'mp4');
    assert.equal(wavSeconds(FILES.master.data, FILES.master.data.length), MASTER_S);
  });
});

describe('checkJob: text rules', () => {
  it('banned: a term in the prompt is a breach naming the rule and the text', async () => {
    const p = rulesProject();
    const r = await checkJob(p, job({ unit: 'S01-010', prompt: `An Acme crate on the wall, ${STYLE}` }));
    assert.equal(r.outcome, 'rules-breach');
    const b = r.breaches.find((x) => x.rule === 'banned')!;
    assert.equal(b.shot, 'S01-010');
    assert.match(b.message, /banned term "acme" in the prompt: ".*acme crate/);
    assert.match(b.message, /a brand name/);
  });

  it('banned: the exception (a fabric word) passes; the bare word does not', async () => {
    const p = rulesProject();
    assert.deepEqual((await checkJob(p, job({ unit: 'S01-010', prompt: `A Gore-Tex coat, ${STYLE}` }))).breaches, []);
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S01-010', prompt: `Gore on the floor, ${STYLE}` }))).breaches), ['banned']);
  });

  it('banned: the camera note and the reference notes are checked too', async () => {
    const p = rulesProject();
    const r = await checkJob(p, job({ unit: 'S01-010', prompt: STYLE, camera: 'acme dolly', refs: [{ id: 'x', note: 'like the acme ad' }] }, { provider: 'manual' }));
    assert.deepEqual(r.breaches.map((b) => b.field), ['camera note', 'note on ref x']);
  });

  it('banned: a term only in the negative prompt passes (that is how a prompt avoids it)', async () => {
    const p = rulesProject();
    assert.deepEqual((await checkJob(p, job({ unit: 'S01-010', prompt: STYLE, negative: 'no acme logos, no gore' }))).breaches, []);
    assert.deepEqual((await checkJob(p, job({ unit: 'KIT', output: 'portrait', prompt: 'x', negative: 'no acme' }, { stage: 'bible' }))).breaches, []);
  });

  it('banned: a scoped term applies only to shots in its scope, and never to a bible job', async () => {
    const p = rulesProject();
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S02-010', prompt: `zorblax, ${STYLE}` }))).breaches), ['banned']);
    assert.deepEqual((await checkJob(p, job({ unit: 'S01-010', prompt: `zorblax, ${STYLE}` }))).breaches, []);
    assert.deepEqual((await checkJob(p, job({ unit: 'ADA', prompt: 'zorblax', output: 'portrait' }, { stage: 'bible' }))).breaches, []);
    // an unscoped term applies to a bible job
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'ADA', prompt: 'an acme hat', output: 'portrait' }, { stage: 'bible' }))).breaches), ['banned']);
  });

  it('banned: the spoken text of a voice job is checked (sound carries it as the prompt)', async () => {
    const p = rulesProject();
    const r = await checkJob(p, job({ unit: 'S01-010', prompt: 'I bought it at Acme.', output: 'vo', refs: [{ id: 'voice-1', role: 'voice' }] }, { kind: 'audio', stage: 'sound', provider: 'elevenlabs' }));
    assert.deepEqual(r.breaches.map((b) => [b.rule, b.field]), [['banned', 'spoken text']]);
  });

  it('require: scoped required text is needed in its scene only', async () => {
    const p = rulesProject();
    const miss = await checkJob(p, job({ unit: 'S03-010', prompt: `Guests dance, ${STYLE}` }));
    assert.deepEqual(rulesOf(miss.breaches), ['require']);
    assert.match(miss.breaches[0]!.message, /lacks required text "silhouettes only" \(applies to scenes S03\)/);
    assert.deepEqual((await checkJob(p, job({ unit: 'S03-020', prompt: `Silhouettes only, ${STYLE}` }))).breaches, []);
    assert.deepEqual((await checkJob(p, job({ unit: 'S01-010', prompt: STYLE }))).breaches, []);
  });

  it('require: applies to picture outputs of shots (key frames, clips), not to voice text or bible images', async () => {
    const p = rulesProject();
    assert.deepEqual((await checkJob(p, job({ unit: 'S03-010', prompt: 'Spoken words.', output: 'vo' }, { kind: 'audio', stage: 'sound' }))).breaches, []);
    assert.deepEqual((await checkJob(p, job({ unit: 'HARBOUR', prompt: 'a plate', output: 'plate' }, { stage: 'bible' }))).breaches, []);
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S03-010', prompt: 'a clip', output: 'clip' }, { kind: 'video', stage: 'motion' }))).breaches), ['require', 'require']);
  });

  it('require on the negative: the job must send a negative that carries it', async () => {
    const p = rulesProject();
    p.rules!.require.push({ text: 'no text, no logos', applies_to: 'negative' });
    const none = await checkJob(p, job({ unit: 'S01-010', prompt: STYLE }));
    assert.match(none.breaches[0]!.message, /required text "no text, no logos" is missing: there is no negative prompt/);
    assert.deepEqual((await checkJob(p, job({ unit: 'S01-010', prompt: STYLE, negative: 'blur, No text, no logos' }))).breaches, []);
  });

  it('exempt: a reference shot skipping "house-style" needs no style text, but every other rule still applies', async () => {
    const p = rulesProject();
    assert.deepEqual((await checkJob(p, job({ unit: 'S01-020', prompt: '(Archive look) a child' }))).breaches, []);
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S01-020', prompt: '(Archive look) an acme box' }))).breaches), ['banned']);
    // A non-exempt shot without the style is a breach.
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S01-010', prompt: 'no style here' }))).breaches), ['require']);
    // house-style skips only requires that are part of the house style
    p.rules!.require.push({ text: 'hands in frame', applies_to: 'prompt', scope: { shots: ['S01-020'] } });
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S01-020', prompt: '(Archive look)' }))).breaches), ['require']);
  });

  it('exempt: banned, banned:<term>, require and require:<text> switch those off for the shot', async () => {
    const p = rulesProject();
    p.rules!.exempt.push({ shots: ['S03-010'], skip: ['banned:acme', 'require:silhouettes only'] });
    assert.deepEqual((await checkJob(p, job({ unit: 'S03-010', prompt: `acme, ${STYLE}` }))).breaches, []);
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S03-010', prompt: `gore, ${STYLE}` }))).breaches), ['banned']);
  });

  it('a unit owned by a shot (a key frame asset) is checked as that shot', async () => {
    const p = rulesProject();
    p.assets.push({ id: 'S03-010_keyframe', kind: 'keyframe', stage: 'keyframes', status: 'pending', owner: 'S03-010', comments: [], tags: [] });
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S03-010_keyframe', prompt: STYLE }))).breaches), ['require']);
  });
});

describe('checkJob: references, by content hash', () => {
  it('an allowed file is accepted for its entry; a renamed copy of it is accepted by hash', async () => {
    const { dir, project: p } = await rulesFolder();
    const ok = await checkJob(p, job({ unit: 'ADA', prompt: 'portrait', output: 'portrait', refs: [{ id: 'ref_ada_crop', uri: FILES.crop.path }] }, { stage: 'bible' }), { projectDir: dir });
    assert.deepEqual(ok.breaches, []);
    // Same bytes, another name and no asset: still the allowed file. Here for ADA's shot S01-020 (ADA only).
    const copy = await checkJob(p, job({ unit: 'S01-020', prompt: '(x)', refs: [{ id: 'loose', uri: FILES.cropCopy.path }] }), { projectDir: dir });
    assert.deepEqual(copy.breaches, []);
  });

  it('a photo that is not allowed is refused, naming the file and its hash', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'loose', uri: FILES.street.path }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['uploads']);
    assert.equal(r.breaches[0]!.file, FILES.street.path);
    assert.equal(r.breaches[0]!.sha256, HASH.street);
    assert.match(r.breaches[0]!.message, /not a file akuko generated and its hash is not in rules.uploads.allow/);
  });

  it('`for` misuse: an allowed crop of one person used as a reference for another is refused', async () => {
    const { dir, project: p } = await rulesFolder();
    // Attached to HARBOUR's entry: it is a reference for HARBOUR, which the allowance does not cover.
    p.assets.push({ id: 'ref_misused', kind: 'reference', stage: 'bible', status: 'approved', owner: 'HARBOUR', comments: [], tags: [], file: { uri: FILES.cropCopy.path, mime: 'image/png' } });
    const r = await checkJob(p, job({ unit: 'HARBOUR', prompt: 'plate', output: 'plate', refs: [{ id: 'ref_misused', uri: FILES.cropCopy.path }] }, { stage: 'bible' }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['uploads']);
    assert.match(r.breaches[0]!.message, /may be a reference only for ADA; here it is for HARBOUR/);
    // A loose file in a shot with ADA and HARBOUR is a reference for both: HARBOUR is outside `for`.
    const shot = await checkJob(p, job({ unit: 'S01-010', prompt: STYLE, refs: [{ id: 'loose', uri: FILES.cropCopy.path }] }), { projectDir: dir });
    assert.match(shot.breaches[0]!.message, /here it is for HARBOUR$/);
  });

  it('a file with no `for` may be used for any entry', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'loose', uri: FILES.birds.path }] }), { projectDir: dir });
    assert.deepEqual(r.breaches, []);
  });

  it('never_from_photo: a generated portrait is fine; any photo, even an allowed one, is refused', async () => {
    const { dir, project: p } = await rulesFolder();
    const gen = await checkJob(p, job({ unit: 'S02-010', prompt: STYLE, refs: [{ id: 'KIT_portrait', uri: FILES.kitGenerated.path, role: 'character' }] }), { projectDir: dir });
    assert.deepEqual(gen.breaches, []);
    const photo = await checkJob(p, job({ unit: 'S02-010', prompt: STYLE, refs: [{ id: 'loose', uri: FILES.birds.path }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(photo.breaches), ['never-from-photo']);
    assert.match(photo.breaches[0]!.message, /KIT may only use generated references/);
  });

  it('a file brought back by hand (manual) is external, even with a ledger entry', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'KIT_portrait', prompt: 'turnaround', output: 'turnaround', refs: [{ id: 'KIT_sketch', uri: FILES.kitByHand.path }] }, { stage: 'bible' }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['never-from-photo', 'uploads']);
  });

  it('a ref that borrows a generated asset id but points at another file is judged by that file', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S02-010', prompt: STYLE, refs: [{ id: 'KIT_portrait', uri: FILES.street.path }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['never-from-photo', 'uploads']);
  });

  it('a generated file swapped on disk is refused as changed', async () => {
    const { dir, project: p } = await rulesFolder();
    await writeFile(join(dir, FILES.kitGenerated.path), 'something else');
    const r = await checkJob(p, job({ unit: 'S02-010', prompt: STYLE, refs: [{ id: 'KIT_portrait', uri: FILES.kitGenerated.path }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['generated-changed']);
  });

  it('a remote or missing file cannot be checked by hash and is refused', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'a', uri: 'https://example.invalid/x.png' }, { id: 'b', uri: 'inbox/gone.png' }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['uploads', 'uploads']);
    assert.match(r.breaches[0]!.message, /not a local file/);
    assert.match(r.breaches[1]!.message, /the file is not there/);
  });

  it('a ref with no file (a provider voice id) has nothing to upload', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S01-010', prompt: 'words', output: 'vo', refs: [{ id: 'voice-1', role: 'voice' }] }, { kind: 'audio', stage: 'sound', provider: 'elevenlabs' }), { projectDir: dir });
    assert.deepEqual(r.breaches, []);
  });

  describe('slices (provenance recorded in the project by akuko\'s cutter)', () => {
    /** A slice asset as the cutter records it. */
    const cut = (id: string, uri: string, tag: string, extra: Record<string, unknown> = {}) => ({
      id, kind: 'vo' as const, stage: 'motion' as const, status: 'approved' as const, owner: 'S03-020', comments: [], provider: SLICE_PROVIDER, tags: [tag],
      file: { uri, mime: 'audio/wav' }, ...extra,
    });
    const lip = (ref: { id: string; uri: string; note?: string }) =>
      job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, output: 'lipsync', refs: [{ role: 'audio', ...ref }] }, { kind: 'video', stage: 'motion' });

    it('the tag helpers round-trip and refuse a non-span', () => {
      assert.deepEqual(parseSliceTag(sliceTag(HASH.master, 0.25, 0.75)), { sha256: HASH.master, in_s: 0.25, out_s: 0.75 });
      assert.throws(() => sliceTag(HASH.master, 1, 1));
      assert.equal(parseSliceTag('slice-of:sha256:abc@0-1'), undefined);
    });

    it('a recorded slice of a file allowed with slices: true is accepted', async () => {
      const { dir, project: p } = await rulesFolder((q) => { q.assets.push(cut('L001_cut', FILES.slice.path, sliceTag(HASH.master, 0.5, 1), { file: { uri: FILES.slice.path, mime: 'audio/wav', hash: HASH.slice } })); });
      assert.deepEqual((await checkJob(p, lip({ id: 'L001_cut', uri: FILES.slice.path }), { projectDir: dir })).breaches, []);
    });

    it('a note claiming a slice counts for nothing: a stranger\'s WAV and a renamed photo are refused (review probes P3, P3b)', async () => {
      const { dir, project: p } = await rulesFolder();
      const note = `slice-of=sha256:${HASH.master}@0-1`;
      for (const uri of [FILES.strangerVoice.path, FILES.photoAsWav.path]) {
        const r = await checkJob(p, lip({ id: 'v', uri, note }), { projectDir: dir });
        assert.deepEqual(rulesOf(r.breaches), ['uploads'], uri);
        assert.match(r.breaches[0]!.message, /its hash is not in rules.uploads.allow/);
      }
    });

    it('a recorded "slice" whose bytes are not audio or video is refused, whatever its extension', async () => {
      const { dir, project: p } = await rulesFolder((q) => { q.assets.push(cut('fake_cut', FILES.photoAsWav.path, sliceTag(HASH.master, 0, 1))); });
      const r = await checkJob(p, lip({ id: 'fake_cut', uri: FILES.photoAsWav.path }), { projectDir: dir });
      assert.match(r.breaches[0]!.message, /recorded as a slice, but its content is not audio or video/);
    });

    it('a slice past the end of its source, of a source not allowed with slices, or not from the cutter is refused', async () => {
      const { dir, project: p } = await rulesFolder((q) => {
        // The master, with no recorded sha256: it is found by hashing and its length read from its WAV header (2 s).
        q.audio = { master: { uri: FILES.master.path, duration_s: 99, sample_rate: 8000, start_tc: '00:00:00:00' }, lines: [] };
        q.assets.push(cut('late_cut', FILES.slice.path, sliceTag(HASH.master, 1.8, 2.5)));
        q.assets.push(cut('birds_cut', FILES.slice.path, sliceTag(HASH.birds, 0, 0.5)));                         // birds allowed, but not slices: true
        q.assets.push(cut('hand_cut', FILES.slice.path, sliceTag(HASH.master, 0, 0.5), { provider: 'manual' })); // not the cutter
      });
      const late = await checkJob(p, lip({ id: 'late_cut', uri: FILES.slice.path }), { projectDir: dir });
      assert.match(late.breaches[0]!.message, /ends at 2.5 s, past the end of its source \(2 s\)/);
      const birds = await checkJob(p, lip({ id: 'birds_cut', uri: FILES.slice.path }), { projectDir: dir });
      assert.match(birds.breaches[0]!.message, /is a slice of sha256 .* not in rules.uploads.allow with slices: true/);
      const hand = await checkJob(p, lip({ id: 'hand_cut', uri: FILES.slice.path }), { projectDir: dir });
      assert.match(hand.breaches[0]!.message, /its hash is not in rules.uploads.allow/);
    });

    it('the source length comes from audio.master when its sha256 is the source hash', async () => {
      const { dir, project: p } = await rulesFolder((q) => {
        q.audio = { master: { uri: FILES.master.path, duration_s: 1.2, sample_rate: 8000, start_tc: '00:00:00:00', sha256: HASH.master }, lines: [] };
        q.assets.push(cut('L001_cut', FILES.slice.path, sliceTag(HASH.master, 1, 1.5)));
      });
      const r = await checkJob(p, lip({ id: 'L001_cut', uri: FILES.slice.path }), { projectDir: dir });
      assert.match(r.breaches[0]!.message, /past the end of its source \(1.2 s\)/);
    });
  });

  it('never_from_photo can\'t be switched off by the id a job claims (review probes P1, P1b, P2)', async () => {
    const { dir, project: p } = await rulesFolder();
    const kitJob = (ref: { id: string; uri: string }) => job({ unit: 'KIT', output: 'portrait', prompt: 'portrait', refs: [ref] }, { stage: 'bible' });
    for (const ref of [{ id: 'x', uri: FILES.birds.path }, { id: 'HARBOUR', uri: FILES.birds.path }, { id: 'ADA', uri: FILES.crop.path }]) {
      const r = await checkJob(p, kitJob(ref), { projectDir: dir });
      assert.ok(rulesOf(r.breaches).includes('never-from-photo'), `${ref.id} → ${rulesOf(r.breaches).join(',')}`);
    }
    // The consented crop as an ADA-owned reference in KIT's bible job: for KIT and ADA, so both rules refuse it.
    const owned = await checkJob(p, kitJob({ id: 'ref_ada_crop', uri: FILES.crop.path }), { projectDir: dir });
    assert.deepEqual(rulesOf(owned.breaches), ['never-from-photo', 'uploads']);
  });

  it('a generated ref for a never-from-photo entry must carry a sha256 its file still matches', async () => {
    const { dir, project: p } = await rulesFolder((q) => { delete q.assets.find((a) => a.id === 'KIT_portrait')!.file!.hash; });
    const r = await checkJob(p, job({ unit: 'S02-010', prompt: STYLE, refs: [{ id: 'KIT_portrait', uri: FILES.kitGenerated.path }] }), { projectDir: dir });
    assert.deepEqual(rulesOf(r.breaches), ['never-from-photo']);
    assert.match(r.breaches[0]!.message, /can't be verified as generated/);
    // The same unverified file for an entry that isn't never-from-photo is fine.
    const q2 = structuredClone(p);
    q2.rules!.never_from_photo = [];
    assert.deepEqual((await checkJob(q2, job({ unit: 'S02-010', prompt: STYLE, refs: [{ id: 'KIT_portrait', uri: FILES.kitGenerated.path }] }), { projectDir: dir })).breaches, []);
  });

  it('a free (manual) job gets the text rules only: akuko uploads nothing for it', async () => {
    const { dir, project: p } = await rulesFolder();
    const r = await checkJob(p, job({ unit: 'S03-020', prompt: `silhouettes only, ${STYLE}`, refs: [{ id: 'loose', uri: FILES.street.path }] }, { provider: 'manual' }), { projectDir: dir });
    assert.equal(r.paid, false);
    assert.deepEqual(r.breaches, []);
    assert.deepEqual(rulesOf((await checkJob(p, job({ unit: 'S03-020', prompt: 'acme' }, { provider: 'manual' }), { projectDir: dir })).breaches), ['banned', 'require', 'require']);
  });
});

describe('rules.required', () => {
  it('required with nothing to enforce refuses a paid job as rules-missing; a manual job still runs', async () => {
    const p = rulesProject();
    p.rules = { required: true, banned: [], require: [], uploads: { allow: [] }, never_from_photo: [], exempt: [], consent: [] };
    const r = await checkJob(p, job({ unit: 'S01-010', prompt: 'x' }));
    assert.equal(r.outcome, 'rules-missing');
    assert.match(r.breaches[0]!.message, /rules.required is true but the project has no rules/);
    assert.equal((await checkJob(p, job({ unit: 'S01-010', prompt: 'x' }, { provider: 'manual' }))).outcome, 'ok');
  });

  it('invalid rules refuse every job', async () => {
    const p = rulesProject();
    (p.rules as unknown as { banned: unknown[] }).banned.push({ term: '' });
    assert.equal((await checkJob(p, job({ unit: 'S01-010', prompt: 'x' }, { provider: 'manual' }))).outcome, 'rules-missing');
  });

  it('a project with no rules block checks nothing', async () => {
    const p = rulesProject();
    delete p.rules;
    assert.equal((await checkJob(p, job({ unit: 'S01-010', prompt: 'acme', refs: [{ id: 'x', uri: 'https://example.invalid/a.png' }] }))).outcome, 'ok');
  });
});

describe('the synthetic project', () => {
  it('passes integrity (its rules name real ids)', () => {
    assert.deepEqual(checkIntegrity(rulesProject()), []);
  });
});

/** A gate that counts calls and would "spend" if reached. */
function spyGate(): SpendGate & { calls: string[] } {
  const calls: string[] = [];
  const cost = { amount: 0.04, currency: 'USD', per_unit: {}, basis: 'spy' };
  return {
    calls,
    async quote(j: Job): Promise<QuoteResult> { calls.push(`quote:${j.id}`); return { cost: { ...cost, per_unit: { [j.items[0]!.unit]: 0.04 } }, billing: 'direct-api', paid: true }; },
    async run(j: Job): Promise<RunResult> { calls.push(`run:${j.id}`); return { status: 'refused', refusal: { code: 'not-approved', message: 'spy' } }; },
    async collect(h: JobHandle) { calls.push(`collect:${h.job}`); return { status: { state: 'done' as const }, assets: [] }; },
  };
}

describe('guardGate', () => {
  it('a refused job never reaches the gate: not quote, not run', async () => {
    const { dir, project } = await rulesFolder();
    const spy = spyGate();
    const g = guardGate(spy, project, { projectDir: dir });
    const bad = job({ unit: 'S01-010', prompt: `An Acme sign, ${STYLE}` }, { id: 'job_bad' });
    const q = await g.quote(bad);
    assert.equal(q.refusal?.code, RULES_BREACH);
    assert.match(q.refusal!.message, /refuse job job_bad; nothing was priced, sent or spent/);
    assert.match(q.refusal!.message, /S01-010 \[banned\] banned term "acme"/);
    assert.match(q.refusal!.message, /rules\/cli.ts check/);
    assert.equal(q.cost.amount, 0);
    const r = await g.run(bad);
    assert.equal(r.status, 'refused');
    assert.equal(r.status === 'refused' ? r.refusal.code : '', RULES_BREACH);
    assert.deepEqual(spy.calls, []);
  });

  it('a clean job passes straight through; collect always passes through', async () => {
    const { dir, project } = await rulesFolder();
    const spy = spyGate();
    const g = guardGate(spy, project, { projectDir: dir });
    const good = job({ unit: 'S01-010', prompt: STYLE }, { id: 'job_good' });
    assert.equal((await g.quote(good)).cost.amount, 0.04);
    await g.run(good);
    await g.collect({ job: 'job_x', provider: 'fal', ref: 'r', stage: 'keyframes', units: [], submitted_at: 'now', ledger: [] });
    assert.deepEqual(spy.calls, ['quote:job_good', 'run:job_good', 'collect:job_x']);
  });

  it('reads the project fresh on every call (a rule added after the guard was built still applies)', async () => {
    const { dir, project } = await rulesFolder();
    let current = project;
    const spy = spyGate();
    const g = guardGate(spy, { readState: async () => current }, { projectDir: dir });
    const j = job({ unit: 'S01-010', prompt: `quokka, ${STYLE}` });
    assert.equal(await g.check(j), null);
    current = structuredClone(project);
    current.rules!.banned.push({ term: 'quokka' });
    assert.equal((await g.check(j))?.code, RULES_BREACH);
  });

  it('rules-missing has its own code', async () => {
    const p = rulesProject();
    p.rules = { required: true, banned: [], require: [], uploads: { allow: [] }, never_from_photo: [], exempt: [], consent: [] };
    const spy = spyGate();
    const r = await guardGate(spy, p).run(job({ unit: 'S01-010', prompt: 'x' }));
    assert.equal(r.status === 'refused' ? r.refusal.code : '', RULES_MISSING);
    assert.deepEqual(spy.calls, []);
  });

  it('checks the job it hands on: changing the caller\'s object afterwards changes nothing', async () => {
    const { dir, project } = await rulesFolder();
    const seen: Job[] = [];
    const spy = spyGate();
    const g = guardGate({ ...spy, quote: async (j) => { seen.push(j); return spy.quote(j); } }, project, { projectDir: dir });
    const j = job({ unit: 'S01-010', prompt: STYLE });
    const pending = g.quote(j);
    j.items[0]!.prompt = 'acme';
    await pending;
    assert.equal(seen[0]!.items[0]!.prompt, STYLE);
  });
});

describe('checkProjectRules (the preflight)', () => {
  it('lists every breach in the project with its shot id, and nothing for a clean one', async () => {
    const { dir, project: p } = await rulesFolder((q) => {
      q.shots.find((s) => s.id === 'S02-010')!.prompt = `Kit by an Acme van, zorblax, ${STYLE}`;
      q.bible.characters.find((e) => e.id === 'KIT')!.refs.push('KIT_sketch');
      q.assets.push({ id: 'ref_street', kind: 'reference', stage: 'bible', status: 'approved', owner: 'S03-020', comments: [], tags: [], file: { uri: FILES.street.path, mime: 'image/jpeg' } });
    });
    const c = await checkProjectRules(p, { projectDir: dir });
    const got = c.breaches.map((b) => `${b.where} ${b.rule}`);
    assert.deepEqual(got, [
      'S02-010 banned',            // acme
      'S02-010 banned',            // zorblax, in P2
      'S03-010 require',           // silhouettes only
      'S03-020 uploads',           // the street photo attached to the shot
      'bible:KIT never-from-photo', // the hand-made portrait listed for KIT
      'bible:KIT uploads',
    ]);
    assert.deepEqual(c.counts, { shots: 5, entries: 5, refs: 4, lines: 0 });
  });

  it('checks narration, script lines and dialogue line text for banned terms, but not the negative', async () => {
    const { dir, project: p } = await rulesFolder((q) => {
      q.shots.find((s) => s.id === 'S03-010')!.prompt = `Guests dance, silhouettes only, ${STYLE}`;
      q.shots.find((s) => s.id === 'S01-010')!.narration = 'I bought it at Acme.';
      q.shots.find((s) => s.id === 'S01-010')!.negative = 'no acme logos';
      q.shots.find((s) => s.id === 'S02-010')!.script_line = 'KIT: zorblax, again.';
      q.shots.find((s) => s.id === 'S03-020')!.lines = [{ id: 'Q01', kind: 'spoken' }];
      q.audio = { lines: [{ id: 'Q01', kind: 'spoken', film_in_s: 0, film_out_s: 1, text: 'Meet me by the ACME sign.' }, { id: 'Q02', kind: 'thought', film_in_s: 1, film_out_s: 2, text: 'Gore everywhere.' }] };
    });
    const c = await checkProjectRules(p, { projectDir: dir });
    assert.deepEqual(c.breaches.map((b) => `${b.where} ${b.field}`), ['S01-010 narration', 'S02-010 script line', 'S03-020 line Q01', 'line:Q02 line Q02']);
    assert.equal(c.counts.lines, 2);
  });
});

describe('guardedGate()', () => {
  it('builds the gate with the guard in front: a breach never reaches the gate, and the gate writes nothing', async () => {
    const { dir } = await rulesFolder();
    const host = createLocalHost({ projectDir: dir });
    const manual = createManualProvider(host);
    const g = guardedGate({ host, providers: [manual.provider], level: 'B', reader: createLocalHost({ projectDir: dir }), projectDir: dir });
    const before = await host.readState();
    const r = await g.run(job({ unit: 'S01-010', prompt: `an acme box, ${STYLE}` }, { provider: 'manual' }));
    assert.equal(r.status === 'refused' ? r.refusal.code : r.status, RULES_BREACH);
    assert.deepEqual(await host.readState(), before);
    assert.equal((await g.quote(job({ unit: 'S01-010', prompt: STYLE }, { provider: 'manual' }))).paid, false, 'a clean job reaches the real gate');
  });
});
