# Reconciliation mode — design, rules, and honest limitations

Reconciliation merges independently-played async continuations of one shared
save into a single "what really happened" timeline. It is deliberately a
*different simulation* from the live game — board-game rules: each player's
**economy is replayed from their record**, while **movement and war run live**
under the real engine with bots at every helm.

Implementation map: `src/engine/reconcile.ts` (scripted stages, spy doctrine,
final scoring), `src/engine/pipeline.ts` (mode branch), `src/storage/reconcile.ts`
(harvest + deterministic start assembly), `src/ui/reconcileRun.ts` (bot-driven
runner producing a normal, replay-verified save), Home screen (⚖ UI).
Tests: `tests/unit/reconcile.test.ts`, `tests/determinism/reconciliation.test.ts`.

## The rules

- **Shared base**: the longest common command prefix of the submitted saves.
- **Scripts**: per empire, harvested from its own save by state-diffing every
  turn boundary — research + completed fields, ships (hull + where built),
  colonization claims (with founding size), positive population deltas
  (own race + androids), buildings, terraforming milestones, garrison counts,
  empire-wide spy roster. **No production beyond recorded production.**
- **Ships** spawn at the owner's colony nearest the recorded yard. Only
  elimination halts a script.
- **Colonization** is one-shot, first-come: a later claim holds until the
  holder loses the world, then activates with all intervening pop deltas,
  buildings and terraforming caught up (capped by capacity).
- **Reach insurance**: every 5th turn an empire with no outpost ship gets one
  at its strongest world; a scheduled claim evicts a squatting outpost.
- **War is real**: fuel range, battles, bombardment, defensive structures,
  invasions vs garrison+militia — the exact main-game rules, bots commanding
  (alwaysWar, core-worlds pursuit when the variant is on).
- **Spies**: sabotage targets defensive structures; espionage copies only
  passive techs (armor / drives / fuel cells), only with a ≥10 offense
  advantage or against a democracy, and only on a successful roll.
- **Scoring**: at the shortest save's final turn, if nobody has won, the
  biggest surviving population elects a leader (council-style win).
- **Determinism**: seed and scripts derive from the file set alone — same
  files, same outcome, any order, any machine. Missing players join as plain
  CPUs from the base (warned).

## Shortcomings — strategies the rules rule out

Fixed during development (they were real gaps):

- ~~Terraforming was invisible~~ — a player who terraformed a world got its
  base climate back in reconciliation, silently shrinking their pop script's
  room. Now terraform milestones are recorded and replayed (permanent once
  applied while the owner held the world).
- ~~Android economies undercounted~~ — built androids now count in the pop
  script alongside the owner race (natives and captured aliens still don't:
  those are discovery/combat, not production).
- ~~Silent tail loss~~ — scoring ends at the *shortest* save; a much longer
  save's extra turns are ignored. That is by design (a shared clock), but it
  is now warned loudly at load time.

Inherent to the design (accepted, documented):

1. **No reactive militarization.** Your fleet size is your record. If your
   solo game faced pushover bots and you built three frigates, the
   reconciliation will not build the navy your real rival deserves. The
   counterweight: production never stops short of elimination, so a strong
   recorded economy floods the front regardless of how the war goes.
2. **No counter-design.** Recorded hulls spawn with your best *scripted-tech*
   design of that class, but nobody refits missile boats because the enemy
   turned out beam-heavy.
3. **No adaptive colonization.** Claims are fixed and one-shot; you cannot
   redirect a settler to the world your rival missed, or re-colonize your own
   glassed world (outposts are the only elastic settlement).
4. **No player diplomacy.** Bots fight toward the goal; alliance webs,
   tech-trade economies and peace-for-time plays from live multiplayer do not
   exist here. Treaties standing in the base state carry over.
5. **No population logistics.** Colonist shipping between worlds is blocked
   (pop appears exactly where recorded), so "seed the gaia from the core"
   plays are the async game's job, not the reconciliation's.
6. **No blockade sieges or economic warfare.** With no live economy there is
   no starving a colony out, no trade to raid, no tax to squeeze — worlds fall
   to bombs and marines or not at all. Heavily-shielded worlds therefore
   trend toward stalemate; the end-of-scripts population election exists
   precisely to score those draws.
7. **Frozen court.** Leaders, Antaran raids, random events, the council and
   discovery payouts (splinter/artifact free tech) are outside the record and
   do not fire. What the base state had, it keeps.
8. **Espionage is a sideshow.** By design spies only copy passives or blow up
   defenses — deep-strike tech theft and economy sabotage strategies are out.
9. **Gains ride the record; losses stay home.** Only positive deltas are
   recorded, so pop you lost to wars or starvation in your own game
   re-materializes in the merged timeline unless the reconciliation's own
   fighting re-inflicts it. Measured in practice by the field experiment
   (bugs/reconcile-experiment.md): the most battle-scarred own game came back
   demographically whole and won the end-of-scripts population election.

The honest summary: reconciliation rewards *building a great engine* and
punishes *metagaming weak bots*, because the engine's output is portable into
the merged timeline but tactical adaptation is delegated to the reconciliation
bots. That is the intended trade of an async board game: your plan travels,
your hands stay home.
