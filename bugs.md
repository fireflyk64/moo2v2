- [ ] We need a new game mode: fast start. In this mode players can complete turns one after the next without waiting for synchronization.
The first player's host monitors incoming committed turns from each player. Battles against andomidans or monsters should auto resolve. Since all randomness should be based on a hash of the initial seed plus turn id plus type of event.  Once the first player's simulation host sees players make contact with another empire or their ships encounter each other at a system on a turn, it flashes the screen CONTACT and gives folks a chance to save the file it has computed. This effectively may rewind players. The savegame can be used to start the game in synchoronous mode at the contact turn. If players get more than 10 turns in front of the slowest player, a warning should pop up on their screen so they aren't disappointed if their progress is rewound. We could disallow the fastest player to be more than 10 turns ahead of the slowest person. The key is that it does not synchronize on a turn-by-turn basis.
If there are other robust ways to ensure fast plays, please make a report of ideas in a text file called ui_speedup_ideas.md We don't want to change the game rules.

- [ ] At a system we need to be able to select all ships checkboxes
For some reason freighters are not used to move food Instead: freighter maintenace should cost 0.5 BC when in use to transport food (one per) or colonists (5 per pop) and free when not in use.

- [ ] Settlers should take N turns to travel where N is determined by the second to best drive (or nuclear propulsion by default)

- [ ] Make tooltip go away after first "💡 drag citizens between jobs or onto another colony · ☑ tick rows for bulk builds & presets"

- [ ] Default name of destroyer should be "Destroyer" instead of just a number
Anti-missile rocket should be 360

- [ ] Morale tech should not be on the research list if you're unification

- [ ] Andromedons attack should be off by default--it's too devastating for most game

- [ ] We should have an alert for the turn colony ship arrived at a colonizable planet in the map view like the research done alert in the research view.
- [ ] Colonies menu should have a notification if any colony is in a default "build" mode instead of actively constructing
- [ ] Double check discovered_bugs.md to make sure all are solved correctly in light of the new feature set