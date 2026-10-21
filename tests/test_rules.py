"""Runs the shared rule cases (tests/shared/rules_cases.json) against the SERVER rules.
The browser test suite runs the same file against the CLIENT rules (src/gameplay/rules.js).

    python -m unittest discover -s tests -v
"""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from server import rules as R  # noqa: E402
from server.config import CONFIG  # noqa: E402
from server.progression import compute_coins, compute_xp  # noqa: E402

with open(os.path.join(ROOT, "tests", "shared", "rules_cases.json"), encoding="utf-8") as f:
    CASES = json.load(f)["cases"]


def run_case(case):
    c = case["create"]
    state = R.create_match(c["mode"], [{"id": p, "name": p.upper()} for p in c["players"]], c["it"], CONFIG, countdown=c["countdown"])
    for i, step in enumerate(case["steps"]):
        where = f"{case['name']} / step {i}: {step}"
        if "tick" in step:
            R.tick(state, step["tick"])
        if "tag" in step:
            res = R.apply_tag(state, *step["tag"])
            exp = step.get("expect", {})
            if "ok" in exp:
                assert res["ok"] == exp["ok"], f"{where}: ok={res['ok']} reason={res['reason']}"
            if "reason" in exp:
                assert res["reason"] == exp["reason"], f"{where}: reason={res['reason']}"
            continue
        if "perfectDodge" in step:
            res = R.perfect_dodge(state, *step["perfectDodge"], **step.get("opts", {}))
            exp = step.get("expect", {})
            if "ok" in exp:
                assert res["ok"] == exp["ok"], f"{where}: ok={res['ok']} reason={res['reason']}"
            if "reason" in exp:
                assert res["reason"] == exp["reason"], f"{where}: reason={res['reason']}"
            continue
        if "collectCoin" in step:
            got = R.collect_coin(state, step["collectCoin"])
            exp = step.get("expect", {})
            if "ok" in exp:
                assert got == exp["ok"], f"{where}: collect={got}"
            continue
        if "leave" in step:
            R.remove_player(state, step["leave"])
        if "protect" in step:
            R.protect(state, step["protect"])
        if "forceIt" in step:
            R.force_it(state, step["forceIt"])
        exp = step.get("expect")
        if exp:
            check(state, exp, where)


def check(state, exp, where):
    players = state["players"]
    if "it" in exp:
        its = sorted(p["id"] for p in players.values() if p["it"] and not p["out"] and p["connected"])
        assert its == sorted(exp["it"]), f"{where}: it={its}"
    if "out" in exp:
        outs = sorted(p["id"] for p in players.values() if p["out"])
        assert outs == sorted(exp["out"]), f"{where}: out={outs}"
    if "phase" in exp:
        assert state["phase"] == exp["phase"], f"{where}: phase={state['phase']}"
    if "endReason" in exp:
        assert state["result"] and state["result"]["reason"] == exp["endReason"], f"{where}: result={state['result']}"
    if "winners" in exp:
        assert sorted(state["result"]["winners"]) == sorted(exp["winners"]), f"{where}: winners={state['result']['winners']}"
    if "team" in exp:
        assert state["result"]["team"] == exp["team"], f"{where}: team={state['result']['team']}"
    if "tags" in exp:
        for pid, n in exp["tags"].items():
            assert players[pid]["tags"] == n, f"{where}: tags[{pid}]={players[pid]['tags']}"
    if "itTime" in exp:
        for pid, v in exp["itTime"].items():
            assert abs(players[pid]["itTime"] - v) < 0.01, f"{where}: itTime[{pid}]={players[pid]['itTime']}"
    if "coins" in exp:
        for pid, n in exp["coins"].items():
            assert players[pid]["coinsPicked"] == n, f"{where}: coins[{pid}]={players[pid]['coinsPicked']}"
    if "dodges" in exp:
        for pid, n in exp["dodges"].items():
            assert players[pid]["perfectDodges"] == n, f"{where}: dodges[{pid}]={players[pid]['perfectDodges']}"
    if "boost" in exp:
        for pid, v in exp["boost"].items():
            left = max(0.0, players[pid]["boostUntil"] - state["time"])
            assert abs(left - v) < 0.01, f"{where}: boost[{pid}]={left}"
    if "tagCount" in exp:
        assert state["tagCount"] == exp["tagCount"], f"{where}: tagCount={state['tagCount']}"
    if "ranking" in exp:
        got = [r["id"] for r in state["result"]["ranking"]]
        assert got == exp["ranking"], f"{where}: ranking={got}"
    if "coinAward" in exp:
        for pid, total in exp["coinAward"].items():
            got = compute_coins(state["result"], pid, CONFIG["coins"])["coins"]
            assert got == total, f"{where}: coins[{pid}]={got}"
    if "xp" in exp:
        for pid, total in exp["xp"].items():
            got = compute_xp(state["result"], pid, CONFIG["progression"])["total"]
            assert got == total, f"{where}: xp[{pid}]={got}"


class SharedRuleCases(unittest.TestCase):
    pass


def _make(case):
    def test(self):
        run_case(case)
    return test


for _i, _case in enumerate(CASES):
    setattr(SharedRuleCases, f"test_{_i:02d}_" + "".join(ch if ch.isalnum() else "_" for ch in _case["name"])[:60], _make(_case))


class RulesExtra(unittest.TestCase):
    def test_unknown_mode_rejected(self):
        with self.assertRaises(ValueError):
            R.create_match("nope", [{"id": "a"}], ["a"], CONFIG)

    def test_late_joiner_in_elimination_spectates(self):
        st = R.create_match("elimination", [{"id": "a"}, {"id": "b"}, {"id": "c"}], ["a"], CONFIG, countdown=0)
        p = R.add_player(st, "late")
        self.assertTrue(p["out"])

    def test_snapshot_is_json_serialisable(self):
        st = R.create_match("classic", [{"id": "a"}, {"id": "b"}], ["a"], CONFIG, countdown=0)
        R.tick(st, 1.0)
        json.dumps(R.snapshot(st))

    def test_rounding_matches_javascript(self):
        # JS Math.round rounds .5 up; Python round() would round half to even
        self.assertEqual(R._r2(0.125), 0.13)
        self.assertEqual(R._r2(2.675000001), 2.68)


if __name__ == "__main__":
    unittest.main()
