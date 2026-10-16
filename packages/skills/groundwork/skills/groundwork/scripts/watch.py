#!/usr/bin/env python3
"""watch.py — keep a groundwork explorer (or cross-plan index) live.

Polls a plan folder (or a plans/ dir) for file changes and re-runs the matching
generator on each debounced change, so the artifact tracks new files + edits
without a manual re-run. Stdlib only (mtime polling — no watchdog dependency).

  python3 watch.py --plan plans/my-feature       # refresh artifact/explorer.html
  python3 watch.py --plans-dir plans/            # refresh <dir>/_index.html (+ changed plans' explorers)

Pair it with the artifact's built-in live-reload: when the explorer/index is
served over http(s) as a top-level page, it polls its own Last-Modified and
reloads when this watcher rewrites it — so the browser updates hands-free.

The files this tool *writes* (`.groundwork.json`, `artifact/explorer.html`,
`_index.html`) are excluded from change-detection, so a regenerate never
re-triggers itself.
"""
import os
import sys
import time
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generate_explorer       # noqa: E402
import generate_plans_index    # noqa: E402

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".next", "dist", "build", ".cache"}
# Outputs we write — must never count as a change (would loop).
SKIP_BASENAMES = {".groundwork.json", "_index.html", ".DS_Store"}
POLL = 1.0          # seconds between scans
DEBOUNCE = 0.7      # wait for the tree to be stable this long before regenerating


def _snapshot(root):
    snap = {}
    for dp, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn in SKIP_BASENAMES:
                continue
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, root)
            if rel.endswith(os.path.join("artifact", "explorer.html")) or rel.endswith("artifact/explorer.html"):
                continue
            try:
                snap[rel] = os.path.getmtime(full)
            except OSError:
                pass
    return snap


def _wait_stable(root):
    """Block until the snapshot stops changing for DEBOUNCE, then return it."""
    prev = _snapshot(root)
    while True:
        time.sleep(DEBOUNCE)
        cur = _snapshot(root)
        if cur == prev:
            return cur
        prev = cur


def _safe(fn, *args):
    """Run a generator; one bad plan is logged and skipped, never fatal to the watcher."""
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001 - the watcher must outlive any single plan
        print(f"  ! {args[0]}: {type(e).__name__}: {e}", file=sys.stderr)
        return {"error": f"{type(e).__name__}: {e}"}


def watch_plan(plan):
    print(f"watching plan {plan}  (Ctrl-C to stop)")
    r = _safe(generate_explorer.generate, plan)
    print(f"  · initial: {r.get('data')}/{r.get('meta')}  ({r.get('stats', {}).get('files', '?')} files)")
    snap = _snapshot(plan)
    while True:
        time.sleep(POLL)
        cur = _snapshot(plan)
        if cur != snap:
            # Baseline = what the tree looked like once it settled, taken BEFORE we
            # regenerate: an edit that lands while generate() runs differs from it and
            # triggers another cycle instead of being swallowed by a post-regen re-snapshot.
            snap = _wait_stable(plan)
            r = _safe(generate_explorer.generate, plan)
            stamp = time.strftime("%H:%M:%S")
            print(f"  · {stamp} regenerated explorer: data={r.get('data')} meta={r.get('meta')}")


def watch_plans_dir(plans_dir):
    print(f"watching plans dir {plans_dir}  (Ctrl-C to stop)")
    r = _safe(generate_plans_index.generate, plans_dir)
    print(f"  · initial index: {r.get('data')}/{r.get('meta')}  ({r.get('stats', {}).get('count', '?')} plans)")
    snap = _snapshot(plans_dir)
    while True:
        time.sleep(POLL)
        cur = _snapshot(plans_dir)
        if cur != snap:
            stable = _wait_stable(plans_dir)
            # which top-level plan dirs changed? Diff the SETTLED tree (not the pre-debounce
            # `cur`): a file edited in another plan during the debounce window belongs to
            # this cycle, and snap is advanced before generating so nothing is lost.
            changed = {rel.split(os.sep, 1)[0] for rel in set(stable) ^ set(snap)}
            changed |= {rel.split(os.sep, 1)[0] for rel in stable if rel in snap and stable[rel] != snap[rel]}
            snap = stable
            # refresh their explorers too (if they have one)
            for slug in sorted(changed):
                pdir = os.path.join(plans_dir, slug)
                if os.path.isdir(pdir) and os.path.exists(os.path.join(pdir, "artifact", "explorer.html")):
                    _safe(generate_explorer.generate, pdir)
            ir = _safe(generate_plans_index.generate, plans_dir)
            stamp = time.strftime("%H:%M:%S")
            print(f"  · {stamp} regenerated index: data={ir.get('data')} meta={ir.get('meta')}  (touched: {', '.join(sorted(changed)) or '—'})")


def main(argv=None):
    p = argparse.ArgumentParser(description="watch a plan / plans dir and regenerate its explorer / index on change")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan")
    g.add_argument("--plans-dir")
    args = p.parse_args(argv)
    try:
        if args.plan:
            watch_plan(os.path.normpath(args.plan))
        else:
            watch_plans_dir(os.path.normpath(args.plans_dir))
    except KeyboardInterrupt:
        print("\nstopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
