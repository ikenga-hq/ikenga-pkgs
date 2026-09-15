#!/usr/bin/env python3
"""Self-contained tests for groundwork_state.py. Run: python3 test_groundwork_state.py
Exercises the guarantees the skill promises but previously specified only in prose."""
import json, os, re, shutil, subprocess, sys, tempfile, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
PROFILES = os.path.join(SKILL, "profiles")
SCRIPT = os.path.join(HERE, "groundwork_state.py")

PASS, FAIL = 0, 0
def check(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else:    FAIL += 1; print(f"  FAIL {name} {extra}")

def run(*a, expect=0):
    r = subprocess.run([sys.executable, SCRIPT, *a], capture_output=True, text=True)
    if expect is not None and r.returncode != expect:
        print(f"    (rc={r.returncode}, stderr={r.stderr.strip()})")
    return r

def snap(plan):
    """sha256 of every file under plan + their mtimes."""
    out = {}
    for root, _, files in os.walk(plan):
        for f in files:
            p = os.path.join(root, f)
            out[os.path.relpath(p, plan)] = (hashlib.sha256(open(p,'rb').read()).hexdigest(), os.path.getmtime(p))
    return out

tmp = tempfile.mkdtemp(prefix="gw-test-")
try:
    # ---- profile conformance ----
    print("profile conformance:")
    r = run("validate-profile", "--profiles-root", PROFILES, "--all")
    res = json.loads(r.stdout)
    names = {p["name"]: p["status"] for p in res["profiles"]}
    for n in ("_shared","software","general","content","design-system","film"):
        check(f"{n} conformant", names.get(n) == "conformant", names.get(n))

    # drop a malformed profile (extends typo) → rule 4
    bad = os.path.join(tmp, "profiles_bad"); shutil.copytree(PROFILES, bad)
    os.makedirs(os.path.join(bad, "ops"))
    json.dump({"name":"ops","extneds":"_shared","spine_version":"1",
               "labels":{"work_unit":"x","isolation_axis":"y","freeze_gate_noun":"z"},
               "optional_blocks":[],"produces_designs":False,"spine_overrides":{}},
              open(os.path.join(bad,"ops","profile.json"),"w"))
    r = run("validate-profile", "--profiles-root", bad, "--name", "ops", expect=1)
    res = json.loads(r.stdout)
    check("malformed profile rejected", res["status"]=="rejected")
    check("canonical rule-4 error string",
          any('extends must be "_shared"' in e for e in res["errors"]), res["errors"])

    # ---- scaffold + idempotency ----
    print("scaffold + idempotency:")
    plan = os.path.join(tmp, "plan-a")
    r = run("scaffold","--plan",plan,"--profiles-root",PROFILES,"--profile","software",
            "--goal","Lift the share-card renderer into its own pkg")
    check("scaffold ok", r.returncode==0, r.stderr)
    spine = ["00-README.md","01-plan.md","02-research-external.md","03-research-internal.md",
             "04-discussion.md","05-tracking.md",".groundwork.json"]
    for f in spine: check(f"scaffold wrote {f}", os.path.exists(os.path.join(plan,f)))
    # no stray {{}}
    stray=[f for f in os.listdir(plan) if f.endswith(".md") and "{{" in open(os.path.join(plan,f)).read()]
    check("no stray {{ }} placeholders", not stray, stray)

    # vocab tokens must never reach a user. Scan EVERY scaffolded file (html/json too, not just .md)
    # for every profile, plus the board template and kickoff brief that are handed to users verbatim.
    print("no unrendered {{vocab.*}} tokens:")
    vocab_re = re.compile(r"\{\{\s*vocab\.")
    for prof in ("software", "general", "content", "design-system", "film"):
        vp = os.path.join(tmp, f"vocab-{prof}")
        run("scaffold","--plan",vp,"--profiles-root",PROFILES,"--profile",prof,"--goal",f"{prof} vocab check")
        leaks = []
        for root_, _, files_ in os.walk(vp):
            for fn in files_:
                p = os.path.join(root_, fn)
                if vocab_re.search(open(p, encoding="utf-8", errors="replace").read()):
                    leaks.append(os.path.relpath(p, vp))
        check(f"{prof}: scaffolded files (all types) carry no vocab token", not leaks, leaks)
    board_tpl = open(os.path.join(PROFILES,"_shared","board","index.html"), encoding="utf-8").read()
    check("board template carries no vocab token (its copy-prompts reach users verbatim)",
          not vocab_re.search(board_tpl), [l for l in board_tpl.splitlines() if vocab_re.search(l)][:3])
    check("board kickoff brief resolves {work_unit} at runtime",
          "{work_unit}" in board_tpl and ".replace(/\\{work_unit\\}/g" in board_tpl)
    wu = re.search(r"const WORK_UNIT_BY_PROFILE = (\{.*?\});", board_tpl)
    labels = {n: json.load(open(os.path.join(PROFILES,n,"profile.json"), encoding="utf-8"))["labels"]["work_unit"]
              for n in os.listdir(PROFILES) if os.path.exists(os.path.join(PROFILES,n,"profile.json"))}
    check("board WORK_UNIT_BY_PROFILE matches every profile.json labels.work_unit",
          bool(wu) and json.loads(wu.group(1))==labels, (wu and wu.group(1), labels))
    orch = open(os.path.join(SKILL,"agents","orchestrator.md"), encoding="utf-8").read()
    brief = orch.split("## Brief",1)[1].split("\n---",1)[0]
    check("orchestrator kickoff brief carries no vocab token", not vocab_re.search(brief))
    # anchor sane
    anc = json.load(open(os.path.join(plan,".groundwork.json")))
    check("anchor profile/version", anc["profile"]=="software" and anc["spine_version"]=="1")
    check("anchor records regions", len(anc["docs"]["01-plan.md"]["generated_regions"])>=1)

    before = snap(plan)
    import time; time.sleep(0.05)
    r = run("scaffold","--plan",plan,"--profiles-root",PROFILES,"--profile","software",
            "--goal","Lift the share-card renderer into its own pkg")
    after = snap(plan)
    # spine files byte-identical (anchor may bump updated; allow that one)
    spine_files = [f for f in before if f != ".groundwork.json"]
    identical = all(before[f][0]==after[f][0] for f in spine_files)
    check("re-scaffold: spine files byte-identical", identical)
    mtimes_ok = all(before[f][1]==after[f][1] for f in spine_files)
    check("re-scaffold: spine mtimes unchanged (true no-op)", mtimes_ok)
    # the anchor itself must be a true no-op too (incl. `updated` — regression guard)
    check("re-scaffold: .groundwork.json byte-identical (no updated churn)",
          before[".groundwork.json"][0]==after[".groundwork.json"][0],
          "updated/last_written churned on no-op scaffold")
    # anchor hashes must be REAL sha256 that verify against on-disk content
    anc2 = json.load(open(os.path.join(plan,".groundwork.json")))
    real = all(re.fullmatch(r"sha256:[0-9a-f]{64}", anc2["docs"][f]["hash"])
               for f in anc2["docs"])
    check("anchor hashes are real sha256 (not placeholders)", real)
    import hashlib as _h
    verifies = anc2["docs"]["01-plan.md"]["hash"] == \
        "sha256:"+_h.sha256(open(os.path.join(plan,"01-plan.md"),'rb').read()).hexdigest()
    check("anchor whole-file hash verifies against disk", verifies)

    # ---- write-region hash-diff ----
    print("write-region hash-diff:")
    r = run("write-region","--plan",plan,"--file","02-research-external.md","--id","findings",
            "--action","research","--content","## Finding\n\nReal external research here.")
    check("first write -> WRITTEN", json.loads(r.stdout)["result"]=="WRITTEN")
    r = run("write-region","--plan",plan,"--file","02-research-external.md","--id","findings",
            "--action","research","--content","## Finding\n\nReal external research here.")
    check("identical re-write -> UNCHANGED", json.loads(r.stdout)["result"]=="UNCHANGED")
    # idempotency of the written region: a third identical write doesn't churn file
    s1 = snap(plan); time.sleep(0.05)
    run("write-region","--plan",plan,"--file","02-research-external.md","--id","findings",
        "--action","research","--content","## Finding\n\nReal external research here.")
    s2 = snap(plan)
    check("UNCHANGED leaves file mtime intact",
          s1["02-research-external.md"][1]==s2["02-research-external.md"][1])

    # hand-edit inside fence -> SKIPPED_DIRTY
    f = os.path.join(plan,"02-research-external.md"); t=open(f).read()
    t = t.replace("Real external research here.","Real external research here. HAND EDIT.")
    open(f,"w").write(t)
    r = run("write-region","--plan",plan,"--file","02-research-external.md","--id","findings",
            "--action","research","--content","## Finding\n\nDifferent computed content.")
    check("hand-edit inside fence -> SKIPPED_DIRTY", json.loads(r.stdout)["result"]=="SKIPPED_DIRTY")
    r = run("write-region","--plan",plan,"--file","02-research-external.md","--id","findings",
            "--action","research","--content","## Finding\n\nDifferent computed content.","--force")
    check("--force overrides dirty -> WRITTEN", json.loads(r.stdout)["result"]=="WRITTEN")

    # hand-edit OUTSIDE fence survives a region write
    print("augments-not-clobbers:")
    t = open(f).read().replace("## How to use this file","## How to use this file\n\nHANDWRITTEN-SACRED line.")
    open(f,"w").write(t)
    run("write-region","--plan",plan,"--file","02-research-external.md","--id","sources",
        "--action","research","--content","1. A source — http://x (accessed 2026-05-23)")
    check("hand prose outside fence survives", "HANDWRITTEN-SACRED line." in open(f).read())

    # ---- ids ----
    print("ID allocation:")
    check("first gap is G-01", json.loads(run("next-id","--plan",plan,"--kind","gap").stdout)["next"]=="G-01")
    run("register-id","--plan",plan,"--id","G-01","--doc","04-discussion.md","--field","status=folded")
    check("next gap after G-01 is G-02", json.loads(run("next-id","--plan",plan,"--kind","gap").stdout)["next"]=="G-02")
    check("gate id by name", json.loads(run("next-id","--plan",plan,"--kind","gate","--name","schema").stdout)["next"]=="G-SCHEMA")

    # ---- anchor mutators (no hand-editing) ----
    print("anchor mutators:")
    run("stamp-research","--plan",plan,"--file","02-research-external.md")
    a2 = json.load(open(os.path.join(plan,".groundwork.json")))
    check("stamp-research sets stamp", a2["research"]["02-research-external.md"].get("stamped"))
    r = run("register-subplan","--plan",plan,"--file","06-rest-to-graphql.md",
            "--archetype","decision-doc","--topic","REST to GraphQL")
    a3 = json.load(open(os.path.join(plan,".groundwork.json")))
    check("register-subplan records entry",
          a3["subplans"].get("06-rest-to-graphql.md",{}).get("archetype")=="decision-doc")
    check("register-subplan normalizes ref to null",
          a3["subplans"]["06-rest-to-graphql.md"]["ref"] is None)

    # ---- spine gate ----
    print("spine gate:")
    check("v1==v1 ok", run("spine-gate","--plan",plan,"--expected","1").returncode==0)
    check("anchor older -> refuse", run("spine-gate","--plan",plan,"--expected","2",expect=3).returncode==3)

    # ---- derived data ----
    print("derived data:")
    check("board-data emits plan", "plan" in json.loads(run("board-data","--plan",plan).stdout))
    check("status-data emits docs", "docs" in json.loads(run("status-data","--plan",plan,"--profiles-root",PROFILES).stdout))

    # ---- board-data --with-briefs (workflow-emit feed) ----
    print("board-data --with-briefs:")
    run("register-id","--plan",plan,"--id","WP-01","--doc","05-tracking.md",
        "--field","title=Contract freeze","--field","wave=0","--field","tier=opus")
    # bare board-data carries tier but no brief key
    wp_bare = json.loads(run("board-data","--plan",plan).stdout)["wps"][0]
    check("board-data WP carries tier", wp_bare.get("tier")=="opus")
    check("board-data (bare) omits brief", "brief" not in wp_bare)
    # write a 09 with a WP-01 section; --with-briefs should attach its body
    open(os.path.join(plan,"09-orchestration.md"),"w",encoding="utf-8",newline="\n").write(
        "# Plan — orchestration\n\n## Work-package matrix\n\n"
        "### WP-01 — Contract freeze\n- **GOAL**: freeze the schema\n- **DEFINITION OF DONE**: types compile\n\n"
        "---\n\n## Tracking protocol\nblah\n")
    wp_b = json.loads(run("board-data","--plan",plan,"--with-briefs").stdout)["wps"][0]
    check("--with-briefs attaches brief", "GOAL" in (wp_b.get("brief") or ""))
    check("--with-briefs stops brief at rule", "Tracking protocol" not in (wp_b.get("brief") or ""))

    # ---- explorer-data (file-tree model for artifact/explorer.html) ----
    print("explorer-data:")
    # drop a design mockup so we can assert html is referenced, not embedded
    open(os.path.join(plan,"designs","option-a.html"),"w").write("<!doctype html><h1>mock design</h1>")
    ed = json.loads(run("explorer-data","--plan",plan).stdout)
    flat=[]; _w=lambda ns:[ (flat.append(n), n.get("children") and _w(n["children"])) for n in ns]; _w(ed["tree"])
    by={n["path"]:n for n in flat}
    check("explorer-data emits non-empty tree", len(ed["tree"])>0)
    check("explorer-data emits stats", all(k in ed.get("stats",{}) for k in ("files","embedded","referenced")))
    check("spine markdown embedded with content",
          by.get("01-plan.md",{}).get("embedded") is True and "content" in by.get("01-plan.md",{}))
    check("design html referenced, not embedded",
          by.get("designs/option-a.html",{}).get("type")=="design" and by["designs/option-a.html"].get("embedded") is False)
    check("design html kind=design", by.get("designs/option-a.html",{}).get("kind")=="design")
    check("explorer-data passes ids registry through", "WP-01" in ed.get("ids",{}))
    # idempotency: the volatile self-files must NOT be in the model (else every re-run drifts)
    check("explorer-data excludes .groundwork.json", ".groundwork.json" not in by)
    check("explorer-data excludes artifact/explorer.html", "artifact/explorer.html" not in by)
    # symlink-loop guard: a dir symlink to an ancestor must not explode the tree
    try:
        os.symlink("..", os.path.join(plan, "designs", "loop"))
        ed_loop = json.loads(run("explorer-data","--plan",plan).stdout)
        check("explorer-data bounds symlink loops", ed_loop["stats"]["files"] < 60)
        os.remove(os.path.join(plan, "designs", "loop"))
    except (OSError, NotImplementedError):
        pass  # platform without symlink support

    # ---- plans-index-data + write-region-plain (cross-plan) ----
    print("plans-index-data:")
    proot = os.path.join(tmp, "plansroot"); os.makedirs(proot, exist_ok=True)
    for nm, prof in (("alpha", "software"), ("beta", "general")):
        run("scaffold", "--plan", os.path.join(proot, nm), "--profiles-root", PROFILES, "--profile", prof, "--goal", f"{nm} goal")
    os.makedirs(os.path.join(proot, "not-a-plan"))  # no .groundwork.json — must be skipped
    pi = json.loads(run("plans-index-data", "--plans-dir", proot).stdout)
    check("plans-index finds both plans, skips non-plan", pi["stats"]["count"] == 2)
    check("plans-index lists alpha+beta", {p["slug"] for p in pi["plans"]} == {"alpha", "beta"})
    check("plans-index by_profile", pi["stats"]["by_profile"].get("software") == 1 and pi["stats"]["by_profile"].get("general") == 1)
    a = next(p for p in pi["plans"] if p["slug"] == "alpha")
    check("plans-index rollup carries wps/has/drift", all(k in a for k in ("wps", "has", "drift", "gates")))
    # write-region-plain: anchorless fence write, idempotent
    idx = os.path.join(proot, "_index.html")
    open(idx, "w").write('<x>\n<!-- groundwork:auto:start plans-index-data -->\nnull\n<!-- groundwork:auto:end plans-index-data -->\n</x>')
    r1 = json.loads(run("write-region-plain", "--file", idx, "--id", "plans-index-data", "--content", '{"a":1}').stdout)
    check("write-region-plain writes", r1["result"] == "WRITTEN")
    r2 = json.loads(run("write-region-plain", "--file", idx, "--id", "plans-index-data", "--content", '{"a":1}').stdout)
    check("write-region-plain idempotent (UNCHANGED on re-run)", r2["result"] == "UNCHANGED")
    # --html-script-safe: embedded </script> must be neutralized so it can't break the <script> fence
    run("write-region-plain", "--file", idx, "--id", "plans-index-data",
        "--content", '{"c":"x</script><img>&y"}', "--html-script-safe")
    inner = open(idx).read().split("start plans-index-data")[1].split("end plans-index-data")[0]
    check("html-script-safe removes literal </script>", "</script>" not in inner)
    check("html-script-safe emits \\u003c escapes", "\\u003c/script" in inner)
    import json as _json
    check("html-script-safe still valid JSON (round-trips)",
          _json.loads(inner[inner.index("{"):inner.rindex("}")+1])["c"] == "x</script><img>&y")

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
