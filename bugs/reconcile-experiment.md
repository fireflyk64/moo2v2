# Reconciliation field experiment

Seed `fedcba9876543210fedcba9876543210`, medium galaxy, base 12 turns (all balanced), async +110 turns each
(own seat plays its personality AGGRESSIVELY — the human analog; stand-ins balanced/passive), engine 0.32.0.

## Own async games (how well each player did at home)

| player | own score | colonies | pop | apps | warships |
|---|---|---|---|---|---|
| Industrialist (seat 3) | 250 | 6 | 24 | 25 | 5 |
| Expander (seat 0) | 233 | 6 | 22 | 23 | 3 |
| Techer (seat 1) | 232 | 6 | 25 | 26 | 0 |
| Militarist (seat 2) | 226 | 6 | 25 | 25 | 0 |

## Recorded scripts (what each save contributed)

| player | ships | colonize | pop entries | buildings | research |
|---|---|---|---|---|---|
| Expander | 8 | 4 | 17 | 0 | 1 |
| Techer | 0 | 4 | 15 | 0 | 4 |
| Militarist | 0 | 4 | 16 | 0 | 3 |
| Industrialist | 5 | 4 | 10 | 1 | 3 |

## Reconciliation outcome

Ended turn 124 — winner: **Expander** (council); 2 war relation(s) standing at the end.

| player | recon score | colonies | pop | apps | warships | eliminated |
|---|---|---|---|---|---|---|
| Expander | 279 | 6 | 29 | 23 | 8 |  |
| Industrialist | 250 | 6 | 24 | 25 | 5 |  |
| Techer | 236 | 6 | 27 | 26 | 0 |  |
| Militarist | 228 | 6 | 25 | 25 | 0 |  |

## Verdict

❌ The strongest own game was Industrialist (score 250) but Expander won the reconciliation.

## What happened (analysis)

The upset is real and has three concrete causes, none of them a harness bug
(an instrumented probe confirmed every bot command validates and applies):

1. **The victory metric is population, and "best performing" was measured as a
   composite.** Industrialist's 250 leaned on production, treasury and fleet —
   but nobody conquered anybody before the clock ran out, so the game was
   scored by the spec'd end-of-scripts POPULATION election. On that metric the
   final count was Expander 29 · Techer 27 · Militarist 25 · Industrialist 24.
   The mode's yardstick is people, not GDP; by the yardstick that actually
   decides, Expander's script *was* the best game.

2. **The record keeps your gains and forgets your losses.** Per the design,
   only positive deltas are recorded ("we only record production… every time a
   new population is created"). Expander played the most aggressive own game
   (8 warships built, wars with its stand-ins) and ended it at just 22 pop —
   but its 17 recorded growth entries replayed in the merged timeline WITHOUT
   the home-game losses, re-materializing it at 29 pop. An empire that bled at
   home comes back at full demographic strength unless the reconciliation's
   own wars re-inflict the damage. Documented as an inherent asymmetry in
   docs/reconciliation.md.

3. **Wars stalemate on the clock.** Two wars were live at the end, yet every
   empire still held exactly its six colonies: with ≤8 hulls a side and intact
   starbases, ~12 turns of fighting cannot finish a siege — the exact
   shield-stalemate the population election exists to score. Fleet strength
   only matters here if it converts colonies before the shortest save's final
   turn; otherwise it is 40 points of composite score the election ignores.

**Takeaways for players:** in reconciliation, growth curves are the win
condition unless someone actually finishes conquests before the shortest
save runs out; save length is strategy (a short file ends the game early);
and fighting costly wars in your own async game is cheaper than it looks,
because only your gains ride the record.

**Earlier iterations** (small map / 45–60 turns, kept for the record): all
four personalities produced near-identical 3-colony games with zero fleets —
at short horizons the onion personalities barely diverge, and the
reconciliation was a one-point election tiebreak. Horizon length is the
difference between a coin flip and a story.
