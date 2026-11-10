/**
 * akuko — the README of a master-clock export (WP-23b): what was placed, what was left out, and the import
 * steps. Pure text from the plan.
 */

import type { ExportPlan } from './plan.ts';
import { startOf } from './plan.ts';
import { moveLabel } from './master.ts';
import { timecode } from './timecode.ts';

const frames = (n: number): string => `${n} frame${n === 1 ? '' : 's'}`;

export function renderMasterReadme(plan: ExportPlan, o: { format: 'fcpxml' | 'edl' | 'both'; timelineOnly: boolean; edlFiles: string[] }): string {
  const { fps } = plan;
  const m = plan.master!;
  const start = startOf(plan);
  const tc = (f: number): string => timecode(start + f, fps);
  const L: string[] = [];
  const nShots = plan.shots.filter((s) => s.uses !== 'no-duration' && s.uses !== 'removed').length;
  const placed = plan.shots.filter((s) => s.uses !== 'gap' && s.uses !== 'no-duration' && s.uses !== 'removed').length;
  const nCards = plan.cards?.length ?? 0;
  L.push(`# ${plan.title}: DaVinci Resolve handoff (master clock)`, '');
  L.push(`${placed} of ${plan.shots.length} shots and ${nCards} card${nCards === 1 ? '' : 's'} are on the timeline, each at its **film time**, over the locked master audio. ${timecode(plan.totalFrames, fps)} (${frames(plan.totalFrames)}) at ${fps.label} fps, ${plan.width} x ${plan.height}; the timeline starts at **${m.startTc}**. Written by akuko; only material a person approved is on it.`, '');
  if (o.timelineOnly) {
    L.push('**This is a timeline-only export.** No media was copied, so the clips and the master will open offline in Resolve until you relink them (Media Pool > select the clips > right-click > Relink Selected Clips). `DOWNLOAD-LIST.md` names every file.', '');
  }
  L.push('## How this timeline is laid out', '');
  L.push(
    `- **Audio track A1 is the master**, \`${m.media.dest.split('/').pop()}\`, whole, from its first sample at ${m.startTc}. It is never cut or moved: every picture is placed against it. ${m.linked ? `It is **referenced in place** (\`--link-media\`), not copied: it stays at \`${m.media.uri}\`, so keep it where it is, or relink it.` : 'It is **copied** into `audio/` (use `--link-media` to reference it in place instead, so a large file is not duplicated).'}`,
    `- **Picture (V1)**: each shot sits at \`film.in_s\` and lasts until \`film.out_s\`, in whole frames (seconds x the real frame rate, ${fps.label} fps, rounded to the nearest frame at both ends, so shots that touch in film time touch here). **Gaps are kept as gaps**: a pause between scenes is empty video, not closed up.`,
    "- Picture for a shot, in order: its approved **lip-sync clip**, else its approved **clip**, else its approved **key frame** as a still held for the whole slot, else a **gap** (listed in LEFT-OUT.md).",
    "- A clip **longer** than its slot is cut at the slot's end. A clip **shorter** is followed by a **gap** for the rest of the slot (nothing is stretched or frozen) and named in the notes: decide in Resolve whether to hold its last frame.",
    '- **Picture files never bring their own sound.** The master is the only sound; any clip that carries audio is muted in the timeline (and listed below).',
    '- Approved **cards** (title, part cards, credits) sit at their film times on V1. A card nobody approved is left out and listed.',
    "- Voice-over, music and effects that exist in the project are **not laid**: the master already has the film's sound. They are listed as covered by the master in LEFT-OUT.md.",
    '',
  );
  L.push('## Import into Resolve (FCPXML, the main file)', '');
  L.push(
    `1. New Resolve project. Before importing anything set **Timeline frame rate to ${fps.label}** and the resolution to ${plan.width} x ${plan.height} (Project Settings > Master Settings). The rate locks once there is media in the Media Pool.`,
    '2. File > Import > Timeline... > `timeline.fcpxml`. Keep **Automatically import source clips into media pool** ticked.',
    `3. Check the timeline's **start timecode is ${m.startTc}** (Timeline > Timeline Settings; the import should set it from the file, but option names differ a little between Resolve versions). If it shows another value, set it to ${m.startTc} so the timecodes in the tables below match.`,
    '4. Check A1 holds the master from its first frame, and that V1 clips are silent. Park the playhead on the first frame of a shot from the table and play: its line should land with the picture.',
    '5. If anything is offline (you moved the folder): Media Pool > select the clips > right-click > **Relink Selected Clips** and point at this folder. Files are matched by file name, and every name here is unique.',
    '',
  );
  if (o.format !== 'fcpxml') {
    L.push('## Fallback: EDL', '');
    L.push(
      'An EDL has timecodes and reel names but no file locations or frame rate, and **cannot carry camera moves** (see the moves table). Use it only if the FCPXML does not import.',
      '',
      `1. Import everything in \`media/\` and \`audio/\` into the Media Pool first (File > Import > Media), and set the timeline frame rate to ${fps.label}.`,
      '2. Project Settings > General Options > Conform Options: tick **Assist using reel names from the** and pick **Source clip filename** *before* importing.',
      `3. File > Import > Timeline... > \`edl/video.edl\` (a new timeline). ${o.edlFiles.length > 1 ? 'Each `edl/audio-N.edl` is its own new timeline: for the master, simply drag the master from the Media Pool onto A1 at the start instead.' : ''}`,
      "4. Reels: `V###` the picture of shot ###, `C001`... the cards, `MASTER` the master audio; the file name is in each event's `FROM CLIP NAME` comment. **Unverified:** whether Resolve matches `V###` reels to files by itself; if clips are offline, use the FCPXML or place them by hand from the Timeline table.",
      '',
    );
  }
  L.push('## Timeline', '', '| Record in | Frames | Length | What |', '|---|---|---|---|');
  for (const v of plan.video) {
    const what = v.kind === 'gap' ? `gap${v.shot ? ` (${v.shot})` : ''}: ${v.note ?? ''}` : `${v.shot}: ${v.note ?? v.kind}`;
    L.push(`| ${tc(v.recIn)} | ${v.frames} | ${(v.frames * fps.num / fps.den).toFixed(3)} s | ${what} |`);
  }
  L.push('', `The timeline is ${frames(plan.totalFrames)} long: the master's length (${m.durationS} s) rounded **up** to a whole frame, so none of its sound is cut. ${nShots} shot${nShots === 1 ? ' has' : 's have'} a film time.`, '');
  const gaps = plan.video.filter((v) => v.kind === 'gap');
  if (gaps.length > 0) {
    L.push('## Gaps', '', `${gaps.length} gap${gaps.length === 1 ? '' : 's'}: film time with no picture (a pause between scenes, or a shot nobody has approved). They are the "gap" rows in the table above.`, '');
  }
  if (plan.moves && plan.moves.length > 0) {
    L.push('## Camera moves on stills', '');
    L.push(
      `${plan.moves.length} still${plan.moves.length === 1 ? ' has' : 's have'} a camera move (scale and drift over the whole slot). Two things are in the FCPXML for each: an animated transform (scale and position keyframes across the slot), **and a marker** on the clip with the same numbers in words.`,
      '',
      "**Not verified:** whether Resolve imports FCPXML transform keyframes. Blackmagic's manual says an XML import can bring in position, scale and rotation (\"Use sizing information\" in the import dialog) but does not say that keyframed animation arrives; forum reports (read 2026-11-10) are mixed, and several say moves on stills came in static. **After import, open a clip with a move and look at Inspector > Transform:** if the Zoom and Position keyframes are there, nothing more to do. If the still sits unmoved, read its marker and set the move by hand from the table: key Zoom at the first frame (From) and the last frame (To), and Position X/Y at the last frame, then ease if the table says so. The EDL cannot carry moves at all.",
      '',
      '`x` and `y` are pixels of a 1920 x 1080 frame (negative = left / up). In the FCPXML they are written as Apple documents them: percent of the frame height, y up. Eases map to keyframe interpolation (`ease-in` eases away from the first keyframe, `ease-out` into the last, `ease-in-out` both, `none` is linear); this mapping is also unverified in Resolve.',
      '',
      '| Shot | Record in | Length | Move |',
      '|---|---|---|---|',
    );
    for (const mv of plan.moves) L.push(`| ${mv.shot} | ${tc(mv.recIn)} | ${frames(mv.frames)} | ${moveLabel(mv.shot, mv.move).replace(/^MOVE [^:]+: /, '')} |`);
    L.push('');
  }
  if (plan.leftOut.length > 0) {
    L.push('## Left out', '', 'Not on the timeline (the reasons are in `LEFT-OUT.md` too):', '');
    for (const x of plan.leftOut) L.push(`- ${x.unit} (${x.what}): ${x.why}`);
    L.push('');
  }
  const silent = plan.media.filter((x) => x.hasAudio && x.role === 'clip');
  if (silent.length > 0) {
    L.push('## Picture files that carry sound (muted)', '', 'These files have their own audio track. It is muted in the timeline: the master is the only sound.', '');
    for (const x of silent) L.push(`- ${x.dest}`);
    L.push('');
  }
  L.push('See `LEFT-OUT.md` for what is not on the timeline and why, and `checksums.sha256` to check the copies. Re-running the export replaces only the files listed in `export-manifest.json`.', '');
  return L.join('\n');
}
