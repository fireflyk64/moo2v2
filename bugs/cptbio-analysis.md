# CptBio post-mortem: how the human crushed OnionAI (bugs/cptbio-turn233.moo2save)

Game: 4 players, large galaxy, pre-warp, seed `27e70b8d3a678d20…`. Seat 0
"Federation" (human, CptBio), seats 1–3 OnionAI bots. By turn 233 the human
held 45 colonies / 521 pop / 77 techs / 155 freighters / a doomstar; the best
bot held 28 colonies / 163 pop / 44 techs / 0 freighters, and the human had
annihilated a 27-hull bot fleet in a single battle (t212, 100% vs 43%).

## The recorded curves (replayed from the save's log)

| turn | human pop/cols/techs | Bot 1 pop/cols/techs | notes |
|-----:|----------------------|----------------------|-------|
| 60   | 23 / 3 / 23          | 23 / 2 / 9           | human already ahead on tech 2.5× |
| 100  | 54 / 9 / 27          | 28 / 2 / 17          | bot BANKED 2937 BC, both yards minting trade goods |
| 140  | 97 / 15 / 34         | 50 / 12 / 25         | bot finally expanding (t102+) |
| 200  | 281 / 31 / 56        | 117 / 24 / 37        | human: 70 freighters, 248 buildings |
| 233  | 521 / 45 / 77        | 163 / 28 / 44        | doomstar ends it |

## Root causes (verified against snapshots, not guessed)

1. **Expansion-blocked ≠ expansion-constrained.** Bot 1 did not KNOW the
   colony_ship tech until ~turn 101 (the t101 field completion granted
   `colony_ship, freighters, outpost_ship, transport`). A reachable terran-4
   world sat 60+ turns in scan range (star 34, planetScore 54 vs bar 24). The
   research plan dominated (poor RP keeps the research constraint loud), plan
   hysteresis (×1.15) kept it locked, and `runResearch` only consulted the
   dominant plan's wanted-apps list — so the cold-fusion unlock was never
   picked. The moment it landed (t102), the bot went 2→10 colonies in 30
   turns and reach chained outward with every settlement.
2. **Trade-goods steady state + hoarding.** With nothing scoring positive to
   build (cost/turns penalty on a 9-prod yard) and no ships buildable, both
   yards minted trade goods for 40 turns while 3000 BC sat idle. Nothing in
   `maybeBuy` drained a hoard: it only bought items that fit the current plan.
3. **Research throughput, not field choice, was the tech gap.** Bot RP was
   6–9/turn for a hundred turns vs the human's 150 at t101 — the jobs preset
   stayed 'industry' until 4-5 buildings existed, which never happened on a
   colony that couldn't build anything worthwhile.
4. **Piecemeal strikes.** After the t212 massacre the bot fed single
   destroyers/frigates/cruisers into the human's defended star (t224, t227,
   t231) — the strike doctrine moved every stack independently toward the
   target, so late-built hulls arrived alone and died alone.
5. **Zero freighters, ever.** No brain had a freighter rule. The human ran
   155. (As of ENGINE 0.27.0 food cannot be chartered — no freighters means
   starvation — so this went from "leak" to "existential".)

## What the human did that the bots should copy

- Freighters early (10 by t50) → no colony ever starves, barren mining
  worlds are viable colonies.
- Housing + steady colony ships: pop compounds; pop IS prod, RP and BC.
- ~10 buildings per colony (484 total) vs the bots' 2 (66 total) — build the
  economy, then the fleet; a doomstar at t233 beats 27 laser destroyers.
- Clear monster lairs to open prize systems (b193 vs the npc at star 26).

## Fixes applied (see onionBot.ts / governor.ts / soloBot.ts)

- Expansion floors at 85 when colony_ship is unknown and reachable settle
  targets exist ("blocked on the unlock" outranks the hysteresis).
- `runResearch` resolves against a score-ordered UNION of every loud
  constraint's wanted apps, not just the dominant plan's.
- Jobs flip to 'blend' at 2 buildings (not 4) while the plan is research.
- `maybeBuy` drains hoards: fit ≥ 3 buys when the treasury is 3× the reserve.
- Muster-then-strike: stacks assemble at the heaviest concentration and only
  a stack holding the assembly bar (100% for lair clears, 70% for rival
  strikes) jumps the target.
- All three brains order a freighter fleet whenever shipping would feed a
  starving colony (uncovered lack + leftover surplus).

- `runResearch` resolves THROUGH the tech ladder: an open field whose
  successor rungs offer a wanted app ranks for it (depth-ordered). Without
  this, colony_ship sat one cheap rung (cold_fusion, cost 80) past an open
  field and the resolver ground battle_pods for fifty turns instead of
  climbing to it.

## Benchmark results (same galaxy, OnionAI in all four seats, aggressive)

`MOO2_CPTBIO=1 npx vitest run tests/balance/cptbio-bench.test.ts` appends to
`bugs/tournament/cptbio-bench.jsonl`. Improved bots vs the RECORDED game, at
seat 1 (the race the old bot lost with):

| turn | improved bot (4-way war) | old recorded bot (peace) | human |
|-----:|--------------------------|--------------------------|-------|
| 100  | 7c / 34 pop / 19 apps    | 2c / 27 pop / 21 apps    | 9c / 51 / 27 |
| 150  | 18c / 79 pop / 23 apps / 17 hulls | 16c / 53 pop / 26 apps / 9 hulls | 18c / 99 / 38 |
| 200  | 26c / 156 pop / 31 apps / 25 hulls / 35 freighters | 24c / 109 pop / 38 apps / 22 hulls / 0 freighters | 31c / 267 / 56 / 70 freighters |

The colony-tech deadlock is gone (breakout at ~t45 instead of t102), pop is
+43% over the old bot at t200 while fighting three aggressive rivals instead
of coasting, freighters exist, and the fleet is bigger — matching the human's
economy curve to ~t150 before the 4-way war drags it. Tech remains the gap
(the recorded bots free-rode a peaceful game; the human's 150 RP/turn at
t100 is still far out of reach). A research-cap experiment (raising the
constraint ceiling 80→90 so it can clear production's 70×1.15 hysteresis
bar) bought +2 apps at the cost of −48 pop at t200 and was reverted — the
next tech lever should be building/jobs based, not plan-selection based.

## Round 2: the human's ladder, encoded (CORE_ORDER)

The 45-colony command log shows a near-identical development order on every
colony: factory → lab → supercomputer → pollution control → star base →
atmospheric renewer → space port → robo miners → stock exchange → astro
university → autolab. Now in onionBot as CORE_ORDER: scoreBuild pays the
first missing rung +28 (second +12), maybeBuy buys the next rung above the
reserve and buys hulls in wartime, the research wanted-lists follow the same
ladder ('robominers' also fixed — the old 'robo_miner_plant' entry named a
buildable and never matched a field), and production pressure fades as yards
get their tools. Same-map benchmark, seat 1, t200:

| bot | colonies | pop | apps | hulls | score |
|-----|---------:|----:|-----:|------:|------:|
| recorded (peace) | 24 | 109 | 38 | 22 | 955 |
| round 1 (at war) | 26 | 156 | 31 | 25 | 1144 |
| + CORE ladder (at war) | 31 | 173 | 29 | 33 | 1333 |
| human (peace) | 31 | 267 | 56 | 0 | 1477 |

Colony count now matches the human's at t200, with a 33-hull fleet the
human never fielded, while fighting three rivals. The remaining distance is
tech and the pop it compounds — research throughput (jobs/labs staffing),
still the next frontier.
