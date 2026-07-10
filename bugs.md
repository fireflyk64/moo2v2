- [x] We need a new game mode: fast start. In this mode players can complete turns one after the next without waiting for synchronization.
The first player's host monitors incoming committed turns from each player. Battles against andomidans or monsters should auto resolve. Since all randomness should be based on a hash of the initial seed plus turn id plus type of event.  Once the first player's simulation host sees players make contact with another empire or their ships encounter each other at a system on a turn, it flashes the screen CONTACT and gives folks a chance to save the file it has computed. This effectively may rewind players. The savegame can be used to start the game in synchoronous mode at the contact turn. If players get more than 10 turns in front of the slowest player, a warning should pop up on their screen so they aren't disappointed if their progress is rewound. We could disallow the fastest player to be more than 10 turns ahead of the slowest person. The key is that it does not synchronize on a turn-by-turn basis.
If there are other robust ways to ensure fast plays, please make a report of ideas in a text file called ui_speedup_ideas.md We don't want to change the game rules.

- [x] At a system we need to be able to select all ships checkboxes
For some reason freighters are not used to move food Instead: freighter maintenace should cost 0.5 BC when in use to transport food (one per) or colonists (5 per pop) and free when not in use.

- [x] Settlers should take N turns to travel where N is determined by the second to best drive (or nuclear propulsion by default)

- [x] Make tooltip go away after first "💡 drag citizens between jobs or onto another colony · ☑ tick rows for bulk builds & presets"

- [x] Default name of destroyer should be "Destroyer" instead of just a number
Anti-missile rocket should be 360

- [x] Morale tech should not be on the research list if you're unification

- [x] Andromedons attack should be off by default--it's too devastating for most game

- [x] We should have an alert for the turn colony ship arrived at a colonizable planet in the map view like the research done alert in the research view.
- [x] Colonies menu should have a notification if any colony is in a default "build" mode instead of actively constructing
- [x] Double check discovered_bugs.md to make sure all are solved correctly in light of the new feature set
  (verified 2026-07-10: the audit's regression locks in tests/unit/auditfixes.test.ts all pass on the new
  engine; the fast-start pump reuses the same accept→fold path as lockstep so the finding-54 turn-hash
  bookkeeping is untouched; fast buffers live OUTSIDE the log so no seq reuse (finding 56); the new
  validators are pure reads per the validator-purity contract; freighter upkeep builds on the audit's
  busyFreighters fix. Full suite: 375+ tests green, determinism/fuzz/soak included.)