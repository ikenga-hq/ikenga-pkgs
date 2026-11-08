# Style and lookbook — template

Read by `actions/bible.md`. Code (`../../../bible/prompts.ts`) fills the prompt block below from the bible entry.

## What a style entry has

The words (the entry's `description` and `notes`: palette, light, grain, lens feel, what the film never does) and **one lookbook image** (asset `<entry>_lookbook`): a single key frame that shows those words as a picture. No characters, no named location; just the light, colour, texture and composition the film lives in.

The lookbook is made **first**. Once a person approves it, it is attached as a reference to every portrait, turnaround and plate, and later to every key frame, so that the film reads as one film.

Rules for a lookbook frame:

- **Wide, 16:9, no people.** A landscape or interior in the intended light, with space left in the composition the way the notes say.
- **A palette strip is welcome**: five swatches along the bottom edge, no labels.
- **No text.**

If the project has more than one style entry (rare), each gets its own lookbook and all approved ones are attached.

## Audit before sending it to review

- the light, palette and grain match the notes, including the things the film avoids (no lens flares, no neon);
- no people, no text, no watermark;
- it would still look like the same film next to the others.

## Prompt: lookbook

```text
Lookbook key frame for a film: {{name}}.
{{description}}
A single wide cinematic frame, 16:9, no people, no text. Show the light, colour palette, texture and composition described in the notes. Five small colour swatches along the bottom edge, no labels.
Notes: {{notes}}
```
