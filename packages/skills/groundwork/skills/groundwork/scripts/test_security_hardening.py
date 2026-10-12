#!/usr/bin/env python3
"""Regression tests for the groundwork security-review fixes (scaffold --force data
loss, symlink / non-regular-file reads, symlink writes, script-safe escaping, linear
heading regexes). Run: python3 test_security_hardening.py  (or pytest). Every test works
in its own tempfile.mkdtemp() directory; nothing is written outside it."""
import importlib.util
import json
import os
import resource
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
PROFILES = os.path.join(SKILL, "profiles")
STATE = os.path.join(HERE, "groundwork_state.py")
GEN_EXPLORER = os.path.join(HERE, "generate_explorer.py")
GEN_INDEX = os.path.join(HERE, "generate_plans_index.py")

SECRET = "TOPSECRET-hunter2-token-9f3a"


def _limit_mem():
    # 400 MB address-space cap so an unbounded read of /dev/zero fails fast
    # (MemoryError) instead of eating the machine.
    resource.setrlimit(resource.RLIMIT_AS, (400 * 1024 * 1024, 400 * 1024 * 1024))


def gw(*args, limit=False, timeout=60):
    return subprocess.run([sys.executable, STATE, *args], capture_output=True, text=True,
                          timeout=timeout, preexec_fn=_limit_mem if limit else None)


def scaffold(plan, *extra):
    return gw("scaffold", "--plan", plan, "--profiles-root", PROFILES,
              "--profile", "software", "--goal", "Test goal", *extra)


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def anchor(plan):
    return json.loads(read(os.path.join(plan, ".groundwork.json")))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="gw-sec-")
        self.plan = os.path.join(self.tmp, "plans", "p1")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def make_plan(self):
        r = scaffold(self.plan)
        self.assertEqual(r.returncode, 0, r.stderr)

    def secret_file(self):
        p = os.path.join(self.tmp, "secret.txt")
        with open(p, "w") as f:
            f.write(SECRET + "\n")
        return p


class ScaffoldForce(Base):
    def _seed(self):
        self.make_plan()
        r = gw("register-id", "--plan", self.plan, "--id", "WP-01", "--doc", "01-plan.md")
        self.assertEqual(r.returncode, 0, r.stderr)
        for f, marker in (("01-plan.md", "HAND-WRITTEN-PLAN-PROSE"),
                          ("04-discussion.md", "HAND-WRITTEN-DISCUSSION")):
            with open(os.path.join(self.plan, f), "a", encoding="utf-8") as fh:
                fh.write(f"\n{marker}\n")

    def test_force_preserves_prose_and_ids(self):
        self._seed()
        r = scaffold(self.plan, "--force")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("HAND-WRITTEN-PLAN-PROSE", read(os.path.join(self.plan, "01-plan.md")))
        self.assertIn("HAND-WRITTEN-DISCUSSION", read(os.path.join(self.plan, "04-discussion.md")))
        self.assertIn("WP-01", anchor(self.plan)["ids"])

    def test_force_keeps_designs_subplans_research(self):
        self._seed()
        a = anchor(self.plan)
        a["designs"]["designs/d-01.html"] = {"design": "D-01", "locked": True}
        a["subplans"]["06-x.md"] = {"archetype": "diff-plan", "status": "active"}
        a["research"]["02-research-external.md"] = {"stamped": "2026-01-01"}
        with open(os.path.join(self.plan, ".groundwork.json"), "w") as f:
            json.dump(a, f)
        self.assertEqual(scaffold(self.plan, "--force").returncode, 0)
        b = anchor(self.plan)
        for k in ("designs", "subplans", "research"):
            self.assertEqual(b[k], a[k], k)

    def _write_goal(self, action):
        content = os.path.join(self.tmp, "goal.txt")
        with open(content, "w") as f:
            f.write("Changed goal text")
        r = gw("write-region", "--plan", self.plan, "--file", "01-plan.md", "--id", "goal",
               "--action", action, "--content-file", content)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_force_rerenders_clean_init_owned_fence(self):
        self._seed()
        # a clean fence last written by init -> --force may re-render it
        self._write_goal("init")
        out = json.loads(scaffold(self.plan, "--force").stdout)
        self.assertIn("01-plan.md#goal", out["refreshed_regions"])
        text = read(os.path.join(self.plan, "01-plan.md"))
        self.assertIn("Test goal", text)
        self.assertNotIn("Changed goal text", text)
        self.assertIn("HAND-WRITTEN-PLAN-PROSE", text)

    def test_force_never_resets_fence_written_by_another_action(self):
        self._seed()
        # generated content (research/orchestrate/...) is not a blank template:
        # --force must keep it even though its hash matches the recorded one
        self._write_goal("research")
        out = json.loads(scaffold(self.plan, "--force").stdout)
        self.assertNotIn("01-plan.md#goal", out["refreshed_regions"])
        self.assertIn("01-plan.md#goal", out["skipped_dirty_regions"])
        self.assertIn("Changed goal text", read(os.path.join(self.plan, "01-plan.md")))

    def test_force_skips_hand_edited_fence(self):
        self._seed()
        p = os.path.join(self.plan, "01-plan.md")
        text = read(p).replace("Test goal\n<!-- groundwork:auto:end goal -->",
                               "MY OWN GOAL EDIT\n<!-- groundwork:auto:end goal -->", 1)
        self.assertIn("MY OWN GOAL EDIT", text)
        with open(p, "w") as f:
            f.write(text)
        out = json.loads(scaffold(self.plan, "--force").stdout)
        self.assertIn("01-plan.md#goal", out["skipped_dirty_regions"])
        self.assertIn("MY OWN GOAL EDIT", read(p))

    def test_force_restores_missing_file_and_keeps_rest(self):
        self._seed()
        os.remove(os.path.join(self.plan, "02-research-external.md"))
        self.assertEqual(scaffold(self.plan, "--force").returncode, 0)
        self.assertTrue(os.path.exists(os.path.join(self.plan, "02-research-external.md")))
        self.assertIn("HAND-WRITTEN-PLAN-PROSE", read(os.path.join(self.plan, "01-plan.md")))

    def test_force_recreates_only_a_corrupt_anchor(self):
        self._seed()
        with open(os.path.join(self.plan, ".groundwork.json"), "w") as f:
            f.write("{not json")
        self.assertEqual(scaffold(self.plan).returncode, 2)  # without --force: refuse
        self.assertEqual(scaffold(self.plan, "--force").returncode, 0)
        self.assertEqual(anchor(self.plan)["ids"], {})
        self.assertIn("HAND-WRITTEN-PLAN-PROSE", read(os.path.join(self.plan, "01-plan.md")))

    def test_reset_all_is_the_destructive_flag(self):
        self._seed()
        self.assertEqual(scaffold(self.plan, "--reset-all").returncode, 0)
        self.assertNotIn("HAND-WRITTEN-PLAN-PROSE", read(os.path.join(self.plan, "01-plan.md")))
        self.assertEqual(anchor(self.plan)["ids"], {})


class ExplorerWalk(Base):
    def test_symlinks_out_of_plan_are_not_embedded(self):
        self.make_plan()
        sec = self.secret_file()
        os.symlink(sec, os.path.join(self.plan, "notes.txt"))        # file link
        outdir = os.path.join(self.tmp, "outside")
        os.makedirs(outdir)
        shutil.copy(sec, os.path.join(outdir, "hosts.yml"))
        os.symlink(outdir, os.path.join(self.plan, "ref"))           # dir link
        r = gw("explorer-data", "--plan", self.plan)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(SECRET, r.stdout)
        names = json.dumps(json.loads(r.stdout)["tree"])
        self.assertNotIn("notes.txt", names)
        self.assertNotIn("hosts.yml", names)

    def test_internal_symlink_is_skipped_too(self):
        self.make_plan()
        os.symlink(os.path.join(self.plan, "01-plan.md"), os.path.join(self.plan, "alias.md"))
        r = gw("explorer-data", "--plan", self.plan)
        self.assertNotIn("alias.md", r.stdout)

    def test_dev_zero_symlink_does_not_blow_memory(self):
        self.make_plan()
        os.symlink("/dev/zero", os.path.join(self.plan, "z.txt"))
        r = gw("explorer-data", "--plan", self.plan, limit=True)
        self.assertEqual(r.returncode, 0, r.stderr[-300:])
        self.assertNotIn("z.txt", r.stdout)

    def test_regular_files_still_embedded(self):
        self.make_plan()
        with open(os.path.join(self.plan, "notes.md"), "w") as f:
            f.write("# hello embed\n")
        r = gw("explorer-data", "--plan", self.plan)
        self.assertIn("hello embed", r.stdout)

    def test_fifo_is_skipped_not_hung(self):
        self.make_plan()
        os.mkfifo(os.path.join(self.plan, "pipe.txt"))
        r = gw("explorer-data", "--plan", self.plan, timeout=20)
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("pipe.txt", r.stdout)

    def test_read_regular_capped_helper(self):
        spec = importlib.util.spec_from_file_location("gws", STATE)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        p = os.path.join(self.tmp, "big.txt")
        with open(p, "wb") as f:
            f.write(b"x" * 100)
        self.assertEqual(len(m.read_regular_capped(p, 10)), 11)   # cap+1 => "over cap"
        self.assertEqual(len(m.read_regular_capped(p, 1000)), 100)
        self.assertIsNone(m.read_regular_capped("/dev/zero", 10))
        link = os.path.join(self.tmp, "lnk")
        os.symlink(p, link)
        self.assertIsNone(m.read_regular_capped(link, 10))        # no final-component symlink


class AnchorDocsPaths(Base):
    def _poison(self, key):
        a = anchor(self.plan)
        a["docs"][key] = {"hash": "sha256:0", "generated_regions": []}
        with open(os.path.join(self.plan, ".groundwork.json"), "w") as f:
            json.dump(a, f)

    def test_plans_index_rejects_dev_zero_doc_key(self):
        self.make_plan()
        self._poison("/dev/zero")
        r = gw("plans-index-data", "--plans-dir", os.path.dirname(self.plan), limit=True)
        self.assertEqual(r.returncode, 0, r.stderr[-300:])
        plans = json.loads(r.stdout)["plans"]
        self.assertTrue(plans[0]["drift"])

    def test_status_data_rejects_escaping_keys(self):
        self.make_plan()
        sec = self.secret_file()
        self._poison("../../secret.txt")
        self._poison(sec)
        self._poison("/dev/zero")
        r = gw("status-data", "--plan", self.plan, limit=True)
        self.assertEqual(r.returncode, 0, r.stderr[-300:])
        states = {d["file"]: d["state"] for d in json.loads(r.stdout)["docs"]}
        for k in ("../../secret.txt", sec, "/dev/zero"):
            self.assertEqual(states[k], "rejected", k)
        self.assertNotIn(SECRET, r.stdout)

    def test_symlinked_doc_out_of_plan_is_rejected(self):
        self.make_plan()
        sec = self.secret_file()
        os.symlink(sec, os.path.join(self.plan, "leak.md"))
        self._poison("leak.md")
        states = {d["file"]: d["state"]
                  for d in json.loads(gw("status-data", "--plan", self.plan).stdout)["docs"]}
        self.assertEqual(states["leak.md"], "rejected")

    def test_normal_docs_still_in_sync(self):
        self.make_plan()
        docs = json.loads(gw("status-data", "--plan", self.plan).stdout)["docs"]
        self.assertTrue(docs)
        self.assertTrue(all(d["state"] == "in-sync" for d in docs), docs)


class SymlinkWrites(Base):
    def test_explorer_scaffold_does_not_write_through_symlink(self):
        self.make_plan()
        victim = os.path.join(self.tmp, "victim.txt")
        with open(victim, "w") as f:
            f.write("PRECIOUS")
        art = os.path.join(self.plan, "artifact")
        os.makedirs(art, exist_ok=True)
        dest = os.path.join(art, "explorer.html")
        os.symlink(victim, dest)
        r = subprocess.run([sys.executable, GEN_EXPLORER, "--plan", self.plan, "--force-rescaffold"],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertEqual(read(victim), "PRECIOUS")
        self.assertFalse(os.path.islink(dest))
        self.assertIn("groundwork:auto:start explorer-data", read(dest))

    def test_explorer_dangling_symlink_creates_nothing_at_target(self):
        self.make_plan()
        target = os.path.join(self.tmp, "should-not-exist.txt")
        art = os.path.join(self.plan, "artifact")
        os.makedirs(art, exist_ok=True)
        os.symlink(target, os.path.join(art, "explorer.html"))
        subprocess.run([sys.executable, GEN_EXPLORER, "--plan", self.plan],
                       capture_output=True, text=True, timeout=60)
        self.assertFalse(os.path.exists(target))

    def test_plans_index_dangling_symlink(self):
        self.make_plan()
        plans_dir = os.path.dirname(self.plan)
        target = os.path.join(self.tmp, "should-not-exist-2.txt")
        os.symlink(target, os.path.join(plans_dir, "_index.html"))
        r = subprocess.run([sys.executable, GEN_INDEX, "--plans-dir", plans_dir],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertFalse(os.path.exists(target))
        self.assertFalse(os.path.islink(os.path.join(plans_dir, "_index.html")))

    def test_artifact_dir_symlink_refused(self):
        self.make_plan()
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.makedirs(elsewhere)
        shutil.rmtree(os.path.join(self.plan, "artifact"))
        os.symlink(elsewhere, os.path.join(self.plan, "artifact"))
        r = subprocess.run([sys.executable, GEN_EXPLORER, "--plan", self.plan],
                           capture_output=True, text=True, timeout=60)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(os.listdir(elsewhere), [])


class ScriptSafeAndRegexes(Base):
    def _mod(self):
        spec = importlib.util.spec_from_file_location("gws2", STATE)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m

    def test_html_script_escape_handles_line_separators(self):
        m = self._mod()
        out = m._html_script_escape("a\u2028b\u2029c</script>&")
        self.assertNotIn("\u2028", out)
        self.assertNotIn("\u2029", out)
        self.assertIn("\\u2028", out)
        self.assertIn("\\u2029", out)
        self.assertNotIn("<", out)
        # round-trips through a JSON string
        self.assertEqual(json.loads('"' + out + '"'), "a\u2028b\u2029c</script>&")

    def test_heading_regexes_are_linear_and_trim(self):
        m = self._mod()
        for rx, head in ((m._PHASE_HEAD_RE, "## Phase 1 — a"),
                         (m._WP_HEAD_RE, "### WP-01 — a"),
                         (m._ROUND_HEAD_RE, "## Round 1 — a")):
            text = head + " " * 30000 + "b"
            t0 = time.time()
            rx.search(text)
            self.assertLess(time.time() - t0, 1.0, rx.pattern)
            mm = rx.search(head + "title   \n")
            self.assertTrue(mm.group(2).endswith("title"))

    def test_wrap_script_escapes_plan_text(self):
        self.make_plan()
        content = os.path.join(self.tmp, "state.json")
        evil = "</script><img src=x onerror=alert(1)>"
        with open(content, "w") as f:
            json.dump({"version": 1, "risks": [{"title": evil}]}, f)
        r = gw("write-region", "--plan", self.plan, "--file", "artifact/index.html",
               "--id", "spec-state", "--action", "refresh-living-spec", "--content-file", content,
               "--wrap-script", "groundwork-spec-state", "--force")
        self.assertEqual(r.returncode, 0, r.stderr)
        text = read(os.path.join(self.plan, "artifact", "index.html"))
        self.assertNotIn(evil, text)
        self.assertNotIn("<img src=x", text)
        start = text.index('<script type="application/groundwork+json" id="groundwork-spec-state">')
        body = text[start:text.index("</script>", start)]
        self.assertIn("\\u003c/script\\u003e", body)

    def test_wrap_script_rejects_non_json(self):
        self.make_plan()
        r = gw("write-region", "--plan", self.plan, "--file", "artifact/index.html",
               "--id", "spec-state", "--action", "x", "--content", "<script>nope</script>",
               "--wrap-script", "groundwork-spec-state", "--force")
        self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=1)
