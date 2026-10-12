#!/usr/bin/env python3
"""generate_explorer.py — deterministic automation of the `groundwork explorer`
action: (re)generate `artifact/explorer.html` for one plan, or for every plan
under a plans/ directory.

  python3 generate_explorer.py --plan plans/my-feature
  python3 generate_explorer.py --all-under plans/ [--missing-only]

Resolves the profile's explorer template (overlay → base), scaffolds
`artifact/explorer.html` lazily on first run, builds the model via
`groundwork_state.py explorer-data`, and writes the `explorer-data` /
`explorer-meta` fences (with `--force` on a fresh scaffold). Stdlib only.

This is the byte-exact path the explorer action documents; agents may run it
directly instead of performing the steps by hand. (`groundwork plans-index
--generate-missing` is just `--all-under <dir> --missing-only` here.)
"""
import os
import sys
import json
import shutil
import argparse
import tempfile
import datetime
import subprocess

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(SKILL, "scripts", "groundwork_state.py")
PROFILES = os.path.join(SKILL, "profiles")


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
        os.replace(tmp, dest)
    finally:
        if os.path.lexists(tmp):
            os.remove(tmp)


def _title(plan, anchor):
    p01 = os.path.join(plan, "01-plan.md")
    if os.path.exists(p01):
        with open(p01, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.startswith("# "):
                    return line[2:].strip()
    return anchor.get("goal", "")


def generate(plan, force_rescaffold=False):
    plan = os.path.normpath(plan)
    ap = os.path.join(plan, ".groundwork.json")
    if not os.path.exists(ap):
        return {"plan": os.path.basename(plan), "skipped": "not a groundwork plan"}
    try:
        anchor = json.load(open(ap))
    except Exception as e:
        return {"plan": os.path.basename(plan), "error": f"corrupt anchor: {e}"}
    profile = anchor.get("profile") or "software"

    g = _run("spine-gate", "--plan", plan, "--expected", "1")
    if g.returncode == 3:
        return {"plan": os.path.basename(plan), "error": "spine-gate refused (version mismatch)"}

    cand = os.path.join(PROFILES, profile, "explorer", "index.html")
    tpl = cand if os.path.exists(cand) else os.path.join(PROFILES, "_shared", "explorer", "index.html")

    art = os.path.join(plan, "artifact")
    if os.path.islink(art):
        return {"plan": os.path.basename(plan),
                "error": "refusing: artifact/ is a symlink (would write outside the plan folder)"}
    os.makedirs(art, exist_ok=True)
    dest = os.path.join(art, "explorer.html")
    # A symlink at dest (live or dangling) is replaced, never written through.
    scaffolded = force_rescaffold or os.path.islink(dest) or not os.path.exists(dest)
    if scaffolded:
        _scaffold_copy(tpl, dest)

    md = _run("explorer-data", "--plan", plan)
    if md.returncode != 0:
        return {"plan": os.path.basename(plan), "error": "explorer-data failed: " + md.stderr[:200]}
    model = md.stdout
    stats = json.loads(model).get("stats", {})

    meta = {
        "title": _title(plan, anchor), "profile": profile,
        "plan_folder": "plans/" + os.path.basename(plan), "plan_slug": os.path.basename(plan),
        "goal": anchor.get("goal", ""), "root_rel": "..",
        "refreshed": datetime.date.today().isoformat(),
    }
    mf = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    mf.write(model); mf.close()
    xf = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(meta, xf); xf.close()
    force = ["--force"] if scaffolded else []
    # --html-script-safe: the fences live inside <script type="application/json">,
    # so embedded file bodies containing `</script>` must be neutralized.
    r1 = _run("write-region", "--plan", plan, "--file", "artifact/explorer.html",
              "--id", "explorer-data", "--action", "explorer", "--content-file", mf.name,
              "--html-script-safe", *force)
    r2 = _run("write-region", "--plan", plan, "--file", "artifact/explorer.html",
              "--id", "explorer-meta", "--action", "explorer", "--content-file", xf.name,
              "--html-script-safe", *force)
    os.unlink(mf.name); os.unlink(xf.name)
    return {"plan": os.path.basename(plan), "profile": profile, "scaffolded": scaffolded,
            "data": _result(r1), "meta": _result(r2), "stats": stats}


def _plan_dirs(root):
    out = []
    for name in sorted(os.listdir(root)):
        d = os.path.join(root, name)
        if os.path.isdir(d) and os.path.exists(os.path.join(d, ".groundwork.json")):
            out.append(d)
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description="(re)generate artifact/explorer.html for one or all plans")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan", help="a single plan folder")
    g.add_argument("--all-under", help="a plans/ dir — generate for every child plan")
    p.add_argument("--missing-only", action="store_true", help="with --all-under: skip plans that already have artifact/explorer.html")
    p.add_argument("--force-rescaffold", action="store_true", help="overwrite the HTML scaffold (template bump)")
    args = p.parse_args(argv)

    if args.plan:
        res = generate(args.plan, force_rescaffold=args.force_rescaffold)
        print(json.dumps(res, indent=2))
        return 0 if not res.get("error") else 1

    plans = _plan_dirs(args.all_under)
    results, made, skipped, errs = [], 0, 0, 0
    for d in plans:
        if args.missing_only and os.path.exists(os.path.join(d, "artifact", "explorer.html")):
            skipped += 1
            results.append({"plan": os.path.basename(d), "skipped": "already has explorer"})
            continue
        r = generate(d, force_rescaffold=args.force_rescaffold)
        results.append(r)
        if r.get("error"):
            errs += 1
        elif r.get("skipped"):
            skipped += 1
        else:
            made += 1
            print(f"  ✓ {r['plan']:42} {r.get('profile','?'):13} {'scaffolded' if r.get('scaffolded') else 'refreshed'}  "
                  f"({r.get('stats',{}).get('files','?')} files)")
    for r in results:
        if r.get("error"):
            print(f"  ✗ {r['plan']}: {r['error']}")
    print(f"\n{made} generated · {skipped} skipped · {errs} errors  (of {len(plans)} plans under {args.all_under})")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
