# akuko

An agent skill that takes a short story, treatment or film script to a finished short film, one reviewed stage at a time:

`intake → breakdown → sketch board → bibles → key frames → motion → sound → assemble → export`

It runs in **Claude artifacts** (claude.ai), **Claude Code**, and the **Ikenga** desktop app, and detects which one at the start of every action. Two rules never bend: only a person approves anything, and nothing paid runs without an estimate, a budget cap and an explicit OK.

> **Status: skeleton.** The router, host detection and project format are in place; most actions are stubs that say which work package fills them. Don't expect a film yet.

## Layout

| Path | What |
|---|---|
| `SKILL.md` | Router — start here |
| `actions/` | One file per action, with Atelier frontmatter |
| `lib/state.md` | How actions read and write `akuko.json` |
| `lib/hosts.md` | Host detection, what each host can do, a manual host check |
| `hosts/` | Host adapter contract (`types.ts`) and one adapter per host |
| `profiles/film/` | The film profile |
| `schema/` | The `akuko.json` project format (Zod + JSON Schema) |

## Check your host

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning hosts/detect.ts
```

prints the detected host level and capabilities.

## License

Apache-2.0 — see `LICENSE`.
