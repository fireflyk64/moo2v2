#!/usr/bin/env python3
"""Summarize minced-phase tournament results (MincedOnion vs onion AND vs v2,
mirror personalities; merges shard files by glob).

Usage:
    python3 analyze_minced.py 'results-minced-r1*.jsonl' \
        [--baseline 'results-minced-r0*.jsonl'] [--at 297]

Per-matchup totals (minced vs each rival brain: pts/wins/avg score), a
per-personality table per matchup, one line per match, and — with
--baseline — avg-score deltas at a checkpoint turn.  --at 297 also compares
the minced seat to the human SOLO benchmark (1356 pts at t297).
"""
import argparse
import collections
import glob
import json

HUMAN_T297 = 1356  # the SOLO save benchmark row printed by tournament.test.ts


def load(pattern):
    rows = []
    for path in sorted(glob.glob(pattern)):
        with open(path) as f:
            rows.extend(json.loads(l) for l in f if l.strip())
    return [r for r in rows if r["phase"] == "minced"]


def seat_brain(r, seat):
    cfg = r["a"] if seat == 0 else r["b"]
    return cfg.get("brain") or "v2"


def minced_seat(r):
    return 0 if seat_brain(r, 0) == "minced" else 1


def summarize(rows):
    # keyed by matchup ("vs onion" / "vs v2"), then side ("minced" / rival)
    agg = collections.defaultdict(
        lambda: {"pts": 0, "wins": 0, "games": 0, "score": 0, "elim": 0}
    )
    per = collections.defaultdict(lambda: {"games": 0, "score": 0, "wins": 0})
    for r in rows:
        ms = minced_seat(r)
        rival = seat_brain(r, 1 - ms)
        for seat in (0, 1):
            side = "minced" if seat == ms else rival
            fin = r["final"][seat]
            other = r["final"][1 - seat]
            row = agg[(rival, side)]
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
            key = (rival, side, pers)
            per[key]["games"] += 1
            per[key]["score"] += fin["score"]
            if r["winner"] == seat:
                per[key]["wins"] += 1
    return agg, per


def at_checkpoint(rows, turn):
    per = collections.defaultdict(list)
    tot = collections.defaultdict(list)
    for r in rows:
        cp = r["checkpoints"].get(str(turn)) or r["checkpoints"].get(turn)
        if not cp:
            continue
        ms = minced_seat(r)
        rival = seat_brain(r, 1 - ms)
        for seat in (0, 1):
            side = "minced" if seat == ms else rival
            pers = (r["a"] if seat == 0 else r["b"])["personality"]
            per[(rival, side, pers)].append(cp[seat]["score"])
            tot[(rival, side)].append(cp[seat]["score"])
    return per, tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pattern")
    ap.add_argument("--baseline")
    ap.add_argument("--at", type=int, default=297)
    args = ap.parse_args()
    rows = load(args.pattern)
    agg, per = summarize(rows)
    print(f"minced-phase matches={len(rows)}")
    for rival in sorted({k[0] for k in agg}):
        print(f"\n=== minced vs {rival} ===")
        print(f"{'side':<8}{'pts':>4}{'wins':>5}{'games':>6}{'avg':>7}{'elim':>5}")
        for side in ("minced", rival):
            s = agg.get((rival, side))
            if not s:
                continue
            avg = s["score"] / max(1, s["games"])
            print(f"{side:<8}{s['pts']:>4}{s['wins']:>5}{s['games']:>6}{avg:>7.0f}{s['elim']:>5}")
        pers_names = sorted({k[2] for k in per if k[0] == rival})
        for p in pers_names:
            m = per.get((rival, "minced", p), {"games": 0, "score": 0, "wins": 0})
            v = per.get((rival, rival, p), {"games": 0, "score": 0, "wins": 0})
            mavg = m["score"] / max(1, m["games"])
            vavg = v["score"] / max(1, v["games"])
            lead = "MINCED" if mavg > vavg else rival
            print(
                f" {p:<14} minced {mavg:>6.0f} ({m['wins']}w)  {rival} {vavg:>6.0f} ({v['wins']}w)  -> {lead}"
            )
    print("\npairs:")
    for r in rows:
        ms = minced_seat(r)
        rival = seat_brain(r, 1 - ms)
        m, v = r["final"][ms], r["final"][1 - ms]
        w = (
            "MINCED"
            if r["winner"] == ms
            else rival.upper()
            if r["winner"] is not None
            else "-"
        )
        print(
            f" {r['a']['personality']:<13} vs={rival:<5} seed={r['seed'][:8]} mincedSeat={ms}"
            f" t={r['finalTurn']:>4} winner={w:<6}"
            f" minced={m['colonies']}c/{m['apps']}a/{m['pop']}p/{m['warships']}w/{m['score']}pts"
            f" {rival}={v['colonies']}c/{v['apps']}a/{v['pop']}p/{v['warships']}w/{v['score']}pts"
            f" map={r['mapFullPct']}%"
        )
    # human-benchmark comparison at the SOLO horizon
    cper, ctot = at_checkpoint(rows, 297)
    minced_cp = [s for (rv, side), scores in ctot.items() if side == "minced" for s in scores]
    if minced_cp:
        avg = sum(minced_cp) / len(minced_cp)
        print(
            f"\nminced avg score at t297: {avg:.0f}  (human SOLO benchmark {HUMAN_T297};"
            f" {avg / HUMAN_T297:.2f}x)"
        )
    if args.baseline:
        bper, btot = at_checkpoint(load(args.baseline), args.at)
        cper, ctot = at_checkpoint(rows, args.at)
        print(f"\navg score at t{args.at} (baseline -> current):")
        for key in sorted(set(btot) | set(ctot)):
            bs = btot.get(key)
            cs = ctot.get(key)
            bavg = sum(bs) / len(bs) if bs else float("nan")
            cavg = sum(cs) / len(cs) if cs else float("nan")
            print(f" {key[1]:<8} (vs {key[0]:<5}){bavg:>8.0f} -> {cavg:>7.0f}  ({cavg - bavg:+.0f})")
        for key in sorted(set(bper) | set(cper)):
            bs = bper.get(key)
            cs = cper.get(key)
            bavg = sum(bs) / len(bs) if bs else float("nan")
            cavg = sum(cs) / len(cs) if cs else float("nan")
            print(
                f" {key[1]:<7} (vs {key[0]:<5}) {key[2]:<14}{bavg:>8.0f} -> {cavg:>7.0f}  ({cavg - bavg:+.0f})"
            )


if __name__ == "__main__":
    main()
