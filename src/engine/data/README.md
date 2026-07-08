# Engine static data

`generated.ts` is produced by `node scripts/gen-data.mjs` from the tables in
`mechanics/` (numeric parameter data: ids, costs, stats). `node scripts/gen-data.mjs
--check` verifies it is current; a test runs this. `index.ts` is the hand-curated
layer: types, lookups, stock-race presets, exclusivity rules, and `DATA_VERSION`.

## Canonical identity decisions

1. **String ids are the canonical join key** across techs, applications, buildables,
   and weapons. The source docs' numeric `tech_id`s conflict (see anomalies) and are
   kept only as reference metadata.
2. **`APPLICATION_ROWS` (from `mechanics/tech/technology_effects.md`) is authoritative
   for tech-tree structure**: which researchable items exist and which field contains
   them. It mirrors the game's actual tree. `TECH_ROWS`' `fieldNum` values disagree
   with it for ~30 rows; the generator emits warnings listing them, and we always use
   the application placement.
3. Display-name variants are normalized via alias maps in `scripts/gen-data.mjs`
   (e.g. `research_laboratory` → `research_lab`, `battle_station` → `battlestation`,
   `planetary_stock_exchange` → `stock_exchange`, `habitat_transformation` →
   `gaia_transformation`).

## Documented data fix-ups (applied by the generator)

- **tech_id 24 duplicate**: the source assigns 24 to both `battle_scanner` and
  `battleoids`. `battle_scanner` keeps 24; `battleoids` is reassigned synthetic 224.
- **tech_id 10 duplicate**: assigned to both `android_scientists` (part of the
  consecutive 9/10/11 android trio) and `anti_matter_bomb`; the bomb moves to
  synthetic 225.
- **tech_id 0 placeholders** (`spacetime_surfing`, monster weapons): kept as 0,
  meaning "no public number".
- **Numeric id conflicts kept as-is** (string ids are canonical anyway):
  43 = `cyber_security_link` (tech table) vs `core_waste_dump` (buildables);
  72 = `fusion_drive` (tech table) vs `galactic_cybernet` (buildables).
- **Source typo**: field "Multi-Dimensiomal Physics" → `multi_dimensional_physics`.
- **"Starlight Projector" name collision** in the source: the weapon-table row
  (tech 47, 50–100 damage) and the Temporal-Physics planet-destroyer prose describe
  different things. We keep the weapon row as `starlight_projector` and treat the
  planet-destroyer as `stellar_converter` (its own row). Do not merge them.

## Known tech-table rows with no researchable application (37)

These are starting items (`capitol`, `spies`, `housing`, `trade_goods`,
`marine_barracks` — see `unresearchable.md`), Orion/Antaran unresearchables
(`xentronium_armor`, `damper_field`, `black_hole_generator`, `particle_beam`,
`space_time_crystal`, `spacetime_surfing`), hyper-advanced repeatable fields
(`hyper_advanced_*`, modeled as synthetic applications in the curated layer),
monster/`super_swarm`-style specials, and a handful of rows whose researchable
identity is folded into another application's effect (battle suits into armors,
`interceptor_bays` into `fighter_bays`, etc.). Run `node scripts/gen-data.mjs`
to see the current list; treat additions as regressions.

## Field-subject derivation

Fields carry no subject column; subjects are derived by walking each subject's
`next`-chain from its root (`engineering`, `nuclear_fission`, `chemistry`,
`military_tactics`, `electronics`, `astro_ecology`, `physics`,
`advanced_magnetism`). Every field is reached exactly once; `xenon_technology`
(self-referential row 74, the Orion/Antaran pool) is assigned subject `special`.

## Formula decision log (decide → document → golden-lock)

Entries land here as gap formulas (🔍 in PLAN.md) get sourced and implemented.

All sources consulted for *functional rules only* (numbers/formulas re-expressed in our
own words); no source prose is copied. SW-Calc = strategywiki.org MOO2 "Calculations"
page (checked against game v1.31); SW-Feed = its "Feeding your people" page; Blog-MaxPop
= masteroforion2.blogspot.com "Maximum Population"; Book-Mapgen = moo2mod.com/doc/game/mapgen.html.

| # | Topic | Decision | Source | Locked by |
|---|---|---|---|---|
| F1 | Population growth | per race-group: `inc_k = floor(sqrt(2000·c·free/cap))`, then `floor(inc_k·(100+race±50/100+medicine+housing)%)` + 100k if growth center, − food-lack penalty (50k/lack; cybernetic 25k food + 25k prod). Housing bonus % = `floor(PP·40/colonists)`. | SW-Calc | economy tests |
| F2 | Colony output | `P = P_const + round(P_base + P_bonus)`; `P_base = Σ colonists·coeff` (coeff = planet + race + tech + buildings); `P_bonus = C_total%·P_base − colonist penalties − pollution`. C_total: morale (unification ignores, +50% farm/prod; democracy +50% research; feudal −50% research) + leader. Colonist penalties: conquered 25%, wrong gravity 25%/50%, blockade 50% farm/prod. | SW-Calc | economy tests |
| F3 | Food/farmer by climate | non-aquatic: 0 = hostile/energized/barren; 1 = desert/arid/tundra; 2 = swamp/ocean/terran; 3 = gaia. Aquatic: tundra/swamp = 2, ocean/terran/gaia = 3. | SW-Feed | economy tests |
| F4 | Production/worker by minerals | ultra_poor 1, poor 2, abundant 3, rich 5, ultra_rich 8. | SW-Calc + community consensus | economy tests |
| F5 | Research/scientist | base 3. | community consensus | economy tests |
| F6 | Max population | `size_mult(5/10/15/20/25 tiny→huge) × climate%`: hostile/energized/barren/desert/tundra/ocean 25%, swamp 40%, arid 60%, terran 80%, gaia 100%. Aquatic: ocean/terran→100%, tundra/swamp→80%. Tolerant: +25pp except terran/gaia (→100%). Subterranean: +2·sizeClass flat. Round half-up. | Blog-MaxPop | economy tests |
| F7 | Money | `income = special + round(pop·(1+raceBC)) + Σ floor((special+popInc)·coeff)` for spaceport .5 / stock exchange 1 / currency exchange .5 / democracy .5, `+ round(popInc·morale%)` + leader − `round(maint·climateCoeff)` (hostile +50%, energized/desert +25%). **No tax slider exists** — resolves the "tax" gap. | SW-Calc | economy tests |
| F8 | Pollution | `ceil((prodFromWorkers/divisor·leaderCoeff·tolerantFraction − sizeAbsorb)/2)`, divisor 1/2/4/8 (none/processor/renewer/both), sizeAbsorb 2·sizeClass (nano disassemblers double), flat building production exempt, core waste dump ⇒ 0, negatives ⇒ 0. Subtracted from production. | SW-Calc | economy tests |
| F9 | Buy cost | remaining-based piecewise: done<10%: `4X−10Y`; 10–50%: `3.5X−5Y` (we use `floor((7X−10Y)/2)`); ≥50%: `2(X−Y)`. No buy same turn as completion-by-buy; disallow housing/trade goods. | SW-Calc | economy tests |
| F10 | Morale | additive %: −20 feudal/dictatorship (and advanced forms) without marine/armor barracks; +20 holo simulator; +30 pleasure dome; +20 VR network (empire-wide); +10 civic insight (dict/imperium). Applied via C_total (F2) and money (F7). Unification immune. | SW-Feed + racepicks.md | economy tests |
| F11 | Star counts | small 20, medium 36, large 54, huge 71. | Book-Mapgen | galaxy tests |
| F12 | Trade goods / housing | trade goods: colony production converts to BC at 2 PP → 1 BC (fantastic traders 1:1). Housing: production feeds F1's housing bonus. | community consensus (marked tunable) | economy tests |
| F13 | Star colors / planet rolls | weighted tables in `galaxy.ts` marked TUNABLE defaults (source page incomplete); structure supports swapping classic/fan-patch odds per mechanics §03. | Book-Mapgen (partial) | galaxy golden tests |
| F14 | Gravity penalty | per-colonist −25% one step off race preference, −50% two steps (low-G race on high-G); high-G races never penalized; gravity generator clears it; applies to farm/prod/research per-colonist output. | SW-Calc (+ community) | economy tests |
| C* | Combat redesign rules | components/speeds/to-hit per C1-C6 in `shipdesign.ts` header; COMBAT_PACE=250 tuned by `tests/balance`; CP overage −10 BC/pt; bombardment 20 dmg = 1 pop unit (60/40 pop/building split, floor 1 pop). Combat is exempt from classic fidelity (prompt.md). | our design | combat + balance tests |
| L1 | Leader skill magnitudes | per skill: base × level (levels 1–5), starred/enhanced skills 2× base. Bases in `data/leaders.ts` `SKILL_BASE` (farming/labor/science +3%/lvl, financial +5%/lvl, spiritual +3 morale/lvl, medicine +5% growth/lvl, environmentalist +2 absorb/lvl, megawealth +5 BC/lvl, researcher +3 RP/lvl, operations +2 CP/lvl, weaponry/helmsman +5/lvl, ordnance +10% max dmg/lvl, tactics +5% speed/lvl, trader +25% treaty/lvl, diplomat +5% council weight/lvl, spy master +10/lvl, telepath +5/lvl + fast assimilation, assassin 10%/lvl, famous 10% discount + 2% offer/lvl, navigator +1 pc per 2 lvl (per lvl enhanced), instructor +1 XP/lvl best-only, engineer repair-anywhere). Classic magnitudes unpublished in our sources — these are ours. | our design (mechanics/leaders.md lists skills only) | leaders tests |
| L2 | Leader classification | rank decides: Admiral/Commander/Captain/Commodore = ship officer (fleet-wide bonuses, no assignment); civil ranks = colony leader (assigned to one colony). | our design | leaders tests |
| L3 | Hiring economics | points = Σ(enhanced?2:1); hire = 50+25·points BC (Famous −10%/lvl cap 50, charismatic −25, floor 10); salary = points BC/turn; broke ⇒ highest-salary leader quits. Max 4 colony + 4 ship leaders. | our design | leaders tests |
| L4 | Offers & XP | offer chance 4%/turn with open slot (+2%/famous lvl, +4 charismatic, ×0.5 repulsive), TTL 5 turns; XP +1/turn (+best instructor, +1 any space academy); level thresholds 30/90/180/300 XP. | our design | leaders tests |
