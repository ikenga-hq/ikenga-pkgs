/**
 * akuko — command line for the sound stage (hosts B and C).
 *
 *   node --experimental-strip-types sound/cli.ts <command> --project <dir> [options]
 *
 *   plan   [--script-lines all|sc1_sh1,sc1_sh2]
 *            one planned voice-over per shot that has narration text. A shot with only a
 *            script line is PROPOSED, not planned: pass --script-lines with the shot ids
 *            (or all) once the person has confirmed those lines as the narration.
 *   status                    one line per voice-over, and what it is waiting for
 *   step   --provider <id> [--voice <voice id>] [--model <id>] [--units a,b] [--scene sc1]
 *            the next voice-over (one shot) through the spend gate: manual | elevenlabs
 *            paid: prints the spend line and stops until a person approves it, then runs
 *            manual: prints the text and stops; bring files back with `ingest`
 *   ingest --job <id> --unit <asset id> --file <audio> [--words <words.json>] [--actual <n>]
 *            record a take the person made for a manual job; without --words it is recorded
 *            without timings (never guessed)
 *   collect --job <id>        poll a paid job submitted earlier and record its files
 *   sync [--captions]         repair the stage state, then rebuild audio.narration and the
 *                             caption files (audio/vo/captions.vtt|srt) from the APPROVED takes
 *   add-music | add-sfx --file <audio> --licence "<text>" [--source "<text>"] [--shot id | --scene id] [--name "<text>"]
 *            record a music bed / SFX the person supplied (licence required; nothing is generated)
 *
 * Fold decisions first (`decisions/cli.ts fold`); `approved` only ever arrives that way.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalHost, writeFileAtomic } from '../hosts/local.ts';
import type { Job, JobHandle, Provider } from '../providers/contract.ts';
import { createManualProvider } from '../providers/manual/index.ts';
import { createElevenLabsProvider } from '../providers/tts/elevenlabs/index.ts';
import { createSpendGate } from '../spend/gate.ts';
import { rebuildNarration } from './narration.ts';
import { SoundError, planSound, soundStatus } from './plan.ts';
import { collectVoiceover, finalizeSound, generateVoiceover, ingestSoundFile, ingestVoiceover, type StepResult } from './run.ts';
import { WordsError } from './words.ts';

export interface CliResult { code: number; out: string }

function flags(argv: string[]): { cmd: string; opt: Map<string, string | true> } {
  const [cmd = '', ...rest] = argv;
  const opt = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) { opt.set(a.slice(2), next); i++; } else opt.set(a.slice(2), true);
  }
  return { cmd, opt };
}
const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

const MIME: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };

interface SavedJob { job: Job; handle: JobHandle }
const jobFile = (dir: string, id: string): string => join(dir, 'sound', 'jobs', `${id}.json`);
const NL = String.fromCharCode(10);

function describe(r: StepResult): CliResult {
  switch (r.status) {
    case 'awaiting-approval':
      return { code: 0, out: `${r.confirmation}${NL}Nothing has been sent. Put the amount in front of the person; once they have approved it, run this step again.` };
    case 'refused':
      return { code: 1, out: `Refused (${r.code}): ${r.message}` };
    case 'failed':
      return { code: 1, out: `Failed: ${r.error}` };
    case 'running':
      return { code: 0, out: `Job ${r.job.id} is still running (${r.message}). Run collect --job ${r.job.id} later.` };
    case 'done':
      return { code: 0, out: `Done: ${r.assets.length} voice-over${r.assets.length === 1 ? '' : 's'} recorded (${r.assets.join(', ')}), cost ${Number(r.cost.toFixed(6))}. They are waiting for the person's review.${r.message ? `${NL}Note: ${r.message}` : ''}` };
    case 'handoff': {
      const lines = r.job.items.map((i) => `${i.unit}${i.duration_s !== undefined ? ` (the shot lasts ${i.duration_s}s; keep the read inside it)` : ''}:${NL}${i.prompt}`);
      return { code: 0, out: `${r.text}${NL}${NL}Read these words exactly, nothing added:${NL}${lines.join(NL + NL)}${NL}${NL}Job ${r.job.id}. When the files are back: ingest --job ${r.job.id} --unit <asset id> --file <audio> [--words <words.json>] for each. Without a words file the take is recorded without timings and captions need them.` };
    }
  }
}

export async function run(argv: string[], now: () => Date = () => new Date()): Promise<CliResult> {
  const { cmd, opt } = flags(argv);
  const dir = str(opt.get('project'));
  if (!dir) return { code: 2, out: 'akuko: --project <folder> is required.' };
  const host = createLocalHost({ projectDir: dir, now });
  const clock = () => now().toISOString();

  try {
    if (cmd === 'status') {
      const rows = soundStatus(await host.readState());
      if (rows.length === 0) return { code: 0, out: 'Nothing planned yet. Run plan.' };
      return { code: 0, out: rows.map((r) => `${r.asset}: ${r.status} (${r.state}${r.waiting.length ? `, waiting for ${r.waiting.join(', ')}` : ''}${r.textChanged ? '; the shot\'s text changed since this take - consider sending it back' : ''}${r.noWords ? '; no word timings, captions need them' : ''})`).join(NL) };
    }
    if (cmd === 'plan') {
      const sl = str(opt.get('script-lines'));
      const scriptLines = sl === undefined ? undefined : sl === 'all' ? ('all' as const) : sl.split(',').filter(Boolean);
      const r = planSound(await host.readState(), clock(), scriptLines ? { scriptLines } : {});
      await host.writeState(r.project);
      const out = [r.created.length ? `Planned ${r.created.length} voice-over${r.created.length === 1 ? '' : 's'}: ${r.created.join(', ')}.` : 'Nothing new to plan.'];
      if (r.proposals.length) {
        out.push(`${r.proposals.length} shot${r.proposals.length === 1 ? ' has' : 's have'} no narration, only a script line. Ask the person whether to speak these lines as the narration; if yes, run plan --script-lines <ids|all>. Nothing is chosen for them:`);
        for (const x of r.proposals) out.push(`  ${x.shot}: ${x.script_line}`);
      }
      if (r.noText.length) out.push(`No text at all (no voice-over): ${r.noText.join(', ')}.`);
      return { code: 0, out: out.join(NL) };
    }
    if (cmd === 'sync') {
      const repaired = await finalizeSound({ host, now: clock });
      const r = await rebuildNarration({ host, now: clock, readFile: (uri) => readFile(join(dir, uri)), ...(opt.has('captions') ? { forceCaptions: true } : {}) });
      const out: string[] = [];
      if (repaired.length) out.push(`Reset ${repaired.join(', ')} to pending (no file).`);
      if (r.status === 'nothing') out.push(r.reason);
      else {
        out.push(r.status === 'built' ? `audio.narration rebuilt: ${r.words} word${r.words === 1 ? '' : 's'} on the film timeline.` : `audio.narration is up to date (${r.words} words).`);
        if (r.trackSkipped) out.push(`No single narration track: ${r.trackSkipped}.`);
        if (r.withoutTimings.length) out.push(`Without word timings (not in the captions): ${r.withoutTimings.join(', ')}.`);
        if (r.captions) out.push(`Captions: ${r.captions.cues} cues, ${r.captions.vtt} and ${r.captions.srt}.`);
        out.push(...r.warnings.map((w) => `Note: ${w}`));
      }
      return { code: 0, out: out.join(NL) };
    }

    if (cmd === 'add-music' || cmd === 'add-sfx') {
      const path = str(opt.get('file'));
      const licence = str(opt.get('licence'));
      if (!path || licence === undefined) return { code: 2, out: 'akuko: --file and --licence "<text>" are required (the person states the licence; akuko records it).' };
      const mime = MIME[extname(path).toLowerCase()];
      if (!mime) return { code: 1, out: `akuko: ${path} is not a .mp3, .wav, .ogg or .m4a file.` };
      const shot = str(opt.get('shot'));
      const scene = str(opt.get('scene'));
      const source = str(opt.get('source'));
      const name = str(opt.get('name'));
      const r = await ingestSoundFile({ host, now: clock }, {
        kind: cmd === 'add-music' ? 'music' : 'sfx',
        file: { filename: resolve(path).split(/[\\/]/).pop() ?? 'file', mime, data: new Uint8Array(await readFile(path)) },
        licence,
        ...(source ? { source } : {}),
        ...(name ? { name } : {}),
        placement: shot ? { shot } : scene ? { scene } : 'film',
      });
      return { code: 0, out: `Recorded ${r.asset}; it is waiting for the person's review.` };
    }

    // Commands below talk to providers, always through the gate.
    const level = (await host.detect()).level;
    const manual = createManualProvider(host, { now: clock });
    const providers: Provider[] = [manual.provider, createElevenLabsProvider(host, { now: clock })];
    const gate = createSpendGate({ host, providers, level, now: clock });
    const deps = { host, gate, now: clock };

    if (cmd === 'step') {
      const provider = str(opt.get('provider'));
      if (!provider) return { code: 2, out: 'akuko: --provider manual|elevenlabs is required.' };
      const model = str(opt.get('model'));
      const voice = str(opt.get('voice'));
      const units = str(opt.get('units'))?.split(',').filter(Boolean);
      const scene = str(opt.get('scene'));
      const r = await generateVoiceover(deps, { provider, ...(model ? { model } : {}), ...(voice ? { voice } : {}), ...(units ? { units } : {}), ...(scene ? { scene } : {}) });
      if (r.status === 'handoff' || r.status === 'running') {
        await mkdir(join(dir, 'sound', 'jobs'), { recursive: true });
        await writeFileAtomic(jobFile(dir, r.job.id), `${JSON.stringify({ job: r.job, handle: r.handle } satisfies SavedJob, null, 2)}\n`);
      }
      return describe(r);
    }

    const jobId = str(opt.get('job'));
    if (cmd === 'ingest' || cmd === 'collect') {
      if (!jobId) return { code: 2, out: 'akuko: --job <id> is required.' };
      const file = jobFile(dir, jobId);
      if (!existsSync(file)) return { code: 1, out: `akuko: no saved job ${jobId}; run step first.` };
      const saved = JSON.parse(await readFile(file, 'utf8')) as SavedJob;
      if (cmd === 'collect') return describe(await collectVoiceover(deps, saved.job, saved.handle));
      const unit = str(opt.get('unit'));
      const path = str(opt.get('file'));
      if (!unit || !path) return { code: 2, out: 'akuko: --unit and --file are required.' };
      const mime = MIME[extname(path).toLowerCase()];
      if (!mime) return { code: 1, out: `akuko: ${path} is not a .mp3, .wav, .ogg or .m4a file.` };
      const wordsPath = str(opt.get('words'));
      const actual = str(opt.get('actual'));
      const model = str(opt.get('model'));
      const r = await ingestVoiceover(deps, manual, saved.job, unit, { filename: resolve(path).split(/[\\/]/).pop() ?? 'file', mime, data: new Uint8Array(await readFile(path)) }, {
        ...(wordsPath ? { words: { filename: wordsPath, data: new Uint8Array(await readFile(wordsPath)) } } : {}),
        ...(actual !== undefined ? { actual: Number(actual) } : {}),
        ...(model !== undefined ? { model } : {}),
      });
      return { code: 0, out: [`Recorded ${r.asset}${r.timings ? ' with word timings' : ' without word timings'}; it is waiting for the person's review.`, ...r.warnings].join(NL) };
    }

    return { code: 2, out: 'akuko: command must be plan, status, step, ingest, collect, sync, add-music or add-sfx.' };
  } catch (err) {
    if (err instanceof SoundError || err instanceof WordsError) return { code: 1, out: err.message };
    return { code: 1, out: `akuko: ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  console.log(r.out);
  process.exitCode = r.code;
}
