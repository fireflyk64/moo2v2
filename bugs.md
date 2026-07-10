- [x] Freighter colonist transfer between stars
  — the drop failed silently because cross-system moves simply didn't exist. Now they do, MOO2-style: dragging colonists to a colony at another star loads them onto freighters (5 per colonist, tied up for the whole trip), takes normal travel time (wormholes 1 turn), respects fuel range, and lands them as workers. In-system stays free and instant. The top bar shows 🚚 free/total freighters (busy convoys reduce food capacity too), and every rejection reason is now surfaced in the note ("needs 10 free freighters (5 per colonist; 3 free)").

- [x] Two fights in the same turn locked the game with no strategy select
  — root cause: the orders dialog was one component instance whose stance/priority state initialized once; when battle B replaced battle A the dialog silently carried A's state and the game sat through the 60s defaults timeout (×2 = "several minutes"). The dialog is now keyed by battle id, so each fight gets a fresh dialog with correct defaults.

- [x] Picks accessible + sorted (race_picks_accessible.html)
  — the lobby's custom-race screen was rebuilt to the mock: category fieldsets (Population/Farming/Industry/Science/Money/Ship Defense/Ship Attack/Ground Combat/Spying) as radio groups with explicit "Normal" options, governments, and alphabetized Special Abilities; every option shows its cost badge and full description on hover/focus (aria-describedby) plus a "Show all descriptions" toggle; live "Picks remaining" status with aria-live; exclusive pairs self-resolve. Also "we need a picks = 14": the host can set the pick budget (10 classic / 14) — flows through validation, the auction, and game start.

- [x] Technologies described — gen-data now carries each application's effect text from the docs into the generated data (`effectSummary`), and the Research screen shows it on hover for every application.

- [x] Cache busting — every build stamps a build id and emits version.json; the running app checks it (5-minute interval + window focus) and shows a "new version deployed — reload" bar when the deployment changed. Assets were already content-hashed.

- [x] No wormholes on the homeworld — generation assigns wormholes after homeworld selection and excludes home systems (mirror mode already couldn't).

- [x] Auto-turn redesigned — the old mode jumped 60 turns at once. Now: turns ALWAYS advance one at a time; the host option is a timer ("30s/60s/2min/5min after all but one commit") that force-advances when a single laggard holds the table, with a live countdown banner. Uncommitting below the threshold disarms it.

- [x] "selected rich world got ultra rich" — two real causes fixed: the Fleets tab's colonize button silently settled the lowest-id planet (it now lists every colonizable planet with its climate/size/minerals), and the map key drew rich and ultra-rich with the same "gold ring" wording (the key now says thin gold = rich, THICK gold = ultra-rich).

- [x] Queued items locked in — picking a queued item in the build column now PROMOTES it to the active slot (no duplicate error), queued items appear in the build dropdown marked "(queued)", and queue entries are chips with ✕ to remove.

- [x] Farmer on barren / farmers below 1 pop / tundra farmer
  — farmers can no longer be assigned where food per farmer is zero (tech-aware: hydroponics etc. re-enable it); the farm cell shows 🚫 and refuses drops. Starvation now stops at the last whole colonist unit — a colony can starve down to 1 pop but never to death (the earlier "no 0-pop colonies" rule still removes sub-unit remnants from other causes). A lone tundra farmer feeds itself.

- [x] Unhelpful spreadsheet hint — replaced with "💡 drag citizens between jobs or onto another colony · ☑ tick rows for bulk builds & presets".

- [x] Monsters protect worthwhile planets — keepers now guard prize systems (ultra-rich / gaia / terran / specials like artifacts) 55% of the time vs 8% for ordinary ones, in both normal and mirror galaxies (tested across seeds).

- [x] Host-offline warning inaccurate — the lobbylink server fires player-left on pure SIGNALING blips while the WebRTC data channel is fine. The banner is now debounced 8 seconds and cancels on rejoin, so it only shows for a host that's really gone.

- [x] Scouts fight — scouts carry one laser cannon on a frigate-class fit: they trigger battles, shoot in the sim, and are no longer sideline bystanders.

- [x] No size-1 planets / planets small / empty stars too common — size weights are now [0,22,34,28,16] (tiny worlds gone, average up half a class) and empty-system weights were slashed (<15% of stars offer nothing, tested).

- [x] Map dots — under each explored star: one dot per planet, gray = uncolonized, player-colored = colonized, × = asteroid belt / gas giant (all with hover titles).

- [x] Free freighters displayed (see the first item) — 🚚 free/total in the top bar with a breakdown tooltip.

- [x] Only participants can watch battles — replays are emitted per participant and the client filters by visibility; spectators no longer receive other people's fleet compositions.

- [x] "1t to arrival takes multiple turns" — a real off-by-one: arrivals were processed before the turn counter advanced, so every trip landed one resolution late. Ships (and freighter convoys) now arrive on the turn boundary their ETA promised.

- [x] Outposts out of the colonies table — they're counted in the footer ("· 2 outposts (map)") but no longer clutter the sheet.

- [x] Fleet help text shows once — dismissible with "got it ✕", remembered.

- [x] MIRV/ECCM two tech layers deeper, point defense one — advanced mods now unlock only when the empire has completed a field 2 levels (PD: 1 level) beyond the weapon's own field in its subject; the Designer shows 🔒 with the reason and the engine rejects violations.

- [x] "saved" dialog sticks around — the save note fades after 6 seconds.

- [x] Retreat as a way to avoid fighting — evade_retreat is selectable from the start; and when a side's escorts withdraw alive, their noncombat ships now fall back WITH them instead of being destroyed (only annihilated escorts doom the convoy).

- [x] MIRV does not increase DPS — it does now: ×4 in the Designer's DPS readout, and in the sim each MIRVed missile splits into four independent warheads (each can be point-defensed, each pays shield flat — like MOO2).

- [x] Range increments from chemistry — audited against the docs: standard 4pc → deuterium 6 → iridium 9 → uridium 12 → thorium unlimited, exactly as mechanics/tech/chemistry.md specifies. The first chem tech genuinely gives +2 parsecs; on a medium map that's big but correct. (Extended Fuel Tanks as a per-ship component remains unmodeled, documented.)

- [x] Leader expiration — offers show "expires turn N — K turns left".

- [x] Can't tell what kind of warship an enemy fleet is — hull classes are now visible at explored/scanned stars: the star panel shows "⚔ enemy fleet: 3× Silicoids cruiser · 1× frigate".

- [x] Doom stars roundish — drawn as a planet-sized sphere with a superlaser dish instead of the biggest dart.

- [x] Stuck in the corner when fleeing — retreating ships now run for the NEAREST of the four edges and exit through any of them (attackers/defenders are no longer funneled to one side).

- [x] Battle simulator armor class — each lab group has an armor selector (titanium ×1 … xentronium ×10), and ships observed in battle import with their armor class inferred from their real hull points.

- [x] Mauler device always hits — weapon rows' built-in behaviors (naturalMods) were being dropped entirely before combat; they now ride along, so the mauler's 'hit' flag forces 100% to-hit (this also gave the starlight projector its built-in mods).

- [x] Overkill spreads — a per-tick damage ledger (including warheads in flight) makes weapons whose target is already dead-on-paper walk the REST of the volley to the next victim; an overwhelming broadside now kills several ships in one pass (tested).

- [x] Starlight projector flashy — a blinding white lance with halo and impact flare.

- [x] Ship died with no visual cause — killing shots are flagged in the replay, drawn thicker and persisting ~4 extra frames, and explosions are much bigger, double-ringed, and last 14 frames — scrubbing the timeline can't miss a kill anymore.

- [x] Assault shuttles and fighter bays in the battle simulator — classId-4 strike craft are implemented: bays launch squadrons that fly to the target (point defense can splash them) and hit with their strategic payload; assault shuttles board and ALWAYS cripple a system (drive/computer/shield). Fighter Bays unlock interceptors + bombers, Heavy Fighter Bays the heavy fighter, all selectable in the lab and on real designs.

- [x] Ships retreating in the sim leave the field and count as survivors (they always did in the result; now they visibly exit via the nearest edge). Real battles relocate retreated ships toward home — verified.

- [x] Telemetry — screen-time aggregates (seconds per tab) ride the command log with each commit, live in the shared state per empire (and therefore in every save file), and the Empires tab shows a "⏱ Time spent per screen (all empires)" table.

- [x] Antarans → Andromedans in every user-facing string (internal ids unchanged for save compatibility).

- [x] Improve the non-cheating AI via self-play until it beats itself
  — done as an actual loop: the fair bot's brain is versioned (v1 = original, kept as the benchmark; v2 = tuned). A headless harness (tests/determinism/selfplay.test.ts) plays full 110-turn wars — both seatings × 3 seeds. Diagnostics drove three iterations: v2 first won research massively (43 vs 26 techs) but under-expanded and built zero warships (2/6 wins); adding a 2-3-ship colony pipeline + one-warship-per-colony fleet doctrine got to 4/6; teaching it to SPEND its treasury (buy colony ships outright, 2:1 on everything else) and to build housing on fully-developed worlds reached 5/6 with clear margins. The test enforces ≥66% v2 wins forever, plus a v2-vs-v2 stability game.

---
Verification (2026-07-10): `npm test` 331 passed (52 files; new suites: movecolonists cross-star, autoturn timer, galaxygen guards/sizes/wormholes, zeropop/starvation-floor, scouts, modgate, combatfixes, telemetry, selfplay), `npm run test:game` 9 passed (incl. AI self-play), `MOO2_BALANCE=1` envelope, `svelte-check` 0 errors, `npm run build`, Playwright 8/8. ENGINE_VERSION 0.5.0 → 0.6.0 (behavioral changes: arrival timing, pop transits, starvation floor, armed scouts, combat mechanics, monster placement) — old saves load snapshot-first per the compatibility contract, enforced by the golden fixture.
