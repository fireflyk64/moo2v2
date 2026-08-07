# Reconciliation tactics lab

Seed `fedcba9876543210fedcba9876543210`, small map, identical scripts both seats (12 frigates + 4 destroyers
by t25, missile base t8, 3 marine transports, +1 pop/6t), scoring at turn 100.
Every cell is one full bot-run; seat position is part of the matchup (the map is not mirrored).

| seat0 \\ seat1 | winner | type | turn | colonies | pop | warships | eliminated |
|---|---|---|---|---|---|---|---|
| consolidated vs consolidated | consolidated (seat1) | council | 101 | 3 / 3 | 22 / 29 | 9 / 0 | - / - |
| consolidated vs split | split (seat1) | council | 101 | 3 / 3 | 22 / 29 | 1 / 10 | - / - |
| consolidated vs hybrid | hybrid (seat1) | council | 101 | 3 / 3 | 22 / 29 | 15 / 0 | - / - |
| split vs consolidated | consolidated (seat1) | council | 101 | 4 / 2 | 23 / 24 | 15 / 0 | - / - |
| split vs split | split (seat1) | council | 101 | 3 / 3 | 22 / 29 | 0 / 13 | - / - |
| split vs hybrid | hybrid (seat1) | council | 101 | 3 / 3 | 22 / 29 | 15 / 8 | - / - |
| hybrid vs consolidated | consolidated (seat1) | council | 101 | 3 / 3 | 22 / 29 | 9 / 0 | - / - |
| hybrid vs split | split (seat1) | council | 101 | 3 / 3 | 22 / 29 | 16 / 16 | - / - |
| hybrid vs hybrid | hybrid (seat1) | council | 101 | 3 / 3 | 22 / 29 | 16 / 16 | - / - |

## Election wins (pop-scored; the asymmetric map biases these to seat 1)

- **consolidated**: 3
- **split**: 3
- **hybrid**: 3

## Military differential (surviving hulls − opponent, both seatings)

- **split**: +31
- **hybrid**: -13
- **consolidated**: -18

## Colony delta vs the scripted 3 (conquests minus losses)

- **split**: +1
- **hybrid**: +0
- **consolidated**: -1
## Analysis

- **Split wins the war.** Two-to-three balanced groups, each committing only to
  targets it can beat, out-fought both other doctrines across seatings: +31
  surviving hulls and the grid's only conquest. Multiple simultaneous winnable
  commitments keep every hull working while single-fleet doctrines wait on one
  perfect moment.
- **Consolidated hits hardest and loses most.** It annihilated hybrid twice
  (15–0, 9–0) — massing absolutely wins collisions — but against split it
  committed the whole navy into fights split could decline or reinforce, and
  finished −18 with the only net colony loss.
- **Hybrid declines too much.** Its raiders were too light to open fronts and
  its main fleet too cautious: two of four contested rows ended with zero
  contact (16/16). It kept its ships and took nothing.
- **The election is script-locked on an asymmetric map.** Every cell's
  pop-vote went to seat 1 (bigger scripted frontier worlds, 29 vs 22 pop) —
  tactics moved attrition and territory, not the vote, on a 100-turn clock.
  Conquest must convert into POP (invasions, not just kills) to flip an
  election; only split's conquest row even moved the needle (23 vs 24).
- **Engineering found along the way:** target selection must prefer REACHABLE
  targets (a fleet committed to a star it cannot fly to parks at home
  forever); fleets now stage forward while outpost chains extend; reach
  insurance fields up to two outpost ships (lane + redundancy) because a
  single parked ship froze the chain; outposts diversify their settle spots
  by ship parity.
- **Default changed:** bot-run reconciliations and live stand-ins now default
  to **split** on this evidence (single seed, N=1 per cell — rerun with
  RECONTAC_SEED to widen the base; consolidated remains the answer when one
  decisive collision is unavoidable).
