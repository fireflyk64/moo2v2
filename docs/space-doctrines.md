# Space-combat doctrines (engine 0.26)

The tactic a fleet is given decides **what range it fights at**, and therefore
which of its weapons are worth carrying. Everything tunable lives in one table,
`src/engine/spaceTactics.ts` → `DOCTRINE_PROFILE`; `src/engine/combat.ts` flies
the geometry it describes.

## The six doctrines

| doctrine | stands at | fights in | wants |
| --- | --- | --- | --- |
| **standoff** | 320u, giving ground | long band — beams at 40%, warheads at full | missiles, torpedoes, heavy mounts, drives to keep the range |
| **line** | 186u, then holds the exact spot | medium band, 70% damage | forward arcs, accurate guns, patience |
| **charge** | 34u, in the target's baffles | short band, 100% damage and +10 to hit | strike craft, boarding shuttles, short-range beams |
| **flank** | wall at 150u, 36% of the roster into their rear arcs | medium, plus knife range astern | fast light hulls, an enemy with slow capitals |
| **pincer** | the same, 48% split to both sides | as flank, more of it | the same, plus numbers |
| **envelop** | a ring closing 150u → 70u | short band, all round | turrets, and anything that must not be allowed to run |

A battle order's `formation` field carries the doctrine directly. Without one,
the stance still speaks: a standoff stance is a standoff, a holding stance a
line, anything else a charge.

## Why the choice matters

Damage falls off with range (100% inside 96u, 70% to 224u, 40% beyond) and
to-hit follows it (+10 / 0 / −20). **Guided munitions ignore both**, which is
the whole reason missile fleets and beam fleets want opposite tactics. Layered
on top:

- **Drives decide what you can fly.** An anchor is a place in the world. A
  fleet that cannot cover the ground never arrives, a wing that cannot run the
  corner arrives late, and a standoff only keeps its band while it can outrun
  the pursuit — the withdrawal is *abeam*, which costs a quarter of its way.
- **Turn rate decides whether your guns bear.** Hulls rotate toward their
  choreographed heading at the hull turn rate. A titan spends a maneuver
  doctrine pointing at empty space; a frigate does not.
- **Rear arcs pay.** Direct fire landing from astern of a target's beam, at
  short or medium range, does 140% damage (`REAR_ARC_DMG_PCT`). That is what a
  flanking wing exists to earn, and what a hull that cannot come about cannot
  deny. Wings deliberately hunt the enemy's *capitals* for exactly this reason.
- **Standing still is a firing position, not a safe one.** A ship may *juke* —
  swing off course, fire an off-axis mount, swing back — paying movement points
  per 11.25° beyond the mount's true arc, divided by its turn rate, out of the
  movement it did not spend going anywhere. So a wall that stands to its guns
  fires most of its battery off-axis. The other half of the bargain is **motion
  evasion**: direct fire is 4 to-hit points less likely to land per movement
  point the target actually spent *translating* (turning on the spot buys
  nothing). The wall is the easiest thing on the field to hit; the fleet
  dancing through the medium band is the hardest.
- **Carriers are a short-range weapon.** Fighters and assault shuttles carry
  fuel for `STRIKE_CRAFT_TICKS` of flight — about 170 field units of reach.
  Launched from a charge or a closing net the sortie arrives; launched from a
  standoff it never gets there.
- **Envelop pins.** There is nowhere to give ground to a fleet that is all
  around you, and off-axis jukes cost the enveloped side double.

Slow, forward-gunned capitals (`isLumbering`) fly the *spirit* of whatever
doctrine they are given — shortest route to its band, bows on — because
ordering a battleship division to fly a dogfight weave only leaves it turning.
They still steer physically, so they arrive late with their bows coming round,
which is precisely what a flanking wing is looking for.

## Measuring it

`tests/balance/space-tactics-sim.test.ts` is a Monte Carlo over ten fleet
archetypes × every doctrine pair × both deployment orientations. It is the
tool that found the problem this system was built to fix and the tool that
tuned the table.

```sh
MOO2_SPACE=1 npx vitest run tests/balance/space-tactics-sim.test.ts
```

Knobs: `MOO2_SPACE_TRIALS=n` (seeds per cell), `MOO2_SPACE_TACTICS=0` (measure
the old 0.24/0.25 pattern engine instead), `MOO2_SPACE_RETREAT=n`,
`MOO2_SPACE_QUICK=1`. Reports land in `bugs/space-sim/`.

The numbers to read:

- **leverage** — how far the doctrine choice moves the material result inside
  one fixed matchup. The pre-0.26 engine sat around 24 points and its
  per-archetype rows were flat to half a point; 0.26 runs around 43.
- **dominance spread** — the gap between the strongest and weakest doctrine
  pooled over everything. Should stay under about ten points; one doctrine far
  above the rest means there is a single right answer, which is the same
  failure as no answer at all.
- **identity by matchup** — the best doctrine per (fleet, opponent) cell. All
  six should appear. If it is one doctrine repeated, the picker is decoration.
- **drive race** — the same fleets fought across a range of engine deltas. The
  winning maneuver should follow the drives.

`tests/unit/spacedoctrine.test.ts` is the fast regression: byte-exactness for
inputs without the `tactics` flag, determinism, the range bands, each mechanic
above, and a compact gate that no doctrine is the right answer everywhere.

## What the bots pick

Bots choose their own tactics from their own fleet, never the enemy's blueprints:

- **Space doctrine** — `onionBot.pickFormation` → `spaceTactics.pickDoctrine`
  reads the fleet's mount mix and drives: warhead fleets stand off, carriers
  and boarders close, fast light hulls flank, anything under its own orbital
  guns holds a line, and a slow fleet closes a net on bases.
- **Ground attack** — `groundTactics.pickGroundAttack` reads the target
  planet's public terrain (cover → infiltrate, broken rock → bounding
  overwatch, open → a charge/flank) and rides as `invadeTactic` on the battle
  order.
- **Ground defense** — `soloBot.orderGroundDoctrine` → `pickGroundDefense`
  sets each colony's standing doctrine from its own garrison mix: a
  militia-heavy world forts up, a marine-heavy garrison maneuvers.

Both ground pickers score every option with the *same* strength math the
resolver uses (`groundModifiers` / `groundCompFactors`), so a heuristic can
never drift from the battle.

## Trying it in the Battle Lab

The Lab (`#battle-lab`) has a **scenario picker** of curated set-piece
matchups where the doctrine makes or breaks the fight — combined arms, a
shield wall, a lumbering giant, a drive race, arcs and angles, a missile
screen. Load one, flip a doctrine or a drive, and re-run to watch it swing.
Each group also has a **speed override** (`spd`), because the Lab otherwise
gives every hull the same max-drive engine and the drive race is half the
point. The scenarios live in `src/ui/screens/battleLabScenarios.ts` and
`tests/unit/battlelabscenarios.test.ts` proves every one builds and fights.

## Compatibility

`BattleInput.tactics` gates all of it. Absent or false runs the 0.24/0.25
pattern sim byte-for-byte (verified against the pre-0.26 engine), so every
stored replay reproduces. `battles.ts` stamps the flag on every newly built
input, so any battle fought on 0.26 diverges from a 0.25 re-sim by design.
