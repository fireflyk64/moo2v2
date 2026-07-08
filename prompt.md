I am assigned to make a web-based 4x game that has exactly the same underlying game rules and mechanics of master of orion 2. The tech tree must have identical behaviors and all mechanics of the game should be identical with the exception of combat and creative. The game itself should be written entirely in typescript. It must have a peer-to-peer multiplayer setup using (by default) lobbylink, for example pqrstuvw.xyz/lobbylink has a lobbylink server running that allows us to test with port 5173 locally. Lobbylink sets up direct webrtc connections to sync data. Player 1 should be elected as host and that host-role need not transfer in games.

The typescript part of lobbylink is checked out in ~/dev/lobbylink which has ~/dev/lobbylink/clients/ts which we can use to establish peer to peer connections.
We should probably use the sqlocal kysely sort of package to save out game state.
The game should be extremely streamlined so that players can take their turns quite quickly, and do most or all things from an integrated system-wide spreadsheet mode that lets players edit all colonies and planets.
FTL transit must allow point to point transit and should not rely on per-system gates (except for that gate technology)

Combat should be visual with game sprites and should happen automatically where the ships do one pass and it should be balanced such that equal tech level will do a bit of damage in the time available but it’s not usually enough for full devastation.
We should have an option to make creative where you can research all 3 techs in that section but you have to pay research points for each item (and the minimum 1 turn)
Also we should have a mode where players can choose to bid for race picks at the start.


Also we should have a game mode when you switch what you are building you keep the progress on the partially built thing but you can’t simply transfer your build points over to a completely different thing.
There need not be any NPCs or Bots in this game (except for purposes of testing).
The mechanics folder contains many of the known mechanics of the game, and internet sources may be drawn upon.

Start by making a comprehensive checklist of all items that need to be done to accomplish these goals. The first few items on the checklist should be the data structures that persist in the sqlite database and define everything that has happened in the game.
The second should be the robust multiplayer mechanism that uses lobbylink to establish webrtc connections between peers and lets them communicate with the first joiner.
Then the simulation side of things, how the planets are managed and how time proceeds when players commit turns.
Then the next step should be how the near-realtime combat happens with the pass of ships entering long range, medium range, short range and getting that one pass...and maybe players can use various maneuvers to stay at distance or evade. Players should be able to see what happens in battle.
Only two player need battle at a time. Battles should take no more than 1 minute to resolve entirely, preferably less, to keep the game as quick as possible.
Then the next step is to start making the pluggable subsystems work with the clear descriptions needed here.
Serialize out the plan into a markdown file so it may be resumed independently later or by other accounts or models as developers may continue this from other computers or VMS.
Ensure the plan is a comprehensive todo list that does not miss any steps from a fully playable game in browser. This includes headless testing.


Once the plan has all necessary components, begin implementing from the top of the plan list.
