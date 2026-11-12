---
name: bible
description: "Build the character, location and style bible."
domain: content
ux_mode: approve
run:
  kind: chat_prompt
  prompt: |
    Load actions/bible.md from the akuko skill and follow it.
    Run host detection first (lib/hosts.md) and obey the review and spend rules in SKILL.md.
triggers:
  - kind: manual
depends_on: []
requires_capabilities:
  - fs
  - network
  - secrets
  - chat
---

# action: `bible` — build the character, location and style bible

**Loaded when**: every earlier stage is approved (breakdown and sketch) and the user runs `/akuko bible`.

**Reads first**: `../lib/state.md` (§3 bible, §Status transitions, §Decision folding), `../lib/hosts.md`, `../lib/spend.md`, `../lib/providers.md`, and the film templates `../profiles/film/templates/character.md`, `location.md`, `style.md` (what a sheet, plate and lookbook contain and how they are labelled).

**Stage**: `bible` (3) · **paid** (spend gate before every generation) · free with the manual provider. Never approves.

**What is judgement and what is code.** Which images exist, the order they are made in, the references each one gets, the prompt text, the job id and every status move are code in `../bible/` (tested). Yours: the **audit** of each image before it goes to review (the templates list what to look for), what to tell the person, and handing the person the right thing at each gate. **Never write a status or an id yourself, and never call a provider directly: only `gate.run()` does.**

## The technique

Consistency comes from the order, not from luck (plan E-3):

1. **Lookbook first.** One wide key frame of the film's look. Once approved, it is attached to everything after it.
2. **Portrait**, then a **labelled turnaround** that is generated **with the approved portrait attached** (`FRONT`, `THREE-QUARTER FRONT`, `SIDE`, `THREE-QUARTER BACK`, `BACK`, five views, same clothes). Principal characters get both; a Supporting character gets a portrait only; a Background character gets none.
3. **Plates** for each location: the place, empty, wide, in the lookbook's look.

Reliability drops past two principals in a frame (breakdown already caps shots at two), so audit each sheet for duplicated figures and stray labels before sending it on.

## Where the stage is tracked

The checklist entries stay **approved** at stage `breakdown`; they are never re-opened. The bible stage's units are **assets**, one planned per image (`char_mara_portrait`, `char_mara_turnaround`, `loc_river-pier_plate`, `style_fog-and-lamplight_lookbook`), stage `bible`. See `../lib/state.md` §3 for the exact rules. A person approves an image on the board (a decision, folded); folding is the only thing that writes `approved`.

## Steps

All commands: `node --experimental-strip-types ../bible/cli.ts <command> --project <folder>` (B and C). Paid image providers: `gemini-image`, `fal` and `byteplus-image` (Seedream on BytePlus ModelArk, `ARK_API_KEY`). On host A use the manual provider, or a paid direct image API under R-11 only, in the order of `../actions/motion.md` §Steps "On host A" with `../bible/cli.ts` in place of the motion command (`../lib/spend.md` §Host A).

0. **Fold decisions first** (`../decisions/cli.ts fold`, `../lib/state.md` §Decision folding). Tell the person what the report says, including every rejected decision. If the project is locked, say which earlier stage is waiting and stop.
1. **`plan`**: creates the planned images for every approved checklist entry. Safe to repeat.
2. **`status`**: one line per image, with what it is waiting for. Report it to the person in plain words. If a line says "generated against a superseded portrait/lookbook", tell the person that image was made from a reference that has since changed and that they may want to send it back. Never regenerate or change it yourself.
3. **Choose the provider** (config and the person decide, not you): `manual` (free; hosts A, B, C), `gemini-image` or `fal` (paid direct API; hosts B and C only, refused on A). A paid provider needs a budget cap from `/akuko setup`; without one the command says so and stops.
4. **`step --provider <id>`** makes the next wave (the earliest wave with images ready):
   - **Paid:** it prints the spend line. **Show it to the person and wait.** Nothing has been sent. The person approves on the board (or replies in the exact words of the line, `approve <amount> <CURRENCY>`); fold, then run `step` again. It then runs, records the files and marks them `pending-review`. A declined spend sends nothing.
   - **Manual:** it prints the prompt package (the prompt, the reference files to attach, the name to save as) and saves the job. Give it to the person. They bring the files back by attaching them or dropping them in the folder: `ingest --job <id> --unit <asset id> --file <path> [--actual <cost they report>]`, once per image.
   - **A connected tool on the person's plan (host A, e.g. Canva):** it uses their plan's AI allowance, not money, and it is not free. Before **each wave** post the allowance line from `../lib/spend.md` §Allowance (how many generations, which service, that akuko can't see what is left) and wait for the exact reply `approve <n> canva generations`. Record every generation in the ledger with zero money and its units count. One reply covers one wave; a retry is a new wave.
5. **Audit each image** (the template's checklist) **before** telling the person it is ready. If one fails, say what is wrong and offer another try (paid: a new approval). Do not hide a bad sheet.
6. **Stop at the review gate.** Everything made is `pending-review` and the stage is `in-review`. The person reviews each image one at a time on the board. The next wave stays blocked until they approve the references it needs. Don't start it, and don't call anything approved.
7. **After the person's answers**: fold, then `sync` (sets each entry's `refs[]` to its approved images and the stage state), then `step` again for the next wave. When the last image is approved the stage is `approved` and keyframes opens.

## When a person sends an image back

Folding turns it into `needs-rework` with their words. Run `step --units <asset id>` for it: the old file is cleared (it stays stored; the "Revised: …" comment says where), their words are added to the prompt, the new take fills the same asset, and it goes to `pending-review` again. A paid regeneration is a new job and needs a new approval.

## Rules check

When the project has `rules` (`../lib/state.md` §"Rules guard (WP-26)"), every job is checked against them before the spend gate: banned terms in the prompt (the entry's name, description and notes go into it; the negative prompt is not checked for banned terms, since listing a word there is how a prompt avoids it), and for a paid job every reference file by its content hash. A picture the person supplied can be sent only if its sha256 is in `rules.uploads.allow`; when the allowance has `for`, it must cover the entry the job is for (and the entry the picture is attached to). A `never_from_photo` entry can use only images akuko generated and can verify by their recorded hash. A breach prints `Refused (rules-breach): …`, naming each rule and the offending text or file; `rules-missing` means `rules.required` is set but no rules are recorded. Nothing was priced, sent or spent. **Tell the person what it says and stop.** Don't reword a description, drop a reference or edit `rules` to get past it: the person decides. Before a paid wave, run the free preflight, `node --experimental-strip-types ../rules/cli.ts check --project <folder>`, and show the person anything it lists.

## Limits to know

- At most **14** reference images per image. The turnaround sends the portrait and the lookbook (and any pictures the person supplied for that entry as `reference` assets). The providers' per-role sublimits (for example 4 character references on a Gemini Flash model) are **not** enforced yet; with the default sends there are never more than a few.
- An image a provider refuses or fails stays `draft`; say so, and nothing is recorded as made. Money a failed call cost is counted against the cap (`../lib/spend.md`).

## Rules it inherits

- Detect the host first; read and write the project only through the host adapter (`../hosts/`).
- Fold decisions before doing anything else (`../lib/state.md` §Decision folding).
- Ends at a review gate: units go to `pending-review`; only a person moves them to `approved`. Never auto-advance.
- No paid call without an estimate, a budget cap and an explicit OK from a person; every generation goes through `gate.run()`.
