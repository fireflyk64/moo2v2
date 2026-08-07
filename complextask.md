You have 4 major tasks.

- [x] One is to build a variant called core worlds with
  two options: centtral vs random. The game generates num player + 2 unique
  stars guaranteed to have at least 1 world inside. The color should be
  striking and different than any other star type. In the core mode they are
  all in the middle of the map in a circle but in the other mode they are
  randomly scattered around the map. If any player has a colony on all of
  these worlds with at least 1 pop they win the game (but players are offered
  a choice to keep playing if they want). THe AI in this mode must
  relentlessly pursue these stars. The planets shouldn't necessarily be
  special but they must at least have one.

- [x]  second task: when the AI takes on a monster world with no splinter colony
  effect they should bring along a colony ship. The AI bot should also ship
  population around to try to bring many colonists to excellent worlds (eg
  gaia or rich or ultra rich) so they are at least half full

- [x]  third  task replay mode where a savegame can be loaded and viewed from any
  player's view and at any turn. an animation mode can happen to click the
  turns along and the map should show what happens. Players can click to each
  player color to instantly view from that player's vision (there should be a
  list of banners that can be clicked in tihs mode)

- [ ]  Last task and most complicated is that an asycnhronous version of the game
  should be available. In this mode a player can select a save game file to
  resume and select async mode (it could even be before contact). Everyone
  will select the same save file in async mode. In async mode it plays as a
  single player game with bots playing for all the other civilizations. The
  player plays and expands for as many turns as they see fit. In the end
  there's a new reconciliation mode. where you can load all the save game in
  reconciliation mode and it works as follows. Note reconciliation mode
  probably should operate in a compeltely different part of the simulation
  than the normal simulation since the rules are much more like board games
  than the original moo
  a new save game is generated walking the game through in the following
  manner with reconciliation mode. Each save file is used to get that player's
  recorded research list (which tech was invented when) a ship production
  list (turn, planet, ship type) troop numbers at each planet, number of spies
  empire wide, and which planets were colonized list and population delta 
  list for each planet and building list from the game. These are recorded per
  turn. There is no additional production aside from recorded production.
  Ships prefer to pop out in the colonies closest to where they were actually
  produced. Population generates at the correct turns unless that colony
  already has been reduced to zero population. Buildings are also built on
  those turns unless the colony has been zeroed out. AI bots control the ships
  to best try to achieve the goal (either the victory stars option or total
  universe domination). Only if a player is eliminated is their ship
  production halted. This allows large fleets to be produced from the
  homeworld if a player was doing very well in their savegame but for some
  compatible with a replay mode. per above (but the rules of course are these   
  alternative list-driven rules). Spies should be able to either sabotage       
  defensive structures or if set to espionage they can copy passive             
  technologies like armor class or ship drive or range if they have a large     
  advantage or are against democracy and spy rolls are such.                    
  The end should allow players to see a cinematic view of "what really          
  happened" based on their production and conquest in their own games. Again if 
  this is victory stars then the AIs should battle for the middle planets and   
  victory can be attained by camping uncontested fleets on each stars since     
  colonies are predetermined. Note that whoever grabs a colony first in this    
  variant effectively puts the other player's colonization of the planet on     
  hold until that player loses control of the planet. Eg if player A took       
  Sirius on turn 4 and player B took it on turn 5 but player A lost it due to   
  fleet fighting on turn 65 then player B would take it on turn 66 instead of   
  turn 5 and it would instantly get the intervening associated population       
  deltas up to turn 66. The actual space fighting fighting should happen        
  exactly as the main game and the buildings (starbase, etc) and ground         
  structures cna determinne if invasions are successful and space battles are.  
  Remember that we only record production values (eg deltas) every time a new   
  ship is created or a new population is created.
  