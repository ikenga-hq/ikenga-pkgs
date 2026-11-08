# Short Story Fixture — The Tell-Tale Heart / The Beating

This fixture provides the inputs needed for a full pipeline run of Edgar Allan Poe's classic short story *The Tell-Tale Heart* adapted as *The Beating* (~70 seconds, 16:9, 4 scenes, 12 shots), matching the project shape in `fixtures/the-beating/akuko.json`.

## Files

- `source.md`: The full text of Edgar Allan Poe's *The Tell-Tale Heart* (1843, public domain) sourced from Project Gutenberg eBook #2148 (*The Works of Edgar Allan Poe, Volume 2*), stripped of Gutenberg header/footer/licence boilerplate with story text kept exact.
- `screenplay.fountain`: The adapted Fountain screenplay produced by following the `adapt` route (`actions/intake.md`). Formatted with title page, standard scene headings, visual present-tense action, and exact dialogue quotes.
- `proposal.json`: The breakdown proposal matching the structure of `breakdown/__fixtures__/proposal-adapt.json`. Defines the 4 scenes, character/location/style checklist, and 12 shots totaling 70 seconds runtime.
- `short-story.test.ts`: Integration test running intake and breakdown on these fixture inputs in a temp folder, asserting integrity, lint cleanliness, exact shot/scene matches, verbatim script coverage, and idempotency.

## How a run uses these files

A real run on host B/C exercises the breakdown CLI over these files:

1. **Create project:**
   ```bash
   node --experimental-strip-types breakdown/cli.ts new --project ./my-film --title "The Beating"
   ```

2. **Intake (adapt route):**
   Place `source.md` in `my-film/script/source.md` and `screenplay.fountain` in `my-film/script/screenplay.fountain`, then run:
   ```bash
   node --experimental-strip-types breakdown/cli.ts intake --project ./my-film --route adapt
   ```
   Intake records `script-source` and `script-screenplay` assets at `pending-review` and moves stage `intake` to `in-review`. A person reviews and approves intake.

3. **Breakdown proposal apply:**
   Once intake is approved:
   ```bash
   node --experimental-strip-types breakdown/cli.ts apply --project ./my-film --proposal ./proposal.json
   ```
   This validates the proposal, checks integrity, allocates canonical IDs (`sc<N>`, `sc<N>_sh<M>`, `char_*`, `loc_*`, `style_*`), populates `scenes[]`, `shots[]`, `script.beats[]`, and the bible checklist, and lints the result.

4. **Tagging and Linting:**
   ```bash
   node --experimental-strip-types breakdown/cli.ts tag --project ./my-film
   node --experimental-strip-types breakdown/cli.ts lint --project ./my-film
   ```
   `tag` appends `[[sc<N>_sh<M>]]` Fountain notes to each shot's originating paragraph in `script/screenplay.fountain`. `lint` verifies that all shots satisfy timing limits (≤ 10 s), principal character limits (≤ 2), and tag alignments with zero errors.
