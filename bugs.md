- [ ] Having multiple tabs disrupt the save file is a huge problem. Can we have an additional copy of the savegame in memory as well that we can save irrespective of the tab situation? Or we may need another solution altogether for storing the data. We cannot expect users to remain to a single tab and it's very confusing that some tabs can't save. 

- [ ] opponents can flash your screen red by committing and uncommitting we should lock it to red once someone commits.

- [ ] option to auto-turn 60 (or configurable) after everyone has committed the first time


- [ ] For basic technologoes: eg Cold fusion and basic level 1 tech should research everything all at once. I need to be able to get friegheters and transports and colony ships. Currently it's not workable that way. The mechanics need to match master of orion tech tree.


- [ ] no transports needed for insystem colonist movement: can we drag the people around as individual citizen icons for both worker allocation (food, industry, research) as well as individual transport which auto-uses freighters not transport ships. The people should change icons if they are workers (having a hammer) or scientists (beaker) or farmer (grain) 


- [ ] In the colonies screen we need a button to select all of whatever has been filtered. We should be able to have quick configuration of research or industry or research-blend (where industry is set to enough to cause <= 2 pollution)


- [ ] We need to be able to rename stars

- [ ] We need to be able to rename colonies and tag colonies with various fixed tags

- [ ] We need at least one path from each player to each other in range 4.

- [ ] We should also have a mirror mode option at game start where the nearby stars are replicated and rotated so that everyone gets exactly the same opportunity and all players on the edge of the map

- [ ] the home system should have exactly the same other planets in it among all players.
good-start (one other planet that is ultra rich) and  minstart (1 other planet that is abundant in home system) 


- [ ] People should be able to transit through wormholes even if they don't have range. This allows outposts to be placed on the other side to extend the range and allow incursions

- [ ] We ought to have research percentage and food in the top bar


- [ ] This needs to be the last time we break save games. We need to make sure the save game file is forward-compatible to future changes (this last time is ok to break old saves so we can do architectural improvemetns). We need a methodology that will not break savegames as we add future features or solve future bugs (like tech tree bugs). We should also include previous turns in the save game file unless a user checks an optional "no history" option. We should be able to resume savegames from older turns to be able to play out "what if" scenarios. Those can be packaged up since it seems to be about. 

- [ ] Once all the above are done, we should add better combat mechanics: arcs F, FX, R, 360, and also include turning and percentage hits based on computer and evasion and range and engine speed. Some beams do less damage at a range. And some weapons damage a random amount (eg 3-15 for certain beams like neutron blaster) Battle tactics should include maintaining formations as well as just charge hold or retreat.  There's also a passthrough formation that charges and then retreats after the charge cohesively (like fighting as raiders). The actual sprites should rotate accordingly. battle damage should take out systems like engines during fights (though specific damage does not need to persist outside of the damage aside from percentages). Analyze how master of orion does the combat and review the docs on this. The ships should show the range damage. The battle simulator should let us clone specific ship types so we don't have to enter each one individually. When designing ships: you should be able to see your DPS and speed and evasion capability and range.

- [ ] We can allow users to run the battle simulator for ship types encountered or built during a game. Only do this when all the other features above are done

- [ ] We did not notice leaders being encountered, especially system leaders.

- [ ] The large map was zoomed out and hard to see or zoomed in with scroll when reloaded. Both views are nice we should be able to toggle between.