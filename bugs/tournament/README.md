# AI tournament — setup, results, and the improvement loop

Goal: a **satisfying single-player opponent**. The bot must develop like a
real player in every start mode (especially pre-warp), fight when it should,
and never sit on one planet (see `bugs/root-causes-2026-07-15.md` for the
turn-297 failure this grew out of).

## Running a round

```sh
MOO2_TOURNEY=1 npx vitest run tests/balance/tournament.test.ts
```

Takes minutes to ~an hour depending on knobs. Environment knobs:

| var | default | meaning |
|---|---|---|
| `TOURNEY_TURNS` | `297` | turn horizon (matches the human benchmark game) |
| `TOURNEY_SEEDS` | the SOLO game's seed | comma-separated seeds; add more to de-noise |
| `TOURNEY_PHASES` | `races,rr` | `races` = race gauntlet, `rr` = personality round-robin, `arch` = bot-archetype gauntlet, `onion` = OnionAI-vs-v2 brain mirrors (knobs `TOURNEY_ONION_PERS`, `TOURNEY_ONION_RACE`; summarize with `analyze_onion.py`) |
| `TOURNEY_RACES` | `solari,ferron,lithor,hivex` | presets for the gauntlet (standard, cybernetic, lithovore, uncreative-farmer) |
| `TOURNEY_PICKS` | `10` | pick-point budget for every match (`settings.pickPoints`) — archetypes rescale to it, stock presets ignore it |
| `TOURNEY_ARCHS` | all five | budget-scaling archetypes (`src/ui/botRaces.ts`) for the `arch` phase, each vs balanced solari |
| `TOURNEY_OUT` | `bugs/tournament` | output directory |
| `TOURNEY_SEATINGS` | `2` | `1` = one seating per pair (fast iteration; beware: pair order is fixed, so per-personality seat bias skews CROSS-personality comparisons — only round-over-round deltas are trustworthy) |
| `TOURNEY_SHARD` | `0/1` | `k/n` runs only matches with index % n == k — launch n parallel vitest workers with the same `TOURNEY_RUNID` to split a round across cores |
| `TOURNEY_RUNID` | timestamp | fixes the output basename so shards write `results-<id>.<k>.jsonl` |

`analyze.py <glob>` merges shard jsonl files, prints the ranking/pairwise
list, and `--baseline <jsonl> [--at 500]` compares avg per-personality scores
at a checkpoint turn — fair even when runs used different turn horizons
(games are deterministic per seed+code, so an unchanged pairing replays its
baseline exactly).

Outputs (per run, timestamped):
- `results-<runid>.jsonl` — one JSON line per match, **appended as matches
  finish** (a killed run keeps its data). Fields: seat configs, winner,
  per-seat stats at turns 100/200/final (`colonies/apps/pop/warships/bc/score`).
- `results-<runid>.md` — the human-readable report: race gauntlet table with
  the human's actual turn-297 empire as the benchmark row, personality
  ranking (2 pts a win, 1 pt for leading an unfinished game), pairwise list,
  a **map fullness** summary (avg % of planets claimed at game end — the
  design goal is a pretty much full map by the time a game concludes), and
  any violations (stalls, underdeveloped-at-t200 empires).

Score = `colonies*20 + pop*3 + apps + warships*5 + bc/50` (the selfplay
metric; eliminated = −1000). Human benchmark at turn 297 for context:
**18 colonies / 131 apps / 197 pop / score ≈ 1356**.

## The improvement loop (directions for a fresh session/model)

You are tuning `src/ui/soloBot.ts` — the only brain the shipped game has.
The sim never special-cases bots; everything goes through logged commands.

1. Run a round (above). Read the report's ranking and the pairwise list.
2. Diagnose the LOSERS: what did the bottom personality not do? Typical
   levers, all in `soloBot.ts`:
   - `PROFILES` — scienceBias / fleetRatio / expand / buyEager per
     personality. Keep every personality **viable** (personalities.test.ts
     gate) and **distinct** (techer out-techs militarist; militarist
     out-builds techer; expander holds most colonies).
   - `BUILD_ORDER` — the building priority (seeded from the human's winning
     turn-297 game). Reorder or gate per profile.
   - `attack()` — target choice, strike fraction, when to declare war.
   - `extendRange()` — outpost pushes toward unreachable systems.
   - `fairExpansion()` — colony_base / colony-ship pipeline depth.
3. Change ONE thing, then re-run the SAME seeds and compare rankings and avg
   scores. `results-*.jsonl` diffs cleanly.
4. Add seeds (`TOURNEY_SEEDS=seed1,seed2,...`, 32 hex chars each) before
   claiming a win — single-seed results reshuffle easily (see the memory
   note in selfplay.test.ts: score gates, not win counts).
5. Guardrails — these must stay green after every change:
   ```sh
   npx vitest run tests/determinism tests/unit
   npx svelte-check --tsconfig ./tsconfig.json
   ```
   - `tests/determinism/prewarp.test.ts` — the cordoned-AI regression
     (research, expansion, scouting in pre-warp).
   - `tests/determinism/selfplay.test.ts` — v2 must keep ≥0.9× v1's
     aggregate score. If you tune v2 hard enough that this gate looks silly,
     raise the gate, don't delete it.
   - `tests/determinism/personalities.test.ts` — viability + distinctness.
6. Log what you changed and why in `bugs/tournament/LOG.md` (append-only:
   date, change, before/after ranking, verdict). Future rounds start by
   reading that file.

## What "satisfying" means (acceptance sketch)

- In a 297-turn pre-warp game on the SOLO map, a fair-mode bot should be in
  the same order of magnitude as the human benchmark (double-digit colonies,
  100+ apps for research-capable races) — not necessarily winning, never
  cordoned.
- Lithovore (`lithor`), cybernetic (`ferron`) and standard (`solari`) races
  all develop: ≥3 colonies and ≥20 apps by turn 200 (the harness enforces
  this as a violation).
- Wars happen: aggressive personalities reach the enemy (fuel-range fix) and
  finish games; a whole tournament with zero conquest wins is a red flag.
- No personality is a free win for the others.
