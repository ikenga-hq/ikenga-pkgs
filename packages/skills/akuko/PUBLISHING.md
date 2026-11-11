# Publishing akuko

akuko has one editable copy: `packages/skills/akuko/skills/akuko/` in this repo. Everything public is built from it.

| Output | Built by | Where it goes | Who pushes |
|---|---|---|---|
| npm `@ikenga/skill-akuko` | Changesets release job (`release.yml`) | npm | CI, when the "chore: version packages" PR merges |
| Mirror tree `./dist-mirror/` | `pnpm build:mirror` | [`ikenga-hq/akuko`](https://github.com/ikenga-hq/akuko), the `npx skills add ikenga-hq/akuko` install surface | **A person, by hand, with the owner's OK** |
| claude.ai zip `./dist-claudeai/akuko.zip` | `pnpm build:claudeai` | Uploaded in claude.ai (and optionally attached to a GitHub release on `ikenga-hq/akuko`) | **A person, by hand, with the owner's OK** |

Per ADR-009 (all platform code and pkgs in `ikenga-pkgs`, Apache-2.0) the source lives here under Apache-2.0; the mirror is a generated copy for installers that want a one-skill repo. Never edit the mirror directly: the next build overwrites it. This is the same route as groundwork (`packages/skills/groundwork/scripts/build-mirror.mjs` → `ikenga-hq/groundwork`).

## What the builds do

Both run `scripts/build-mirror.mjs`.

1. **Test gate.** Runs every `skills/akuko/**/*.test.ts` (the package's `test` script, the set CI runs) and refuses to build if any fail. There is no skip flag. On Windows only, `scripts/check-view.test.ts` is left out with a warning, because its headless jsdom checks hang locally there; CI on Linux runs it.
2. **Version-parity guard** (as groundwork). A pending `.changeset/*.md` that names `@ikenga/skill-akuko` means `package.json` is pre-bump, so the build refuses. Wait for the release PR to merge, pull, and build again. `--allow-version-drift` builds anyway (use it for a review build only; the mirror's `package.json` will carry the old version).
3. **Runtime dependencies.** The skill's TypeScript imports `zod` and `@ikenga/studio-schema`. The build adds, inside the skill folder:
   - `package.json` with `zod` pinned to the version this package has installed (the lockfile's), and `jsdom`, `ajv`, `ajv-formats` as `optionalDependencies` (only `scripts/check-view.mjs` uses them);
   - `vendor/studio-schema/`: `@ikenga/studio-schema` built from `packages/apps/studio/shared` (the build runs its `tsc`), referenced as `file:./vendor/studio-schema`. It is vendored rather than taken from npm because the workspace source can be ahead of the last npm release, and the tests ran against the source. It declares no dependencies, so it shares the skill's one `zod`.

   `npm install` in the installed skill folder then makes every action runnable. `scripts/doctor.sh` prints that command when packages are missing.
4. **Output.**
   - `build:mirror` → `dist-mirror/`: `package.json` (private), `README.md` (this package's README with a "generated mirror" banner), `install.sh` (from `scripts/install.sh`), `LICENSE`, `.gitignore`, `.gitattributes`, `skills/akuko/` (the whole source tree plus the runtime files).
   - `build:claudeai` → `dist-claudeai/akuko.zip` (one top-level `akuko/` folder) and `files.txt`. Only runtime files: no `*.test.ts`, `__fixtures__/`, `fixtures/`, `evals/` or `blocks/` (HyperFrames compositions cannot render on claude.ai). Three fixture files are kept because `scripts/check-view` reads them at run time: `fixtures/the-beating/akuko.json` (its default project) and `views/__fixtures__/tiny-board.html` and `board-b-instrumented.html` (their ids are reserved by hash). **The build fails if the zip would hold more than 200 files**, claude.ai's limit.

Neither build pushes or uploads anything.

## Releasing a version

1. Merge the content PRs (each with a changeset for `@ikenga/skill-akuko`).
2. Merge the Changesets "chore: version packages" PR. CI publishes the npm package.
3. On an up-to-date `main`:

   ```bash
   pnpm install --frozen-lockfile --filter "@ikenga/skill-akuko..."
   pnpm --filter @ikenga/skill-akuko build:mirror
   pnpm --filter @ikenga/skill-akuko build:claudeai
   ```

4. **Check the clean install** before pushing: copy `dist-mirror/skills/akuko` to a folder outside this repo, then

   ```bash
   cd <copy> && npm install
   node --experimental-strip-types --disable-warning=ExperimentalWarning hosts/detect.ts --tools Bash
   bash scripts/doctor.sh
   ```

   `doctor` must report every required runtime package `ok`.
5. **Get the owner's OK**, then push the mirror. Keep the mirror repo's own hand-maintained files (if any) out of the overwrite:

   ```bash
   git clone https://github.com/ikenga-hq/akuko.git /tmp/akuko-mirror
   rsync -a --delete --exclude .git --exclude .github --exclude assets --exclude CONTRIBUTING.md \
     packages/skills/akuko/dist-mirror/ /tmp/akuko-mirror/
   cd /tmp/akuko-mirror && git add -A && git commit -m "akuko <version>" && git push
   ```

   The first push creates nothing: the `ikenga-hq/akuko` repo must already exist (created by the owner).
6. With the same OK, upload `dist-claudeai/akuko.zip` in claude.ai (Settings → Capabilities → Skills) and, if wanted, attach it to a GitHub release tagged `v<version>` on `ikenga-hq/akuko`. A changed file set has to pass claude.ai's upload scan again.

## Before a public push

- No customer, client or personal names in the tree (projects, films, studios, people). Fixtures must be public-domain or invented.
- No keys, `.env` files or real project folders.
- README scope matches what `SKILL.md` routes to: anything still marked **Stub** in `actions/*.md` is described as a stub.
