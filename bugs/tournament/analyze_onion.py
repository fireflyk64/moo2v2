#!/usr/bin/env python3
"""Summarize onion-phase tournament results (onion brain vs v2, mirror
personalities; merges shard files by glob).

Usage:
    python3 analyze_onion.py 'results-onion-r1*.jsonl' \
        [--baseline 'results-onion-r1*.jsonl'] [--at 200]

Per-brain totals (pts/wins/avg score), per-personality pair lines, and —
with --baseline — per-brain and per-(brain,personality) avg-score deltas at
a checkpoint turn (fair across different turn horizons; unchanged pairings
replay their baseline exactly, so deltas isolate the side that changed).
"""
import argparse
import collections
import glob
import json


def load(pattern):
    rows = []
    for path in sorted(glob.glob(pattern)):
        with open(path) as f:
            rows.extend(json.loads(l) for l in f if l.strip())
    return [r for r in rows if r["phase"] == "onion"]


def seat_brain(r, seat):
    cfg = r["a"] if seat == 0 else r["b"]
    return cfg.get("brain") or "v2"


def summarize(rows):
    agg = {
        b: {"pts": 0, "wins": 0, "games": 0, "score": 0, "elim": 0}
        for b in ("onion", "v2")
    }
    per = collections.defaultdict(lambda: {"games": 0, "score": 0, "wins": 0})
    for r in rows:
        for seat in (0, 1):
            brain = seat_brain(r, seat)
            fin = r["final"][seat]
            other = r["final"][1 - seat]
            row = agg[brain]
            row["games"] += 1
            row["score"] += fin["score"]
            if fin.get("eliminated"):
                row["elim"] += 1
            if r["winner"] == seat:
                row["wins"] += 1
                row["pts"] += 2
            elif r["winner"] is None and fin["score"] >= other["score"]:
                row["pts"] += 1
            pers = (r["a"] if seat == 0 else r["b"])["personality"]
            key = (brain, pers)
            per[key]["games"] += 1
            per[key]["score"] += fin["score"]
            if r["winner"] == seat:
                per[key]["wins"] += 1
    return agg, per


def at_checkpoint(rows, turn):
    """(brain, personality) -> scores at the checkpoint; brain -> scores too"""
    per = collections.defaultdict(list)
    tot = collections.defaultdict(list)
    for r in rows:
        cp = r["checkpoints"].get(str(turn)) or r["checkpoints"].get(turn)
        if not cp:
            continue
        for seat in (0, 1):
            brain = seat_brain(r, seat)
            pers = (r["a"] if seat == 0 else r["b"])["personality"]
            per[(brain, pers)].append(cp[seat]["score"])
            tot[brain].append(cp[seat]["score"])
    return per, tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pattern")
    ap.add_argument("--baseline")
    ap.add_argument("--at", type=int, default=200)
    args = ap.parse_args()
    rows = load(args.pattern)
    agg, per = summarize(rows)
    print(f"onion-phase matches={len(rows)}")
    print(f"{'brain':<8}{'pts':>4}{'wins':>5}{'games':>6}{'avg':>7}{'elim':>5}")
    for b, s in sorted(agg.items(), key=lambda kv: -kv[1]["pts"]):
        avg = s["score"] / max(1, s["games"])
        print(f"{b:<8}{s['pts']:>4}{s['wins']:>5}{s['games']:>6}{avg:>7.0f}{s['elim']:>5}")
    print("\nper personality (brain avg / wins):")
    pers_names = sorted({k[1] for k in per})
    for p in pers_names:
        o = per.get(("onion", p), {"games": 0, "score": 0, "wins": 0})
        v = per.get(("v2", p), {"games": 0, "score": 0, "wins": 0})
        oavg = o["score"] / max(1, o["games"])
        vavg = v["score"] / max(1, v["games"])
        lead = "ONION" if oavg > vavg else "v2"
        print(
            f" {p:<14} onion {oavg:>6.0f} ({o['wins']}w)  v2 {vavg:>6.0f} ({v['wins']}w)  -> {lead}"
        )
    print("\npairs:")
    for r in rows:
        onion_seat = 0 if seat_brain(r, 0) == "onion" else 1
        o, v = r["final"][onion_seat], r["final"][1 - onion_seat]
        w = (
            "ONION"
            if r["winner"] == onion_seat
            else "V2"
            if r["winner"] is not None
            else "-"
        )
        print(
            f" {r['a']['personality']:<13} seed={r['seed'][:8]} onionSeat={onion_seat}"
            f" t={r['finalTurn']:>4} winner={w:<6}"
            f" onion={o['colonies']}c/{o['apps']}a/{o['pop']}p/{o['warships']}w/{o['score']}pts"
            f" v2={v['colonies']}c/{v['apps']}a/{v['pop']}p/{v['warships']}w/{v['score']}pts"
            f" map={r['mapFullPct']}%"
        )
    if args.baseline:
        bper, btot = at_checkpoint(load(args.baseline), args.at)
        cper, ctot = at_checkpoint(rows, args.at)
        print(f"\navg score at t{args.at} (baseline -> current):")
        for b in ("onion", "v2"):
            if not btot.get(b) and not ctot.get(b):
                continue
            bavg = sum(btot[b]) / len(btot[b]) if btot.get(b) else float("nan")
            cavg = sum(ctot[b]) / len(ctot[b]) if ctot.get(b) else float("nan")
            print(f" {b:<8}{bavg:>8.0f} -> {cavg:>7.0f}  ({cavg - bavg:+.0f})")
        for key in sorted(set(bper) | set(cper)):
            bs = bper.get(key)
            cs = cper.get(key)
            bavg = sum(bs) / len(bs) if bs else float("nan")
            cavg = sum(cs) / len(cs) if cs else float("nan")
            print(f" {key[0]:<7} {key[1]:<14}{bavg:>8.0f} -> {cavg:>7.0f}  ({cavg - bavg:+.0f})")


if __name__ == "__main__":
    main()
