---
"@ikenga/pkg-studio": minor
---

Studio render lanes. Spend gate (WP-12): paid renders (fal, and any future network engine) reserve against a per-project ceiling at enqueue, settle on success and void on failure or cancel. The ceiling comes from `metadata.spend_ceiling_usd` or `STUDIO_SPEND_CEILING_USD`; there is no tool verb to raise it, and `spend.status` is read-only. Project identity is now path-canonical, so the same folder opened with different separators no longer gets a second ledger. A cell with `metadata.depends_on` refuses to enqueue until every dependency is approved. Blender: Cycles GPU device selection, anchor-plate fitting, mp4 assembly, and Blender-authored fal shapes reachable from a cell. fal still and inpaint render path. New Remotion renderer adapter for `.tsx` cells, with authoring conventions (WP-13/14/17). The DaVinci Resolve bridge is hardened (WP-18): repeated media imports are deduped, and the resolved timeline is set as current.
