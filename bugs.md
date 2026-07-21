# Status 2026-07-21: all items below are FIXED — notes inline under each.

Round 6 (same day): leader-offer fast-forward blocker needs an ignore status; ground battles should be top-down tabletop maps with battalion symbols, per-planet fixed terrain (rocky worlds favor defense), RPS tactics for both sides chosen with battle orders, scoutable/owner-previewable terrain; space battles need LOGH-style formations (hold the line / flank / 3-group envelopment) and optional SLEWING (F-arc ships trade movement to rotate guns on target, big hulls pay more, 360 mounts at full speed) as a start-screen option.
  ✅ ALL FIXED (ENGINE_VERSION 0.23.0):
  - 🔕 ignore per leader offer (Empires tab): auto-play rolls on, badge goes
    quiet, offer stays hireable until expiry (committed fc47703).
  - Ground: groundTactics.ts — fixed 12x8 terrain per planet (climate-
    weighted; ridge/craters on rocky worlds, urban at the colony), 8 attack
    tactics vs 4 doctrines through an RPS matrix + terrain-fit modifiers;
    set_ground_tactic doctrine per colony (map panel, with 🗺 terrain preview
    for owners and anyone with a ship at the star); attacker tactic on the
    invade order (battle-orders dialog); GroundBattleDialog is now a top-down
    theater map: NATO battalion boxes, tactic arrows, terrain legend, fallen-
    battalion markers. Absent tactics = byte-exact legacy invasions.
  - Space: battle_orders formation line/flank/pincer/envelop — heavies hold
    the wall while fast wings swing wide (one seeded coin for flank side);
    slewing as a lobby option (default off): F-arc ships spend movement per
    extra 11.25° step (cost scales with hull turn rate — frigates slew nearly
    free, titans pay half their move), 360-only ships never need it; both
    carried on BattleInput so replays re-sim exactly; battle lab got a fleet-
    plan dropdown per side + slewing toggle; bots pick flank/envelop with big
    fleets and form a line when defending orbital works.

Round 5 (same day): battle backdrops with the contested planet + galaxy-style pixel art; bombardment feels too strong (check guides, cap pop/building losses by fleet size); deterministic monster clears (12 frigates / 6 destroyers / 3 cruisers / 2 battleships / 1 titan = auto-win, bots plan with it); a visual tech tree on the research page; attackers/defenders choose the engagement planet so the right star base and batteries fight.
  ✅ ALL FIXED (ENGINE_VERSION 0.22.0):
  - Battles play over stippled pixel nebulae + 1px stars with the engaged
    world looming behind the defender's edge (battle/backdrop.ts).
  - Audit: mechanics/*.md has no numeric bombard rule; the real issue was
    uncapped mounts×ammo scaling. Per-turn caps by hull weight (fr1/de2/cr4/
    bb6/ti12/ds24): strong ≥12 ≤3 pop+1 bldg; medium 6-11 ≤2+1; small <6
    ≤1 pop, 25%-gated bldg (battles.ts, bombard-math tests).
  - Monster lairs auto-clear at ≥12 total hull weight, zero losses, normal
    loot/event path; Guardian/Antarans excluded; both bot brains muster
    minimal 12-weight detachments (tests/unit/npc.test.ts).
  - Research screen: full visual tech tree — 8 subject ladders, past picks
    ✓'d, current glowing with target, available/queued/locked color-coded,
    queue buttons on every future node (toggleable, remembered).
  - Battle orders: attacker assaults a chosen colony (only ITS base/batteries
    fight, it takes the barrage) or fights in deep space (no colony guns, no
    bombard — blockade only); defender auto-defends an assaulted colony, or
    chooses meet-the-fleet vs hold-at-colony when unassaulted (hold drags the
    fight under its guns). Absent choice = byte-exact legacy for old replays.
    Bots assault the weakest-defended colony (tests/unit/engagement.test.ts).

Round 2 (same day): the interface should look more of a bright gray device having texturing with dark green backgrounds like a transparent oled screen that has a green tint and is displaying data. Right now it's too muted. Also we definitely want the colorful-style galaxy pixel art like in the example image of the map view.
  ✅ FIXED: theme.css now has a two-layer system — DEVICE tokens (bright
  textured gray: --device-hi/mid/lo/edge + an inline SVG noise texture) used
  by buttons, table-header rails, and the game shell's header/footer bezels,
  and SCREEN tokens (green-tinted dark glass panels, --screen-glass inner
  glow, green-washed body/section backgrounds) for everything displaying
  data. Active nav tabs read as lit panes of the screen. makeGalaxyBackground
  was rewritten to render at 1/5 resolution with saturated spiral arms, a
  bright core, and green/violet/magenta/ember/teal nebula clusters, upscaled
  with image-rendering:pixelated for the chunky look of bugs/galaxy_compact.png.

Sometimes when I click the farmer to drag them instead it selects the farmers (same with worker or scientist icons). I need to focus on clicking without moving to get them selected. I'd like that a simple drag selects everything to the right and doesn't highlight the emojis.  This is a major slowdown in play.
  ✅ FIXED (Spreadsheet.svelte): citizen emojis are user-select:none so a drag can
  never sweep-highlight them; a drag from icon i always carries i + everyone to
  its right with no click needed; a gesture that became a drag no longer toggles
  the click-selection; drags cancelled outside a valid cell clean up after
  themselves (dragend).
We also need to have a count of number of enemy ships detected on scanners. Players can look at this count (0) to know they are not missing out on dangerous situations early in game without checking maps.
  ✅ FIXED: new engine selector detectedEnemyShips (same visibility rule the map
  uses) + a 📡 count in the top bar (data-testid="enemy-detected"), red when >0,
  with an explanatory tooltip. Unit-locked in tests/unit/detectedships.test.ts.
Major Reskin
- The game should be called Mantle of Ophion: Battle across Andromeda. Acronym of MOOv2 should be fine most places. We also consider Mantle of Oblivion or Magistrate of Ophidian or Mediators of Omega... so we need it to be a variable somewhere we can change later.
  ✅ FIXED: src/ui/brand.ts is the single source (BRAND.title/subtitle/acronym);
  splash, in-game header and the browser tab all read it. Renaming later is a
  one-file edit.
- The UI doens't look retro enough and it's too blue. I think it should look more grayish more like the images in bugs/*.png
  can you please spend effort making the UI look more like this including the pixelated inconic worlds that show up instead of writing "Desert rich high-g s4" It needs to have all the functionality of the current one of course.
  ✅ FIXED: full retro pass — monospace terminal type, uppercase chrome, black
  background, gray panels, green phosphor accents, subtle CRT scanlines; ~220
  hardcoded blues/navies swapped for theme tokens. New PixelPlanet.svelte draws
  deterministic pixel-art worlds per climate; the colonies table shows sprite +
  "Terran Large / Rich" instead of the old text-only cell (full spec still on
  hover), and the map's system panel planet list got sprites too.
- The overall theme should be more gray UI with black background but some green highlights--like an alien GUI --and it should be modular so we can easily change the theming of the game on future iterations without huge rewrites.
  ✅ FIXED: all theme tokens live in src/ui/theme.css (surfaces, type, signals,
  effects, font, radius, scanline strength). Retheme = edit that file or add a
  [data-theme='name'] block; the previous blue look is preserved as
  [data-theme='nebula'] as proof.
Better AI: players complain the computer AI is still too weak. Make sure that they are strengthened
  ✅ FIXED: the tournament-winning OnionAI constraint brain is now the default
  solo opponent (it beat the old default v2 brain 582 vs 502 avg score with zero
  eliminations across the personality round-robin); see bugs/tournament/LOG.md.
Also make sure that the mirror AI mode also is quite difficult since it at least can play catch up if it falls behind due to the mechanics--you can try some battles with the mirror mode AI and ensure it does beat the other AIs (though through cheating). It might be bad to give them whole colonies, but granting them colony ships with escorts that "top up" their fleet relative to the enemies might be reasonable. Then those escorts can fly around and cause havoc.
  ✅ FIXED: in mirror-galaxy games bots now top up when behind — escorts of their
  best design up to the strongest enemy's fleet (solvency-gated and capped so the
  grants don't bankrupt them; naive ungated grants actually LOST — see
  tests/balance/mirror.test.ts header) plus an occasional colony ship when
  behind on colonies. debug_spawn_ships gained an optional shipKind for this.
  Proof harness: MOO2_MIRROR=1 npx vitest run tests/balance/mirror.test.ts —
  catch-up onion beats fair-onion 845 vs 333 and fair-v2 973 vs 514 at t297;
  the seat-0 self-twin regression guard holds at 0.95× (soft gate 0.85).
