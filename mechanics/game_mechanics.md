<!-- FILE: 00_model_context_brief.md -->

# 00 - Model Context Brief

## Goal

Build a rules-complete, data-driven 4X strategy game inspired by the mechanics of Master of Orion II. The implementation should separate:

- Immutable data: races, picks, tech fields, techs, hulls, weapons, buildings, costs, and flags.
- Simulation state: galaxy map, colonies, fleets, leaders, diplomacy, technologies known, ship designs, and queues.
- Presentation layer: UI, art, audio, names, and text. Replace protected expression with original work unless licensed.

## High-level game identity

The game is a turn-based space empire simulation. Each player controls a race/empire, expands from a starting system, colonizes planets, researches technology, builds fleets, designs warships, interacts diplomatically, and fights tactical or strategic battles.

Core loop per turn:

1. Player/AI issues orders.
2. Colonies allocate population and production.
3. Research points are applied.
4. Build queues complete items.
5. Fleets move, arrive, blockade, intercept, and trigger battles.
6. Diplomacy, espionage, random events, leaders, monsters, and special systems resolve.
7. UI/state refreshes for the next turn.

## Data-driven implementation pattern

Use JSON/YAML/CSV/SQLite tables for all balance data. Every table should include a stable `id`, display-key, rules fields, prerequisites, and patch/mod profile. Use deterministic tests for:

- Build completion and overflow.
- Research unlock options for Creative, Uncreative, and standard races.
- Colony output under race picks, buildings, morale, gravity, pollution, and leaders.
- Tactical combat damage order, to-hit, range penalties, shield/armor interaction, and special effects.
- AI ship-design choices and colonization priorities.

## Scope boundary

A model can use this pack to draft a system design and code, but not to copy protected assets or proprietary implementation. A pixel-perfect or byte-perfect implementation requires an empirical conformance suite against the original and legal permission for protected material.


## Safe terminology overlay

Use the safe naming overlay in `11_safe_terminology_overlay.md` when generating prompts, code, schemas, or documentation. The overlay preserves numeric ids and mechanics while replacing high-sensitivity labels with neutral Ecology, Better Living, Tech Detox, Habitat, and Stellar Safety terminology.

<!-- FILE: 01_game_loop_and_systems.md -->

# 01 - Game Loop and Systems

## Primary objects

### Game

Fields:

- `turn_number`
- `galaxy_settings`: galaxy size, age, difficulty, number of opponents, tactical/strategic combat preference, random events setting, starting tech level.
- `players`: list of player empires.
- `star_systems`: map nodes with coordinates, star type, planets, specials, monsters, wormholes, and owner visibility state.
- `fleets`: mobile groups of ships, transports, outposts, colony ships, monsters, and special entities.
- `diplomacy_state`: bilateral relations, treaties, wars, demands, gifts, threats, tribute, spying incidents.
- `event_queue`: random events, Antarans, monsters, leader offers, council votes, discoveries.

### Empire

Fields:

- `race_template` or `custom_race_definition`.
- `known_techs`, `researchable_fields`, `current_research_field`.
- `colonies`, `fleets`, `ship_designs`.
- `treasury_bc`, `command_points`, `food_pool`, `research_pool`.
- `contacts`, `treaties`, `espionage_allocations`.
- `leaders`: colony leaders and ship officers.
- `score_components`.

### Star system

Fields:

- `name_key` or generated name.
- `x`, `y` galactic coordinates.
- `star_class`.
- `planets`: ordered orbit list.
- `special`: monster, artifact, splinter colony, Orion, wormhole, nebula/stellar-hazard if supported.
- `visibility_by_empire`: unknown, scanned star, planet info, colony info, fleet info.

### Colony

Fields:

- `planet_id`, `owner_empire_id`, `population`, `farmers`, `workers`, `scientists`.
- `marines`, `morale`, `pollution`, `waste`, `food_surplus`, `production_surplus`.
- `buildings`, `build_queue`, `active_project`.
- `leader_id`, `blockaded`, `unrest`, `assimilation_state`.

### Ship design

Fields:

- `hull_type`.
- `armor_type`, `shield_type`, `drive_type`, `computer_type`, `special_systems`.
- `weapons`: weapon id, count, arc, mount/mods, ammo, bay allocation.
- `space_used`, `cost`, `command_point_usage`, `strategic_values`.

### Tactical ship instance

Fields:

- `design_id`, `hull_hp`, `armor_hp_by_facing` if modeled, `structure_hp`, `shield_hp`, `system_hp`.
- `current_speed`, `position`, `facing`, `initiative`, `ammo_remaining`, `cooldowns`.
- `status_effects`: stasis, tractor, boarding, web, retreat, captured, disabled.

## Turn phases

Recommended deterministic phase ordering:

1. Load pending player commands.
2. Resolve colony population growth, starvation, and migration/assimilation.
3. Resolve food, industry, science, BC income, maintenance, command points, pollution.
4. Advance build queues and research.
5. Spawn completed ships/buildings/units.
6. Move fleets by drive speed and range; resolve range/outpost constraints.
7. Trigger encounters: enemy fleets, monsters, colonies, blockades, invasions.
8. Resolve tactical/strategic combat.
9. Resolve bombardment, ground combat, colony capture/destruction.
10. Resolve diplomacy, espionage, leader offers, random events, Antarans.
11. Check victory/loss conditions.
12. Save state and notify players.

## Resource model

Main empire-wide or colony-level resources:

- Food: generated mainly by farmers and certain buildings/traits. Consumed by population.
- Production: generated by workers, factories, minerals, and buildings. Used for build queues.
- Research: generated by scientists, labs, artifacts, leaders, and picks. Used for tech fields.
- BC/money: generated by taxes/trade/buildings/traits. Used for maintenance, buying, spying, tribute, and fleet support.
- Command points: cap for supported warships. Shortfall usually creates BC maintenance pressure.
- Population: the master limiting resource for colony output.

## Command points and range/scanning constants

Public parameter data exposes the following classic defaults.

### Command point sources

| Source | Command points |
|---|---:|
| Colony | 1 |
| Star base | 2 |
| Battlestation | 4 |
| Star fortress | 6 |
| Warlord pick bonus | 2 |
| Tachyon communications bonus | 1 |

### Ship command point usage by hull

| Hull | CP usage |
|---|---:|
| Frigate | 1 |
| Destroyer | 1 |
| Cruiser | 2 |
| Battleship | 4 |
| Titan | 6 |
| Doomstar | 12 |

### Ship communication and range

| Item | Value |
|---|---:|
| Ships outside communication range before automatic return | 5 parsecs |
| Distance at which ships are considered out of range | 10 parsecs |

### Scanning bonuses

| Source | Scan bonus |
|---|---:|
| Normal scanner | 2 |
| Neutron scanner | 5 |
| Tachyon scanner | 7 |
| Scout lab | 2 |
| Sensor cluster | 2 |

### Stealth bonuses

| Source | Stealth bonus |
|---|---:|
| Stealth armor | 10 |
| Sub space teleporter | 10 |
| Phasing cloak | 10 |
| Stealthy Ships race pick | 10 |

## Victory conditions to implement

- Conquest: all other empires eliminated or subjugated.
- Galactic council victory: periodic vote, thresholds and alliance behavior to verify.
- Antaran/Orion special victory path: if implemented, gate by special system conquest and final encounter rules.
- Score/time end: optional depending on scenario mode.

## Save-game determinism recommendations

- Store RNG seed and stream position per subsystem: map generation, AI, combat, diplomacy, random events.
- Store all data-table version hashes in the save file.
- Make every end-turn phase replayable from a command log.
- Add regression snapshots for colony output, tech choices, combat outcomes, AI design generation, and diplomacy state.

<!-- FILE: 02_races_and_picks.md -->

# 02 - Races and Picks

## Race creation overview

Classic race creation uses a pick-budget system. Standard custom races start with a positive-pick budget, positive traits spend that budget, and negative traits add budget. The public 1.50 parameter data exposes classic values for maximum positive picks, maximum negative picks, and the adaptive upgrade bonus.

| Parameter | Classic value |
|---|---:|
| Maximum positive custom race picks | 10 |
| Maximum negative picks | -10 |
| Adaptive upgrade added picks | 4 |

## Race pick data

The following table uses public parameter identifiers. `value` is the numeric modifier stored with that pick where applicable. For government or boolean traits, cost alone is usually the important value.

| Pick id | Cost | Value / modifier | Implementation meaning |
|---|---:|---:|---|
| growth1 | -4 | -50 | Population growth penalty tier. |
| growth2 | 3 | 50 | Population growth bonus tier. |
| growth3 | 6 | 100 | Higher population growth bonus tier. |
| farming1 | -3 | -1 | Farming output penalty. |
| farming2 | 4 | 2 | Farming output bonus. |
| farming3 | 7 | 4 | Higher farming output bonus. |
| industry1 | -3 | -1 | Industry output penalty. |
| industry2 | 3 | 1 | Industry output bonus. |
| industry3 | 6 | 2 | Higher industry output bonus. |
| science1 | -3 | -1 | Research output penalty. |
| science2 | 3 | 1 | Research output bonus. |
| science3 | 6 | 2 | Higher research output bonus. |
| money1 | -4 | -1 | BC/income penalty. |
| money2 | 5 | 1 | BC/income bonus. |
| money3 | 8 | 2 | Higher BC/income bonus. |
| defense1 | -2 | -20 | Ship defense penalty. |
| defense2 | 3 | 25 | Ship defense bonus. |
| defense3 | 7 | 50 | Higher ship defense bonus. |
| attack1 | -2 | -20 | Ship attack penalty. |
| attack2 | 2 | 20 | Ship attack bonus. |
| attack3 | 4 | 50 | Higher ship attack bonus. |
| ground1 | -2 | -10 | Ground combat penalty. |
| ground2 | 2 | 10 | Ground combat bonus. |
| ground3 | 4 | 20 | Higher ground combat bonus. |
| spying1 | -3 | -10 | Spying penalty. |
| spying2 | 3 | 10 | Spying bonus. |
| spying3 | 6 | 20 | Higher spying bonus. |
| feudal | -4 | n/a | Government: Feudal. |
| dictatorship | 0 | n/a | Government: Dictatorship. |
| democracy | 7 | n/a | Government: Democracy. |
| unification | 6 | n/a | Government: Unification. |
| lowg_world | -5 | n/a | Homeworld gravity trait: low-G. |
| highg_world | 6 | n/a | Homeworld gravity trait: high-G. |
| aquatic | 5 | n/a | Aquatic habitability/population trait. |
| subterranean | 6 | n/a | Increased planet population capacity. |
| large_hw | 1 | n/a | Larger homeworld. |
| rich_hw | 2 | n/a | Richer homeworld minerals. |
| poor_hw | -1 | n/a | Poor homeworld minerals. |
| arti_world | 3 | n/a | Artifact homeworld. |
| cybernetic | 4 | n/a | Cybernetic food/production upkeep model. |
| lithovore | 10 | n/a | Population does not need normal food. |
| repulsive | -6 | n/a | Severe diplomacy/trade limitation. |
| charismatic | 3 | n/a | Diplomacy/trade bonus. |
| uncreative | -4 | n/a | Research selection penalty; random tech in field. |
| creative | 8 | n/a | Research all techs in a field instead of choosing one. |
| tolerant | 10 | n/a | Pollution/habitat/environmental tolerance bonus. |
| fantastic_traders | 4 | n/a | Trade/income advantage. |
| telepathic | 6 | n/a | Special diplomacy/conquest mechanics; verify exact conquest behavior. |
| lucky | 3 | n/a | Random-event advantage. |
| omniscient | 3 | n/a | Galaxy visibility/scouting advantage. |
| stealthy_ships | 4 | n/a | Fleet stealth bonus. |
| trans_dimensional | 5 | n/a | Movement/combat mobility bonus. |
| warlord | 4 | n/a | Command/crew/combat advantage; includes CP bonus in parameter table. |
| out_of_box_thinking | 2 | n/a | Out-of-the-Box Thinking: may buy skipped technologies from already-completed fields with research points (requires the matching game option). |

## Research pick behavior

Implement three research-choice behaviors:

- Standard: when a technology field is completed, choose one technology from that field.
- Creative: receive all technologies in the completed field.
- Uncreative: receive one randomly selected technology from the completed field.

## Government types

Minimum implementation distinctions:

- Feudal: lower pick cost; should affect research/production/diplomacy according to verified formulas.
- Dictatorship: neutral baseline government.
- Democracy: high-cost government, typically stronger economy/research and diplomacy/trade; cannot use some coercive features if modeling them.
- Unification: high-cost government, typically morale/production stable and strong internal control.

Implementation recommendation: encode government as a modifier bundle, not as hard-coded conditionals.

```yaml
government:
  id: democracy
  pick_cost: 7
  modifiers:
    research_percent: TBD_verify
    bc_percent: TBD_verify
    morale: TBD_verify
    diplomacy_bias: TBD_verify
```

## Stock races

The public parameter page contains stock-race definitions with identifiers such as Alkari, Bulrathi, Darlok, Elerian, Gnolam, Human, Klackon, Mrrshan, Psilon, Sakkra, Silicoid, Trilarians, Meklar, and custom slots. For a lawfully renamed successor, treat stock races as presets made from the same pick table and provide original names/art/lore.

Recommended preset schema:

```yaml
race_preset:
  id: original_species_01
  archetype: defensive_pilots
  government: dictatorship
  picks:
    ship_defense: +50
    artifact_homeworld: true
  homeworld:
    gravity: normal
    size: medium
    minerals: average
  ai_personality:
    expansion: high
    aggression: medium
    diplomacy: medium
```

## Race validation rules

- Exactly one government unless a scenario explicitly overrides it.
- Mutually exclusive tiers: only one of growth1/growth2/growth3, one of farming tiers, and so on.
- Mutually exclusive homeworld mineral/size/gravity tiers.
- Custom race cost sum must remain within positive and negative caps.
- Creative and Uncreative are mutually exclusive.
- Charismatic and Repulsive are mutually exclusive.
- Ensure UI displays the current budget and final score multiplier if score modifiers are implemented.

<!-- FILE: 03_galaxy_planets_mapgen.md -->

# 03 - Galaxy, Planets, and Map Generation

## Galaxy setup inputs

Expose these settings:

- Galaxy size: small, medium, large, huge. Each setting controls star count and map dimensions.
- Galaxy age: affects star/planet mineral richness, habitability, and distribution.
- Number of opponents.
- Difficulty.
- Tactical combat enabled/disabled.
- Random events enabled/disabled.
- Starting technology level: pre-warp, average, advanced.
- Race selection/custom race.

## Star system schema

```yaml
star_system:
  id: system_0001
  name_key: generated_or_original_name
  x: 123
  y: 456
  star_class: yellow
  special: null
  planets:
    - orbit: 1
      body_type: planet
      size: medium
      climate: terran
      mineral_richness: abundant
      gravity: normal
      max_population: 12
      owner: null
      colony: null
```

## Planet attributes

Recommended fields:

- `orbit_index`
- `body_type`: planet, asteroid_belt, gas_giant, empty.
- `size`: tiny, small, medium, large, huge.
- `climate`: hostile, energized, barren, desert, tundra, ocean, swamp, arid, terran, gaia, etc. Verify exact climate ladder for final conformance.
- `mineral_richness`: ultra_poor, poor, average, abundant, rich, ultra_rich.
- `gravity`: low_g, normal_g, high_g.
- `special`: artifacts, gold/gems, natives, splinter colony, monsters, Orion, wormhole, etc.
- `max_population_base` and modifiers from climate, size, race picks, subterranean, aquatic, habitat_domes, terraforming, and gaia transformation.
- `pollution_absorption` / environmental tolerance.

## Colonization

Core checks:

1. Player has a colony ship/outpost ship/transport as applicable.
2. Destination is within range or has intermediate support.
3. Planet is colonizable and not blocked by enemy fleet/monster unless battle is resolved.
4. Apply race-habitat rules for gravity/climate and population cap.
5. Initialize colony with starting population, morale, buildings, marines, and production queue.

## Outposts

Implement outposts as support nodes that extend range and visibility but do not function as full colonies unless upgraded/colonized.

Outpost schema:

```yaml
outpost:
  system_id: system_0032
  owner: empire_1
  range_extension: data_table_value
  scan_bonus: data_table_value
  maintenance_bc: data_table_value
```

## Planet transformation chain

Minimum mechanics:

- Terraforming improves climate/population cap by discrete steps.
- Soil enrichment improves farming/food on suitable planets.
- Atmospheric renewal improves hostile environments.
- Gaia transformation is late-game and high cost.
- Artificial planet converts asteroid belts under the correct tech/building rules.

Use the building/buildable costs in `04_colonies_buildings_units.md` and tech unlocks in `05_research_tech_tree.md`.

## Map generation conformance checklist

For exactness testing, create fixed-seed tests for:

- Star count per galaxy size.
- Coordinate distribution and minimum distances.
- Star-class distribution per galaxy age.
- Number of orbits per star.
- Planet climate/size/mineral/gravity generation.
- Homeworld generation overrides.
- Special systems and monsters.
- Orion placement if implemented.
- Wormhole pairing if implemented.

A production replica should be data-driven enough to swap between classic defaults, fan-patch defaults, and original-new balance sets.

<!-- FILE: 04_colonies_buildings_units.md -->

# 04 - Colonies, Buildings, and Buildables

## Colony production loop

A colony converts population assignments into food, production, and research. Buildings, race picks, leaders, planet minerals, gravity, climate, pollution, morale, and government then modify the raw output.

Recommended order:

1. Determine effective population and job assignment.
2. Apply gravity/climate/population restrictions.
3. Compute raw farmer/worker/scientist output.
4. Apply race pick modifiers.
5. Apply building and leader modifiers.
6. Compute pollution/waste and environmental cleanup.
7. Apply production to build queue.
8. Apply food surplus/deficit to population growth or starvation.
9. Apply research points to current tech field.
10. Apply BC income, maintenance, and command-point overage costs.

## Buildable products table

Columns:

- `id`: public parameter id.
- `tech_id`: technology id that unlocks the item, where provided.
- `cost`: production cost.
- `maintenance`: BC maintenance per turn.
- `group`: category used by build lists and UI filters.

| id | tech_id | cost | maintenance | group |
|---|---:|---:|---:|---|
| marine_barracks | 107 | 60 | 1 | government |
| hydroponic_farm | 86 | 60 | 2 | food |
| habitat_domes | 27 | 60 | 1 | food |
| habitat_dome_terraforming | 27 | 50 | 0 | special |
| population_growth_center | 37 | 100 | 2 | special |
| soil_enrichment | 162 | 150 | 2 | food |
| soil_enrichment_terraforming | 162 | 50 | 0 | special |
| subterranean_farms | 172 | 120 | 4 | food |
| weather_controller | 199 | 200 | 3 | food |
| artificial_planet | 16 | 500 | 0 | special |
| deep_core_mine | 45 | 250 | 3 | production |
| core_waste_dump | 43 | 200 | 8 | production |
| astro_university | 18 | 250 | 4 | science |
| research_lab | 152 | 60 | 1 | science |
| supercomputer | 178 | 150 | 2 | science |
| autolab | 19 | 250 | 3 | science |
| galactic_cybernet | 72 | 1000 | 0 | special |
| alien_management_center | 8 | 120 | 1 | economy |
| space_academy | 164 | 100 | 1 | government |
| galactic_currency_exchange | 73 | 250 | 5 | economy |
| star_base | 167 | 400 | 2 | defense |
| battle_station | 22 | 1000 | 3 | defense |
| star_fortress | 169 | 2500 | 4 | defense |
| missile_base | 109 | 200 | 2 | defense |
| ground_batteries | 81 | 250 | 2 | defense |
| fighter_garrison | 61 | 150 | 2 | defense |
| stellar_safety_shield | 150 | 80 | 1 | defense |
| flux_shield | 68 | 300 | 3 | defense |
| planetary_stellar_safety_shield | 150 | 250 | 2 | defense |
| planetary_flux_shield | 68 | 750 | 5 | defense |
| planetary_barrier_shield | 129 | 500 | 3 | defense |
| android_workers | 11 | 120 | 0 | special |
| android_farmers | 9 | 120 | 0 | special |
| android_scientists | 10 | 120 | 0 | special |
| automated_factory | 20 | 60 | 1 | production |
| robo_miner_plant | 155 | 200 | 3 | production |
| nanite_factory | 113 | 300 | 2 | production |
| colony_base | 39 | 200 | 0 | ship |
| colony_ship | 40 | 500 | 0 | ship |
| outpost_ship | 122 | 100 | 0 | ship |
| transport | 191 | 100 | 0 | ship |
| freighter_fleet | 69 | 100 | 0 | ship |
| spy | 166 | 50 | 0 | special |
| trade_goods | 187 | 50 | 0 | special |
| housing | 85 | 0 | 0 | special |
| capitol | 34 | 200 | 0 | government |
| pleasure_dome | 134 | 250 | 3 | government |
| holo_simulator | 84 | 120 | 1 | government |
| virtual_reality_network | 196 | 250 | 3 | government |
| super_swarm | 177 | 0 | 0 | special |
| spacetime_surfing | 0 | 0 | 0 | special |
| re_population | 0 | 0 | 0 | special |
| barrier | 0 | 0 | 0 | special |
| stock_exchange | 173 | 200 | 2 | economy |
| telepathic_training | 183 | 0 | 0 | special |
| food_replicators | 64 | 250 | 10 | food |
| gravity_generator | 77 | 120 | 2 | special |
| dimensional_portal | 53 | 500 | 5 | economy |
| atmospheric_renewer | 21 | 100 | 3 | production |
| warp_interdictor | 198 | 300 | 4 | defense |
| microlite_construction | 108 | 0 | 0 | special |
| adaptive_habitat_lattice | 29 | 0 | 0 | special |
| capitol_1 | 34 | 0 | 0 | government |
| capitol_2 | 34 | 0 | 0 | government |
| capitol_3 | 34 | 0 | 0 | government |
| capitol_4 | 34 | 0 | 0 | government |
| capitol_5 | 34 | 0 | 0 | government |
| marine_barracks_splinter | 107 | 0 | 0 | government |
| armor_barracks_splinter | 0 | 0 | 0 | government |

## Lander and ship production costs

| Buildable | Cost |
|---|---:|
| Colonization lander | 100 |
| Outpost lander | 100 |
| Frigate hull in colony queue | 20 |
| Destroyer hull in colony queue | 70 |
| Cruiser hull in colony queue | 250 |
| Battleship hull in colony queue | 600 |
| Titan hull in colony queue | 1500 |
| Doomstar hull in colony queue | 4000 |

## Miscellaneous costs

| Item | Cost |
|---|---:|
| Freighter | 100 |
| Spy | 50 |
| Housing | 0 |
| Trade goods | 50 |

## Building-effect implementation notes

Because costs and groups are table-driven, effects should be stored separately as composable modifiers.

Example schema:

```yaml
building_effect:
  building_id: automated_factory
  modifiers:
    production_flat: TBD_verify
    pollution_flat_or_percent: TBD_verify
  flags:
    unique_per_colony: true
```

Recommended effect categories:

- Food flat/percent: hydroponic_farm, habitat_domes, soil_enrichment, subterranean_farms, weather_controller, food_replicators.
- Production flat/percent: automated_factory, robo_miner_plant, nanite_factory, deep_core_mine, core_waste_dump.
- Science flat/percent: research_lab, supercomputer, autolab, astro_university.
- Economy: stock_exchange, galactic_currency_exchange, dimensional_portal, alien_management_center.
- Morale/government: marine_barracks, holo_simulator, pleasure_dome, virtual_reality_network, capitol.
- Defense: missile_base, fighter_garrison, ground_batteries, star_base, battle_station, star_fortress, warp_interdictor, stellar-safety/flux/barrier shields.
- Planet transformation: habitat_dome_terraforming, soil_enrichment_terraforming, artificial_planet, gravity_generator, atmospheric_renewer, gaia_transformation if represented as a special project.
- Units/ships: colony_base, colony_ship, outpost_ship, transport, freighter_fleet, spy.

## Queue and buyout mechanics

To implement:

- One active build item per colony plus a queue.
- Production overflow behavior after completion.
- BC buyout cost curve and restrictions.
- Auto-build governors if modeling them.
- Obsolete building replacement, if any.
- Captured colony building retention/destruction rules.

## Colony capture and assimilation

Minimum model:

- Resolve orbital battle first.
- Bombardment may destroy population, marines, buildings, and planetary defenses.
- Transports/ground forces invade.
- Ground combat uses race ground modifiers, marines, armor barracks if present, leaders, tech, and defensive buildings.
- Captured population may assimilate over time depending on government/race mechanics.

<!-- FILE: 05_research_tech_tree.md -->

# 05 - Research and Technology Tree

## Research model

Technology is organized into eight subjects with field levels. A normal race usually chooses one technology from a completed field. Creative races receive all technologies in the field. Uncreative races receive a random technology from the field.

Recommended subject ids:

- Engineering / Construction
- Power
- Chemistry
- Sociology
- Computers
- Ecology
- Physics
- Force Fields

## Starting tech fields

Public parameter data indicates these starting field ids:

| Start mode | Known field ids |
|---|---|
| Pre-warp | 29, 28, 55, 57, 22 |
| Average | 4, 56, 23, 31, 9, 10, 18, 7 |

**Implementation note (this variant).** Pre-warp completes ONLY Engineering
(field 29), not the table's five: colony base, star base and marine barracks
are buildable from turn 1, and everything else — electronic computer, lasers,
drives, fuel cells, armor, bombs, missiles, colony ships — is researched from
scratch. That puts exactly the classic eight fields on a pre-warp game's
first research screen, at their listed prices:

| RP | Field | Grants |
|---|---|---|
| 80 | Advanced Engineering | anti-missile rockets, fighter bays, reinforced hull |
| 50 | Nuclear Fission | nuclear drive, nuclear bomb |
| 50 | Chemistry | nuclear missile, standard fuel cells, extended fuel tanks, titanium armor |
| 150 | Military Tactics | space academy |
| 50 | Electronics | electronic computer |
| 80 | Astro Ecology | hydroponic farm, habitat domes |
| 50 | Physics | laser cannon, laser rifle, space scanner |
| 250 | Advanced Magnetism | class I shield, mass driver, ECM jammer |

**Implementation note (this variant), Average/Advanced.** The table's Average
row is kept as reference data only. Average (and Advanced) complete the five
tier-1 roots (29, 28, 55, 57, 22) plus Cold Fusion (23) — the classic MOO2
normal opening: electronic computer, nuclear drive, lasers, standard fuel
cells, titanium armor, and colony/outpost/transport ships + freighters are
known from turn 1; Optronics is NOT pre-researched. That puts exactly the
classic eight fields on an average game's first research screen:

| RP | Field | Grants |
|---|---|---|
| 80 | Advanced Engineering | anti-missile rockets, fighter bays, reinforced hull |
| 250 | Advanced Fusion | fusion drive, fusion bomb, augmented engines |
| 250 | Advanced Metallurgy | deuterium fuel cells, tritanium armor |
| 150 | Military Tactics | space academy |
| 150 | Optronics | research lab, optronic computer, dauntless guidance system |
| 80 | Astro Ecology | hydroponic farm, habitat domes |
| 150 | Fusion Physics | fusion beam, fusion rifle |
| 250 | Advanced Magnetism | class I shield, mass driver, ECM jammer |

(One deliberate data difference vs. classic MOO2: freighters live in Cold
Fusion here — with the colony/outpost/transport ships — not in Nuclear
Fission.) Ships still fly and can be designed before those techs land because
the nuclear drive, standard fuel cells (4 pc range) and titanium armor are
hardcoded baselines (`movement.ts`, `shipdesign.ts`) and every empire keeps a
pre-built starter frigate. That starter "Patrol Frigate" is the one deliberate
knowledge exception: it mounts 2 laser cannons before physics is researched
(the pre-built kit skips the weapon-knowledge gate) — new player designs
cannot take lasers, a targeting computer, or any other unresearched component.
Average/advanced are unchanged and still begin with the five tier-1 roots
above: they reuse field ids 29,28,55,57,22 as a *data* lookup to build their
superset of the engineering-only pre-warp mode grant. Default start mode is
**average** (the MOO2 normal opening: two scouts + a colony ship; pre-warp
gets one scout and no colony ship). The homeworld starts with a marine
barracks AND a star base in every non-advanced mode — including pre-warp
(improvements.md: "The original planet starts with a starbase even in
pre-warp").

**Research discovery lines (improvements.md).** Every listed cost above is
what the research screen shows, but a field is actually *discovered* somewhere
past it: the real completion point is uniform on (listed, 2 × listed],
seeded per game and per field — the SAME hidden line for every empire, so
nobody gets a private discount. The UI never reveals the line; instead, as
soon as next turn's research could reach it (accumulated RP + RP/turn >
listed cost), the screen shows the exact "% chance to discover" — e.g. 138
RP spent on a 150-RP field at +15/turn overshoots the listed 150 by 3 of the
150 possible line positions: "(2% chance to discover)". Before that point the
screen estimates "~N turns" against the expected line (≈1.5 × listed: a fresh
50-RP field at 12 RP/turn reads "~7 turns"). Leftover RP past the line
carries into the next field.

## Technology field table

Columns:

- `id`: field identifier.
- `row`: public field number.
- `previous`: prerequisite field id, 0 if root or special.
- `next`: next field id in sequence, 0 if terminal.
- `cost`: research point cost.
- `tier`: UI/AI tier number.

| id | row | previous | next | cost | tier |
|---|---:|---:|---:|---:|---:|
| advanced_ecology | 1 | 18 | 34 | 400 | 5 |
| advanced_chemistry | 2 | 9 | 47 | 650 | 6 |
| advanced_construction | 3 | 4 | 21 | 150 | 3 |
| advanced_engineering | 4 | 29 | 3 | 80 | 2 |
| advanced_fusion | 5 | 23 | 41 | 250 | 4 |
| advanced_governments | 6 | 12 | 32 | 4500 | 13 |
| advanced_magnetism | 7 | 0 | 36 | 250 | 4 |
| advanced_manufacturing | 8 | 19 | 11 | 1500 | 9 |
| advanced_metallurgy | 9 | 22 | 2 | 250 | 4 |
| military_tactics | 10 | 0 | 73 | 150 | 3 |
| advanced_robotics | 11 | 8 | 67 | 2000 | 10 |
| teaching_methods | 12 | 43 | 6 | 2000 | 10 |
| anti_matter_fission | 13 | 41 | 46 | 2000 | 10 |
| artificial_consciousness | 14 | 60 | 25 | 1500 | 9 |
| artificial_intelligence | 15 | 56 | 60 | 400 | 5 |
| artificial_gravity | 16 | 54 | 65 | 1150 | 8 |
| synthetic_ecosystems | 17 | 30 | 70 | 4500 | 13 |
| astro_ecology | 18 | 0 | 1 | 80 | 2 |
| astro_construction | 19 | 63 | 8 | 1150 | 8 |
| astro_engineering | 20 | 21 | 62 | 400 | 5 |
| capsule_construction | 21 | 3 | 20 | 250 | 4 |
| chemistry | 22 | 0 | 9 | 50 | 1 |
| cold_fusion | 23 | 55 | 5 | 80 | 2 |
| cybertechnics | 24 | 25 | 33 | 3500 | 12 |
| cybertronics | 25 | 14 | 24 | 2750 | 11 |
| distortion_fields | 26 | 64 | 61 | 3500 | 12 |
| electromagnetic_refraction | 27 | 45 | 72 | 1500 | 9 |
| electronics | 28 | 0 | 56 | 50 | 1 |
| engineering | 29 | 0 | 4 | 50 | 1 |
| evolutionary_adaptation | 30 | 44 | 17 | 2750 | 11 |
| fusion_physics | 31 | 57 | 66 | 150 | 3 |
| galactic_economics | 32 | 6 | 82 | 6000 | 14 |
| galactic_networking | 33 | 24 | 49 | 4500 | 13 |
| trait_adaptation | 34 | 1 | 35 | 900 | 7 |
| trait_variations | 35 | 34 | 44 | 1150 | 8 |
| gravitic_fields | 36 | 7 | 45 | 650 | 6 |
| high_energy_distribution | 37 | 46 | 38 | 3500 | 12 |
| hyper_dimensional_fission | 38 | 37 | 40 | 4500 | 13 |
| hyper_dimensional_physics | 39 | 51 | 69 | 6000 | 14 |
| interphased_fission | 40 | 38 | 76 | 10000 | 16 |
| ion_fission | 41 | 5 | 13 | 900 | 7 |
| superscalar_construction | 42 | 67 | 58 | 6000 | 14 |
| macro_economics | 43 | 73 | 12 | 1150 | 8 |
| macro_adaptation | 44 | 35 | 30 | 1500 | 9 |
| magneto_gravitics | 45 | 36 | 27 | 900 | 7 |
| matter_energy_conversion | 46 | 13 | 37 | 2750 | 11 |
| molecular_compression | 47 | 2 | 53 | 1150 | 8 |
| molecular_control | 48 | 50 | 80 | 10000 | 16 |
| moleculartronics | 49 | 33 | 81 | 6000 | 14 |
| molecular_manipulation | 50 | 53 | 48 | 4500 | 13 |
| multi_dimensional_physics | 51 | 59 | 39 | 4500 | 13 |
| multi_phased_physics | 52 | 65 | 59 | 2000 | 10 |
| nano_technology | 53 | 47 | 50 | 2000 | 10 |
| neutrino_physics | 54 | 66 | 16 | 900 | 7 |
| nuclear_fission | 55 | 0 | 23 | 50 | 1 |
| optronics | 56 | 28 | 15 | 150 | 3 |
| physics | 57 | 0 | 31 | 50 | 1 |
| planetoid_construction | 58 | 42 | 78 | 7500 | 15 |
| plasma_physics | 59 | 52 | 51 | 3500 | 12 |
| positronics | 60 | 15 | 14 | 900 | 7 |
| quantum_fields | 61 | 26 | 71 | 4500 | 13 |
| robotics | 62 | 20 | 63 | 650 | 6 |
| servo_mechanics | 63 | 62 | 19 | 900 | 7 |
| subspace_fields | 64 | 72 | 26 | 2750 | 11 |
| subspace_physics | 65 | 16 | 52 | 1500 | 9 |
| tachyon_physics | 66 | 31 | 54 | 250 | 4 |
| tectonic_engineering | 67 | 11 | 42 | 3500 | 12 |
| temporal_fields | 68 | 71 | 79 | 15000 | 17 |
| temporal_physics | 69 | 39 | 77 | 15000 | 17 |
| trans_adaptation | 70 | 17 | 75 | 7500 | 15 |
| transwarp_fields | 71 | 61 | 68 | 7500 | 15 |
| warp_fields | 72 | 27 | 64 | 2000 | 10 |
| xeno_relations | 73 | 10 | 43 | 650 | 6 |
| xenon_technology | 74 | 74 | 74 | 15000 | 22 |
| advf_ecology | 75 | 70 | 0 | 25000 | 18 |
| advf_power | 76 | 40 | 0 | 25000 | 18 |
| advf_physics | 77 | 69 | 0 | 25000 | 18 |
| advf_construction | 78 | 58 | 0 | 25000 | 18 |
| advf_fields | 79 | 68 | 0 | 25000 | 18 |
| advf_chemistry | 80 | 48 | 0 | 25000 | 18 |
| advf_computers | 81 | 49 | 0 | 25000 | 18 |
| advf_sociology | 82 | 32 | 0 | 25000 | 18 |

## Technology table

Columns:

- `id`: technology identifier.
- `tech_id`: public technology number.
- `field_id`: technology field number.
- `ai_group`: public AI group id. Use a separate lookup for group meanings.
- `strategic`: whether the item is flagged for strategic use in the parameter table.

| id | tech_id | field_id | ai_group | strategic |
|---|---:|---:|---:|---:|
| alien_management_center | 8 | 73 | 1 | 0 |
| anti_matter_bomb | 10 | 46 | 7 | 1 |
| android_farmers | 9 | 25 | 2 | 1 |
| android_scientists | 10 | 25 | 2 | 1 |
| android_workers | 11 | 25 | 2 | 1 |
| anti_matter_torpedo | 12 | 46 | 7 | 1 |
| anti_missile_rocket | 13 | 31 | 7 | 1 |
| anti_grav_harness | 14 | 16 | 6 | 1 |
| achilles_targeting_unit | 15 | 39 | 6 | 1 |
| artificial_planet_construction | 16 | 58 | 2 | 1 |
| assault_shuttle | 17 | 63 | 7 | 1 |
| astro_university | 18 | 73 | 5 | 0 |
| autolab | 19 | 33 | 5 | 0 |
| automated_factory | 20 | 3 | 2 | 0 |
| atmospheric_renewer | 21 | 2 | 2 | 0 |
| battle_pods | 22 | 45 | 6 | 1 |
| battlestation | 23 | 20 | 7 | 0 |
| battle_scanner | 24 | 28 | 6 | 1 |
| class_i_shield | 25 | 7 | 7 | 1 |
| class_iii_shield | 26 | 36 | 7 | 1 |
| habitat_domes | 27 | 18 | 4 | 0 |
| better_living_cascade | 28 | 70 | 7 | 1 |
| adaptive_habitat_lattice | 29 | 80 | 4 | 0 |
| black_hole_generator | 30 | 68 | 7 | 1 |
| bomber_bays | 31 | 54 | 7 | 1 |
| capitol | 34 | 29 | 1 | 0 |
| class_v_shield | 35 | 45 | 7 | 1 |
| class_vii_shield | 36 | 64 | 7 | 1 |
| class_x_shield | 37 | 61 | 7 | 1 |
| population_growth_center | 38 | 34 | 4 | 0 |
| colony_base | 39 | 29 | 3 | 0 |
| colony_ship | 40 | 29 | 3 | 0 |
| cruiser | 42 | 21 | 7 | 0 |
| cyber_security_link | 43 | 33 | 1 | 0 |
| cybertronic_computer | 44 | 24 | 6 | 1 |
| deep_core_mine | 45 | 67 | 2 | 0 |
| starlight_projector | 47 | 74 | 7 | 1 |
| tech_detox_pods | 48 | 35 | 7 | 1 |
| deuterium_fuel_cells | 49 | 23 | 3 | 1 |
| doom_star_construction | 50 | 58 | 7 | 0 |
| cruiser_class_shield | 51 | 37 | 7 | 1 |
| damper_field | 52 | 71 | 7 | 1 |
| dimensional_portal | 53 | 26 | 1 | 0 |
| disruptor_cannon | 54 | 48 | 7 | 1 |
| displacement_device | 55 | 51 | 7 | 1 |
| electronic_computer | 56 | 28 | 6 | 1 |
| emissions_guidance_system | 57 | 72 | 7 | 1 |
| fast_missile_racks | 58 | 72 | 7 | 1 |
| fighter_bays | 59 | 31 | 7 | 1 |
| neutronium_armor | 60 | 50 | 6 | 1 |
| fighter_garrison | 61 | 54 | 7 | 0 |
| fire_control_center | 62 | 64 | 6 | 1 |
| fleet_support_base | 63 | 7 | 1 | 0 |
| food_replicators | 64 | 46 | 4 | 0 |
| freighters | 69 | 29 | 3 | 0 |
| fusion_beam | 70 | 31 | 7 | 1 |
| fusion_bomb | 71 | 5 | 7 | 1 |
| fusion_drive | 72 | 5 | 3 | 1 |
| galactic_currency_exchange | 73 | 32 | 1 | 0 |
| gauss_cannon | 78 | 9 | 7 | 1 |
| graviton_beam | 79 | 36 | 7 | 1 |
| gyro_destabilizer | 80 | 16 | 7 | 1 |
| ground_batteries | 81 | 27 | 7 | 0 |
| hard_shields | 82 | 39 | 7 | 1 |
| heavy_fighter_bays | 83 | 54 | 7 | 1 |
| holo_simulator | 84 | 73 | 1 | 0 |
| housing | 85 | 29 | 4 | 0 |
| hydroponic_farm | 86 | 18 | 4 | 0 |
| hyper_drive | 87 | 69 | 3 | 1 |
| hyper_x_capacitors | 88 | 69 | 7 | 1 |
| inertia_nullifier | 89 | 51 | 6 | 1 |
| inertial_stabilizer | 90 | 27 | 6 | 1 |
| interceptor_bays | 91 | 31 | 7 | 1 |
| ion_drive | 92 | 41 | 3 | 1 |
| iridium_fuel_cells | 93 | 41 | 3 | 1 |
| jump_gate | 94 | 64 | 3 | 0 |
| space_scanner | 95 | 29 | 3 | 0 |
| neutron_scanner | 96 | 60 | 3 | 1 |
| ion_pulse_cannon | 97 | 45 | 7 | 1 |
| plasma_scanner | 98 | 60 | 3 | 1 |
| tachyon_scanner | 99 | 66 | 3 | 1 |
| laser_cannon | 100 | 28 | 7 | 1 |
| laser_rifle | 101 | 28 | 6 | 0 |
| lightning_field | 102 | 51 | 7 | 1 |
| mauler_device | 105 | 68 | 7 | 1 |
| merculite_missiles | 106 | 22 | 7 | 1 |
| marine_barracks | 107 | 29 | 1 | 0 |
| mass_driver | 104 | 22 | 7 | 1 |
| microlite_construction | 108 | 78 | 2 | 0 |
| missile_base | 109 | 22 | 7 | 0 |
| multi_phased_shields | 110 | 61 | 7 | 1 |
| multi_wave_ecm_jammer | 111 | 65 | 7 | 1 |
| neutron_blaster | 115 | 34 | 7 | 1 |
| nano_disassemblers | 116 | 53 | 6 | 1 |
| neutronium_bomb | 118 | 50 | 7 | 1 |
| neutronium_battle_suit | 117 | 50 | 6 | 0 |
| nuclear_bomb | 119 | 55 | 7 | 1 |
| nuclear_drive | 120 | 55 | 3 | 1 |
| nuclear_missile | 121 | 55 | 7 | 1 |
| outpost_ship | 122 | 29 | 3 | 0 |
| particle_beam | 123 | 59 | 7 | 1 |
| neutron_pellet_gun | 114 | 1 | 6 | 0 |
| battleoids | 24 | 67 | 6 | 0 |
| personal_shield | 126 | 7 | 6 | 0 |
| phasors | 127 | 52 | 7 | 1 |
| phasing_cloak | 128 | 39 | 6 | 1 |
| planetary_barrier_shield | 129 | 26 | 7 | 0 |
| planetary_flux_shield | 130 | 68 | 7 | 0 |
| planetary_gravity_generator | 131 | 16 | 2 | 0 |
| planetary_stellar_safety_shield | 132 | 2 | 7 | 0 |
| plasma_cannon | 137 | 59 | 7 | 1 |
| plasma_rifle | 138 | 59 | 6 | 0 |
| plasma_torpedoes | 139 | 66 | 7 | 1 |
| plasma_web | 140 | 72 | 7 | 1 |
| pollution_processor | 141 | 19 | 2 | 0 |
| positronic_computer | 142 | 60 | 6 | 1 |
| proton_torpedoes | 146 | 54 | 7 | 1 |
| pulson_missiles | 149 | 47 | 7 | 1 |
| stellar_safety_shield | 150 | 2 | 7 | 0 |
| reinforced_hull | 151 | 29 | 6 | 1 |
| research_lab | 152 | 28 | 5 | 0 |
| robominers | 155 | 62 | 2 | 0 |
| scout_lab | 156 | 18 | 5 | 0 |
| sensor_cluster | 157 | 37 | 6 | 1 |
| shield_capacitor | 158 | 39 | 6 | 1 |
| shield_piercing | 159 | 65 | 7 | 1 |
| space_academy | 164 | 10 | 6 | 0 |
| space_port | 163 | 43 | 1 | 0 |
| space_time_crystal | 161 | 74 | 3 | 1 |
| soil_enrichment | 162 | 1 | 4 | 0 |
| spacetime_surfing | 0 | 77 | 3 | 1 |
| spatial_compressor | 165 | 16 | 7 | 1 |
| spies | 166 | 28 | 1 | 0 |
| star_base | 167 | 29 | 7 | 0 |
| star_fortress | 169 | 42 | 7 | 0 |
| stealth_field | 170 | 26 | 6 | 1 |
| stasis_field | 171 | 71 | 7 | 1 |
| stock_exchange | 173 | 6 | 1 | 0 |
| stellar_converter | 174 | 40 | 7 | 1 |
| neutronium_fighter_garrison | 175 | 69 | 7 | 1 |
| neutronium_fighters | 176 | 69 | 7 | 1 |
| supercomputer | 178 | 56 | 5 | 0 |
| superscalar_construction | 179 | 42 | 2 | 1 |
| transporters | 180 | 45 | 6 | 1 |
| structural_analyzer | 181 | 65 | 6 | 1 |
| sub_space_teleporter | 182 | 26 | 6 | 1 |
| telepathic_training | 183 | 75 | 6 | 0 |
| terraforming | 184 | 1 | 4 | 0 |
| thorium_fuel_cells | 185 | 38 | 3 | 1 |
| titan_construction | 186 | 8 | 7 | 0 |
| trade_goods | 187 | 29 | 1 | 0 |
| tractor_beam | 188 | 45 | 6 | 1 |
| tritanium_armor | 189 | 9 | 6 | 1 |
| tritanium_battle_suit | 190 | 9 | 6 | 0 |
| transport | 191 | 29 | 3 | 0 |
| universal_antidote | 192 | 70 | 6 | 0 |
| uridium_fuel_cells | 193 | 13 | 3 | 1 |
| virtual_reality_network | 196 | 43 | 1 | 0 |
| warp_dissipater | 197 | 52 | 7 | 1 |
| warp_interdictor | 198 | 72 | 7 | 0 |
| weather_controller | 199 | 30 | 4 | 0 |
| wide_area_jammer | 200 | 52 | 7 | 1 |
| xentronium_armor | 201 | 74 | 6 | 1 |
| zeon_missile | 202 | 53 | 7 | 1 |
| hyper_advanced_ecology | 203 | 75 | 4 | 0 |
| hyper_advanced_power | 204 | 76 | 3 | 1 |
| hyper_advanced_physics | 205 | 77 | 6 | 1 |
| hyper_advanced_construction | 206 | 78 | 2 | 1 |
| hyper_advanced_force_fields | 207 | 79 | 7 | 1 |
| hyper_advanced_chemistry | 208 | 80 | 6 | 1 |
| hyper_advanced_computers | 209 | 81 | 5 | 1 |
| hyper_advanced_sociology | 210 | 82 | 1 | 0 |
| gaia_transformation | 211 | 17 | 4 | 0 |

## Unlock implementation

Each tech row should map to one or more effects:

```yaml
technology:
  id: automated_factory
  field_id: 3
  unlocks:
    buildings: [automated_factory]
  strategic: false
```

For weapon and ship-component techs, unlock effects should reference the ship designer data tables:

```yaml
technology:
  id: plasma_cannon
  unlocks:
    weapons: [plasma_cannon]
```

## Research UI behavior

- Display one active field per subject or a unified pick list depending on chosen UI design.
- Hide fields whose prerequisites are unknown.
- On field completion, present available technologies unless Creative/Uncreative changes behavior.
- Allow tech trading/espionage/capture if diplomacy and spying modules are implemented.

## Hyper-advanced fields

The hyper-advanced fields are terminal repeatable or late-game fields in each subject. Implement them as researchable improvements that increase category output or combat stats according to verified formulas.

<!-- FILE: 06_ships_weapons_armor_design.md -->

# 06 - Ships, Weapons, Armor, and Design

## Ship-design loop

A ship design combines:

- Hull size/class.
- Armor, drive, computer, shield.
- Special systems.
- Weapons with mount/modification choices.
- Fighter, missile, bomb, and special payloads.

The designer must enforce:

- Maximum hull space.
- Minimum/automatic systems required by hull and known techs.
- Miniaturization rules: older components become smaller/cheaper as the empire researches higher technology levels.
- Weapon-mod availability by weapon and researched prerequisite.
- Command point usage by hull.
- Build cost and maintenance.

## Hull table

| hull | cost | size | marines | armor_hp | structure_hp | computer_hp | drive_hp | shield_hp | strategic_beam | strategic_missile | strategic_special | strategic_bomb | strategic_def_bonus | strategic_hits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| frigate | 20 | 25 | 5 | 4 | 4 | 1 | 2 | 1 | 1 | 0 | 0 | 0 | 50 | 4 |
| destroyer | 70 | 60 | 8 | 10 | 10 | 2 | 5 | 2 | 2 | 0 | 0 | 0 | 40 | 15 |
| cruiser | 250 | 120 | 12 | 30 | 30 | 5 | 10 | 6 | 2 | 1 | 0 | 2 | 30 | 25 |
| battleship | 600 | 250 | 20 | 50 | 50 | 7 | 15 | 7 | 4 | 2 | 1 | 5 | 25 | 40 |
| titan | 1500 | 500 | 30 | 80 | 80 | 10 | 20 | 10 | 6 | 4 | 3 | 10 | 20 | 80 |
| doomstar | 4000 | 1200 | 50 | 150 | 150 | 20 | 40 | 20 | 10 | 10 | 5 | 25 | 15 | 300 |
| star_base | 400 | 400 | 20 | 60 | 60 | 10 | 0 | 15 | 3 | 3 | 0 | 0 | -10 | 100 |
| battlestation | 1000 | 800 | 40 | 90 | 90 | 15 | 0 | 20 | 6 | 6 | 0 | 0 | -10 | 200 |
| star_fortress | 2500 | 1600 | 80 | 120 | 120 | 20 | 0 | 30 | 10 | 10 | 0 | 0 | -10 | 500 |

## Weapon table

Columns:

- `tech_id`: technology id from the technology table.
- `class_id`: public weapon class id. Keep as numeric until your implementation defines names.
- `ammo`: `-1` usually indicates non-ammo-limited beam-like weapons in the parameter data.
- `size` and `cost`: base ship-design values before miniaturization and mount/mod adjustments.
- `natural_mods`: built-in weapon flags.
- `tactical_damage` and `strategic_damage`: public min-max defaults.
- `available_mods`: comma-separated mod flags.

| id | tech_id | class_id | ammo | size | cost | natural_mods | tactical_damage | strategic_damage | available_mods |
|---|---:|---:|---:|---:|---:|---|---|---|---|
| mass_driver | 104 | 0 | -1 | 10 | 7 | nr | 6-6 | 6-6 | hv,pd,ap,af |
| gauss_cannon | 78 | 0 | -1 | 10 | 10 | nr | 18-18 | 18-18 | hv,ap,af |
| laser_cannon | 100 | 0 | -1 | 10 | 5 | none | 1-4 | 1-4 | hv,pd,ap,co,nr,af |
| particle_beam | 123 | 0 | -1 | 15 | 35 | sp | 10-30 | 10-30 | hv,pd,co |
| fusion_beam | 70 | 0 | -1 | 10 | 6 | dr | 2-6 | 2-6 | hv,pd,co,env |
| ion_pulse_cannon | 97 | 0 | -1 | 30 | 15 | ion | 2-10 | 2-10 | co,af |
| graviton_beam | 79 | 0 | -1 | 15 | 12 | esd | 3-15 | 3-15 | hv,co |
| neutron_blaster | 115 | 0 | -1 | 10 | 8 | mar | 3-12 | 3-12 | hv,co |
| phasor | 127 | 0 | -1 | 10 | 10 | none | 5-20 | 5-20 | hv,pd,co,sp,af |
| disrupter | 54 | 0 | -1 | 20 | 25 | nr | 40-40 | 40-40 | hv,af |
| starlight_projector | 47 | 0 | -1 | 30 | 75 | mar,co | 50-100 | 50-100 | hv |
| plasma_cannon | 137 | 0 | -1 | 25 | 15 | dr,env | 6-30 | 6-30 | hv,co |
| spatial_compressor | 165 | 5 | -1 | 50 | 40 | ai2 | 4-32 | 5-40 | none |
| nuclear_missile | 121 | 1 | 5 | 0 | 0 | none | 8-8 | 8-8 | mv,eccm,arm,fst,emg |
| merculite_missile | 106 | 1 | 5 | 0 | 0 | none | 14-14 | 14-14 | mv,eccm,arm,fst,emg |
| pulson_missile | 149 | 1 | 5 | 0 | 0 | none | 20-20 | 20-20 | mv,eccm,arm,fst,emg |
| zeon_missile | 202 | 1 | 5 | 0 | 0 | none | 30-30 | 30-30 | mv,eccm,arm,fst,emg |
| anti_matter_torpedo | 12 | 2 | 2 | 20 | 15 | none | 25-25 | 25-25 | env,eccm,ovr |
| proton_torpedo | 146 | 2 | 2 | 30 | 20 | none | 40-40 | 40-40 | env,eccm,ovr |
| plasma_torpedo | 139 | 2 | 2 | 40 | 75 | ai1 | 120-120 | 120-120 | nr,env,eccm,ovr |
| nuclear_bomb | 119 | 3 | 10 | 5 | 3 | none | 3-12 | 3-12 | none |
| fusion_bomb | 71 | 3 | 10 | 7 | 5 | none | 4-24 | 4-24 | none |
| anti_matter_bomb | 10 | 3 | 10 | 7 | 6 | none | 5-40 | 5-40 | none |
| neutronium_bomb | 118 | 3 | 10 | 10 | 9 | none | 10-60 | 10-60 | none |
| tech_detox_pod | 48 | 3 | 10 | 5 | 5 | morale | 10-10 | 10-10 | none |
| better_living_cascade | 28 | 3 | 10 | 7 | 8 | morale | 20-20 | 20-20 | none |
| mauler_device | 105 | 0 | -1 | 50 | 75 | hit | 100-100 | 100-100 | hv |
| assault_shuttle | 17 | 4 | 1 | 25 | 10 | none | 0-0 | 0-0 | none |
| heavy_fighter | 83 | 4 | 1 | 80 | 50 | none | 0-0 | 8-32 | none |
| bomber | 31 | 4 | 1 | 60 | 30 | none | 0-0 | 5-20 | none |
| interceptor | 66 | 4 | 1 | 30 | 10 | none | 0-0 | 1-4 | none |
| stasis_field | 171 | 5 | -1 | 75 | 75 | none | 0-0 | 0-0 | none |
| anti_missile_rocket | 13 | 5 | 20 | 20 | 5 | none | 0-0 | 0-0 | none |
| gyro_destabilizer | 80 | 5 | -1 | 75 | 50 | none | 1-4 | 3-8 | none |
| plasma_web | 140 | 5 | -1 | 40 | 40 | none | 5-25 | 5-25 | none |
| pulsar | 148 | 5 | -1 | 50 | 30 | none | 2-24 | 4-20 | none |
| black_hole_generator | 30 | 5 | -1 | 150 | 150 | none | 100-100 | 100-100 | none |
| stellar_converter | 174 | 5 | -1 | 500 | 500 | none | 400-400 | 250-250 | none |
| tractor_beam | 188 | 5 | -1 | 30 | 20 | none | 0-0 | 0-0 | none |
| dragon_breath | 0 | 2 | 1 | 25 | 20 | hit | 300-300 | 250-250 | hv |
| phasor_eye | 0 | 0 | -1 | 10 | 10 | none | 5-10 | 5-10 | hv,pd,co,sp,af |
| crystal_ray | 0 | 0 | -1 | 60 | 75 | mar | 40-80 | 40-80 | hv,co |
| plasma_breath | 0 | 0 | -1 | 50 | 75 | hit | 60-60 | 60-60 | hv |
| plasma_flux | 0 | 5 | -1 | 250 | 100 | none | 10-40 | 10-40 | none |
| caustic_slime | 0 | 5 | -1 | 300 | 100 | none | 25-50 | 25-50 | none |

## Weapon modification table

| mod | mod_id | miniaturization_level | space_percent | cost_percent | damage_multiplier | hint |
|---|---:|---:|---:|---:|---:|---|
| heavy_mount | 1 | 0 | 100 | 100 | 1 | Heavy mount: +50% damage and longer beam reach. |
| point_defense | 2 | 0 | -50 | -50 | 1 | Point defense: shoots incoming missiles and torpedoes, limited anti-ship output. |
| armor_piercing | 3 | 1 | 50 | 50 | 0 | Armor piercing: bypasses armor and hits structure directly. |
| continuous | 4 | 1 | 50 | 50 | 0 | Continuous: +25 to-hit bonus. |
| no_range_dissipation | 5 | 1 | 25 | 25 | 0 | No range dissipation: keeps full damage at all bands. |
| shield_piercing | 6 | 1 | 50 | 50 | 0 | Shield piercing: bypasses shields unless hard shields are active. |
| auto_fire | 7 | 2 | 50 | 50 | 0 | Auto-fire: fires 3 shots with lower per-shot hit chance. |
| enveloping | 8 | 2 | 100 | 100 | 0 | Enveloping: doubles damage and wraps around shields. |
| mirv | 9 | 2 | 100 | 100 | 0 | MIRV: missile splits into 4 independently interceptable warheads. |
| eccm | 10 | 1 | 25 | 25 | 0 | ECCM: ignores missile evasion jamming. |
| heavily_armored | 11 | 1 | 25 | 25 | 0 | Armored munition: survives one interceptor hit. |
| fast | 12 | 1 | 25 | 25 | 0 | Fast munition: higher missile or torpedo travel speed. |
| emissions_guidance | 13 | 0 | 300 | 300 | 0 | Emissions guidance: bypasses shields and favors drive-system knockouts. |
| overloaded | 14 | 1 | 50 | 50 | 0 | Overloaded: +50% damage output. |

## Weapon mod flag legend

Suggested mapping from public shorthand to implementation keys:

| Flag | Suggested key |
|---|---|
| hv | heavy_mount |
| pd | point_defense |
| ap | armor_piercing |
| co | continuous |
| nr | no_range_dissipation |
| sp | shield_piercing |
| af | auto_fire |
| env | enveloping |
| mv | mirv |
| eccm | eccm |
| arm | heavily_armored |
| fst | fast |
| emg | emissions_guidance |
| ovr | overloaded |

Natural mod shorthand should be decoded separately because some flags represent built-in special effects rather than selectable modifications.

## Armor, shields, computers, drives, specials

Minimum component categories:

- Armor: tritanium, neutronium, xentronium, plus stealth armor if implemented as armor/special hybrid.
- Shields: class I, III, V, VII, X; hard shields; multi-phased shields; damper field.
- Computers: electronic, optronic, positronic, cybertronic, moleculartronic if represented.
- Drives/fuel: nuclear, fusion, ion, anti-matter, hyper, thorium, etc. Distinguish tactical combat speed from strategic map range/speed.
- Specials: battle scanner, reinforced hull, automated repair-like systems, transporters, structural analyzer, displacement device, phasing cloak, sub-space teleporter, inertia nullifier, inertial stabilizer, high-energy focus, Achilles targeting unit, etc.

Use the technology table to map unlocks and the source parameter file to fill exact component space/cost values.

## Ship-design algorithm for AI

Inputs:

- Strategic role: scout, colony escort, missile boat, beam ship, carrier, bomber, invasion support, station defense, monster hunter.
- Known techs.
- Opponent observed defenses and weapons.
- Production budget and hull availability.

Process:

1. Pick hull by role, available tech, and economy.
2. Select drive/computer/shield/armor best known or cost-effective.
3. Reserve space for required specials.
4. Select weapon package by range role and target profile.
5. Apply weapon mods according to role.
6. Fill remaining space with secondary weapons, PD, bombs, or specials.
7. Compute strategic strength and maintenance burden.

## Example design schemas

```yaml
ship_design:
  id: missile_destroyer_early
  hull: destroyer
  role: missile_boat
  armor: best_available
  shield: best_available
  computer: best_available
  drive: best_available
  weapons:
    - weapon: nuclear_missile
      count: auto_fit
      mods: [eccm]
  specials:
    - battle_scanner_if_available
```

```yaml
ship_design:
  id: beam_battleship_mid
  hull: battleship
  role: line_beam
  weapons:
    - weapon: phasor
      count: auto_fit
      mods: [continuous, auto_fire]
  specials:
    - battle_scanner
    - reinforced_hull
    - inertial_stabilizer
```

<!-- FILE: 07_combat_mechanics.md -->

# 07 - Combat Mechanics

## Combat modes

Implement two resolution modes:

- Tactical combat: ships move on a tactical battlefield, choose targets and weapons, and resolve individual volleys.
- Strategic combat: auto-resolve using strategic weapon/defense values, hull hits, and fleet composition.

A faithful implementation should make both modes share data tables but use separate formulas where the original does.

## Tactical combat state

```yaml
tactical_battle:
  round: 1
  side_a:
    ships: []
    retreat_edge: west
  side_b:
    ships: []
    retreat_edge: east
  battlefield:
    width: TBD_verify
    height: TBD_verify
    obstacles: []
```

## Hit calculation

Beam to-hit is determined by attacker beam attack versus defender beam defense, with additional modifiers from:

- Ship computer.
- Battle scanner and similar systems.
- Target hull defense bonus.
- Range to target.
- Target speed/maneuver/specials.
- Race attack/defense picks.
- Crew experience, leaders, and warlord-like bonuses.
- Weapon mods and special effects.

Use one canonical function:

```python
def beam_hit_chance(attacker, defender, weapon, distance):
    attack_score = attacker.beam_attack_total + weapon.attack_bonus
    defense_score = defender.beam_defense_total
    range_penalty = lookup_range_hit_penalty(weapon, distance)
    chance = base_formula(attack_score, defense_score) + range_penalty
    return clamp(chance, min_hit_chance, max_hit_chance)
```

The exact base formula and clamps should be empirically verified.

## Range penalties

Public parameter data exposes these hit and damage penalty surfaces.

### Ranged hit penalties

| Distance band | Hit penalty |
|---|---:|
| Range 1 | 0 |
| Range 2 | 0 |
| Range 3 | 0 |
| Range 4 | 0 |
| Range 5 | 0 |
| Range 6 | -10 |
| Range 7 | -20 |
| Range 8 | -30 |
| Range 9 | -40 |
| Range 10 | -50 |
| Range 11 | -60 |
| Range 12 | -70 |
| Range 13 | -80 |
| Range 14 | -90 |
| Range 15 | -100 |

### Ranged damage penalties

| Distance band | Damage penalty percent |
|---|---:|
| Range 1 | 0 |
| Range 2 | 10 |
| Range 3 | 20 |
| Range 4 | 30 |
| Range 5 | 40 |
| Range 6 | 50 |
| Range 7 | 60 |
| Range 8 | 70 |
| Range 9 | 80 |
| Range 10 | 90 |

No-range-dissipation weapons ignore the relevant damage/range penalty as defined by the weapon flag.

## Damage order

Typical damage pipeline to implement and verify:

1. Determine hit or miss.
2. Roll weapon damage min-max.
3. Apply range damage falloff unless ignored.
4. Apply mount/mod multipliers: heavy, point defense, enveloping, overloaded, etc.
5. Apply shield interaction: normal, shield-piercing, enveloping, hard shield, multi-phase, damper.
6. Apply armor interaction: armor piercing, structural analyzer, Achilles targeting, special monster effects.
7. Apply damage to armor, then structure/internal systems according to weapon flags.
8. Resolve critical/system damage: computer, drive, weapons, shields, crew/marines.
9. Check destruction, disabled, captured, stasis, retreat, or surrender.

## Missiles, torpedoes, and fighters

Missiles:

- Track ammo per launcher.
- Move as tactical objects with speed, hit points, defense, and target selection.
- Can be intercepted by point defense and anti-missile rockets.
- Mods include MIRV, ECCM, fast, heavily armored, emissions guidance.

Torpedoes:

- Usually direct-fire or limited-ammo special projectile behavior depending on weapon.
- Mods include enveloping, ECCM, overloaded, no range where allowed.

Fighters/bombers/interceptors:

- Launch from bays.
- Use independent movement/attack profiles.
- Need exact count, refresh, ammo, and survival rules verified.

## Bombardment and planetary combat

After orbital superiority:

1. Attacker may bombard with bombs, beams/specials if allowed, and morale-distraction payloads.
2. Planetary defenses fire or absorb damage: missile base, fighter garrison, ground batteries, shields, stations.
3. Population, marines, buildings, and environment can be damaged.
4. Ground invasion uses transports and marine strength.
5. Captured colony transfers owner and applies assimilation/unrest rules.

## Strategic auto-resolve

Use hull strategic fields and weapon strategic damage as the base. Add:

- Fleet size and hull hit pools.
- Strategic beam/missile/special/bomb values.
- Strategic defense bonus.
- Technology modifiers and race attack/defense.
- Stations and planetary defenses.

A good approximation is not enough for exactness. Build a fixture suite from real tactical-to-strategic comparison cases.

<!-- FILE: 08_ai_and_balance_notes.md -->

# 08 - AI and Balance Notes

## AI modules

Break AI into independent, testable planners:

1. Expansion planner: colonization target scoring, outpost placement, range expansion.
2. Colony planner: population assignment, building queue, buyout decisions, pollution handling.
3. Research planner: field scoring by strategic needs, race traits, military pressure, economy, and victory route.
4. Ship-design planner: role-based templates and counter-designs.
5. Fleet planner: defense, invasion staging, scouting, monster response, blockades.
6. Diplomacy planner: treaty proposals, threats, gifts, war declarations, surrender/tribute.
7. Espionage planner: spying budget, target choice, sabotage vs steal tech.
8. Tactical combat AI: target selection, range control, missile/fighter launch, retreat, boarding.

## AI state features

Recommended empire evaluation features:

- Relative military power.
- Known enemy techs and observed ship roles.
- Economic surplus/deficit.
- Research rank.
- Expansion room and colony quality.
- Diplomatic trust/anger/fear.
- War weariness or equivalent pressure, if modeled.
- Monster/Antaran threat.

## Difficulty scaling

Use separate tables for:

- AI production/research/economy bonuses.
- AI starting resources.
- AI hostility/aggression modifiers.
- Human score multiplier.
- Random event severity.

Do not hard-code difficulty bonuses inside AI logic. Keep them in data and display them in debug builds.

## Balance profiles

Support at least three profiles:

- `classic_default`: public classic values from parameter tables.
- `fan_patch_150`: if using 1.50-specific fixes or balance changes.
- `original_compatible_replica`: legally distinct renamed/rebalanced data set for a new game.

Every profile should version-lock:

- Race pick costs and effects.
- Building costs/maintenance/effects.
- Tech tree costs and unlocks.
- Ship component space/cost/damage.
- Hull sizes and CP usage.
- AI weights.

## Debugging tools

Add developer screens for:

- Colony output breakdown.
- Ship design space/cost breakdown.
- Combat hit/damage roll breakdown.
- Research unlock list and hidden prerequisites.
- AI scoring decisions.
- Map generation seed replay.
- Diplomacy relation reasons.

## Model prompt advice

When asking an LLM to generate implementation code from this pack, instruct it to:

- Create data schemas first.
- Generate loader/validator tests for every Markdown table.
- Implement deterministic simulation kernels before UI.
- Mark unknown formulas as `TBD_verify` rather than inventing them.
- Add fixture tests for every subsystem.
- Avoid copying names, text, art, or audio unless rights are cleared.

<!-- FILE: 09_replica_gap_checklist.md -->

# 09 - Replica Gap Checklist

This pack is rich enough to design a MOO2-like mechanics engine, but not enough to guarantee an exact replica. Use this checklist before claiming exactness.

## Data gaps to verify

- Exact building effects, not just costs/maintenance/groups.
- Exact armor, shield, drive, computer, and special-system space/cost/effects.
- Exact miniaturization formulas by tech level.
- Exact planet climate/size/mineral/gravity generation tables.
- Exact homeworld generation for every stock race.
- Exact stock race presets and AI personality presets.
- Exact leader names, skills, probabilities, and event triggers. Replace protected names if making a new game.
- Exact random event probabilities and consequences.
- Exact diplomacy state machine and AI thresholds.
- Exact espionage/sabotage formulas.
- Exact ground combat formulas.
- Exact strategic auto-combat formulas.
- Exact tactical battlefield dimensions, initiative ordering, movement costs, retreat rules, and special-case interactions.
- Exact colony output formula order, rounding, and overflow behavior.
- Exact population growth, starvation, assimilation, morale, and pollution formulas.
- Exact Galactic Council timing, vote weights, abstentions, alliances, and victory thresholds.
- Exact Antaran/Orion/monster behavior if included.

## Protected material not included

Do not copy without permission:

- Original executable/source code.
- Original art, icons, UI screens, fonts bundled with the game, ship sprites, leader portraits, race portraits.
- Original music or sound effects.
- Original manual text, in-game descriptions, event prose, diplomacy messages, or lore passages.
- Original trademarks, logos, and branding.

## Conformance test plan

Build a licensed-reference harness:

1. Pick a fixed game setup and random seed if seed can be controlled.
2. Record first 100 turns of colony outputs for multiple races.
3. Record tech unlock choices for standard, Creative, and Uncreative races.
4. Record ship-design costs for standard test designs at multiple tech levels.
5. Record tactical combat outcomes with deterministic or repeated trials.
6. Record map generation distributions over many games.
7. Record AI choices under identical visible states.
8. Record save/load round trips and compare state hashes.

## Acceptance levels

- Level 0: Thematic 4X inspired by MOO2; original data and assets.
- Level 1: Similar systems and balance categories; no exact values required.
- Level 2: Uses public classic parameter values for core data tables.
- Level 3: Formula-level behavior matches common gameplay cases.
- Level 4: Empirically verified against licensed original for most systems.
- Level 5: Byte/pixel/timing exactness. This likely requires proprietary code/assets or deep reverse engineering and is outside this pack.

## Recommended lawful target

Aim for Level 2-4 mechanics conformance with original presentation, names, art, audio, UI copy, and balance adjustments. That supports a modern spiritual successor or research replica without copying protected expression.

<!-- FILE: 10_moo2_book_external_reference.md -->

# MOO2 Book External Reference and Rights-Safe Use Notes

This pack does **not** embed or mirror the complete MOO2 Book text, images, PDFs, or generated website.

Reason: the MOO2 Book and related MOO2MOD pages are publicly readable, but the public pages consulted for this pack do not show an explicit open-content redistribution license for wholesale copying. The MOO2MOD home page also carries a copyright notice for the MOO2 1.50 Project. Public availability is not the same as permission to redistribute a full copy inside another ZIP.

## Correct legal distinction

Game rules, procedures, systems, and methods of play can be described and reimplemented at the mechanics level. However, the exact expressive text of a manual, website, guide, table commentary, art, screenshots, UI text, music, sound effects, source code, binaries, names, logos, and other presentation elements may still be protected by copyright, trademark, contract, or other rights.

This reference pack is therefore structured as a mechanics/data specification scaffold rather than a verbatim archive.

## Official public MOO2 Book entry points

Use these URLs as the canonical sources to consult directly:

- MOO2 Book index: https://moo2mod.com/doc/index.html
- Game Manual: https://moo2mod.com/doc/game/manual.html
- Starting a New Game: https://moo2mod.com/doc/game/new_game.html
- Map generation: https://moo2mod.com/doc/game/mapgen.html
- 1.50 Manual / configuration overview: https://moo2mod.com/doc/150/index.html
- 1.50 parameter reference: https://moo2mod.com/doc/150/parameters.html
- Modding: https://moo2mod.com/doc/150/modding.html
- Editing the Book: https://moo2mod.com/doc/150/thebook.html
- MOO2MOD home page: https://moo2mod.com/

## How to use the MOO2 Book with a model without redistributing it here

A rights-safer workflow is:

1. Ask the model to use the files in this ZIP as the primary implementation scaffold.
2. Give the model the official MOO2 Book URLs as external references.
3. Have the model summarize mechanics and formulas in its own words.
4. Avoid copying original manual prose, screenshots, images, branding, executable data, or fan-book text wholesale into generated code or documentation.
5. Validate behavior empirically against a legally obtained copy of the game and/or the fan patch documentation.

## Local inclusion policy for this ZIP

Allowed in this ZIP:

- Original summaries and implementation notes.
- Mechanics tables derived into a specification format.
- Source links and attribution.
- Gap checklists for empirical testing.

Not included in this ZIP without explicit permission or a compatible license:

- The full MOO2 Book website text.
- MOO2 Book images.
- Official or fan manual PDFs.
- Game binaries, art, music, sound effects, fonts, UI screens, or trademarked branding assets.

If you obtain explicit permission or a compatible license from the MOO2 Book rights holder, add the licensed material under a clearly labeled `third_party/moo2_book/` directory with a copy of the license/permission text and provenance notes.

<!-- FILE: 11_safe_terminology_overlay.md -->

# 11 - Safe Terminology Overlay

## Purpose

This pack uses a neutral naming overlay for high-sensitivity source labels while preserving all mechanical values. The overlay is intended for models or clients that respond better to calm, non-graphic terminology.

Rules for this overlay:

- Numeric ids, costs, prerequisites, damage ranges, flags, categories, and unlock positions remain unchanged.
- Only identifiers, display labels, and explanatory wording are softened.
- Source-sensitive labels are intentionally omitted from this pack; use numeric ids for traceability.
- Treat the safe names below as strict aliases, not balance changes.

## Preferred themes

Use these themes consistently in prompts and generated code:

- **Ecology** for the former high-sensitivity research subject.
- **Better Living** for social-comfort, morale, and calm-habitat effects.
- **Tech Detox** for colony-distraction payload behavior.
- **Habitat** for population-capacity and world-comfort effects.
- **Stellar Safety** for environmental shielding labels.

## ID-based alias table

| Category / legacy numeric id | Safe identifier | Safe display label | Mechanical treatment |
|---|---|---|---|
| Research subject | ecology | Ecology | Same subject slot, field progression, and unlock behavior. |
| Field id 18 | astro_ecology | Astro Ecology | Same field id, cost, previous/next links, and tier. |
| Field id 1 | advanced_ecology | Advanced Ecology | Same field id, cost, previous/next links, and tier. |
| Field id 75 | advf_ecology | Advanced Future Ecology | Same field id, cost, previous/next links, and tier. |
| Tech id 27 | habitat_domes | Habitat Domes | Same colony item values and unlock location. |
| Tech id 29 | adaptive_habitat_lattice | Adaptive Habitat Lattice | Same colony item values and unlock location. |
| Tech id 37 | population_growth_center | Population Growth Center | Same colony growth facility values and unlock location. |
| Tech id 48 / weapon row 48 | tech_detox_pods / tech_detox_pod | Tech Detox Pods | Same class-3 orbital payload behavior, size/cost 5/5, morale flag, and 10-10 effect range. |
| Tech id 28 / weapon row 28 | better_living_cascade | Better Living Cascade | Same class-3 orbital payload behavior, size/cost 7/8, morale flag, and 20-20 effect range. |
| Tech id 47 / weapon row 47 | starlight_projector | Starlight Projector | Same late beam-style row, size/cost 30/75, flags, and 50-100 damage range. |
| World climate label | hostile | Hostile | Same climate slot and habitability penalties as the source label at that position. |
| World climate label | energized | Energized | Same climate slot and habitability penalties as the source label at that position. |
| Shield item | stellar_safety_shield | Stellar Safety Shield | Same defensive values and unlock position. |
| Planet shield item | planetary_stellar_safety_shield | Planetary Stellar Safety Shield | Same defensive values and unlock position. |
| Payload flag | morale | Morale | Route this exactly like the original special colony-targeting flag in damage/effect resolution. |

## Prompting guidance

When asking another model to implement this pack, include this instruction:

> Use the safe terminology overlay exactly as written. Do not restore source-sensitive labels. Preserve all numeric ids, prerequisites, costs, effect ranges, and resolution order. Treat safe ids as stable data keys for this implementation.

<!-- FILE: README.md -->

# Master of Orion II Mechanics Reference Pack

This pack is a structured Markdown reference for implementing a Master of Orion II-like 4X strategy game at the rules/data level. It is organized for use by an LLM or engineering team as a specification scaffold.

It includes:

- Game-loop and subsystem architecture.
- Race-pick data and race-creation mechanics.
- Galaxy, planets, colonization, and map-generation notes.
- Colony buildings, buildables, maintenance, and costs from public parameter data.
- Technology-field and technology tables from public parameter data.
- Ship hulls, weapons, modifications, command points, scanning, and stealth values.
- Tactical combat implementation notes and known formula surfaces.
- AI, balance, and validation checklists.

Fable/model compatibility note:

- This pack uses a safe terminology overlay for high-sensitivity source labels. Mechanics and numeric ids are preserved; only display names and data identifiers are softened. See `11_safe_terminology_overlay.md`.

It does not include:

- Original art, sprites, animations, music, sound effects, UI screens, text dumps, binary files, or source code.
- A guarantee of byte-perfect behavior, random-number-stream matching, or exact AI decision-making.
- Permission to use the Master of Orion name, branding, or assets.

Recommended usage:

1. Load the files in numeric order.
2. Treat parameter tables as default classic data unless overridden by a chosen mod/patch profile.
3. Use the gap checklist to verify against original gameplay recordings, save files, or a licensed installation.
4. Replace copyrighted expression with original assets, UI copy, names, and presentation.

## Source basis

Primary public references used for this pack:

- MOO2 Book, especially the game manual, 1.50 manual, map-generation notes, and 1.50 parameter reference: https://moo2mod.com/doc/index.html
- MOO2 1.50 parameter reference. The page describes itself as a semi-automatically generated full list of current config parameters, with specified values set to classic unmodded MOO2 defaults: https://moo2mod.com/doc/150/parameters.html
- StrategyWiki MOO2 technology and warship-mechanics pages: https://strategywiki.org/wiki/Master_of_Orion_II:_Battle_at_Antares

Legal/accuracy note: this is a mechanics-and-data specification, not a dump of copyrighted assets, UI text, manuals, source code, binaries, artwork, music, sound effects, or trademarks. It is intended to support analysis or a lawful spiritual/mechanical recreation. A truly exact commercial replica requires rights clearance and empirical verification against the original executable.

## Files

- `00_model_context_brief.md`
- `01_game_loop_and_systems.md`
- `02_races_and_picks.md`
- `03_galaxy_planets_mapgen.md`
- `04_colonies_buildings_units.md`
- `05_research_tech_tree.md`
- `06_ships_weapons_armor_design.md`
- `07_combat_mechanics.md`
- `08_ai_and_balance_notes.md`
- `09_replica_gap_checklist.md`
- `10_moo2_book_external_reference.md`
- `11_safe_terminology_overlay.md`
