#!/usr/bin/env python3
"""generate_plans_index.py — deterministic automation of the `groundwork
plans-index` action: (re)generate `<plans-dir>/_index.html` for a plans/ dir.

  python3 generate_plans_index.py --plans-dir plans/

Builds the cross-plan rollup via `groundwork_state.py plans-index-data`,
scaffolds `_index.html` from the template on first run, and writes the
`plans-index-data` / `plans-index-meta` fences via the anchorless
`write-region-plain` (idempotent). Stdlib only. Never writes into the plans
it lists.
"""
import os
import sys
import json
import shutil
import argparse
import tempfile
import datetime
import subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import groundwork_state as gws  # noqa: E402

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(SKILL, "scripts", "groundwork_state.py")
TEMPLATE = os.path.join(SKILL, "profiles", "_shared", "plans-index", "index.html")


def _run(*args):
    return subprocess.run([sys.executable, STATE, *args], capture_output=True, text=True)


def _result(r):
    try:
        return json.loads(r.stdout).get("result")
    except Exception:
        return None


def _scaffold_copy(tpl, dest):
    """Copy the template to dest ATOMICALLY. os.replace swaps the directory
    entry itself, so a symlink (live or dangling) at dest is replaced by a
    regular file and is never written through to its target."""
    d = os.path.dirname(os.path.abspath(dest)) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".gw-tmp-")
    os.close(fd)
    try:
        shutil.copyfile(tpl, tmp)
        os.chmod(tmp, gws.dest_mode(dest))  # mkstemp's 0600 must not leak onto the target
        os.replace(tmp, dest)
    finally:
        if os.path.lexists(tmp):
            os.remove(tmp)


def generate(plans_dir, title=None):
    plans_dir = os.path.normpath(plans_dir)
    md = _run("plans-index-data", f"--plans-dir={plans_dir}")
    if md.returncode != 0:
        return {"plans_dir": plans_dir, "error": "plans-index-data failed: " + md.stderr[:200]}
    model = md.stdout
    stats = json.loads(model).get("stats", {})

    dest = os.path.join(plans_dir, "_index.html")
    # A symlink at dest (live or dangling) is replaced, never written through.
    scaffolded = os.path.islink(dest) or not os.path.exists(dest)
    if scaffolded:
        _scaffold_copy(TEMPLATE, dest)

    meta = {"title": gws.clip(title or (os.path.basename(plans_dir) + " · plans")),
            "root_rel": ".", "refreshed": datetime.date.today().isoformat()}
    # --html-script-safe: the fences live inside <script type="application/json">.
    with tempfile.TemporaryDirectory(prefix="gw-index-") as td:
        mf, xf = os.path.join(td, "model.json"), os.path.join(td, "meta.json")
        with open(mf, "w", encoding="utf-8") as fh:
            fh.write(model)
        with open(xf, "w", encoding="utf-8") as fh:
            json.dump(meta, fh)
        r1 = _run("write-region-plain", f"--file={dest}", "--id", "plans-index-data",
                  "--content-file", mf, "--html-script-safe")
        r2 = _run("write-region-plain", f"--file={dest}", "--id", "plans-index-meta",
                  "--content-file", xf, "--html-script-safe")
    return {"plans_dir": plans_dir, "scaffolded": scaffolded,
            "data": _result(r1), "meta": _result(r2), "stats": stats}


def main(argv=None):
    p = argparse.ArgumentParser(description="(re)generate <plans-dir>/_index.html")
    p.add_argument("--plans-dir", required=True)
    p.add_argument("--title")
    args = p.parse_args(argv)
    res = generate(args.plans_dir, title=args.title)
    print(json.dumps(res, indent=2))
    return 1 if res.get("error") else 0


if __name__ == "__main__":
    sys.exit(main())
