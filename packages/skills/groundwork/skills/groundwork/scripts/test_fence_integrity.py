#!/usr/bin/env python3
"""Fixture-plan checks for groundwork_state.py: fence-only writes + idempotent re-runs.
Run: python3 test_fence_integrity.py   (stdlib only, same style as test_groundwork_state.py)

The skill's core promise is that actions write ONLY inside
`<!-- groundwork:auto:start ID -->` fences and that a re-run with the same content is a
byte-exact no-op. This test scaffolds a real plan into a temp dir, salts every spine doc
with hand-written prose around (and between) the fences, then drives `write-region` and
asserts:

  * every byte outside the fences is identical after each write (fence-only writes);
  * a second pass of identical writes reports UNCHANGED and leaves every file's bytes AND
    mtime untouched, the `.groundwork.json` anchor included (idempotency);
  * the anchor's recorded whole-file hash still verifies against disk after the writes.

Negative checks prove the assertions have teeth — a fence write that leaks outside the
fence would fail this test:

  * an out-of-fence mutation is caught by the prose comparator and by the anchor hash;
  * an in-fence hand edit makes the next write report SKIPPED_DIRTY;
  * groundwork_state.py run with two deliberately broken writers (one that strips trailing
    whitespace on the way to disk, one with an off-by-one end-fence span) produces files
    the prose comparator rejects.

The comparator is an independent fence parser on purpose: it does not import
groundwork_state.find_region, so a bug there cannot hide itself.
"""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile, time

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

def result(r):
    try: return json.loads(r.stdout).get("result")
    except Exception: return f"<rc={r.returncode} stdout={r.stdout!r} stderr={r.stderr.strip()!r}>"

def rb(p):
    with open(p, "rb") as f: return f.read()

def wb(p, data):
    with open(p, "wb") as f: f.write(data)

def snap(plan):
    """{relpath: (sha256, mtime_ns)} for every file under plan, anchor included."""
    out = {}
    for root, _, files in os.walk(plan):
        for f in files:
            p = os.path.join(root, f)
            out[os.path.relpath(p, plan)] = (hashlib.sha256(rb(p)).hexdigest(), os.stat(p).st_mtime_ns)
    return out

# Independent fence parser (byte-level). Mirrors the documented fence grammar
# (lib/state.md): markdown, // and # comment variants, one start + one end per id.
_START = re.compile(rb"^[ \t]*(?:<!--|//|#)[ \t]*groundwork:auto:start[ \t]+(\S+)[ \t]*(?:-->)?[ \t]*$", re.M)

def outside_fences(data: bytes):
    """Return the list of byte segments OUTSIDE fence interiors (fence lines included),
    or None if any fence is unbalanced. Interiors are the only bytes a write may change."""
    segs, pos = [], 0
    for sm in _START.finditer(data):
        if sm.start() < pos:
            continue  # a start nested inside an earlier region's interior
        fid = re.escape(sm.group(1))
        em = re.compile(rb"^[ \t]*(?:<!--|//|#)[ \t]*groundwork:auto:end[ \t]+" + fid +
                        rb"[ \t]*(?:-->)?[ \t]*$", re.M).search(data, sm.end())
        if not em:
            return None
        segs.append(data[pos:sm.end()])
        pos = em.start()
    segs.append(data[pos:])
    return segs

def prose_identical(before: bytes, after: bytes) -> bool:
    a, b = outside_fences(before), outside_fences(after)
    return a is not None and b is not None and a == b

# Hand-written prose salted around every fence. Trailing double-space (markdown hard
# break), a tab, non-ASCII and a fence-lookalike in a code span — the kinds of bytes a
# sloppy writer normalizes away or mis-parses.
SALT = ("HAND-PROSE · keep me exactly  \n"
        "\tindented line with ü, 中文 and an em dash —\n"
        "`<!-- groundwork:auto:start not-a-real-fence -->` mentioned inline, not a fence\n")

def salt_plan(plan):
    """Insert SALT before every start fence and after every end fence in each .md file."""
    for f in sorted(os.listdir(plan)):
        if not f.endswith(".md"): continue
        p = os.path.join(plan, f)
        t = rb(p).decode("utf-8")
        t = re.sub(r"(?m)^(<!-- groundwork:auto:start [^ ]+ -->)$", SALT + r"\1", t)
        t = re.sub(r"(?m)^(<!-- groundwork:auto:end [^ ]+ -->)$", r"\1\n" + SALT.rstrip("\n"), t)
        wb(p, t.encode("utf-8"))

# (file, fence id, content) — several fences per file, so neighbouring regions and the
# prose between them are exercised.
WRITES = [
    ("01-plan.md", "goal", "Ship the fixture plan without touching a byte of prose."),
    ("01-plan.md", "ids", "| ID | Title |\n|---|---|\n| `WP-01` | First |"),
    ("02-research-external.md", "findings", "## Finding\n\nExternal research body."),
    ("02-research-external.md", "sources", "1. A source — http://x (accessed 2026-10-04)"),
    ("04-discussion.md", "rounds-index", "| Round | Date |\n|---|---|\n| 1 | 2026-10-04 |"),
    ("05-tracking.md", "wp-matrix", "| WP | Status |\n|---|---|\n| WP-01 | planned |"),
    ("05-tracking.md", "wave-plan", "Wave 1: WP-01"),
    ("05-tracking.md", "critical-path", "WP-01"),
]

def write(plan, f, fid, content, *extra):
    return run("write-region", "--plan", plan, "--file", f, "--id", fid,
               "--action", "test", "--content", content, *extra)

# Run groundwork_state.main() in a subprocess with one function monkeypatched — a
# stand-in for a regression in the real writer.
BROKEN_PRELUDE = f"import sys; sys.path.insert(0, {HERE!r}); import groundwork_state as gs\n"
BROKEN_WRITERS = {
    "strips trailing whitespace on write": BROKEN_PRELUDE + (
        "_aw = gs.atomic_write\n"
        "gs.atomic_write = lambda p, d: _aw(p, '\\n'.join(l.rstrip() for l in d.split('\\n')))\n"),
    "off-by-one end-fence span": BROKEN_PRELUDE + (
        "_fr = gs.find_region\n"
        "def fr(text, fid):\n"
        "    r = _fr(text, fid)\n"
        "    if r is None: return r\n"
        "    (s0, s1), (e0, e1), inner = r\n"
        "    nl = text.find('\\n', e1)\n"
        "    e0 = len(text) if nl < 0 else nl + 1\n"   # resumes AFTER the end-fence line
        "    return (s0, s1), (e0, e1), inner\n"
        "gs.find_region = fr\n"),
}

tmp = tempfile.mkdtemp(prefix="gw-fence-")
try:
    plan = os.path.join(tmp, "plan")
    r = run("scaffold", "--plan", plan, "--profiles-root", PROFILES, "--profile", "software",
            "--goal", "Fixture plan for fence-integrity checks")
    check("scaffold ok", r.returncode == 0, r.stderr)
    salt_plan(plan)

    # ---- comparator self-test ----
    print("comparator sanity:")
    sample = rb(os.path.join(plan, "01-plan.md"))
    check("salted fixture parses (balanced fences)", outside_fences(sample) is not None)
    check("fence-lookalike in a code span is not treated as a fence",
          b"not-a-real-fence" in b"".join(outside_fences(sample)))
    check("comparator: identical bytes -> identical", prose_identical(sample, sample))

    # ---- pass 1: fence-only writes ----
    print("fence-only writes (pass 1):")
    for f, fid, content in WRITES:
        p = os.path.join(plan, f)
        before = rb(p)
        r = write(plan, f, fid, content)
        after = rb(p)
        check(f"{f}#{fid} -> WRITTEN", result(r) == "WRITTEN", result(r))
        check(f"{f}#{fid} prose outside fences byte-identical", prose_identical(before, after))
        check(f"{f}#{fid} content landed inside the fence", content.encode("utf-8") in after)

    anchor = json.loads(rb(os.path.join(plan, ".groundwork.json")))
    for f in sorted({w[0] for w in WRITES}):
        disk = "sha256:" + hashlib.sha256(rb(os.path.join(plan, f))).hexdigest()
        check(f"anchor whole-file hash verifies for {f}", anchor["docs"][f]["hash"] == disk)

    # ---- pass 2: idempotent re-run ----
    print("idempotent re-run (pass 2):")
    s1 = snap(plan)
    time.sleep(0.05)  # mtime resolution: a churned file would show a newer mtime
    results = [result(write(plan, f, fid, content)) for f, fid, content in WRITES]
    s2 = snap(plan)
    check("every identical re-write -> UNCHANGED", all(x == "UNCHANGED" for x in results), results)
    check("re-run leaves every file's bytes identical (anchor included)",
          {k: v[0] for k, v in s1.items()} == {k: v[0] for k, v in s2.items()})
    check("re-run leaves every file's mtime intact (anchor included)", s1 == s2,
          sorted(k for k in s1 if s1[k] != s2.get(k)))

    # ---- negative: out-of-fence mutation is detected ----
    print("negative checks (the assertions have teeth):")
    f = os.path.join(plan, "05-tracking.md")
    good = rb(f)
    mutated = good.replace(b"HAND-PROSE \xc2\xb7 keep me exactly  \n",
                           b"HAND-PROSE \xc2\xb7 keep me exactly\n", 1)
    check("fixture contains the prose to mutate", mutated != good)
    check("out-of-fence mutation -> comparator reports a difference", not prose_identical(good, mutated))
    wb(f, mutated)
    anchor = json.loads(rb(os.path.join(plan, ".groundwork.json")))
    disk = "sha256:" + hashlib.sha256(rb(f)).hexdigest()
    check("out-of-fence mutation -> anchor whole-file hash mismatch", anchor["docs"]["05-tracking.md"]["hash"] != disk)
    wb(f, good)

    # in-fence hand edit -> the next write refuses
    t = good.replace(b"Wave 1: WP-01", b"Wave 1: WP-01 (hand edit)", 1)
    wb(f, t)
    r = write(plan, "05-tracking.md", "wave-plan", "Wave 1: WP-01, WP-02")
    check("in-fence hand edit -> SKIPPED_DIRTY", result(r) == "SKIPPED_DIRTY", result(r))
    check("SKIPPED_DIRTY leaves the file byte-identical", rb(f) == t)
    wb(f, good)

    # deliberately broken writers -> the comparator rejects their output
    for name, prelude in BROKEN_WRITERS.items():
        bp = os.path.join(tmp, "broken-" + re.sub(r"\W+", "-", name))
        shutil.copytree(plan, bp)
        target = os.path.join(bp, "05-tracking.md")
        before = rb(target)
        r = subprocess.run([sys.executable, "-B", "-c", prelude + "gs.main(sys.argv[1:])",
                            "write-region", "--plan", bp, "--file", "05-tracking.md",
                            "--id", "wave-plan", "--action", "test", "--content", "Wave 1: WP-01 + WP-02"],
                           capture_output=True, text=True)
        check(f"broken writer ({name}) ran", r.returncode == 0 and result(r) == "WRITTEN", result(r))
        check(f"broken writer ({name}) -> caught by the prose comparator",
              not prose_identical(before, rb(target)))

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
