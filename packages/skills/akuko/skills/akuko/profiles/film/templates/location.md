# Location plate — template

Read by `actions/bible.md`. Code (`../../../bible/prompts.ts`) fills the prompt block below from the bible entry.

## What a location has

One **plate** (asset `<entry>_plate`): the place with nobody in it, wide, at eye level, in the film's look. It fixes the architecture, materials, layout and light so that every shot set there starts from the same room. People are added later, in key frames.

Rules for a plate:

- **Empty.** No people, no animals, no vehicles in motion. Story-critical props that are part of the place (the door at the end of the hall) stay.
- **Wide and level.** An establishing view, camera at about standing eye height, a clear sense of where the exits and the main light source are.
- **One time of day.** The one the story uses most; say so in the notes if another is needed (a second plate is a second location entry, decided at breakdown).
- **No text.** No signs with readable words unless the story needs them.

## Audit before sending it to review

- nobody in frame; no stray figures in windows or mirrors;
- the layout matches the description (one door, four-poster bed, one lamp);
- the light matches the style entry;
- no text, watermark or caption.

## Prompt: plate

```text
Location plate for a film: {{name}}.
{{description}}
Empty set, no people. Wide establishing view at standing eye height, showing the whole space, its exits and its main light source. No text.
Notes: {{notes}}
Overall look of the film: {{look}}
Match the attached reference images for the film's look.
```
