// Curated effect coverage for every tech application and buildable (Phase 5).
// Encodes the FUNCTIONAL effect data (numbers) from the mechanics docs as
// declarative modifiers, or tags the engine system that implements the item,
// or records an explicit stub (= tracked future work). The coverage test in
// tests/data/effects.test.ts fails if an application is missing here.
//
// scope 'colony' = building present on the colony; 'empire' = tech known.

import type { Modifier } from '../effects';

export type EffectKind =
  | 'building'
  | 'project'
  | 'ship_component'
  | 'ship_special'
  | 'weapon'
  | 'ground_unit'
  | 'empire_tech'
  | 'unlock'
  | 'system';

export interface EffectSpec {
  kind: EffectKind;
  modifiers?: Modifier[];
  /** engine system that implements it (economy | shipdesign | combat | movement | pipeline | battles | research) */
  handler?: string;
  /** not implemented yet; value = what remains + target phase */
  stub?: string;
}

const col = (target: Modifier['target'], amount: number): Modifier => ({ target, amount, scope: 'colony' });
const emp = (target: Modifier['target'], amount: number): Modifier => ({ target, amount, scope: 'empire' });

/** application/buildable id -> canonical key used in EFFECTS */
export const EFFECT_ALIASES: Record<string, string> = {
  robominers: 'robo_miner_plant',
  battlestation: 'battle_station',
  planetary_gravity_generator: 'gravity_generator',
  artificial_planet_construction: 'artificial_planet',
  freighters: 'freighter_fleet',
  spies: 'spy',
};

export const EFFECTS: Record<string, EffectSpec> = {
  // ---------------- ecology ----------------
  hydroponic_farm: { kind: 'building', modifiers: [col('farm_flat', 2)] },
  habitat_domes: { kind: 'building', modifiers: [col('max_pop', 2)] },
  population_growth_center: { kind: 'building', modifiers: [col('growth_flat_k', 100)] },
  soil_enrichment: { kind: 'building', modifiers: [col('farm_coeff', 1)] },
  tech_detox_pods: { kind: 'weapon', handler: 'combat' },
  insight_training: { kind: 'empire_tech', modifiers: [emp('spy_offense', 5), emp('spy_defense', 5)] },
  wellness_systems: { kind: 'empire_tech', modifiers: [emp('growth_pct', 25)], handler: 'economy' },
  terraforming: { kind: 'project', handler: 'terraform' }, // climate-step project (terraform.ts T1)
  subterranean_farms: { kind: 'building', modifiers: [col('farm_flat', 4)] },
  weather_controller: { kind: 'building', modifiers: [col('farm_coeff', 2)] },
  civic_insight: { kind: 'empire_tech', modifiers: [emp('spy_offense', 10), emp('spy_defense', 10)], handler: 'economy' },
  learning_optimization: { kind: 'empire_tech', modifiers: [emp('sci_coeff', 1)] },
  better_living_cascade: { kind: 'weapon', handler: 'combat' },
  universal_wellness_protocol: { kind: 'empire_tech', modifiers: [emp('growth_pct', 50)], handler: 'economy' },
  adaptive_habitat_lattice: { kind: 'empire_tech', modifiers: [emp('farm_coeff', 1)] },
  gaia_transformation: { kind: 'project', handler: 'terraform' }, // terran->gaia project
  trait_reassignment: { kind: 'system', handler: 'commands' }, // +4-pick respec via the trait_reassignment command (Empires tab)

  // ---------------- chemistry ----------------
  nuclear_missile: { kind: 'weapon', handler: 'combat' },
  merculite_missiles: { kind: 'weapon', handler: 'combat' },
  pulson_missiles: { kind: 'weapon', handler: 'combat' },
  zeon_missile: { kind: 'weapon', handler: 'combat' },
  standard_fuel_cells: { kind: 'ship_component', handler: 'movement' },
  deuterium_fuel_cells: { kind: 'ship_component', handler: 'movement' },
  iridium_fuel_cells: { kind: 'ship_component', handler: 'movement' },
  uridium_fuel_cells: { kind: 'ship_component', handler: 'movement' },
  thorium_fuel_cells: { kind: 'ship_component', handler: 'movement' },
  extended_fuel_tanks: { kind: 'ship_special', stub: 'per-design +50% range option (Phase 7 designer)' },
  titanium_armor: { kind: 'ship_component', handler: 'shipdesign' },
  tritanium_armor: { kind: 'ship_component', handler: 'shipdesign' },
  zortrium_armor: { kind: 'ship_component', handler: 'shipdesign' },
  neutronium_armor: { kind: 'ship_component', handler: 'shipdesign' },
  adamantium_armor: { kind: 'ship_component', handler: 'shipdesign' },
  pollution_processor: { kind: 'building', modifiers: [col('pollution_divisor_mult', 2)] },
  atmospheric_renewer: { kind: 'building', modifiers: [col('pollution_divisor_mult', 4)] },
  nano_disassemblers: { kind: 'empire_tech', modifiers: [emp('pollution_absorb_x2', 1)] },
  microlite_construction: { kind: 'empire_tech', modifiers: [emp('prod_coeff', 1)] },

  // ---------------- computers ----------------
  electronic_computer: { kind: 'ship_component', handler: 'shipdesign' },
  optronic_computer: { kind: 'ship_component', handler: 'shipdesign' },
  positronic_computer: { kind: 'ship_component', handler: 'shipdesign' },
  cybertronic_computer: { kind: 'ship_component', handler: 'shipdesign' },
  moleculartronic_computer: { kind: 'ship_component', handler: 'shipdesign' },
  research_lab: { kind: 'building', modifiers: [col('sci_flat', 5), col('sci_coeff', 1)] },
  dauntless_guidance_system: { kind: 'ship_special', stub: 'missile retargeting (Phase 6 combat specials)' },
  neural_scanner: { kind: 'empire_tech', modifiers: [emp('spy_offense', 10)] },
  scout_lab: { kind: 'ship_special', stub: 'exploration/monster-analysis bonus (Phase 6)' },
  security_stations: { kind: 'ship_special', stub: 'boarding defense (Phase 6)' },
  supercomputer: { kind: 'building', modifiers: [col('sci_flat', 10), col('sci_coeff', 2)] },
  holo_simulator: { kind: 'building', modifiers: [col('morale_pct', 20)] },
  emissions_guidance_system: { kind: 'weapon', handler: 'combat' },
  rangemaster_target_unit: { kind: 'ship_special', handler: 'combat' }, // range band one step closer
  cyber_security_link: { kind: 'empire_tech', modifiers: [emp('spy_defense', 10)] },
  autolab: { kind: 'building', modifiers: [col('sci_flat', 30)] },
  structural_analyzer: { kind: 'ship_special', handler: 'combat' }, // beam damage x2
  android_farmers: { kind: 'system', stub: 'android population units (Phase 6)' },
  android_workers: { kind: 'system', stub: 'android population units (Phase 6)' },
  android_scientists: { kind: 'system', stub: 'android population units (Phase 6)' },
  virtual_reality_network: { kind: 'building', modifiers: [col('morale_pct', 20)], handler: 'economy' },
  galactic_cybernet: { kind: 'building', modifiers: [col('sci_flat', 15), col('sci_coeff', 3)] },
  pleasure_dome: { kind: 'building', modifiers: [col('morale_pct', 30)] },
  achilles_targeting_unit: { kind: 'ship_special', handler: 'combat' }, // beams bypass armor

  // ---------------- construction ----------------
  colony_base: { kind: 'unlock', handler: 'economy' }, // settles the innermost free planet in-system
  star_base: { kind: 'building', modifiers: [col('cp_flat', 2)], handler: 'battles' },
  battle_station: { kind: 'building', modifiers: [col('cp_flat', 4)], handler: 'battles' },
  star_fortress: { kind: 'building', modifiers: [col('cp_flat', 6)], handler: 'battles' },
  marine_barracks: { kind: 'building', handler: 'economy' }, // morale fix; ground garrison Phase 6
  armor_barracks: { kind: 'building', handler: 'economy' },
  anti_missile_rocket: { kind: 'weapon', handler: 'combat' },
  fighter_bays: { kind: 'weapon', handler: 'combat' }, // interceptors + bombers mount via CRAFT_BY_BAY (shipdesign.ts) and fly as classId-4 strike craft
  heavy_fighter_bays: { kind: 'weapon', handler: 'combat' }, // heavy fighters, same strike-craft path
  bomber_bays: { kind: 'weapon', stub: 'bombers already ride fighter_bays (CRAFT_BY_BAY); this separate application does nothing' },
  reinforced_hull: { kind: 'ship_special', handler: 'shipdesign' },
  automated_factory: { kind: 'building', modifiers: [col('prod_flat', 5), col('prod_coeff', 1)] },
  missile_base: { kind: 'building', handler: 'combat' }, // +4 best missiles on the defense platform (battles.ts)
  heavy_armor: { kind: 'ship_special', handler: 'combat' }, // armor HP x3
  battle_pods: { kind: 'ship_special', handler: 'shipdesign' },
  troop_pods: { kind: 'ship_special', stub: 'marine capacity (Phase 6 boarding)' },
  survival_pods: { kind: 'ship_special', stub: 'leader rescue (Phase 6 leaders)' },
  space_port: { kind: 'building', modifiers: [col('money_coeff_halves', 1)] },
  fighter_garrison: { kind: 'building', stub: 'carrier ops omitted by the combat redesign (permanent design decision)' },
  robo_miner_plant: { kind: 'building', modifiers: [col('prod_flat', 10), col('prod_coeff', 2)] },
  powered_armor: { kind: 'ground_unit', stub: 'ground combat (Phase 6)' },
  fast_missile_racks: { kind: 'ship_special', handler: 'combat' }, // missiles cycle 2x
  advanced_damage_control: { kind: 'ship_special', handler: 'combat' }, // full repair after each battle
  assault_shuttle: { kind: 'weapon', handler: 'combat' }, // boarding craft: launch as strike craft, cripple systems on contact (combat.ts classId 4)
  titan_construction: { kind: 'unlock', handler: 'shipdesign' },
  doom_star_construction: { kind: 'unlock', handler: 'shipdesign' },
  ground_batteries: { kind: 'building', handler: 'combat' }, // +6 heavy beams on the defense platform (battles.ts)
  battleoids: { kind: 'ground_unit', stub: 'ground combat (Phase 6)' },
  recyclotron: { kind: 'building', handler: 'economy' }, // +1 prod/pop unit, pollution-free (economy.ts)
  automated_repair_unit: { kind: 'ship_special', handler: 'combat' }, // ~0.5% structure/tick in combat
  artificial_planet: { kind: 'project', handler: 'pipeline' }, // converts an asteroid belt / gas giant in-system into a barren world (completeItem)
  robotic_factory: { kind: 'building', handler: 'economy' }, // +5..+25 prod by minerals
  deep_core_mine: { kind: 'building', modifiers: [col('prod_flat', 15), col('prod_coeff', 3)] },
  core_waste_dump: { kind: 'building', modifiers: [col('pollution_zero', 1)] },
  advanced_city_planning: { kind: 'empire_tech', modifiers: [emp('max_pop', 5)] },
  artemis_system_net: { kind: 'building', stub: 'system minefield (Phase 6)' },

  // ---------------- force fields ----------------
  class_i_shield: { kind: 'ship_component', handler: 'shipdesign' },
  class_iii_shield: { kind: 'ship_component', handler: 'shipdesign' },
  class_v_shield: { kind: 'ship_component', handler: 'shipdesign' },
  class_vii_shield: { kind: 'ship_component', handler: 'shipdesign' },
  class_x_shield: { kind: 'ship_component', handler: 'shipdesign' },
  mass_driver: { kind: 'weapon', handler: 'combat' },
  gauss_cannon: { kind: 'weapon', handler: 'combat' },
  ecm_jammer: { kind: 'ship_special', handler: 'combat' }, // 40% missile evasion
  multi_wave_ecm_jammer: { kind: 'ship_special', handler: 'combat' }, // 70% missile evasion
  wide_area_jammer: { kind: 'ship_special', handler: 'combat' }, // 40% fleet-wide missile evasion
  anti_grav_harness: { kind: 'ground_unit', stub: 'ground combat (Phase 6)' },
  inertial_stabilizer: { kind: 'ship_special', handler: 'shipdesign' },
  gyro_destabilizer: { kind: 'weapon', handler: 'combat' }, // fires as a direct-fire special (generic damage; signature spin effect Phase 6)
  stellar_safety_shield: { kind: 'building', handler: 'terraform' }, // hostile world lives as barren (terraform.ts); bombard shield (battles.ts)
  planetary_stellar_safety_shield: { kind: 'building', stub: 'colony shield vs bombardment (Phase 6)' },
  flux_shield: { kind: 'building', stub: 'colony shield vs bombardment (Phase 6)' },
  nanite_factory: { kind: 'building', modifiers: [col('prod_flat', 5)] }, // TUNABLE: +5 prod (classic values unpublished)
  warp_dissipater: { kind: 'ship_special', handler: 'combat' }, // enemy cannot retreat
  stealth_field: { kind: 'ship_special', modifiers: [emp('stealth', 10)], stub: 'fleet concealment (Phase 6 intel)' },
  stealth_suit: { kind: 'empire_tech', modifiers: [emp('spy_offense', 10)] },
  personal_shield: { kind: 'ground_unit', stub: 'ground combat (Phase 6)' },
  pulsar: { kind: 'weapon', handler: 'combat' }, // fires as a direct-fire special (generic damage; signature area burst Phase 6)
  warp_interdictor: { kind: 'building', stub: 'slows hostile FTL nearby (Phase 6 movement)' },
  lightning_field: { kind: 'ship_special', handler: 'combat' }, // 50% incoming missiles destroyed
  hard_shields: { kind: 'ship_special', handler: 'combat' }, // +3 flat, immune to shield-piercing
  multi_phased_shields: { kind: 'ship_special', handler: 'combat' }, // +50% shield pool
  planetary_flux_shield: { kind: 'building', stub: 'colony shield vs bombardment (Phase 6)' },
  planetary_barrier_shield: { kind: 'building', stub: 'colony shield vs bombardment (Phase 6)' },
  displacement_device: { kind: 'ship_special', handler: 'combat' }, // 33% of incoming fire misses
  sub_space_teleporter: { kind: 'ship_special', stub: 'teleport movement (Phase 6 combat specials)' },
  inertia_nullifier: { kind: 'ship_special', handler: 'combat' }, // +4 combat speed
  stasis_field: { kind: 'weapon', stub: 'special weapon class (Phase 6 combat specials)' },
  phasing_cloak: { kind: 'ship_special', stub: 'cloaking (Phase 6 combat specials)' },
  cloaking_device: { kind: 'ship_special', stub: 'cloaking (Phase 6 combat specials)' },

  // ---------------- physics ----------------
  laser_cannon: { kind: 'weapon', handler: 'combat' },
  fusion_beam: { kind: 'weapon', handler: 'combat' },
  neutron_blaster: { kind: 'weapon', handler: 'combat' },
  graviton_beam: { kind: 'weapon', handler: 'combat' },
  phasors: { kind: 'weapon', handler: 'combat' },
  plasma_cannon: { kind: 'weapon', handler: 'combat' },
  disruptor_cannon: { kind: 'weapon', handler: 'combat' },
  mauler_device: { kind: 'weapon', handler: 'combat' },
  starlight_projector: { kind: 'weapon', handler: 'combat' },
  laser_rifle: { kind: 'ground_unit', stub: 'ground combat (Phase 6)' },
  fusion_rifle: { kind: 'ground_unit', stub: 'ground combat (Phase 6)' },
  phasor_rifle: { kind: 'ground_unit', stub: 'ground combat (Phase 6)' },
  plasma_rifle: { kind: 'ground_unit', stub: 'ground combat (Phase 6)' },
  space_scanner: { kind: 'empire_tech', modifiers: [emp('scan', 2)] },
  neutron_scanner: { kind: 'empire_tech', modifiers: [emp('scan', 5)] },
  tachyon_scanner: { kind: 'empire_tech', modifiers: [emp('scan', 7)] },
  tachyon_communication: { kind: 'empire_tech', modifiers: [emp('cp_flat', 1)] },
  subspace_communication: { kind: 'empire_tech', stub: 'command/comm range (verify values, Phase 6)' },
  hyperspace_communication: { kind: 'empire_tech', stub: 'command/comm range (verify values, Phase 6)' },
  battle_scanner: { kind: 'ship_special', handler: 'shipdesign' },
  tractor_beam: { kind: 'weapon', stub: 'special weapon class (Phase 6 combat specials)' },
  gravity_generator: { kind: 'building', handler: 'economy' },
  jump_gate: { kind: 'empire_tech', stub: 'gate-boosted travel between own systems (Phase 6)' },
  plasma_web: { kind: 'weapon', handler: 'combat' }, // fires as a direct-fire special (generic damage; signature clinging web Phase 6)
  dimensional_portal: { kind: 'building', handler: 'npc' }, // enables attack_antarans (npc.ts A1)
  sensors: { kind: 'empire_tech', stub: 'deep scan (verify values, Phase 6)' },
  time_warp_facilitator: { kind: 'ship_special', stub: 'extra combat turn (Phase 6 combat specials)' },
  star_gate: { kind: 'empire_tech', stub: 'instant travel between own systems (Phase 6)' },
  multi_phased_shields_physics: { kind: 'ship_special', stub: 'duplicate name guard (unused)' },

  // ---------------- power ----------------
  nuclear_drive: { kind: 'ship_component', handler: 'movement' },
  fusion_drive: { kind: 'ship_component', handler: 'movement' },
  ion_drive: { kind: 'ship_component', handler: 'movement' },
  anti_matter_drive: { kind: 'ship_component', handler: 'movement' },
  hyper_drive: { kind: 'ship_component', handler: 'movement' },
  interphased_drive: { kind: 'ship_component', handler: 'movement' },
  nuclear_bomb: { kind: 'weapon', handler: 'battles' },
  fusion_bomb: { kind: 'weapon', handler: 'battles' },
  anti_matter_bomb: { kind: 'weapon', handler: 'battles' },
  neutronium_bomb: { kind: 'weapon', handler: 'battles' },
  colony_ship: { kind: 'unlock', handler: 'pipeline' },
  outpost_ship: { kind: 'unlock', handler: 'pipeline' },
  transport: { kind: 'unlock', handler: 'pipeline' },
  freighter_fleet: { kind: 'unlock', handler: 'pipeline' },
  augmented_engines: { kind: 'ship_special', handler: 'combat' }, // +5 combat speed
  ion_pulse_cannon: { kind: 'weapon', handler: 'combat' },
  shield_capacitor: { kind: 'ship_special', handler: 'combat' }, // shield regen 3% -> 5%/tick
  anti_matter_torpedo: { kind: 'weapon', handler: 'combat' },
  proton_torpedoes: { kind: 'weapon', handler: 'combat' },
  plasma_torpedoes: { kind: 'weapon', handler: 'combat' },
  transporters: { kind: 'ship_special', stub: 'marine transport (Phase 6 boarding)' },
  food_replicators: { kind: 'building', handler: 'economy' }, // 2 prod -> 1 food to cover shortages (economy.ts)
  high_energy_focus: { kind: 'ship_special', handler: 'combat' }, // +50% beam damage
  energy_absorber: { kind: 'ship_special', handler: 'combat' }, // incoming damage x0.75 (monsters use it)
  megafluxers: { kind: 'empire_tech', handler: 'shipdesign' },
  hyper_x_capacitors: { kind: 'ship_special', handler: 'combat' }, // beams cycle 2x

  // ---------------- sociology ----------------
  space_academy: { kind: 'building', handler: 'leaders' }, // +1 leader XP/turn empire-wide (leaders.ts)
  xeno_psychology: { kind: 'empire_tech', stub: 'diplomacy bonus (Phase 6)' },
  alien_management_center: { kind: 'building', handler: 'ground' }, // faster assimilation (ground.ts) + spy defense (espionage.ts)
  stock_exchange: { kind: 'building', modifiers: [col('money_coeff_halves', 2)] },
  astro_university: {
    kind: 'building',
    modifiers: [col('farm_coeff', 1), col('prod_coeff', 1), col('sci_coeff', 1)],
  },
  confederation: { kind: 'system', handler: 'shipdesign' }, // advanced feudal: warships 1/3 cost, research penalty -50% -> -25% (economy)
  imperium: { kind: 'system', handler: 'movement' }, // advanced dictatorship: +50% command points, +20 spy defense (espionage)
  federation: { kind: 'system', handler: 'economy' }, // advanced democracy: +50% money/research bonuses become +75%
  galactic_unification: { kind: 'system', handler: 'economy' }, // advanced unification: +50% farm/prod bonuses become +100%
  galactic_currency_exchange: { kind: 'building', modifiers: [col('money_coeff_halves', 1)] },

  // ---------------- non-application buildables & starting items ----------------
  housing: { kind: 'project', handler: 'economy' },
  trade_goods: { kind: 'project', handler: 'economy' },
  spy: { kind: 'unlock', handler: 'espionage' }, // buildable project: +1 agent (cap 10)
  capitol: { kind: 'building', modifiers: [col('morale_pct', 10)], handler: 'ground' }, // +10 morale; assimilation hub (ground.ts)
  habitat_dome_terraforming: { kind: 'project', stub: 'terraform step (Phase 6)' },
  soil_enrichment_terraforming: { kind: 'project', stub: 'terraform step (Phase 6)' },
  hyper_advanced_construction: { kind: 'empire_tech', stub: 'repeatable bonus (Phase 6)' },
  hyper_advanced_power: { kind: 'empire_tech', stub: 'repeatable bonus (Phase 6)' },
  hyper_advanced_chemistry: { kind: 'empire_tech', stub: 'repeatable bonus (Phase 6)' },
  hyper_advanced_sociology: { kind: 'empire_tech', stub: 'repeatable bonus (Phase 6)' },
  hyper_advanced_computers: { kind: 'empire_tech', stub: 'repeatable bonus (Phase 6)' },
  hyper_advanced_ecology: { kind: 'empire_tech', stub: 'repeatable bonus (Phase 6)' },
  hyper_advanced_physics: { kind: 'empire_tech', stub: 'repeatable bonus (Phase 6)' },
  hyper_advanced_force_fields: { kind: 'empire_tech', stub: 'repeatable bonus (Phase 6)' },
};

/** Race pick implementation ledger (checked by the coverage test). */
export const PICK_STATUS: Record<string, { handler?: string; stub?: string }> = {
  growth1: { handler: 'economy' },
  growth2: { handler: 'economy' },
  growth3: { handler: 'economy' },
  farming1: { handler: 'economy' },
  farming2: { handler: 'economy' },
  farming3: { handler: 'economy' },
  industry1: { handler: 'economy' },
  industry2: { handler: 'economy' },
  industry3: { handler: 'economy' },
  science1: { handler: 'economy' },
  science2: { handler: 'economy' },
  science3: { handler: 'economy' },
  money1: { handler: 'economy' },
  money2: { handler: 'economy' },
  money3: { handler: 'economy' },
  defense1: { handler: 'shipdesign' },
  defense2: { handler: 'shipdesign' },
  defense3: { handler: 'shipdesign' },
  attack1: { handler: 'shipdesign' },
  attack2: { handler: 'shipdesign' },
  attack3: { handler: 'shipdesign' },
  ground1: { handler: 'ground' },
  ground2: { handler: 'ground' },
  ground3: { handler: 'ground' },
  spying1: { handler: 'espionage' },
  spying2: { handler: 'espionage' },
  spying3: { handler: 'espionage' },
  feudal: { handler: 'economy' },
  dictatorship: { handler: 'economy' },
  democracy: { handler: 'economy' },
  unification: { handler: 'economy' },
  lowg_world: { handler: 'economy' },
  highg_world: { handler: 'economy' },
  aquatic: { handler: 'economy' },
  subterranean: { handler: 'economy' },
  large_hw: { handler: 'galaxy' },
  rich_hw: { handler: 'galaxy' },
  poor_hw: { handler: 'galaxy' },
  arti_world: { handler: 'galaxy' },
  cybernetic: { handler: 'economy' },
  lithovore: { handler: 'economy' },
  repulsive: { handler: 'commands' }, // implemented: treaty refusal both directions (validatePropose) + halved leader-offer chance (leaders.ts)
  charismatic: { handler: 'leaders' }, // +offer chance, -25% hire cost (leaders.ts)
  uncreative: { handler: 'research' },
  creative: { handler: 'research' },
  tolerant: { handler: 'economy' },
  fantastic_traders: { handler: 'economy' },
  telepathic: { stub: 'diplomacy/mind control (Phase 6)' },
  lucky: { handler: 'npc' }, // never the victim of bad random events (npc.ts E1)
  omniscient: { stub: 'galaxy visibility (Phase 6)' },
  stealthy_ships: { stub: 'fleet concealment (Phase 6)' },
  trans_dimensional: { handler: 'movement' },
  warlord: { handler: 'pipeline' },
};
