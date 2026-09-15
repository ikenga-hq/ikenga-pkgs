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

    # ---- design lifecycle (ids[D-NN] canonical, designs[path] linked variants) ----
    print("design lifecycle:")
    dp = os.path.join(tmp, "plan-design")
    run("scaffold","--plan",dp,"--profiles-root",PROFILES,"--profile","software","--goal","Design lifecycle fixture")
    def J(*a, expect=0):
        r = run(*a, expect=expect)
        try: return json.loads(r.stdout), r
        except json.JSONDecodeError: return {}, r
    def anc(p): return json.load(open(os.path.join(p,".groundwork.json"), encoding="utf-8"))
    def abytes(p): return open(os.path.join(p,".groundwork.json"),"rb").read()
    def dd(p, did):
        return next(d for d in json.loads(run("design-data","--plan",p).stdout)["designs"] if d["id"]==did)

    # D-NN registered with no files — the shape real plans have before any mockup exists
    for n in (1, 2, 3):
        run("register-id","--plan",dp,"--id",f"D-0{n}","--doc","01-plan.md","--field","kind=design",
            "--field",f"title=Screen {n}","--field","phase=P1","--field","status=queued")
    run("register-id","--plan",dp,"--id","WP-01","--doc","05-tracking.md","--field","title=Build screens",
        "--field","status=queued","--field","wave=1")
    data = json.loads(run("design-data","--plan",dp).stdout)
    check("design-data: file-less D-NN are planned + unbuilt", len(data["designs"])==3 and
          all(d["design_state"]=="planned" and d["build_state"]=="unbuilt" for d in data["designs"]))
    p1 = next(c for c in data["coverage"] if c["phase"]=="P1")
    check("coverage counts planned D-NN (0/3, not ok)", p1["designs"]==0 and p1["of"]==3 and p1["ok"] is False, p1)

    for v in ("a", "b"):
        open(os.path.join(dp,"designs",f"d-01-{v}.html"),"w").write(f"<h1>{v}</h1>")
    res,_ = J("register-design","--plan",dp,"--file","designs/d-01-a.html","--id","D-01","--phase","P1")
    check("register-design links file -> REGISTERED", res.get("result")=="REGISTERED" and res.get("design")=="D-01")
    b0 = abytes(dp)
    res,_ = J("register-design","--plan",dp,"--file","designs/d-01-a.html","--id","D-01","--phase","P1")
    check("register-design re-run -> UNCHANGED, anchor byte-identical", res.get("result")=="UNCHANGED" and abytes(dp)==b0)
    J("register-design","--plan",dp,"--file","designs/d-01-b.html","--id","D-01")
    a = anc(dp)
    check("link is two-way (ids.files + designs.design)",
          a["ids"]["D-01"]["files"]==["designs/d-01-a.html","designs/d-01-b.html"]
          and a["designs"]["designs/d-01-b.html"]["design"]=="D-01")
    check("design-data: files -> drafted", dd(dp,"D-01")["design_state"]=="drafted")
    _,r = J("register-design","--plan",dp,"--file","designs/x.html","--id","D-99",expect=1)
    check("register-design refuses unregistered D-NN", r.returncode==1)

    _,r = J("design-lock","--plan",dp,"--id","D-01","--round","2",expect=1)
    check("design-lock with 2 variants and no --file refuses", r.returncode==1)
    res,_ = J("design-lock","--plan",dp,"--id","D-01","--round","2","--file","designs/d-01-a.html")
    a = anc(dp)
    check("design-lock -> LOCKED, records round", res.get("result")=="LOCKED" and a["ids"]["D-01"]["locked_in"]=="Round 2")
    check("design-lock mirrors onto variant registry",
          a["designs"]["designs/d-01-a.html"]["locked"] is True and a["designs"]["designs/d-01-b.html"]["locked"] is False)
    b0 = abytes(dp)
    res,_ = J("design-lock","--plan",dp,"--id","D-01","--round","Round 2","--file","designs/d-01-a.html")
    check("design-lock re-run -> UNCHANGED, anchor byte-identical", res.get("result")=="UNCHANGED" and abytes(dp)==b0)
    _,r = J("design-lock","--plan",dp,"--id","D-01","--round","3","--file","designs/d-01-b.html",expect=1)
    check("design-lock onto a different file while locked refuses", r.returncode==1)
    _,r = J("design-lock","--plan",dp,"--id","D-01","--round","soon",expect=1)
    check("design-lock rejects a non-numeric round", r.returncode==1)

    # implementation linkage + derived build_state
    res,_ = J("register-design-impl","--plan",dp,"--wp","WP-01","--designs","D-01,D-02")
    check("register-design-impl records implements", anc(dp)["ids"]["WP-01"]["implements"]==["D-01","D-02"])
    check("register-design-impl warns on unlocked design", any("D-02" in w for w in res.get("warnings",[])))
    b0 = abytes(dp)
    res,_ = J("register-design-impl","--plan",dp,"--wp","WP-01","--designs","D-01")
    check("register-design-impl is additive + idempotent", res.get("result")=="UNCHANGED" and abytes(dp)==b0)
    _,r = J("register-design-impl","--plan",dp,"--wp","WP-77","--designs","D-01",expect=1)
    check("register-design-impl refuses unknown WP", r.returncode==1)
    check("queued WP -> unbuilt", dd(dp,"D-01")["build_state"]=="unbuilt")
    run("register-id","--plan",dp,"--id","WP-01","--doc","05-tracking.md","--field","status=in_progress")
    check("in_progress WP -> in_progress", dd(dp,"D-01")["build_state"]=="in_progress")
    _,r = J("design-verify","--plan",dp,"--id","D-01","--round","3",expect=1)
    check("design-verify refuses before implemented", r.returncode==1)
    J("register-design-impl","--plan",dp,"--wp","WP-01","--designs","D-01","--pr","42",
      "--url","https://example.test/pr/42","--pr-state","merged")
    check("merged PR listing D-01 -> implemented", dd(dp,"D-01")["build_state"]=="implemented")
    d2 = dd(dp,"D-02")
    check("D-02 (WP in_progress, not in the PR) stays in_progress + warns unlocked",
          d2["build_state"]=="in_progress" and "built against an unlocked design" in d2["warnings"])
    J("register-design-impl","--plan",dp,"--wp","WP-01","--designs","D-01","--pr","42","--pr-state","merged")
    check("PR record updates in place (no duplicate)", len(anc(dp)["ids"]["WP-01"]["prs"])==1)
    res,_ = J("design-verify","--plan",dp,"--id","D-01","--round","3")
    check("design-verify -> VERIFIED", res.get("result")=="VERIFIED" and dd(dp,"D-01")["build_state"]=="verified")
    b0 = abytes(dp)
    res,_ = J("design-verify","--plan",dp,"--id","D-01","--round","3")
    check("design-verify re-run -> UNCHANGED", res.get("result")=="UNCHANGED" and abytes(dp)==b0)
    run("register-id","--plan",dp,"--id","WP-01","--doc","05-tracking.md","--field","status=done")
    check("all implementing WPs done -> implemented", dd(dp,"D-02")["build_state"]=="implemented")

    # review findings attach to a design + state + location
    run("register-id","--plan",dp,"--id","G-01","--doc","04-discussion.md","--field","kind=design-conformance",
        "--field","design=D-01","--field","state=error","--field","location=app/screens/Identity.tsx:88",
        "--field","status=open","--field","severity=important","--field","title=Error copy drifts from mockup")
    f = dd(dp,"D-01")
    check("findings attach by design field (state + location carried)",
          f["open_findings"]==1 and f["findings"][0]["state"]=="error" and f["findings"][0]["location"].endswith(":88"))

    # surfaces
    bd = json.loads(run("board-data","--plan",dp).stdout)
    check("board-data emits design_lifecycle + coverage",
          len(bd.get("design_lifecycle",[]))==3 and any(c["phase"]=="P1" for c in bd.get("coverage",[])))
    check("board-data WP carries implements", next(w for w in bd["wps"] if w["id"]=="WP-01").get("implements")==["D-01","D-02"])
    check("board-data designs carry their D-NN link", all(x.get("design")=="D-01" for x in bd["designs"]))
    sd = json.loads(run("status-data","--plan",dp).stdout)
    check("status-data summarises lifecycle", sd.get("design_lifecycle",{}).get("summary",{}).get("verified")==1)
    ls = json.loads(run("living-spec-data","--plan",dp).stdout)
    check("living-spec-data carries designs", {d["id"] for d in ls.get("designs",[])}=={"D-01","D-02","D-03"})
    proot2 = os.path.join(tmp,"plansroot-design"); os.makedirs(proot2)
    shutil.copytree(dp, os.path.join(proot2,"p"))
    roll = json.loads(run("plans-index-data","--plans-dir",proot2).stdout)["plans"][0]["designs"]
    check("plans-index rollup counts D-NN, not just files",
          roll.get("total")==3 and roll.get("locked")==1 and roll.get("verified")==1, roll)

    # unlock clears verification; history is the audit trail
    res,_ = J("design-unlock","--plan",dp,"--id","D-01","--round","4","--reason","copy change")
    a = anc(dp)
    check("design-unlock -> UNLOCKED, clears verified_in", res.get("result")=="UNLOCKED"
          and "verified_in" not in a["ids"]["D-01"] and a["ids"]["D-01"]["unlocked_in"]=="Round 4")
    check("design-unlock warns about implementing WPs", any("WP-01" in w for w in res.get("warnings",[])))
    check("unlocked + built -> warning, mirror cleared",
          "built against an unlocked design" in dd(dp,"D-01")["warnings"]
          and a["designs"]["designs/d-01-a.html"]["locked"] is False)
    b0 = abytes(dp)
    res,_ = J("design-unlock","--plan",dp,"--id","D-01","--round","4","--reason","again")
    check("design-unlock when not locked -> UNCHANGED", res.get("result")=="UNCHANGED" and abytes(dp)==b0)
    check("history records lock/verify/unlock", [h["action"] for h in a["ids"]["D-01"]["history"]]==["lock","verify","unlock"])
    res,_ = J("design-lock","--plan",dp,"--id","D-01","--round","5","--file","designs/d-01-b.html")
    check("re-lock onto another variant after unlock",
          res.get("result")=="LOCKED" and dd(dp,"D-01")["locked_file"]=="designs/d-01-b.html")

    # spec-only lock (no file) is allowed but flagged
    res,_ = J("design-lock","--plan",dp,"--id","D-03","--round","5")
    check("spec-only lock -> LOCKED + derived warning",
          res.get("result")=="LOCKED" and "locked without a design file" in dd(dp,"D-03")["warnings"])

    # legacy string-form implements (register-id stores `[A,B]` as a string) is tolerated
    run("register-id","--plan",dp,"--id","WP-02","--doc","05-tracking.md","--field","implements=[D-03]",
        "--field","status=in_progress")
    check("string-form implements tolerated", "WP-02" in [w["id"] for w in dd(dp,"D-03")["wps"]])

    # ---- design-migrate: pre-lifecycle anchors ----
    print("design-migrate:")
    lp = os.path.join(tmp, "plan-legacy")
    run("scaffold","--plan",lp,"--profiles-root",PROFILES,"--profile","software","--goal","Legacy designs")
    la = anc(lp)
    la["ids"]["D-01"] = {"doc": "04-discussion.md", "kind": "design", "title": "Board"}
    la["ids"]["D-02"] = {"doc": "01-plan.md", "kind": "design", "title": "Detail"}
    la["designs"] = {"designs/d-01-board.html": {"phase": "P1", "wp": "WP-07", "locked": True, "locked_in": "Round 5"},
                     "designs/pattern-x.html": {"phase": "P2", "wp": None, "locked": False}}
    open(os.path.join(lp,".groundwork.json"),"w",encoding="utf-8",newline="\n").write(json.dumps(la, indent=2)+"\n")
    open(os.path.join(lp,"designs","d-01-board.html"),"w").write("<h1>board</h1>")
    open(os.path.join(lp,"designs","d-02-detail.html"),"w").write("<h1>detail</h1>")
    pre = json.loads(run("design-data","--plan",lp).stdout)
    check("legacy anchor readable before migrate (files reported unlinked, not an error)",
          pre["summary"]["unlinked"]==2 and pre["unlinked"][0]["suggested_id"]=="D-01")
    b0 = abytes(lp)
    res,_ = J("design-migrate","--plan",lp,"--dry-run")
    check("design-migrate --dry-run reports, writes nothing",
          res.get("result")=="DRY_RUN" and len(res["linked"])==1 and abytes(lp)==b0)
    res,_ = J("design-migrate","--plan",lp)
    m1 = dd(lp,"D-01")
    check("design-migrate links by filename token", res.get("result")=="MIGRATED" and m1["files"]==["designs/d-01-board.html"])
    check("design-migrate lifts the legacy lock onto the ID",
          res["lifted_locks"]==["D-01"] and m1["locked_in"]=="Round 5" and m1["phase"]=="P1")
    check("design-migrate reports unmatched files", res["unmatched"]==["designs/pattern-x.html"])
    b0 = abytes(lp)
    res,_ = J("design-migrate","--plan",lp)
    check("design-migrate re-run -> UNCHANGED", res.get("result")=="UNCHANGED" and abytes(lp)==b0)
    res,_ = J("design-migrate","--plan",lp,"--include-unregistered")
    check("--include-unregistered registers + links d-NN files on disk",
          res["registered_from_disk"]==["designs/d-02-detail.html"] and dd(lp,"D-02")["design_state"]=="drafted")

    # hand-rolled shape seen in a real plan: variants link with `id`, the lock sits on the ID
    # with no file named, and one design locks two complementary variants
    print("design lifecycle — hand-rolled anchors:")
    kp = os.path.join(tmp, "plan-idlink")
    run("scaffold","--plan",kp,"--profiles-root",PROFILES,"--profile","software","--goal","Hand-rolled design lock")
    ka = anc(kp)
    ka["ids"]["D-02"] = {"doc": "01-plan.md", "kind": "design", "title": "Profile", "phase": "P1",
                         "status": "locked", "locked": True, "locked_in": "Round 2"}
    ka["designs"] = {
        "designs/d-02-profile.html": {"phase": "P1", "wp": "WP-01", "id": "D-02", "locked": True,
                                      "locked_in": "Round 2", "pane_ids": None, "variant": "single"},
        "designs/returning-confirm.html": {"phase": "P1", "wp": "WP-02", "id": "D-02", "locked": True,
                                           "locked_in": "Round 2", "pane_ids": None, "variant": "returning fast path"},
        "designs/index.html": {"phase": "P1", "wp": "WP-01", "locked": True, "locked_in": "Round 2",
                               "pane_ids": None, "variant": "gallery"}}
    open(os.path.join(kp,".groundwork.json"),"w",encoding="utf-8",newline="\n").write(json.dumps(ka, indent=2)+"\n")
    for fn in ("d-02-profile.html", "returning-confirm.html", "index.html"):
        open(os.path.join(kp,"designs",fn),"w").write("<h1>x</h1>")
    both = ["designs/d-02-profile.html", "designs/returning-confirm.html"]
    k2 = dd(kp,"D-02")
    check("`id` accepted as the variant link", k2["files"]==both, k2["files"])
    check("ID-level lock with no file resolves its locked variants",
          k2["locked"] and k2["locked_files"]==both and k2["locked_file"]==both[0] and not k2["warnings"], k2)
    check("gallery page with no D-NN is reported unlinked",
          [u["path"] for u in json.loads(run("design-data","--plan",kp).stdout)["unlinked"]]==["designs/index.html"])
    res,_ = J("design-lock","--plan",kp,"--id","D-02","--round","2")
    check("design-lock normalizes a hand-rolled lock (no --file needed)",
          res.get("result")=="NORMALIZED" and anc(kp)["ids"]["D-02"].get("locked_files")==both, res)
    b0 = abytes(kp)
    res,_ = J("design-lock","--plan",kp,"--id","D-02","--round","2")
    check("normalized lock re-run -> UNCHANGED", res.get("result")=="UNCHANGED" and abytes(kp)==b0)
    J("design-migrate","--plan",kp)
    rc_entry = anc(kp)["designs"]["designs/returning-confirm.html"]
    check("design-migrate adds the canonical `design` link, keeps `id`",
          rc_entry.get("design")=="D-02" and rc_entry.get("id")=="D-02")
    J("design-unlock","--plan",kp,"--id","D-02","--round","3","--reason","split the fast path")
    res,_ = J("design-lock","--plan",kp,"--id","D-02","--round","4","--file",both[0],"--file",both[1])
    check("design-lock accepts several --file (complementary variants)",
          res.get("result")=="LOCKED" and dd(kp,"D-02")["locked_files"]==both)
    _,r = J("design-lock","--plan",kp,"--id","D-02","--round","5","--file",both[0],expect=1)
    check("re-locking a different file set while locked refuses", r.returncode==1)

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
