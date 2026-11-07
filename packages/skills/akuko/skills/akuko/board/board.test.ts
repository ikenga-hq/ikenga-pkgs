// WP-21 — sketch board: framing-diagram panels and 9-panel beat boards.
//
// Free and deterministic, so everything here runs without a provider. Covered:
// every fixture shot gets a panel (thirds grid, labelled blocking, move arrow,
// no figures or faces), byte-identical output, escaping of script-supplied
// text, shots without blocking, beat boards (nine cells, shot order, spill),
// the stage run through a host (idempotent, no spend), and decision folding
// of the panels like any unit.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyBreakdown } from '../breakdown/apply.ts';
import { completeIntake, createProject } from '../breakdown/intake.ts';
import { foldDecisions } from '../decisions/fold.ts';
import { createLocalHost, serializeProject } from '../hosts/local.ts';
import { createFakeHost } from '../providers/__fixtures__/fake-host.ts';
import { AkukoProjectSchema, findUnit, type AkukoProject, type Decision, type Shot } from '../schema/akuko-project.ts';
import { checkIntegrity } from '../schema/integrity.ts';
import { buildBeatBoards, PANELS_PER_BOARD } from './beatboard.ts';
import { run } from './cli.ts';
import { applyBlocking, ARROW_MOVES, BoardError, drawSketchPanels, esc, lintBoard, panelFileName, panelSvg } from './panels.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FIX = here('./__fixtures__/');
const T0 = () => new Date('2026-11-07T10:00:00Z');
const beating = (): AkukoProject => AkukoProjectSchema.parse(JSON.parse(readFileSync(here('../fixtures/the-beating/akuko.json'), 'utf8')));
const proposal = JSON.parse(readFileSync(here('../breakdown/__fixtures__/proposal-adapt.json'), 'utf8')) as unknown;
const tmp: string[] = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

type PanelInput = Pick<Shot, 'id' | 'shot_type' | 'camera' | 'camera_move' | 'duration_s' | 'blocking'>;
const box = (who: string, x = 0.4, y = 0.3) => ({ who, shape: 'rect' as const, x, y, w: 0.12, h: 0.4 });
const BLOCKING: Record<string, unknown> = {
  sc1_sh1: [box('M', 0.2)],
  sc1_sh2: [box('O', 0.6)],
  sc1_sh3: [box('O')],
  sc1_sh4: [box('M', 0.2), { who: 'O', shape: 'ellipse', x: 0.7, y: 0.6, w: 0.2, h: 0.1 }],
  sc2_sh1: [box('M & O <b>')],
  sc2_sh2: [box('O')],
  sc2_sh3: [box('M')],
  sc2_sh4: [box('O')],
  sc3_sh1: [box('W')],
  sc3_sh2: [box('M')],
  // sc3_sh3 deliberately has none: the panel still renders and lint warns
};

/** A project as the sketch stage finds it: breakdown drawn, every unit approved by a person. */
function readyForSketch(): AkukoProject {
  let p = completeIntake(createProject({ title: 'The Last Ferry', now: T0 }), { route: 'adapt', now: T0 });
  p.stages.intake = { state: 'approved' };
  p.stages.breakdown = { state: 'not-started' };
  for (const a of p.assets) a.status = 'approved';
  p = AkukoProjectSchema.parse(p);
  p = applyBreakdown(p, proposal, { now: T0 }).project;
  for (const u of [...p.shots, ...p.bible.characters, ...p.bible.locations, ...p.bible.styles]) {
    u.status = 'approved';
    const rec = u.by_stage?.[u.stage];
    if (rec) rec.status = 'approved';
  }
  p.stages.breakdown = { state: 'approved' };
  p.stages.sketch = { state: 'not-started' };
  p.current_stage = 'sketch';
  return applyBlocking(AkukoProjectSchema.parse(p), BLOCKING, { now: T0 });
}

const unit = (p: AkukoProject, id: string) => findUnit(p, id)!.unit;
let n = 0;
function decision(action: 'approve' | 'request-changes', unitId: string, minute: number, text?: string): Decision {
  n++;
  const h = createHash('sha1').update(`wp21-${n}`).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const at = new Date(Date.UTC(2026, 10, 7, 12, minute, 0)).toISOString().replace('.000Z', 'Z');
  return { id, action, unit: unitId, stage: 'sketch', by: 'you', at, view: 'test-board@1', ...(text !== undefined && { text }) } as Decision;
}
// The shipped conformed list names `default-board@0.1`; this stage's tests add a conformed view called `test-board@1`.
const CONFORMED = [
  ...(JSON.parse(readFileSync(here('../decisions/__fixtures__/conformed.json'), 'utf8')) as { views: Array<{ view: string }> }).views.map((v) => v.view),
  'test-board@1',
];

// ─────────────────────────────────────────────────────────────────────────

describe('panels: every fixture shot', () => {
  const p = beating();
  it('gets a panel with thirds grid, labelled blocking, type and (when it has one) a move arrow', () => {
    assert.equal(p.shots.length, 12);
    for (const s of p.shots) {
      const svg = panelSvg(s, { aspect: p.project.aspect_ratio });
      assert.match(svg, /^<svg [^>]*viewBox="0 0 160 90"/, s.id);
      assert.match(svg, /<path class="pg" d="M53\.33 0V90M106\.67 0V90M0 30H160M0 60H160"\/>/, `${s.id} thirds grid`);
      for (const b of s.blocking) assert.ok(svg.includes(`<title>${esc(b.who)}</title>`), `${s.id} labels ${b.who}`);
      assert.equal((svg.match(/class="pb"/g) ?? []).length, s.blocking.length, `${s.id} draws one box per blocking entry`);
      assert.ok(svg.includes(`>${s.shot_type.toUpperCase()}</text>`), `${s.id} shows its shot type`);
      const arrows = (svg.match(/class="pah"/g) ?? []).length;
      if (s.camera_move === 'unset') assert.equal(arrows, 0, `${s.id} has no move, so no arrow`);
      else assert.ok(arrows >= 1, `${s.id} (${s.camera_move}) has a camera-move arrow`);
    }
  });

  it('draws boxes only: no figures, faces, images, scripts or external references', () => {
    const allowed = ['svg', 'title', 'style', 'rect', 'path', 'ellipse', 'text', 'line', 'polygon', 'polyline'];
    for (const s of p.shots) {
      const svg = panelSvg(s);
      assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
      for (const m of svg.matchAll(/<([a-zA-Z]+)[\s>/]/g)) assert.ok(allowed.includes(m[1]!), `${s.id}: <${m[1]}>`);
    }
  });

  it('every camera move that has an arrow draws one; static and unset draw none', () => {
    const base = p.shots[0]!;
    for (const m of ARROW_MOVES) assert.match(panelSvg({ ...base, camera_move: m }), /class="pah"/, m);
    for (const m of ['static', 'unset'] as const) assert.doesNotMatch(panelSvg({ ...base, camera_move: m }), /class="pah"/, m);
  });

  it('matches the committed sample panels', () => {
    for (const s of p.shots) {
      const file = join(FIX, 'panels', panelFileName(s.id));
      const want = panelSvg(s, { aspect: p.project.aspect_ratio });
      if (process.env.AKUKO_UPDATE_GOLDEN === '1') { mkdirSync(join(FIX, 'panels'), { recursive: true }); writeFileSync(file, want); }
      assert.equal(readFileSync(file, 'utf8'), want, `${s.id}: regenerate with AKUKO_UPDATE_GOLDEN=1`);
    }
    assert.equal(readdirSync(join(FIX, 'panels')).length, p.shots.length);
  });
});

describe('panels: deterministic', () => {
  it('same input, byte-identical SVG, whatever the object identity', () => {
    const s = beating().shots[9]!;
    assert.equal(panelSvg(s), panelSvg(structuredClone(s)));
    assert.equal(createHash('sha256').update(panelSvg(s)).digest('hex'), createHash('sha256').update(panelSvg(structuredClone(s))).digest('hex'));
  });
  it('supports 9:16 and 1:1 frames', () => {
    const s = beating().shots[0]!;
    assert.match(panelSvg(s, { aspect: '9:16' }), /viewBox="0 0 90 160"/);
    assert.match(panelSvg(s, { aspect: '1:1' }), /viewBox="0 0 120 120"/);
  });
});

describe('panels: escaping', () => {
  const hostile: PanelInput = {
    id: 'sc1_sh1', shot_type: 'ws', camera: '<img src=x onerror=alert(1)> & "q"', camera_move: 'pan', duration_s: 6,
    blocking: [box('<script>alert(1)</script> & Co'), box("O'Hara \"X\"", 0.7)],
  };
  it('escapes names and notes that come from a script', () => {
    const svg = panelSvg(hostile);
    assert.doesNotMatch(svg, /<script/i);
    assert.doesNotMatch(svg, /<img/i);
    assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Co/);
    assert.match(svg, /O&#39;Hara &quot;X&quot;/);
    assert.match(svg, /aria-label="[^"<>]*"/);
  });
  it('escapes a hostile project title, scene heading and label in a beat board', () => {
    const p = beating();
    p.project.title = '<script>x</script> & Sons';
    p.scenes[0]!.heading = '"><img src=x>';
    p.shots[0]!.blocking = [box('<script>y</script>')];
    const html = buildBeatBoards(p).map((b) => b.html).join('\n');
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<img/i);
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt; &amp; Sons/);
  });
});

describe('shots without blocking', () => {
  it('still render (grid, camera note, "no blocking") and lint warns; nothing is invented', () => {
    const s: PanelInput = { id: 'sc3_sh3', shot_type: 'ms', camera: 'Static', camera_move: 'unset', duration_s: 5, blocking: [] };
    const svg = panelSvg(s);
    assert.match(svg, /class="pg"/);
    assert.match(svg, /NO BLOCKING/);
    assert.match(svg, />Static</);
    assert.equal((svg.match(/class="pb"/g) ?? []).length, 0);
    const issues = lintBoard({ shots: [s as Shot] });
    assert.deepEqual(issues.map((i) => [i.rule, i.shot]), [['no-blocking', 'sc3_sh3']]);
    assert.equal(issues[0]!.severity, 'warning');
  });
  it('lint also flags unlabelled, duplicate and out-of-frame boxes', () => {
    const shots = [{ id: 'a', blocking: [box(''), box('X'), box('X'), { who: 'Y', shape: 'rect', x: 0.9, y: 0.1, w: 0.3, h: 0.2 }] }] as unknown as Shot[];
    assert.deepEqual(lintBoard({ shots }).map((i) => i.rule).sort(), ['blocking-duplicate-label', 'blocking-out-of-frame', 'blocking-unlabelled']);
  });
});

describe('blocking proposal', () => {
  it('is refused for unknown shots, bad numbers, unknown fields, and for a panel already under review', async () => {
    const p = readyForSketch();
    assert.throws(() => applyBlocking(p, { nope: [] }), BoardError);
    assert.throws(() => applyBlocking(p, { sc1_sh1: [{ ...box('M'), x: 2 }] }), BoardError);
    assert.throws(() => applyBlocking(p, { sc1_sh1: [{ ...box('M'), colour: 'red' }] }), BoardError);
    const drawn = (await drawSketchPanels(p, createFakeHost(p), { now: T0 })).project;
    assert.throws(() => applyBlocking(drawn, { sc1_sh1: [box('Z')] }), /send it back/);
  });
});

describe('beat boards', () => {
  it('lay nine panels per board in shot order, one board per scene, spare cells empty', () => {
    const boards = buildBeatBoards(beating());
    assert.deepEqual(boards.map((b) => [b.file, b.shots.length]), [
      ['beatboard-sc1.html', 3], ['beatboard-sc2.html', 4], ['beatboard-sc3.html', 1], ['beatboard-sc4.html', 4],
    ]);
    const sc2 = boards[1]!;
    assert.deepEqual(sc2.shots, ['sc2_sh1', 'sc2_sh2', 'sc2_sh3', 'sc2_sh4']);
    assert.equal((sc2.html.match(/<li class="cell"/g) ?? []).length, PANELS_PER_BOARD);
    assert.equal((sc2.html.match(/class="empty"/g) ?? []).length, 5);
    assert.deepEqual([...sc2.html.matchAll(/data-shot="([^"]+)"/g)].map((m) => m[1]), sc2.shots);
    assert.doesNotMatch(sc2.html, /<script|https?:\/\/(?!www\.w3\.org)/);
  });
  it('spill a scene of more than nine shots onto a second board', () => {
    const p = beating();
    const s0 = p.shots[0]!;
    p.shots = Array.from({ length: 11 }, (_, i) => ({ ...structuredClone(s0), id: `sc1_sh${i + 1}`, scene: 'sc1' }));
    const boards = buildBeatBoards(p);
    assert.deepEqual(boards.map((b) => [b.file, b.index, b.of, b.shots.length]), [['beatboard-sc1.html', 1, 2, 9], ['beatboard-sc1-2.html', 2, 2, 2]]);
    assert.match(boards[1]!.html, /board 2 of 2/);
    assert.deepEqual(boards.flatMap((b) => b.shots), p.shots.map((s) => s.id));
  });
  it('are byte-identical on a second build and match the committed sample', () => {
    const a = buildBeatBoards(beating());
    const b = buildBeatBoards(structuredClone(beating()));
    assert.deepEqual(a.map((x) => x.html), b.map((x) => x.html));
    const sample = a.find((x) => x.file === 'beatboard-sc2.html')!;
    const file = join(FIX, 'beatboards', sample.file);
    if (process.env.AKUKO_UPDATE_GOLDEN === '1') { mkdirSync(join(FIX, 'beatboards'), { recursive: true }); writeFileSync(file, sample.html); }
    assert.equal(readFileSync(file, 'utf8'), sample.html, 'regenerate with AKUKO_UPDATE_GOLDEN=1');
  });
});

describe('the stage: draw panels through the host', () => {
  it('is locked until the breakdown is approved', async () => {
    const p = readyForSketch();
    p.stages.breakdown = { state: 'in-review' };
    p.stages.sketch = { state: 'locked' };
    await assert.rejects(drawSketchPanels(p, createFakeHost(p)), /locked/);
  });

  it('draws a panel per shot, free, and leaves every shot pending-review (never approved)', async () => {
    const p = readyForSketch();
    const host = createFakeHost(p);
    const r = await drawSketchPanels(p, host, { now: T0 });
    assert.equal(r.drawn.length, 11);
    assert.deepEqual(host.calls, Array(11).fill('storeAsset'), 'only storeAsset: no provider, no spend gate');
    assert.equal(host.files.size, 11);
    for (const s of r.project.shots) {
      assert.equal(s.stage, 'sketch');
      assert.equal(s.status, 'pending-review');
      assert.equal(s.by_stage?.sketch?.status, 'pending-review');
      assert.match(s.by_stage!.sketch!.output!.uri, /sc\d_sh\d-sketch\.svg$/);
      assert.equal(s.by_stage!.sketch!.output!.mime, 'image/svg+xml');
      assert.equal(s.by_stage?.breakdown?.status, 'approved', 'the breakdown record is kept');
    }
    assert.equal(r.project.stages.sketch.state, 'in-review');
    assert.equal(r.project.current_stage, 'sketch');
    assert.equal(r.project.assets.filter((a) => a.kind === 'panel').length, 0, 'the shot is the review unit; panels are not second units');
    assert.deepEqual(checkIntegrity(r.project), []);
    assert.deepEqual(r.lint.filter((i) => i.rule === 'no-blocking').map((i) => i.shot), ['sc3_sh3']);
    const stored = new TextDecoder().decode(host.files.get(r.project.shots[4]!.by_stage!.sketch!.output!.uri)!);
    assert.ok(stored.includes('&amp; O &lt;b&gt;'), 'stored panel carries the escaped hostile label');
  });

  it('is idempotent: a second run stores nothing and changes nothing', async () => {
    const p = readyForSketch();
    const host = createFakeHost(p);
    const first = await drawSketchPanels(p, host, { now: T0 });
    host.calls.length = 0;
    const again = await drawSketchPanels(first.project, host, { now: () => new Date('2026-11-08T00:00:00Z') });
    assert.deepEqual(host.calls, []);
    assert.equal(again.changed, false);
    assert.equal(again.drawn.length + again.redrawn.length, 0);
    assert.equal(again.unchanged.length, 11);
    assert.equal(serializeProject(again.project), serializeProject(first.project));
  });

  it("folds a person's approve and request-changes like any unit, then redraws only what was sent back", async () => {
    const p = readyForSketch();
    const host = createFakeHost(p);
    const drawn = (await drawSketchPanels(p, host, { now: T0 })).project;

    const d1 = decision('approve', 'sc1_sh1', 1);
    const folded = foldDecisions(drawn, [d1, decision('request-changes', 'sc1_sh2', 2, 'Move Oren further right.')], { conformed: CONFORMED });
    assert.deepEqual(folded.report.rejected, []);
    assert.equal(unit(folded.project, 'sc1_sh1').status, 'approved');
    assert.equal(unit(folded.project, 'sc1_sh2').status, 'needs-rework');
    assert.ok(unit(folded.project, 'sc1_sh2').comments.some((c) => c.text === 'Move Oren further right.'));
    assert.equal(folded.project.stages.sketch.state, 'in-review');
    assert.equal(foldDecisions(folded.project, [d1], { conformed: CONFORMED }).report.changed, false, 'folding the same decision again changes nothing');

    // sent back but nothing changed: not redrawn, and said so
    host.calls.length = 0;
    const same = await drawSketchPanels(folded.project, host, { now: T0 });
    assert.deepEqual(same.stillSentBack, ['sc1_sh2']);
    assert.deepEqual(host.calls, []);
    assert.equal(unit(same.project, 'sc1_sh2').status, 'needs-rework');

    // the agent updates the blocking, then the panel is drawn again and goes back to review
    const edited = applyBlocking(same.project, { sc1_sh2: [box('O', 0.78)] }, { now: T0 });
    const redone = await drawSketchPanels(edited, host, { now: () => new Date('2026-11-08T09:00:00Z') });
    assert.deepEqual(redone.redrawn, ['sc1_sh2']);
    assert.deepEqual(host.calls, ['storeAsset']);
    const s = unit(redone.project, 'sc1_sh2') as Shot;
    assert.equal(s.status, 'pending-review');
    assert.ok(s.comments.some((c) => c.author === 'agent' && c.text.startsWith('Revised:') && c.decision === undefined));
    assert.equal(unit(redone.project, 'sc1_sh1').status, 'approved', 'an approved panel is not touched');

    // approving every shot approves the stage (folding does it, never the action)
    const ids = redone.project.shots.map((x) => x.id);
    const all = foldDecisions(redone.project, ids.map((id, i) => decision('approve', id, 10 + i)), { conformed: CONFORMED });
    assert.equal(all.project.stages.sketch.state, 'approved');
    assert.ok(all.project.shots.every((x) => x.status === 'approved'));
  });

  it('refuses an approval from a view that is not on the conformed list', async () => {
    const p = readyForSketch();
    const drawn = (await drawSketchPanels(p, createFakeHost(p), { now: T0 })).project;
    const d = { ...decision('approve', 'sc1_sh1', 1), view: 'rogue-view@1' } as Decision;
    const f = foldDecisions(drawn, [d], { conformed: CONFORMED });
    assert.equal(unit(f.project, 'sc1_sh1').status, 'pending-review');
    assert.equal(f.report.rejected.length, 1);
  });
});

describe('cli over a real folder', () => {
  it('blocking, draw, draw again, lint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'akuko-board-'));
    tmp.push(dir);
    const p = readyForSketch();
    for (const s of p.shots) s.blocking = [];
    writeFileSync(join(dir, 'akuko.json'), serializeProject(p));
    writeFileSync(join(dir, 'blocking.json'), JSON.stringify(BLOCKING));

    const b = await run(['blocking', '--project', dir, '--file', join(dir, 'blocking.json')], T0);
    assert.equal(b.code, 0, b.out);
    const d1 = await run(['draw', '--project', dir], T0);
    assert.equal(d1.code, 0, d1.out);
    assert.match(d1.out, /Drew 11 panel\(s\)/);
    assert.match(d1.out, /no-blocking/);
    assert.ok(existsSync(join(dir, 'board', 'panels', 'sc1_sh1-sketch.svg')));
    assert.ok(existsSync(join(dir, 'board', 'beatboards', 'beatboard-sc2.html')));
    const state1 = readFileSync(join(dir, 'akuko.json'), 'utf8');
    const html1 = readFileSync(join(dir, 'board', 'beatboards', 'beatboard-sc1.html'), 'utf8');

    const d2 = await run(['draw', '--project', dir], T0);
    assert.match(d2.out, /Drew 0 panel\(s\), redrew 0; 11 left/);
    assert.equal(readFileSync(join(dir, 'akuko.json'), 'utf8'), state1);
    assert.equal(readFileSync(join(dir, 'board', 'beatboards', 'beatboard-sc1.html'), 'utf8'), html1);
    assert.equal(readdirSync(join(dir, 'board', 'panels')).length, 11, 'a re-run writes no second copy');

    assert.equal((await run(['lint', '--project', dir])).code, 0);
    assert.equal((await run(['draw'])).code, 2);
    assert.equal((await createLocalHost({ projectDir: dir }).readState()).stages.sketch.state, 'in-review');
  });
});
