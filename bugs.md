- [x] Having multiple tabs disrupt the save file is a huge problem. Can we have an additional copy of the savegame in memory as well that we can save irrespective of the tab situation? Or we may need another solution altogether for storing the data. We cannot expect users to remain to a single tab and it's very confusing that some tabs can't save.
  — done: a tab that can't get the room database (another tab holds it, detected even through sqlocal's silent fallback) now keeps the FULL game record in a `MemoryGameStore`; 💾 Save works from any tab and any seat, a banner explains the situation, and leaving a room releases the OPFS handle for other tabs.

- [x] opponents can flash your screen red by committing and uncommitting we should lock it to red once someone commits.
  — done: the commit edge/banner latches per turn (may only escalate '' → green → red; resets on turn change or battle phase).

- [x] option to auto-turn 60 (or configurable) after everyone has committed the first time
  — done: host lobby option "Auto-turn to N" (default 60). After the first all-commit the host fast-forwards turns; battles still pause for orders; resumes after host restart.

- [x] For basic technologoes: eg Cold fusion and basic level 1 tech should research everything all at once. I need to be able to get friegheters and transports and colony ships. Currently it's not workable that way. The mechanics need to match master of orion tech tree.
  — done: the docs' "(General)" grant-all marker is now carried through the data generator into the engine. Cold Fusion grants colony ship + freighters + outpost ship + transport to every race, alongside the five level-1 fields, exactly as the mechanics docs mark them.

- [x] no transports needed for insystem colonist movement: can we drag the people around as individual citizen icons for both worker allocation (food, industry, research) as well as individual transport which auto-uses freighters not transport ships. The people should change icons if they are workers (having a hammer) or scientists (beaker) or farmer (grain)
  — done: job cells show draggable citizen icons (🌾 farmer / 🔨 worker / 🧪 scientist); click one to grab it plus everyone to its right, then drag onto another job to reassign or onto a same-system colony to ship them (new `move_colonists` command; in-system moves need NO freighters or transports; never abandons a colony; respects capacity).

- [x] In the colonies screen we need a button to select all of whatever has been filtered. We should be able to have quick configuration of research or industry or research-blend (where industry is set to enough to cause <= 2 pollution)
  — done: "select all (N)" respects the filter (which now also matches tags); job presets ⚗ research / ⚒ industry / ⚗⚒ blend (blend caps industry at ≤2 pollution) apply to the selection.

- [x] We need to be able to rename stars
  — done: ✏️ on the map's star panel (requires a colony/outpost in the system).

- [x] We need to be able to rename colonies and tag colonies with various fixed tags
  — done: double-click (or ✏️) a colony name in the spreadsheet; fixed tags (core, border, farm, industry, research, military, staging, new) with chips + filter support.

- [x] We need at least one path from each player to each other in range 4.
  — done: galaxy generation guarantees all homeworlds share one component of the ≤4-parsec hop graph, inserting bridge stars (always holding at least one body, never monster-guarded) where needed. Tested across all sizes, seeds, player counts.

- [x] We should also have a mirror mode option at game start where the nearby stars are replicated and rotated so that everyone gets exactly the same opportunity and all players on the edge of the map
  — done: "Mirror galaxy" lobby option (2–8 players): identical wedges rotated around a shared hub, homes on an edge ring, same colors/planets/keepers per group, symmetric wormholes; Orion sits on the hub, equidistant from everyone.

- [x] the home system should have exactly the same other planets in it among all players.
good-start (one other planet that is ultra rich) and  minstart (1 other planet that is abundant in home system)
  — done: every home system holds exactly the homeworld + one identical sibling world; lobby "Home system" option picks good start (ultra-rich) or min start (abundant).

- [x] People should be able to transit through wormholes even if they don't have range. This allows outposts to be placed on the other side to extend the range and allow incursions
  — done: wormhole transit ignores fuel range (map + fleets show the far end as reachable, 1 turn).

- [x] We ought to have research percentage and food in the top bar
  — done: the research button now shows progress % (plus turns); food surplus is in the bar (🌾).

- [x] This needs to be the last time we break save games. ...
  — done: save format v2 with a forward-compatibility contract (docs/save-compatibility.md): every save embeds a current-state snapshot and loads on ANY future build (same version = full replay verification; different version = snapshot-first with integrity hashes). Saves carry all history snapshots + the full log unless "no history" is checked; the load screen can branch a what-if game from any earlier turn (new game id, original save untouched). A frozen golden fixture test enforces the contract forever; the local-DB auto-resume also refuses to replay logs across versions.

- [x] Once all the above are done, we should add better combat mechanics: arcs F, FX, R, 360 ...
  — done: weapon arcs F/FX/R/360 (space-cost multipliers, per-mount selector in Designer and Battle Lab; PD always tracks 360°); ships steer on a 32-point compass with hull-based turn rates and the viewer rotates sprites with the helm; to-hit already combines computer vs evasion (hull + combat speed) vs range band; beams attenuate to 70%/40% at medium/long; weapons roll min–max damage (e.g. neutron blaster 3–15 from the data tables); structure hits can knock out drives/computers/shields for the rest of the fight (transient — only hull percentages persist); new tactics: formation (line advances at fleet speed) and passthrough (raiders punch through, then withdraw cohesively); Battle Lab groups have a ⎘ clone button; the Designer shows DPS, evasion, speed and weapon ranges. Balance harness re-tuned check passes.

- [x] We can allow users to run the battle simulator for ship types encountered or built during a game. Only do this when all the other features above are done
  — done: Empires tab → "⚗ Simulate with this game's ships" opens the Battle Lab pre-loaded with your designs (side A) and every enemy design you've met in battle (side B, deduped with approximated tiers). Sandbox only — the real game is untouched.

- [x] We did not notice leaders being encountered, especially system leaders.
  — verified offers DO generate (regression test: both leader kinds within 80 turns on every seed); the problem was visibility — offers now light up a pulsing "🎖 leader offer" badge in the nav until answered on the Empires tab.

- [x] Have a single player bot mode with a very simple bot. ...
  — done: "🤖 Single player vs bot" on the home screen — in-process game, no lobby server. The bot plays through the normal command log only (debug commands are logged moves, the simulation has zero bot special cases): copies your ship designs, is granted research parity and the nearest free colony when you expand, keeps planets fed with 1 scientist + rest industry, builds/buys randomly, gets 100 BC when broke, and the "🗡 aggressive bot" toggle makes it declare war and throw half its fleet at your nearest systems. Persists under room SOLO (reload resumes).

- [x] The large map was zoomed out and hard to see or zoomed in with scroll when reloaded. Both views are nice we should be able to toggle between.
  — done: "🔍 zoom in / 🗺 fit galaxy" toggle on the map; the choice persists across reloads.

---
Follow-up round (2026-07-09, after reboot):

- [x] citizen icons: clicking one selects it plus everyone to its right; a drag moves the whole selection between jobs or to a same-system colony. Icons overlap (tighter the more there are) so wide rows stay narrow.
- [x] planet-type column shrunk to a tiny cut-off cell; hover shows the full "terran abundant normal-g size 3" description.
- [x] in-system colonist transfers no longer require a freighter fleet (MOO2's in-system exception; transports still needed between stars).
- [x] "another tab holds this room's database" warning fixed at the root: it keyed off sqlocal's `persisted` flag, which is just the browser's persistent-storage permission (false for nearly everyone) — that's why it fired with a single tab open. Real detection now checks for sqlocal's silent memory-driver fallback (`storageType === 'memory'`). The banner is one line ("make sure to 💾 save every turn — the browser database is not accessible…") and dismissable.
- [x] games started from a save match each joining player to their saved empire BY NAME (welcome carries the seat; the header shows 👤 who you play). Unknown names fall back to a free seat, never a claimed one; the host itself is name-matched too, so anyone can re-host a save.
- [x] the bot can be subbed in for an absent player: a host-side banner offers "🤖 let the bot play <name>"; the (non-cheating) bot claims the seat by name, plays and commits, and "hand the seat back" frees it for the returning human.
- [x] non-cheating AI: bot mode select on the home screen — "parity bot" (visible logged grants, as before) or "fair bot" (no debug commands at all: researches on its own, builds and sails real colony ships, spends its own money).

Verification (2026-07-09, post-reboot): `npm test` (boundaries + 285 vitest tests incl. new seatmatch/fair-bot suites), `svelte-check` (0 errors), `npm run build`, and — now that the sandbox pid limit was reset by the reboot — the full Playwright e2e suite (6/6 specs, incl. save → re-host → client rejoin) all pass.

---
Play by mail (2026-07-10):

- [x] the moo2v2 game server (`server/cmd/moo2v2-server` — its own Go module; lobbylink stays generic and is linked in as a library via lobbylink's new public `lobbyserver` embedding package, whose serving loop the stock lobbylink binary now also uses) started with `--pbm-config` (see server/pbm-config.example.json) stores one authoritative save per room code under /pbm/, gated by a shared password from the config file (logged in once, token remembered; also set as a cookie for same-origin use). Optional per-seat protect passwords, honor-system beyond the shared one.
- [x] flow: 📬 on the home screen → take the room's lock → download → re-host locally over the same server (name matching returns your empire); every commit re-uploads the save together with who-has-committed, so partial turns persist and the turn advances when the LAST player mails in. "📬 mail in & leave" = final upload + lock release; a vanished player's lock times out (180s default) and the server keeps turn-stamped history copies.
- [x] two players online at once: the first holds the lock and hosts; a later PBM login is told who is playing and simply joins their live lobbylink game (verified in e2e, incl. the crashed-holder case which errors instead of forking the game).
- [x] a 💾 save of a PBM game resumes as a normal serverless game and vice versa (a loaded save can create a PBM room), so games move freely between modes.
- Client changes were kept minimal as requested: HostCore gained getCommittedSeats/seedCommitted; everything else is one UI module (src/ui/pbm.ts) + the home-screen panel + auto-upload wiring; the engine is untouched.

Verification (2026-07-10): `go test ./...` in lobbylink (new internal/pbm suite: auth, lock lifecycle incl. expiry, upload/download roundtrip, seat protection, room-code hygiene), `npm test` (288 vitest tests incl. tests/protocol/pbm.test.ts simulating three mail sessions), `svelte-check` 0 errors, `npm run build`, and the Playwright suite now at 7/7 with e2e/pbm.spec.ts driving the real Go server through create → mail turn → second player advances → live-join → wrong-password rejection.
