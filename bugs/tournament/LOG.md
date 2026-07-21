# AI tournament — improvement log (append-only)

Each entry: date, what changed, evidence before/after, verdict. Read this
before starting a new round (see README.md for the loop).

## 2026-07-15 — round 1 (baseline + first improvement pass)

**Baseline** (`results-2026-07-15T07-25-31.*`, 297 turns, SOLO seed, post
cordon-fix brain): every race develops (no more 1-colony stalls), but
- bots plateaued at 4–14 colonies / 27–39 apps / ~34 pop vs the human
  benchmark 18c/131a/197p (note: the human's 131 apps are inflated by the
  `creative` pick — all apps per field; bots pick one),
- several seats collapsed to −2000…−4600 BC with 0 warships,
- zero matches concluded (no winner by 297) — mutual aggression never lands.

**Diagnosis** (probe: `t60: cp=8/4`, `cp_overage` = 10 BC/point/turn):
1. CP-overage death spiral: the queue fallback on tech-starved worlds queued
   AND bought a warship every single turn, unbounded by command points;
   overage fines (−30+/turn) swallowed the whole economy.
2. Token science: one shifted worker per colony, `industry` preset for most
   of the game.
3. Pop gap: housing only ever queued on fully-built worlds.
4. (introduced during the round, caught by personalities gate) an
   unconditional outpost/colony prepend starved the top shipyard so
   militarist fielded zero warships; expander lost its colony edge.

**Changes** (`src/ui/soloBot.ts`):
- CP headroom gates all warship builds; warlike profiles may run 4 points of
  overage while bc > 100 (menace costs money, bankruptcy is not a strategy).
- Fallback for "nothing buildable" mints trade goods instead of warships.
- Debt handling: empire tax 15%/30% while bc < 0 plus up to 3 trade-goods
  yards scaled to the hole (was: a single yard).
- Housing prioritized on worlds ≥4 buildings and <70% pop; `research` preset
  on worlds ≥5 buildings with nothing important to build; scientists scale
  +1 per 6 pop beyond 10 (front-loading science failed the selfplay gate —
  reverted to grown-colonies-only).
- extendRange only builds new outpost ships when actually cordoned (no
  reachable free system, or war target out of range with nothing left to
  settle); one anchor per star (no duplicate outposts).
- Fleet builds pick the biggest hull finishable in ~12 turns (was: cheapest,
  i.e. frigate spam); expander profile expand 4→6, buyEager.

**After** (same seed/turns): 8–17 colonies, 30–43 apps, all solvent
(+65…+294 BC), fleets up to 16 hulls; lithor 17c/69p ≈ the human's colony
count. Guardrails green (prewarp, selfplay ≥0.9×v1, personalities distinct).
Still no conclusions by turn 297 → next round runs 1000 turns.

**Open items for round 2:**
- Do 1000-turn games conclude? If not, the war layer (bombard-to-kill, fleet
  concentration, target selection) is the next lever — check whether fleets
  actually meet and whether star bases stall sieges.
- Science is still ~3× under a creative human; consider tech-field ordering
  (research_lab/supercomputer line first) rather than cheapest-field-first.
- ferron (cybernetic) is the weakest gauntlet race — check whether its
  half-food half-prod upkeep starves growth under the housing rule.
- Personality ranking from the 1000-turn round-robin: tune the losers.

## 2026-07-15 — round 2 (1000-turn results + the invasion layer)

**1000-turn tournament** (`results-2026-07-15T07-59-29.*`, 38 matches, SOLO
seed): empires now scale all game — up to 48 colonies / 88 apps / 317 pop /
134 warships, top scores ~2967 (the human benchmark scored 1356 at t297).
Ranking (score-decided; NO match produced a winner):

1. industrialist 1553 · 2. expander 1472 · 3. balanced 1321 ·
4. militarist 1199 · 5. techer 1175 · 6. rusher 791

**The defining finding: zero of 38 games concluded, even at 1000 turns with
total naval supremacy (102w vs 2w).** Root cause is mechanical: bombardment
never kills the last population unit (battles.ts:657, by design), and colony
capture requires a GROUND invasion — loaded transports at an enemy colony
star with no defending warships auto-resolve a landing (ground.ts
resolveInvasions) — which the bot never attempted. Also visible: mutual
early wars (rusher pairings) lock both sides at ~5 colonies for the whole
game; war without a finishing move is pure deadweight.

**Change:** `soloBot.ts` gains `invade()` (aggressive/warlike only): keeps a
troop lift of 2 + enemyColonies/3 transports (max 6, built only once ≥4
warships exist, APPENDED to queues so the slipway never starves), drafts
2-unit marine detachments from own colonies with >6 pop, and sails loaded
lifts to enemy colony stars the warfleet has cleared. Bombard-then-land:
the fleet's bombardment already grinds militia down before the troops hit.

**Verify:** guardrails 11/11 green; conclusion test = balanced mirror on the
SOLO seed at 600 turns, expecting an actual winner (see next entry).

## 2026-07-15 — round 3 (wave landings + formal surrender: games END)

Iterating on the conclusion tests (balanced mirror, SOLO seed, 600 turns):
1. Invasions alone: domination (40c/24w vs 16c/3w) but ~2 captures per 100
   turns — piecemeal 2-troop drops get repelled by militia. No winner.
2. **Wave landings**: loaded transports hold until the wave outnumbers the
   weakest CLEARED colony's militia (pop/2 + barracks), then launch
   together; lift sized to that target; fleets besiege up to 4 stars
   (was 2). Faster attrition, still no conclusion inside 600 turns.
3. **Formal surrender** (the finisher): after turn 250, an empire at war
   facing ≥2×+5 colonies AND ≥4×+8 warships against it offers `surrender`
   (diplomacy: winner absorbs colonies/fleets/tech, loser eliminated); the
   winning bot auto-accepts. Result: **the mirror now concludes at turn 553
   with a conquest winner** (56c absorbed realm) instead of timing out at
   1000. Thresholds are brutal on purpose: concede only when crushed.

Guardrails 11/11 green throughout. Full 1000-turn tournament re-run with
all three changes = the round-3 results file (see below).

**Round-3 tournament results** (`results-2026-07-15T18-05-46.*`, 38 matches
— the run was still alive in the background and finished on 2026-07-16):
games now END — 9 conquest wins by formal surrender (5/30 rr + 4/8 races).
Ranking flipped toward aggression:

1. rusher 10pts/1413avg · 2. militarist 7/1383 · 3. balanced 6/1259 ·
4. techer 5/1217 · 5. industrialist 4/818 · 6. expander 3/769

**Losers diagnosed:**
- expander ELIMINATED twice (techer t997, industrialist t448): fleetRatio
  0.5 leaves ~10 warships guarding 25+ colonies; once the enemy fleet
  clears a star the invasion layer eats the whole realm.
- industrialist finishes 719–1146 in timeouts: expand=2 + scienceBias=0 has
  no long game (fewest colonies of the economics profiles, no tech).
- Race gauntlet: ferron and hivex in seat 0 get conquered by balanced
  solari; lithor outgrows solari from either seat (2278/2033 vs 703/790).

**Open items for round 4:** war-responsive defense so pacifist profiles
aren't free food; industrialist needs a growth lever; iteration cost must
drop (1000-turn matches run 15–22 min — round 3 burned 9 CPU-hours).

## 2026-07-16 — round 4 (war fleet floor: REVERTED — homogenized everyone)

Iteration cost fix first: tournament harness gained `TOURNEY_SEATINGS=1`
(single seating per pair) and `TOURNEY_SHARD=k/n` + `TOURNEY_RUNID` (shard a
round across parallel vitest workers; jsonl files merge). Iteration round =
rr-only, 600 turns, single seating, 2 shards ≈ 1 h wall instead of 9.
`analyze.py` merges shards, ranks, and compares avg t500 scores against any
baseline jsonl (fair across different horizons).

**Change tried:** any profile at war floors fleetRatio to 1.25 and gets the
warlike CP-overage allowance ("an empire at war keeps a real navy").

**Result** (`results-r4.*.jsonl`, 15 matches): regression.
- Tournament bots declare war on turn 1, so the floor applied all game to
  everyone: balanced and techer became IDENTICAL bots (their pairwise lines
  match to the point), killing personality distinctness in tournaments.
- Economy sank across the board — avg t500 score vs round 3: balanced −97,
  expander −239, industrialist −144, militarist −153, techer −13, rusher
  +79. Early hulls crowd out factories/labs and the loss compounds.
- 0/15 conclusions (round 3 had 3 inside 600 turns): everyone fields just
  enough navy that nobody gets crushed — wars became pure stalemate.
- Only upside: zero eliminations (expander survived).

**Verdict:** unconditional war floor rejected. Round 5 keeps the idea gated
on being OUTGUNNED (at war && enemy warships > 1.2×mine + 2) so the floor
only fires when the threat is real, and personalities keep their identity
otherwise.

## 2026-07-16 — round 5 (outgunned-only defense floor: KEPT)

**Change:** fleetRatio floors to 1.25 (and the CP-overage allowance applies)
only while at war AND outgunned (enemy warships > 1.2×mine + 2), instead of
whenever at war.

**Result** (`results-r5.*.jsonl`, 15 matches, 600 turns, single seating,
avg t500 score vs round-3 baseline):
- distinctness restored — balanced and techer diverge again;
- industrialist +108 (744→852, last→first at t500): the overage allowance
  while outgunned lets its buy-heavy economy actually field replacements;
- rusher +40, techer +2, balanced −67, expander −105, militarist −138;
- militarist's drop is partly the fix working: its prey now defends
  (expander leads militarist 1047–638 in their pairing);
- conclusions unchanged: rusher still kills industrialist, now t433 (round
  3: t495) — the floor does not stalemate the games the way round 4 did.

Note on method: single-seating rounds never play the seatings where round-3
expander got eliminated (both were expander-as-seat-0), so "no eliminations"
here does not yet prove the survival fix — the final both-seatings run must
confirm. Guardrails 293/293 green.

**Open for round 6:** expander still last on points (never wins, leads only
militarist); techer has no real science edge (apps ≈ everyone's).

## 2026-07-16 — round 6 (per-personality constants: expander KEPT, techer REVERTED)

**Changes:** techer scienceBias 1→2 (with the blend preset gated to ≥3
buildings — from turn 1 it fails the 120-turn viability gate by 2.6%);
expander fleetRatio 0.5→0.7.

**Result** (`results-r6.*.jsonl`; deterministic engine confirmed — pairings
not involving techer/expander replayed round 5 bit-for-bit):
- expander: KEEP. Won its first game ever — ELIMINATED rusher at t585 —
  avg final 1063 (2nd best), t500 +81 vs round 5. "Holds many colonies and
  is no longer free food" is now real.
- techer: REVERT. Apps at t500 unchanged (51 vs everyone's ~50 — the
  research-preset flip on developed worlds already saturates science) while
  its production game cratered (283/302-point finals, t500 −171 vs round
  5). scienceBias buys nothing once colonies mature; the lever is dead.
- conclusions 3/15 (rusher kills industrialist t433, techer kills balanced
  t574, expander kills rusher t585) — up from 1/15 in round 5.

**Round 7:** techer back to scienceBias 1; militarist (1 pt, worst) gets an
economic base for its fleet: expand 2→3, fleetRatio 2→1.7.

## 2026-07-16 — round 7 (militarist economy: REVERTED)

**Change:** militarist expand 2→3, fleetRatio 2→1.7 (techer reverted to
scienceBias 1 — confirmed: its non-militarist pairings replayed round 5
exactly).

**Result** (`results-r7.*.jsonl`): backfired. The colony-ship pipeline
starved the early fleet exactly when the rush arrives — rusher ELIMINATED
militarist at t379 (round 5: militarist survived that pairing at 544), and
balanced beat it 1033–703 (was 789–1096 the other way). Reverted to
fleetRatio 2 / expand 2.

**Method caveat discovered:** in single-seating iteration rounds the pair
order is fixed, so militarist ALWAYS plays seat B — its apparent t500
deficit vs the round-3 baseline (−130) is partly seat bias (it ranked #2 in
the full both-seatings round 3). Per-personality deltas between iteration
rounds are trustworthy; cross-personality rankings inside a single-seating
round are not.

**Net keeps after rounds 4–7:** outgunned-only defense floor (round 5) +
expander fleetRatio 0.7 (round 6). Everything else reverted. Final
validation = both seatings, races+rr, 600 turns.

## 2026-07-16 — round 8 (final validation: both seatings, races+rr, 600 turns)

`results-final.0/1.*` (38 matches, 2 shards, SOLO seed). Zero violations,
zero stalls. Ranking (2 pts a win, 1 pt for leading a timeout):

1. militarist 8 (1 win) · 2. industrialist 7 · 3. rusher 7 (1 win) ·
4. expander 6 (1 win!) · 5. balanced 3 · 6. techer 2

vs the round-3 baseline (avg score at t500, same seatings):
industrialist +156, militarist +85, expander −24, balanced −87, rusher −81,
techer −56.

**What the kept changes bought:**
- The table FLATTENED: round 3 ran a 774-point spread with expander (639)
  and industrialist (818) as free food; now every personality sits between
  604 and 1142 avg final and none is a pushover — the acceptance criterion
  "no personality is a free win" holds.
- expander went from 2 eliminations + last place to a conquest WIN
  (eliminated rusher t585) and mid-table; ferron (cybernetic), which round 3
  conquered at t675 when it sat in seat 0, now survives the full 600.
- Wars still END: 6 conquest wins (3 rr: rusher→industrialist t433,
  expander→rusher t585, militarist→rusher t591; 3 races: mirror ×2 t517,
  hivex t444) — faster than round 3's equivalents.
- Cost: the pacifist scorers (balanced −87, techer −56) lose ground now
  that prey defends itself. techer is the new bottom — it needs a real
  identity lever (scienceBias 2 was tried in round 6 and did nothing).

**Caveat:** single seed (the SOLO map), per README rule 4 the profile-tuning
wins should be re-checked on a second seed before further tuning stacks on
top. All 345 unit/determinism/protocol tests green throughout.

## 2026-07-16 — round 9 (bot race archetypes + pick-point scaling)

New harness capability: `arch` phase (budget-scaling bot archetypes from
`src/ui/botRaces.ts` vs balanced solari), `TOURNEY_PICKS` (pickPoints for
every match), and a **map fullness** metric (% of real planets claimed at
game end; goal = pretty much full). Bots now take a `race` option — an
archetype rescales its picks to the lobby's pick budget (unit-tested to
spend 10/12/14/16 exactly; every archetype milks repulsive for +6).

Runs: `results-r9-arch10.*` and `results-r9-arch16.*` (600 turns, both
seatings, SOLO seed, 10 matches each). Engine 0.15.0 (the same-day battle
noncombatant/walkover + system-administrator changes landed AFTER these
runs — next round re-baselines on 0.16.0; per the selfplay memory rule,
expect reshuffles and judge by score gates, not win counts).

**Result: the archetypes beat the stock preset baseline soundly.**
- 20 matches: 9 conquest WINs for the archetype side, 11 timeouts (archetype
  leading most), ZERO archetype losses or eliminations.
- Pick scaling works and matters: cyborgs turned two @10 timeouts into two
  @16 conquest wins; creatives @10 626/855 pts → @16 1173/1222; forgers @16
  seat 1 hit 33c/466pop/2643pts (the biggest economy any round has produced).
- Identities read clearly: forgers = biggest economy + conquest (t308-365
  kills), lithovores = fastest wars (3 WINs, t~273-350), scholars/creatives
  = tech monsters (creatives 128-130 apps @16 vs the human benchmark's 131).
- Map fullness: avg 84% (@10) / 85% (@16); timeouts end 74-103% full —
  the "map pretty much full at game end" goal holds; low-% games are early
  conquest wins, which is the better outcome anyway.

**Tuned this round:** creatives want-list reorder — industry2 moved ahead
of subterranean/science3 (`botRaces.ts`). Diagnosis: the 12-pick creative
build took science2+subterranean+large_hw and NO industry pick at all;
the round's weakest line overall was the low-budget creative (19c, 0
warships, 626 pts @10 seat 0). Verification (`results-r9-creatives-v2.*`):
@10 the pick set is unchanged by design and the rerun reproduced the v1
scores exactly (626/855 — also a clean determinism check); the reorder
closes the b12 no-industry hole (now science3+industry2+large_hw).

**Next levers spotted:**
- creative @10 seat 0 fielded 6 warships at t100 and ZERO at t600 — it lost
  its fleet mid-game and never rebuilt. Suspect the CP-headroom gate
  (`soloBot.ts` cpHeadroom) starves rebuilds in low-BC tech economies.
- techer still needs an identity lever (open since round 8).
- rerun the arch gauntlet on engine 0.16.0 (noncombatants now escape when
  escorted — invasion/transport attrition changed) and on a second seed.

## 2026-07-16 — round 10 (engine 0.16.0 re-baseline: arch @10/@16 + rr)

Pure re-baseline, no bot changes (`results-r10-arch10/16.*`, both seatings;
`results-r10-rr.*`, single seating, 600 turns; all SOLO seed).

- **arch @16**: consistent with round 9 — 6 conquest WINs, 4 timeouts (all
  archetype-led), zero archetype losses. avg archetype score 1512.
- **arch @10**: mostly consistent BUT **cyborgs seat 1 is now ELIMINATED**
  (r9: timeout) — the 0.16.0 battle changes reshuffled that pairing. avg
  archetype score 1286. creatives seat 0 reproduces the r9 grinder
  bit-for-bit (626 pts, 0 warships at 600).
- **rr** (new 0.16.0 baseline): rusher 1st (2 conquest wins), 3 games end in
  ELIMINATION (industrialist, rusher, militarist each die somewhere), techer
  last. Map fullness 84%.

**Probe** (`creative-probe-baseline.log`, new `MOO2_PROBE=1
tests/balance/creative-probe.test.ts` harness): the creative@10 seat-0 loss
mechanism is a MEAT GRINDER, not a build-gate bug — it queued and built 38
warships over 300 turns, but each newborn hull died within 1-3 turns to the
5-9 solari warships camping its colonies (CP headroom was fine; the r9
cpHeadroom suspicion is REFUTED).

## 2026-07-16 — round 11 (survival reactivity: doomed battles flee, outgunned fleets rally — KEPT)

**Change** (`soloBot.ts`, one concept, two hooks):
- `orderBattles`: a hopeless fight (enemy hulls > 2×mine + 1 on the field)
  orders stance `evade_retreat` — ships warp out to the nearest own colony
  and live. (A 1.5×+1 probe variant fled every defense and got the creative
  ELIMINATED by t590 — colonies need their fleet to stand SOMEWHERE; 2×+1
  kept it alive. `creative-probe-flee15.log`.)
- `attack` → `rally` while outgunned (same empire-wide 1.2×+2 test as the
  round-5 defense floor): instead of piecemeal strikes, ALL warships mass at
  the own colony star with the fewest enemy campers (ties: where most of the
  fleet already is), and stay until the odds recover.

**Result** (same seeds/knobs as round 10):
- arch @10: archetype avg 1286 → **1990 (+55%)**; the cyborgs ELIM is gone
  (919 pts survival); map fullness 76→90%; conquest wins 4→1.
- arch @16: archetype avg 1512 → **2145 (+42%)**; wins 6→5; fullness 72→83%.
- rr: avg score up for 5/6 personalities (industrialist +379, techer +350,
  rusher +239, militarist +197, expander +7, balanced −43); eliminations
  3 → **0**; fullness 87%. **BUT conquest wins 3 → 0** — the beaten side
  now flees well enough that bot attackers cannot finish it, and the
  surrender test (warships ≥ 4×+8) never fires because fleeing preserves a
  token fleet. Dominance is still decisive on points (e.g. rusher 1305 vs
  militarist 415).
- creatives @10 stay weak (640/668) — the grinder no longer bleeds them dry
  but their science-heavy 10-pt build can't rebuild a fleet economy. That is
  a botRaces want-list problem (b10 has no industry pick), NOT a war-layer
  one — future round.

**Verdict: KEPT** — huge score gains, zero eliminations anywhere, map
"pretty much full" everywhere — but the rr zero-conclusions red flag goes
straight into round 12.

## 2026-07-17 — round 12 (surrender threshold catches fleeing losers)

**Change:** the concession test's warship condition drops from
`theirWarships ≥ 4×mine + 8` to `≥ 2×mine + 4` (colonies condition
unchanged at 2×+5, turn ≥ 250). Rationale: round 11's fleeing brain keeps a
token fleet forever, so the 4× deficit never arrives; every rr game timed
out with the winner 2-3× ahead. Checked against round-10/11 finals: no
healthy game (score gap < 2×) would have crossed the new bar.

**Result:** (r12-rr + r12-arch10, same seeds)
- **rr** (`results-r12-rr.*`): conclusions RESTORED — 3 conquest wins
  (techer CONQUERS rusher 2417 vs −1000; rusher and expander finish
  militarist), all via surrender with the winner 2-3× ahead in colonies and
  warships; every no-surrender pairing replays round 11 bit-for-bit.
  techer ranks #1 with its first win ever (5 pts, avg 1286) — the survival
  brain turned its tech lead into a war-winning economy. militarist is the
  seed's designated loser (2 concessions; its surviving games score
  569-953) — note the round-7 caveat: single seating always seats it B.
- **arch @10** (`results-r12-arch10.*`): forgers convert both games to
  conquest WINs (the seat-0 dominant timeout now ENDS at 3212 pts);
  lithovores seat 0 wins again; scores in concluded games read lower than
  round 11 only because conquest freezes the clock early. One design-intent
  cost: cyborgs seat 1 now CONCEDES its mid-game trough (round 11 crawled
  back to 919 by t600 against a passive opponent) — "concede when crushed"
  is judged worth that (a human in the winner's seat finishes that game
  anyway).

**Verdict: KEPT** (with round 11 — the pair ships together). Net vs the
round-10 / 0.16.0 baseline: archetype averages +40-55%%, map fullness 76→90%%
(@10 arch), zero hard eliminations anywhere, wars still end (3 rr + 4 arch
conquests), and the only "eliminations" left are formal surrenders of
genuinely crushed empires. Second-seed validation: `results-r12-seed2.*`
(seed 7c4e1209, arch@10 + rr, single seating).

**Second-seed validation** (`results-r12-seed2.*`, seed 7c4e1209, arch@10 +
rr, single seating, 600 turns): HOLDS. Zero violations, zero stalls; wars
still end (5 conclusions/20: balanced conquers rusher AND militarist, techer
conquers rusher, forgers conquer solari); every "elimination" is a formal
surrender with the winner ~2×+ ahead; no personality hides at 0 warships in
a timeout. Notes: rusher is this seed's weak one (2 concessions — seat-bias
caveat applies); map fullness 63% avg (more early conquests + a rougher
galaxy than the SOLO map). **creatives@10 seat 0 is ELIMINATED on this seed
too (33% map)** — the b10 creative pick list (still no industry pick;
round 9 only fixed b12) is confirmed cross-seed as the next lever (round 13
candidate: reorder `botRaces.ts` creatives want-list so the 10-point build
takes industry over a science luxury).

## 2026-07-18 — OnionAI bring-up (probe round 0, pre-tournament)

**Change:** new third brain `onion` (`src/ui/onionBot.ts`, spec
`bugs/ai_plan.md` "Tech Fortress Doctrine"): dominant-constraint scoring
(expansion/range/research/production/food/treasury/military/defense) with
1.15× hysteresis + per-personality pivot thresholds, marginal-payoff build
scoring (`BUILD_FIT`), constraint-fit research (`SUBJECT_FIT` +
`WANTED_APPS` resolver override), reserve-gated leader hires, smallest-
sufficient-fleet sizing, one-star committed strikes, guardian-prize pricing,
and the v2-proven debt/rally/invasion-wave mechanics re-derived. Selectable
in the lobby (🧅 OnionAI next to parity/fair), `brain:'onion'` in SoloBot,
`onion` tournament phase (mirror personalities vs v2), viability gate
`tests/determinism/onion.test.ts`, probe `tests/balance/onion-probe.test.ts`.

**Probe iterations** (SOLO seed, balanced mirror, 297t, pre-warp medium —
`bugs/tournament/onion-probe.log`):
- v0: 2c/15a, −2729 BC death spiral (6-hull navy on a 2-colony economy;
  debt rescue wiped a 90%-built colony ship; plan=treasury locked 187
  turns). Fixes: fleet cap colonies+1 while ≤3 colonies, warship orders need
  solvency, scrap cheapest hull while < −100 BC, rescue spares heads with
  ≤8 turns left, 30-turn stall re-decision.
- v1: 1c forever — colony_base cost gate too strict (200 cost vs
  prod 4-5 × 25) AND research never reached cold_fusion (colony_ship/
  outpost_ship/transport all unlock there; SUBJECT_FIT.expansion preferred
  chemistry). Fixes: ×45 base gate, resolver-first research (a field
  offering a WANTED app outranks subject affinity; pivot allowed under 25%
  field progress), expansion wants power first.
- v2-probe: 16c/86p/17a vs v2 12c/52p/42a — expansion runaway; plan
  never left expansion (score 91 is unassailable through 1.15× hysteresis
  under the 100 cap). Fix: expansion urgency decays 5%/colony (floor 0.45).
- v3-probe: 12c/67p/23a/11w/688bc vs v2 12c/51p/42a/12w/94bc — balanced,
  ~+9% score. Research still the onion's lag (23a vs 42a): first tournament
  lever.

Guardrails green throughout: determinism+unit 376 pass, svelte-check 0
errors (v2 brain untouched — onion is deliberately self-contained so the
two sides tune independently).

## 2026-07-18 — onion round 1 (baseline: OnionAI vs v2, mirror personalities)

**Setup:** `TOURNEY_PHASES=onion`, seeds 393fb163 + cafef00d, all six
personalities, both seatings, 297t (`results-onion-r1.*`, merged by
`analyze_onion.py`).

**Result:** v2 13 pts / 521 avg — onion 11 pts / 475 avg. Zero conquests
(mirrored strength grinds; all 24 timeouts), zero eliminations, zero
violations. Clean split by temperament:
- Onion takes the WAR mirrors: rusher 546 vs 404 (4/4 pairs), militarist
  466 vs 412 (3/4) — the constraint brain keeps colonies coming (12-15c)
  while v2's rusher/militarist starve at 7-10c with expand 1-2.
- v2 takes every DEVELOPMENT mirror (balanced 588-444, techer 600-444,
  expander 602-473, industrialist 519-476) on one repeated edge: 37-44
  apps vs the onion's 21-30 — and on cafef00d's rich seat 0 v2 hits 19-23
  colonies where the onion caps ~12 (pipeline ceiling + expansion decay).

**Round-2 levers (one per side):** onion — scientist allocation (research
preset flips at 4 buildings instead of 5; research plan buys a second
shift). v2 — war personalities keep a settler pipeline (rusher expand 1→2,
militarist 2→3). Guardrails after both: 376 determinism+unit pass
(selfplay, personalities distinctness, prewarp, onion viability).

## 2026-07-18 — onion round 2 (research-preset flip BACKFIRES; v2 settlers KEPT)

**Changes:** onion — research preset at 4 buildings + double shift under the
research plan. v2 — rusher expand 1→2, militarist 2→3.

**Result** (`results-onion-r2.*`, baseline r1 at t297): v2 15 pts / 523 avg
— onion 9 pts / 430 avg.
- Onion **−44 overall**, concentrated exactly where the change aimed:
  techer −123 (321), balanced −94 (350), expander −78. Full-'research' on
  4-building colonies killed the engines: 7c instead of 12c, pop −20, apps
  up only ~2. The v2 codebase learned this same lesson from its selfplay
  gate ("front-loading scientists tanks the early economy").
  **Verdict: REVERTED.**
- v2 **+4 overall** (523): militarist +26 (438), rusher flat at 405 while
  facing a STRONGER onion rusher (568), everything else within noise, zero
  new violations. A war economy with settlers holds its ground.
  **Verdict: KEPT.**

**Round-3 lever (onion only):** keep yards alive while staffing labs —
'blend' (pollution-capped industry, rest science) on every 4-building
colony under every plan; full 'research' stays a 5-building research-plan
move; shifts back to +1. v2 unchanged this round.

## 2026-07-18 — onion round 3 (blend-at-4 neutral + one death; the REAL tech gap found)

**Change (onion only):** 'blend' preset on every 4-building colony.

**Result** (`results-onion-r3.*`, baseline r1 at t297): checkpoint-fair
onion +3 (476), v2 −4 (516) — noise. Many pairings replayed round 1
bit-for-bit (the preset path rarely fired). The one real difference was
catastrophic: expander/cafef00d/seat1 onion ELIMINATED t294 (v2's first
conquest, 1105 pts) — the solvency guard kept refusing warships while v2
camped its stars. Apps unmoved (21-30 vs 37-44). **Verdict: REVERTED.**

**Diagnosis (instrumented probe, new f/L/sci columns):** the apps gap is
NOT allocation — at t250 the onion ran MORE labs and scientists than v2
(7L/16sci vs 5L/13sci) yet completed HALF the fields (11f vs 22f). Strict
constraint-fit ordering climbs one subject's ladder, and every ladder gets
pricier per rung: a constraint tunnel is a cost tunnel. v2's cheapest-first
harvests every subject's cheap rungs (fields ≈ apps ≈ building unlocks).

**Round-4 levers (onion):** (1) research pick = fit-per-RP (`fit/cost`;
resolver overrides stay absolute) — probe flips the mirror to onion
16c/43a/28f/65p vs v2 10c/41a/26f/45p; (2) bug-class: defense emergency
(enemy at own stars) bypasses the warship solvency guard — the r3
elimination's direct cause; (3) jobs reverted to round-1 allocation. v2
unchanged. Guardrails: 376 pass.

## 2026-07-18 — onion round 4 (fit-per-RP lands: onion +98; v2 needs its turn)

**Changes (onion):** research pick by fit-per-RP + defense-emergency bypass
on the warship solvency guard + jobs reverted to round-1 allocation.

**Result** (`results-onion-r4.*`, baseline r1 at t297): onion 18 pts / 572
checkpoint avg (**+98**, every personality up: techer +172→615, militarist
+104, rusher +96→644, balanced +86); v2 6 pts / 492 (**−28**: techer −129,
rusher −75 — the onion now out-techs the tech personality). Fields/apps gap
closed: probe shows onion 28f/43a vs v2 26f/41a. **Verdict: KEPT** (both
onion levers).

Remaining black spot: cafef00d's rich seat 0 snowballs its holder — when v2
sits there the onion caps at 9-13c vs v2's 19-30c and has now been ground
to elimination twice (r3 expander, r4 balanced; both t294+ timeouts, no
formal conquest). The onion's flat 2-3 settler pipeline is the cause.

**Round-5 levers:** onion — pipeline depth scales with reachable
worthwhile worlds (`2 + settleable/4`, expander +1). v2 — techer
scienceBias 1→2 (at bias 1 its jobs were IDENTICAL to balanced; the
early-blend flip keys off bias ≥ 2). Guardrails: 376 pass, distinctness
gate holds.

## 2026-07-18 — onion round 5 (onion pipeline KEPT; v2 techer bias REVERTED)

**Changes:** onion — settler pipeline scales with reachable worthwhile
worlds. v2 — techer scienceBias 1→2.

**Result** (`results-onion-r5.*`, baseline r1 at t297): onion 17 pts / 586
(**+112**; every personality ≥ +70; the cafef00d/seat1 balanced game is
still the one elimination). v2 7 pts / 498 (−22): militarist +40 (452),
industrialist +23, balanced +13 — but techer **−167** (434, and −38 vs its
own round-4 self): the bias-≥2 blend flip at 3 buildings starves the
opening, exactly as the round-2 note predicted. **Verdicts: onion pipeline
KEPT; techer bias REVERTED.**

Reading v2's residual −22: mostly map-share — the faster onion takes
colonies v2 used to take (colonies·20 dominates the score). v2's own
improvements (war-personality settlers, r2) are real and keep their gains
against the much stronger onion.

**Round-6 lever (v2 only, onion frozen):** port the pipeline lesson —
settler depth scales `expand + freePlanets/8` for balanced/industrialist/
expander. Warlike profiles keep the round-2 fixed depth (scaling them
crowded the war yards and broke militarist-out-builds-techer), and the
fleet-light techer stays flat (its grown empire's absolute fleet beat the
militarist's — same gate, other direction). Guardrails: 376 pass.

## 2026-07-18 — onion round 6 (onion peaks at +124, zero elims; v2 pipeline port REVERTED)

**Change (v2 only, onion frozen):** settler pipeline scaled by global
free-planet count for balanced/industrialist/expander (techer excluded —
scaling it broke militarist-out-builds-techer in BOTH directions before the
final form; warlike kept round-2 depth). Techer bias reverted to 1.

**Result** (`results-onion-r6.*`, baseline r1 at t297): onion 18 pts / 598
(**+124**, first round with ZERO eliminations — the cafef00d black-spot
game dissolved once v2 changed; onion-balanced 590 there). v2 6 pts / 490:
techer recovered to 576 (revert ✓) but balanced −54 / expander −98 — v2
counts ALL free planets, so deep pipelines built 500-cost settlers for
worlds the faster onion had already claimed. **Verdict: pipeline port
REVERTED** (a future port must count reachable-and-worthwhile targets the
way the onion does). Final v2 config = round-2 settler bump + everything
else round-1. Guardrails: 376 pass.

**Final validation battery:** (a) rr round-robin (600t, SOLO seed, single
seating — v2 personalities vs EACH OTHER, no onion) against the r12-rr
baseline: the clean same-opposition answer to "is v2 better than before";
(b) final onion-phase round with the frozen code pair; (c) a third unseen
seed as an overfit check.

## 2026-07-18 — onion rounds 6-7 wrap + validation (final standings)

**Round 7 (frozen final code, both seeds, both seatings —
`results-onion-r7final.*`, baseline r1 at t297):**
- **OnionAI 582 avg (+109 vs its round-1 self), 16 pts, ZERO
  eliminations.** Every personality +80..+140; wins the rusher (688-309),
  militarist (595-436) and industrialist (558-540) mirrors.
- **v2 502 avg, 8 pts** — the pipeline revert recovered
  balanced/expander/techer to near-baseline (−18/−21/−30, vs −54/−98 in
  r6). The two KEPT v2 levers are above baseline even against a +109
  opponent: militarist +24, industrialist +21. Rusher −89 remains v2's
  designated loser mirror (the onion-rusher is brutal); a future
  reachable-target pipeline port is the identified fix.

**v2 same-opposition validation (`results-v2final-rr.*` vs the r12-rr
baseline, 600t, SOLO seed, single seating, checkpoint t500):** every
personality up: balanced +356, techer +259, rusher +226, expander +168,
militarist +151, industrialist +104. Attribution honesty: most of the lift
is the 0.19.0 research-target engine fix (landed between r12 and now); the
war-personality settler bump is this loop's contribution (militarist — the
perennial rr loser — from 544 to 695). ⚠ New red flag for a future round:
0/15 rr games concluded (r12 had 3 conquests) — the uniformly bigger
economies no longer cross the 2×+4/2×+5 surrender bars; "wars must end"
needs re-tuning against 0.19-scale scores.

**Kept levers (final):** onion — fit-per-RP research pick, resolver-first
research targeting, expansion-urgency decay, opportunity-scaled settler
pipeline, defense-emergency solvency bypass, debt scrapping, 45-turn
colony_base gate, 30-turn stall re-decision. v2 — rusher expand 1→2,
militarist 2→3. Reverted after measurement: onion research-preset@4,
blend@4; v2 techer scienceBias 2, global-count pipeline scaling.

Guardrails at close: 376/376 determinism+unit, svelte-check 0 errors.

**Third-seed overfit check** (`results-onion-seed3.*`, unseen seed
11223344…, 12 matches): HOLDS — onion 543 avg / 8 pts / 0 elims vs v2 273 /
6 pts, including the tournament's first CONQUESTS (onion militarist and
rusher eliminate v2 outright). v2 keeps techer (648) and expander (540),
same shape as the tuned seeds. The onion's edge is doctrine, not
seed-memorization.

*Provenance note:* commit `f77e73a` (colony-attack formulas, ENGINE 0.20.0)
landed from a concurrent session AFTER every run above completed — all
onion-round numbers in this entry block are the 0.19.x engine. The merged
tree (0.20.0 + both tuned brains) passes the full 386-test guardrail suite;
the next tournament round starts a fresh 0.20.0 baseline (bombardment
changes will reshuffle all seeds — per the selfplay re-baseline rule, judge
that round only against its own round-1, not these numbers).

## 2026-07-21 — 0.21.0 round: onion becomes the DEFAULT, mirror catch-up lands

**Defaults (bugs.md "AI still too weak"):** the OnionAI is now the default
opponent everywhere — Home.svelte solo picker (concurrent session),
enterSoloGame's botMode default, and addBotForSeat stand-ins (net.ts).
v2 remains the parity-mode brain and the tournament sparring partner.

**Fresh 0.20/0.21 probe baseline** (`results-a2-baseline.*`, onion phase,
rusher/expander/balanced, 1 seating, t297, SOLO seed — per the re-baseline
rule these numbers supersede the 0.19 r7 block): onion 709/948/762 (avg
806) vs v2 343/ELIM/394 (avg −88). The 0.20 bombard/marine engine widened
the brain gap sharply (v2-expander now gets eliminated outright).

**v2 levers this round** (`results-a2-tuned.*`): rusher expand 2→3 (the r7
"designated loser mirror" note, same lever family as the kept r2 bumps) and
the r6-mandated settler-pipeline port done conservatively — depth now caps
on REACHABLE free planets (anchor moveOptions + own-star worlds), never the
global count, so it can only shrink, v1 benchmark untouched. Measured:
rusher 343→349, balanced 394→394, expander ELIM→ELIM — neutral-to-mildly
positive; kept as direction-correct and regression-free. The v2-vs-onion
gap itself is economic scaling, out of scope for constant tuning.

**Mirror catch-up (bugs.md, ENGINE 0.21.0):** debug_spawn_ships grew an
optional non-design shipKind; SoloBot (both brains, settings-gated on
mirror && debugCommands, net.ts flips debugCommands on for solo mirror
games) tops its warfleet up toward the strongest enemy (dead-band >2,
refill to +2, ≤5/turn, solvency-gated, colonies×3 ceiling) and grants a
colony ship per 5 turns while behind on colonies/pop with a reachable
worthwhile world. Tuning lessons pinned in soloBot.ts comments: naive
deficit>0 grants lose (upkeep drag, 374-417); ungated surplus vs an at-war
onion ratchets into a −28k BC spiral (−119 pts, 240 dead grants); a lean
treasury stipend measured net-neutral and was dropped. Proof
(`results-mirror-catchup.txt`, MOO2_MIRROR=1 tests/balance/mirror.test.ts,
t297): catchup-onion@seat1 845 vs fair-onion 333; 973 vs fair-v2 514;
worst-case seat0 vs own twin 472 vs 498 (0.95, soft gate 0.85).

Guardrails at close: 398 unit+determinism tests green (bombard-repro
excluded: pre-existing missing-save ENOENT), svelte-check 0 errors.
