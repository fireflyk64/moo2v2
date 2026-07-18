# UI streamlining — where a real game's hours actually went, and the fix plan

Source: the two saves in `bugs/` are the SAME campaign (room 314, seed
`d7c4e932…`, human "FO1" vs one parity bot, medium galaxy, war from the
opening) captured twice: `monster_test_moo2v2-314.moo2save` at turn 105 and
`moo2v2-314-turn204.moo2save` at turn 204. The engine logs per-screen dwell
seconds + visit counts with every commit (`record_telemetry`, flushed in
GameShell.svelte, accumulated in `empire.telemetry`), so the saves carry a
complete click-by-click time budget. Companion doc: `ui_speedup_ideas.md`
(multiplayer pacing); this one is single-player ergonomics, driven by data.

## Headline numbers

- **3h51m of screen time for 204 turns (~69 s/turn) — and the human was
  losing** (9 colonies vs the bot's 12 at t201). The ⚡ Blitz preset targets a
  ~30-minute *game*; this session spent 4× that on UI alone.
- Time is savagely front-loaded: **turns 1–30 cost 1h43m — 45% of the whole
  session** (the t20–30 snapshot window alone is 47 minutes). First half
  (t1–105): 161m ≈ 92 s/turn. Second half (t106–204): 70m ≈ 42 s/turn.
- The second-half halving shows the existing tools (map hotkeys, governor
  sweeps, quick builds) work once discovered — the problem is the opening
  and the screens those tools don't cover.

## Screen ranking (turn-204 cumulative; Δ = second-half share)

| screen | time | share | visits | s/visit | second half |
|---|---|---|---|---|---|
| **colonies** (Spreadsheet.svelte) | 122m18s | **53%** | 127 | 58s | +31m51s — still #1 |
| map (MapView.svelte) | 40m04s | 17% | 57 | 42s | +22m43s — grows with war |
| research | 28m46s | 13% | 52 | 33s | +4m12s |
| empires | 20m13s | 9% | 22 | 55s | +4m31s |
| designer | 16m18s | 7% | 9 | **109s** | +4m08s |
| fleets | 3m12s | 1% | 27 | 7s | +2m18s — effectively solved |

Command mix (human, 201 turns): `set_jobs`×558, `set_build_queue`×150,
`move_ships`×58, `buy_production`×45, `battle_orders`×34, `set_research`×26,
`load_transports`×**0** (see friction A). The `set_jobs` per-turn histogram
splits cleanly: steady 8–9/turn late (governor sweeps, autopilot on) vs
manual bursts early (t8=15) and mid-crisis (t135=**45 job edits in one
turn**, the session's worst turn at 53 commands).

## Findings, worst first

1. **The colonies spreadsheet is half the game.** 53% of all time, 58s per
   visit, 127 visits. Three separate costs stack: (a) the opening — every
   new colony needs jobs + a build decision, by hand, and turns 20–30 burned
   32 minutes on this screen; (b) job micro — 558 `set_jobs`, with manual
   rebalancing sprees like t135; (c) queue decisions — 150 `set_build_queue`
   with no template/defaults, so every completion pulls the player back in.
2. **The opening is a wall.** 45% of session time before turn 30 is a
   new-player filter and a veteran tax. Everything the governor/bot already
   knows (factory→lab→farm order, preset jobs) is re-derived by hand.
3. **Half the research visits found nothing to do.** 52 visits for 26
   actual picks at 33 s/visit — the tab pulls you in (pulse badge, curiosity)
   when there is no decision pending. The ⏭ research queue (shipped 0.18)
   went unused in this game — `research.extraQueue` stayed empty; it isn't
   discoverable at the moment of choosing.
4. **Designer visits are 109-second stares.** Every tech wave triggers a
   redesign session (t60–70 window: 9m23s in one stretch). The engine
   already maintains latest-tech auto designs (0.12.0, used by map
   quick-build) — the Designer just doesn't offer them as a starting point.
5. **Empires-tab visits run 55s** for what should be glances: leader offers
   (modal-ish decisions buried in a tab), the spy panel (broken, friction B),
   and the stats tables all share one long page.
6. **What already works, keep leaning on it:** the fleets tab is nearly
   obsolete (7 s/visit — map L/U/C/O hotkeys won); governor sweeps halve
   late-game per-turn cost; map-view quick builds moved shipbuilding out of
   the spreadsheet.

## The three reported frictions, root-caused

### A. "I don't know how to invade. I have troop transports parked in orbit."

Invasion works (S10, `src/engine/ground.ts:39`): **loaded** transports
(2 troops each) that sit at an enemy **colony** star with **no defending
warships** auto-land and resolve ground combat. The save shows the player
never got a single `load_transports` accepted in 201 turns of war — the
transports orbited empty, and nothing in the UI says why nothing happens.
Discoverability failures: the only affordances are an L hotkey on the map
and a Fleets-tab button, both labelled as *colonist* moves ("👥 To move
colonists…", "🚛 2 colonists aboard"); the word **invade** appears nowhere;
an empty transport at an enemy star gives zero feedback about the three
preconditions (loaded? colony not outpost? sky cleared?).

**Fix plan**
- Star panel, enemy colony selected while at war: an **🪖 Invade** status
  block that lists the checklist live: `troops aboard 0/2 — load marines at
  your colony (L)` · `defenders in orbit: 3 — clear them first` · `ready:
  landing resolves next turn`. Render the same block on any selected
  transport fleet.
- Rename the actions by context: at your own colony with a war on, `L` reads
  "load marines (invasion)"; the load toast says `🪖 2 marines aboard — drop
  them on an enemy colony with a clear sky`.
- Fleets-tab copy and the in-game help panel get an "Invading" three-liner.
- Reports: when war starts (and when a transport first parks at an enemy
  star unloaded), emit a one-time hint report linking the checklist.

### B. "Agent sabotage does not stick — it keeps resetting to defense."

The engine never reset anything: the log's only two spy orders (t171, t183)
both **sent `mode:"steal"`**, and `empires[0].spies.target` stayed locked on
the bot from t171 to end-of-game. The reset is a UI illusion —
`Empires.svelte:169` keeps `spyTarget`/`spyMode` as local component state
initialized to `null`/`'steal'`, never synced from `me.spies`. Every tab
remount shows "all defensive / steal technology" regardless of the real
orders, so the player (a) believes the orders reset, and (b) when re-applying
after touching only one dropdown, submits the other dropdown's stale default
— which is exactly how a sabotage order became two steal orders. Bonus traps
in the same panel: mode is silently meaningless while target is null, and
"Set orders" with 0 agents (the count was 0 for ~190 of 204 turns) does
nothing without saying so.

**Fix plan**
- Derive the two selects from `me.spies` (`$derived` + explicit dirty
  tracking), submit on change, and delete the Apply button.
- Disable the mode select while target is null; show a live effect line:
  `3 agents · sabotage vs Bot · ~22%/agent/turn, 25% exposure` (the formula
  is in `espionage.ts:78` — surfacing it also explains *why* nothing
  happened with 0 agents: `no agents — build spies from the colony list`).
- Engine-side hygiene (small, replay-safe): `resolveEspionage` silently
  nulls the target when the target is unmet/eliminated
  (`espionage.ts:66-76`); emit a visible event when that happens so a real
  reset is never mysterious.

### C. "The bot changes stuff you've already made… Building a colony ship? No way: infra first, build that barracks."

That's the slider governor, and the report is accurate. Protection against
exactly this exists but only covers **map-hotkey quick builds**: GameShell
passes the quick-build pin set into `governColonies`
(GameShell.svelte:53-64), and pinned colonies are untouchable
(governor.ts:147-151). A queue the player edits **on the colonies screen**
gets no pin, so two governor rules bulldoze it: the stall rule
(governor.ts:185-195) re-decides any head with `turnsLeft > 30` — a
hand-queued colony ship on a modest yard qualifies instantly — and the
chosen replacement is submitted as `items: [item]`
(governor.ts:246-248), **wiping the whole hand-built queue**, not just the
head. The barracks specifically: replacement infra comes from `BUILD_ORDER`
with cheapest-first fallback for anything unlisted (governor.ts:199-206);
`marine_barracks` is unlisted and cheap, so it wins ties on poor worlds.

**Fix plan**
- Pin on intent, not on entry point: any `set_build_queue` issued by an
  actual UI interaction (spreadsheet dropdown, star panel, quick build)
  marks that colony player-owned until the queued items complete or the
  player clears them — same lifecycle the quick-build pins already have.
  (Implementation: route player queue edits through one helper that records
  `colonyId → remaining player items`; the governor already accepts the set.)
- Governor never *shrinks* a queue: when it does re-decide an unpinned
  colony, it may replace only the head it disagrees with and must re-append
  the player's tail (`items: [item, ...playerTail]`).
- Make its actions legible: a per-turn collapsible report line "🤖 governor:
  Kholdan → automated_factory (was idle), Rilke → trade goods (debt)". An
  invisible manager reads as a hostile one.

## The plan, ranked by payoff ÷ cost

Each item is rule-preserving (client-issued ordinary commands only), in the
spirit of `ui_speedup_ideas.md`. Targets refer to the telemetry the game
already records, so every item is measurable against future saves.

**P1 — Founding defaults (kills opening grind, part 1).** A new colony
auto-applies a job preset (`selectors.presetJobs` industry) and a build
template (colony_base if available → factory → lab, i.e. `BUILD_ORDER`
head) as ordinary logged commands, shown as a dismissible "auto-set ✕"
chip. The veteran keeps typing; the opening stops requiring 9 screens of
setup. *Target: turns 1–30 ≤ 30 min (from 103m).*

**P2 — One-click job presets on every spreadsheet row (kills job micro).**
Buttons `farm/industry/blend/research ±sci` per row and an "all colonies:
rebalance" header button — the governor's job pass without surrendering the
queue. 558 `set_jobs` should collapse to dozens. *Target: manual `set_jobs`
< 1/turn average; no more 45-edit turns.*

**P3 — End-turn review popover (kills empty visits).** Extend the commit
button's idle-research warning into the full "3 things need you" list from
`ui_speedup_ideas.md` #6: idle labs, empty queues, arrived colony ships,
unordered scouts, invasion-ready transports (ties into friction A). Clicking
an item deep-links to the spot. The research tab's pulse badge moves here,
so research is visited when a pick exists. *Target: research visits ≈
research picks (was 2×), colonies visits ↓ ~30%.*

**P4 — Governor trust fixes (friction C).** Pin player queues, append-only
re-decides, governor action report. *Target: zero player-queued items
replaced; autopilot adoption earlier in campaigns.*

**P5 — Invasion checklist UI (friction A).** Star-panel/fleet 🪖 block,
contextual labels, help + one-time hint. *Target: war games issue
`load_transports` > 0 without reading the source; first invasion before
turn 150.*

**P6 — Spy panel truthfulness (friction B).** State-derived controls,
submit-on-change, effect/odds line, reset events. *Target: spy orders in
saves match the modes players report choosing; sabotage orders actually
appear in logs.*

**P7 — Designer quick-refresh (109s/visit → glance).** "⟳ Update all
designs to latest tech" using the engine's maintained auto-designs, with a
per-design diff (`+battle_pods, laser→fusion`) and obsolete-toggle in one
row; full editor stays for connoisseurs. *Target: ≤ 45 s/visit.*

**P8 — Empires tab split.** Leader offers become their own toast/inline
accept (they already badge the tab; answering shouldn't cost a 55s page
visit); stats/graphs/agents get sub-tabs so a glance is a glance. *Target:
≤ 25 s/visit.*

**P9 — Keep the telemetry honest.** The dwell/visit instrumentation made
this analysis possible; extend it with `visits:` on the review popover and
governor-report opens so P1–P8 are verifiable from any future save. Add a
tiny `scripts/ui-telemetry.mjs` (decode save → this doc's tables) so the
next pass is one command.

## Acceptance snapshot (re-run on the next full campaign save)

- ≤ 35 s/turn averaged over a full game (was 69); opening 30 turns ≤ 30 min.
- Colonies ≤ 35% share (was 53%); designer ≤ 45 s/visit (was 109).
- Research visits ≈ picks; fleets stays ≤ 10 s/visit.
- ≥ 1 invasion attempted in any war game; spy logs contain the mode the
  player chose; zero governor overwrites of player queues.
