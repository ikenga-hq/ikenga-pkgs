# Character sheet — template

Read by `actions/bible.md`. Code (`../../../bible/prompts.ts`) fills the two prompt blocks below from the bible entry; nothing here is specific to one film or one brand.

## What a character has

Two images, in this order, each approved by a person before the next is made:

1. **Portrait** (asset `<entry>_portrait`). One face, head and shoulders, neutral expression, plain background, even light, no text. It fixes the face, hair, age and build. Everything later is checked against it.
2. **Turnaround** (asset `<entry>_turnaround`). One wide sheet, the same person standing in the same neutral pose, seen from five angles, each with a small label. It is generated **with the approved portrait attached as a reference** and fixes wardrobe and silhouette.

Which characters get which:

| Role in the breakdown | Portrait | Turnaround |
|---|---|---|
| Principal (and any role not named below) | yes | yes |
| Supporting | yes | no |
| Background, Extra, Crowd, Bystander | no | no |

## The turnaround layout

Left to right: `FRONT` · `THREE-QUARTER FRONT` · `SIDE` · `THREE-QUARTER BACK` · `BACK`. Full body, feet visible, arms relaxed, same expression, same clothes in every pose, plain light-grey background. The character's name sits once, top left. A labelled sheet gives the model something to hold on to; an unlabelled one drifts.

## Audit before sending it to review

Look at the sheet yourself first and say what you see:

- the same person five times, not five different people;
- exactly five figures, none duplicated or cropped;
- labels spelled as above, no stray text or watermark;
- clothes and hair identical across poses; hands with five fingers;
- the face still matches the portrait.

A sheet that fails is not sent for review as it is; say what is wrong and offer to try again (a paid run needs a new approval).

## Prompt: portrait

```text
Character portrait for a film. {{name}} ({{role}}).
{{description}}
Head and shoulders, facing the camera, neutral expression, eyes level with the lens, plain mid-grey background, soft even light, no text, no props.
Notes: {{notes}}
Overall look of the film: {{look}}
Match the attached reference images for the film's look; do not copy any figure from them.
```

## Prompt: turnaround

```text
Character turnaround sheet for a film. {{name}} ({{role}}).
{{description}}
The same person as the first attached reference image (the approved portrait): identical face, hair, age and build. Five full-body views side by side on one wide sheet, left to right: FRONT, THREE-QUARTER FRONT, SIDE, THREE-QUARTER BACK, BACK. Same neutral standing pose, same expression, same clothes in every view, feet visible, plain light-grey background. Small clear labels under each view, the name {{name}} once at top left. No other text.
Notes: {{notes}}
Overall look of the film: {{look}}
```
