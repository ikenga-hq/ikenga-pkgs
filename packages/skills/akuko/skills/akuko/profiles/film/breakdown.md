# Film profile — breakdown rules

Read by `actions/breakdown.md`. These are the rules specific to a short film; the mechanics (ids, lint, tags) are code in `breakdown/`.

## The structure

Screenplay, top down: **acts → sequences → scenes → beats → shots.**

- **Scene**: one place and time, from one scene heading to the next. Id `sc<N>`, numbered by order in the screenplay.
- **Sequence** and **act**: groupings you note on the scene in the proposal (`act`, `sequence`). A short film often has one act and two or three sequences. They are kept on each beat's `metadata`, not as units.
- **Beat**: one story moment, a change or an action with a point. Shots that share a scene and a `beat` text share one beat (`sc<N>_b<K>`). Beats carry the narration (`vo`) and the beat's total length.
- **Shot**: one camera setup, one continuous piece of film. Id `sc<N>_sh<M>`. The unit a person reviews, and the unit that is generated.

## Shot sizing

| Rule | Limit | Enforced by |
|---|---|---|
| Length | **10 s at most**; aim for 5 to 10 s | lint error above 10 s, warning under 5 s |
| Principals in frame | **2 at most** | lint error above 2 |
| Duration given | every shot | lint error |

Why: today's video models make clips of about 5 to 10 s, and faces drift when more than two main characters share a frame. A shot over the limit is **split**, not shortened by guessing.

How long is a shot:
- Dialogue: about 2.5 spoken words per second, plus half a second either side.
- A simple action (a turn, a step, a look): 3 to 5 s. A move across a room or a reveal: 6 to 8 s.
- An establishing shot: 5 to 8 s. An insert or reaction can be under 5 s (the warning is meant for review, not a blocker).
- Don't pad to 5 s to quieten a warning; ask whether the shot should be merged with its neighbour.

A character counts as a principal unless their role is `Background`, `Extra`, `Crowd` or `Bystander`. A crowd is one background presence, not many characters.

## Where to cut

- New place or time: a new scene.
- A change of who is the subject, of what we are looking at, or of the action's point: a new shot.
- One continuous action seen from one place: one shot, up to 10 s. If it runs longer, cut on a natural point (a look, a step, a line).
- Two people talking: alternate the speaker (over-the-shoulder or close-up), one shot per line or pair of lines.
- Don't cut on every sentence. A paragraph of action is often one shot, sometimes two.
- Don't invent. Every shot comes from text in the screenplay (or the prose); if the story doesn't show it, it isn't a shot.

## Shot vocabulary

`shot_type`: `ews` extreme wide · `ws` wide · `ls` long · `fs` full · `ms` medium · `cu` close-up · `ecu` extreme close-up · `ots` over the shoulder · `pov` point of view · `insert` · `aerial` · `overhead` · `unset`.

`camera_move`: `static` · `pan` · `tilt` · `dolly` · `truck` · `crane` · `handheld` · `zoom-in` · `zoom-out` · `orbit` · `push-in` · `pull-out` · `whip-pan` · `unset`.

`unset` is honest; a guessed value is not. `camera` is a free note (`Static, low angle`).

## The asset checklist

The checklist is what the bible stage will make. List, once each:
- every **character** who appears in a shot, with a role (`Principal`, `Supporting`, `Background`) and a description taken from the text (age, build, clothing and so on; invent nothing);
- every **location** a shot is set in;
- one or more **styles**: the overall look, from the tone and light the text implies (a lookbook entry).

Each shot lists the characters in frame and its location **by checklist name**; code resolves them to bible ids. Props have no bible entry yet: put a story-critical prop in the shot `notes`.

Everything the breakdown writes is `pending-review`. Bible work (images, sheets) is the next paid stage and is not started here.

## Tags

`[[sc<N>_sh<M>]]` is appended to the screenplay paragraph each shot came from (`script/screenplay.fountain`), or to the source paragraph on the direct route (`script/source.md`). It is invisible to a reader. Rules:
- tag only on a confident match; leave a shot untagged (and say so) rather than guess;
- never move or remove an existing tag; report a disagreement;
- several shots from one paragraph: tags side by side;
- re-running never stacks a second tag.
