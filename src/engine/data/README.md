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

| # | Topic | Decision | Source | Locked by |
|---|---|---|---|---|
| (none yet) | | | | |
