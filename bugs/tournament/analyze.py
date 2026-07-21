#!/usr/bin/env python3
"""Summarize tournament jsonl results (merges shard files by glob).

Usage:
    python3 analyze.py 'results-r4*.jsonl' [--baseline 'results-2026-07-15T18-05-46.jsonl'] [--at 500]

Prints the personality ranking (2 pts a win, 1 pt for leading an unfinished
game), pairwise outcomes, and — with --baseline — a per-personality score
comparison at the given checkpoint turn (default 500), which is fair even
when the two runs used different turn horizons.
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
    return rows


def ranking(rows):
    pts = collections.Counter()
    wins = collections.Counter()
    games = collections.Counter()
    scores = collections.defaultdict(list)
    concluded = 0
    for r in rows:
        if r["phase"] != "rr":
            continue
        a, b = r["a"]["personality"], r["b"]["personality"]
        fa, fb = r["final"][0]["score"], r["final"][1]["score"]
        games[a] += 1
        games[b] += 1
        scores[a].append(fa)
        scores[b].append(fb)
        if r["winner"] == 0:
            pts[a] += 2
            wins[a] += 1
            concluded += 1
        elif r["winner"] == 1:
            pts[b] += 2
            wins[b] += 1
            concluded += 1
        else:
            pts[a if fa >= fb else b] += 1
    return pts, wins, games, scores, concluded


def at_checkpoint(rows, turn):
    """personality -> list of scores at the given checkpoint turn"""
    out = collections.defaultdict(list)
    for r in rows:
        if r["phase"] != "rr":
            continue
        cp = r["checkpoints"].get(str(turn)) or r["checkpoints"].get(turn)
        if not cp:
            continue
        out[r["a"]["personality"]].append(cp[0]["score"])
        out[r["b"]["personality"]].append(cp[1]["score"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pattern")
    ap.add_argument("--baseline")
    ap.add_argument("--at", type=int, default=500)
    args = ap.parse_args()
    rows = load(args.pattern)
    rr = [r for r in rows if r["phase"] == "rr"]
    pts, wins, games, scores, concluded = ranking(rows)
    print(f"matches={len(rows)} rr={len(rr)} concluded={concluded}/{len(rr)}")
    print(f"{'personality':<14}{'pts':>4}{'wins':>5}{'games':>6}{'avgFinal':>9}")
    for p in sorted(scores, key=lambda p: (-pts[p], -sum(scores[p]) / len(scores[p]))):
        print(f"{p:<14}{pts[p]:>4}{wins[p]:>5}{games[p]:>6}{sum(scores[p]) / len(scores[p]):>9.0f}")
    print("\npairwise:")
    for r in rr:
        a, b = r["a"]["personality"], r["b"]["personality"]
        w = a if r["winner"] == 0 else b if r["winner"] == 1 else "-"
        print(
            f" {a:>13} vs {b:<13} winner={w:<13} t={r['finalTurn']:>4}"
            f" scores={r['final'][0]['score']:>6},{r['final'][1]['score']:>6}"
        )
    if args.baseline:
        base = at_checkpoint(load(args.baseline), args.at)
        cur = at_checkpoint(rows, args.at)
        print(f"\navg score at t{args.at} (baseline -> current):")
        for p in sorted(set(base) | set(cur)):
            b = sum(base[p]) / len(base[p]) if base.get(p) else float("nan")
            c = sum(cur[p]) / len(cur[p]) if cur.get(p) else float("nan")
            print(f" {p:<14}{b:>8.0f} -> {c:>7.0f}  ({c - b:+.0f})")


if __name__ == "__main__":
    main()
