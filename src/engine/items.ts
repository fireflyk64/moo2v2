// Buildable availability: what a given colony may place in its build queue.
// Buildings are unique per colony; ships/projects repeat. Availability derives
// from the empire's known applications plus the always-known starting items.

import { ALWAYS_KNOWN_ITEMS, applicationById, buildableById, FIELD_ROWS, FIELD_SUBJECTS } from './data/index';
import type { Colony, Empire, GameState, Planet } from './types';
import { planetOf } from './economy';
import { designStats } from './shipdesign';
import { canTerraform, convertiblePlanetsInSystem, terraformCost, unsettledPlanetsInSystem } from './terraform';

/** Ship-like buildables that spawn units instead of colony structures. */
export const SHIP_BUILDABLES = new Set([
  'colony_ship',
  'outpost_ship',
  'transport',
  'freighter_fleet',
  'construction_ship',
]);

/** Buildables gated by a game-mode option instead of a researched
 * application (checked in canQueue; listed for the unlocks audit). */
export const MODE_GATED_BUILDABLES = new Set(['construction_ship']);

/** The planetary construction ship unlocks once EVERY construction field is
 * researched (hyper-advanced repeats excluded) — an endgame construction
 * capstone, only offered when the game option is on. */
export function constructionShipUnlocked(state: GameState, empire: Empire): boolean {
  if (state.settings.modes.constructionShip !== true) return false;
  const done = new Set(empire.completedFields);
  for (const f of FIELD_ROWS) {
    if (FIELD_SUBJECTS[f.id] !== 'construction' || f.id.startsWith('advf_')) continue;
    if (!done.has(f.num)) return false;
  }
  return true;
}

/** Repeatable non-building projects. */
export const PROJECT_BUILDABLES = new Set([
  'housing',
  'trade_goods',
  'spy',
  'terraforming',
  'gaia_transformation',
  'colony_base',
  'artificial_planet',
]);

/** Buildables intentionally unavailable until later phases (documented). Their
 * effect entries in effectsMap carry matching stub notes. */
export const DEFERRED_BUILDABLES = new Set([
  'fighter_garrison', // carrier ops omitted by the combat redesign (documented)
  'flux_shield', // superseded shield tiers stay data-only (planetary shield covers defense)
  'planetary_flux_shield',
  'planetary_barrier_shield',
  'planetary_stellar_safety_shield',
  'artemis_system_net',
  'warp_interdictor',
  'habitat_dome_terraforming', // data artifacts: covered by the terraforming project
  'soil_enrichment_terraforming',
  'super_swarm',
  'spacetime_surfing',
  're_population',
  'barrier',
  'telepathic_training',
  'microlite_construction',
  'adaptive_habitat_lattice',
  'capitol_1',
  'capitol_2',
  'capitol_3',
  'capitol_4',
  'capitol_5',
  'marine_barracks_splinter',
  'armor_barracks_splinter',
]);

/** Buildables whose unlocking application id differs from the buildable id.
 * Kept in lockstep with the data tables by tests/data/unlocks.test.ts. */
export const BUILDABLE_APP_ALIAS: Record<string, string> = {
  artificial_planet: 'artificial_planet_construction',
  freighter_fleet: 'freighters',
  battle_station: 'battlestation',
  robo_miner_plant: 'robominers',
  nanite_factory: 'nano_disassemblers',
  gravity_generator: 'planetary_gravity_generator',
};

function empireKnowsItem(empire: Empire, itemId: string): boolean {
  if ((ALWAYS_KNOWN_ITEMS as readonly string[]).includes(itemId)) return true;
  if (empire.knownApps.includes(itemId)) return true;
  const app = BUILDABLE_APP_ALIAS[itemId];
  return app ? empire.knownApps.includes(app) : false;
}

function climateAllows(itemId: string, planet: Planet): boolean {
  if (itemId === 'soil_enrichment' || itemId === 'subterranean_farms' || itemId === 'weather_controller') {
    return !['barren', 'energized', 'hostile'].includes(planet.climate);
  }
  return true;
}

/** 'design:<id>' queue items build warships from the empire's designs. */
export function parseDesignItem(itemId: string): number | null {
  if (!itemId.startsWith('design:')) return null;
  const n = Number(itemId.slice(7));
  return Number.isSafeInteger(n) ? n : null;
}

/** 'refit:<shipId>:<designId>' queue items rebuild an existing warship to
 * another design of the same hull class at a starbase colony's yard. */
export function parseRefitItem(itemId: string): { shipId: number; designId: number } | null {
  if (!itemId.startsWith('refit:')) return null;
  const [a, b] = itemId.slice(6).split(':');
  const shipId = Number(a);
  const designId = Number(b);
  return Number.isSafeInteger(shipId) && Number.isSafeInteger(designId) ? { shipId, designId } : null;
}

/** shipyard-capable bases (refits need one in orbit) */
export const SHIPYARD_BASES = ['star_base', 'battle_station', 'star_fortress'] as const;

/** MOO2 refit price: the cost difference between the designs, but never less
 * than a quarter of the new design's cost. Null when the refit is invalid
 * (wrong owner/kind, different hull, unknown design). */
export function refitCost(state: GameState, ownerId: number, shipId: number, designId: number): number | null {
  const empire = state.empires.find((e) => e.id === ownerId);
  const ship = state.ships.find((s) => s.id === shipId);
  if (!empire || !ship || ship.owner !== ownerId) return null;
  if (ship.shipKind !== 'design' || ship.designId === null || ship.designId === designId) return null;
  const oldDesign = empire.designs.find((d) => d.id === ship.designId);
  const newDesign = empire.designs.find((d) => d.id === designId);
  if (!oldDesign || !newDesign || newDesign.hull !== oldDesign.hull) return null;
  const oldStats = designStats(state, empire, oldDesign);
  const newStats = designStats(state, empire, newDesign);
  if (typeof oldStats === 'string' || typeof newStats === 'string') return null;
  return Math.max(newStats.cost - oldStats.cost, Math.ceil(newStats.cost / 4));
}

export function itemCost(state: GameState, ownerId: number, itemId: string, colony?: Colony): number | null {
  const designId = parseDesignItem(itemId);
  if (designId !== null) {
    const empire = state.empires.find((e) => e.id === ownerId);
    const design = empire?.designs.find((d) => d.id === designId);
    if (!empire || !design) return null;
    const stats = designStats(state, empire, design);
    return typeof stats === 'string' ? null : stats.cost;
  }
  const refit = parseRefitItem(itemId);
  if (refit !== null) return refitCost(state, ownerId, refit.shipId, refit.designId);
  if (itemId === 'terraforming' && colony) {
    const planet = state.planets.find((p) => p.id === colony.planetId);
    if (planet) return terraformCost(planet);
  }
  return buildableById.get(itemId)?.cost ?? null;
}

/** Can this item be appended to the colony's queue right now? */
export function canQueue(state: GameState, colony: Colony, itemId: string): string | null {
  if (colony.outpost) return 'outposts cannot build';
  const empire = state.empires.find((e) => e.id === colony.owner);
  if (!empire) return 'no empire';

  const designId = parseDesignItem(itemId);
  if (designId !== null) {
    const design = empire.designs.find((d) => d.id === designId);
    if (!design) return `no design ${designId}`;
    if (design.obsolete) return `${design.name} is obsolete`;
    return null;
  }

  const refit = parseRefitItem(itemId);
  if (refit !== null) {
    const cost = refitCost(state, colony.owner, refit.shipId, refit.designId);
    if (cost === null) return 'invalid refit (same hull class, own warship, different design)';
    const ship = state.ships.find((s) => s.id === refit.shipId)!;
    const planet = planetOf(state, colony);
    if (ship.location.kind !== 'star' || ship.location.starId !== planet.starId) {
      return 'the ship must wait at this colony for its refit';
    }
    if (!SHIPYARD_BASES.some((b) => colony.buildings.includes(b))) {
      return 'refits need a star base (or better) at the colony';
    }
    const newDesign = empire.designs.find((d) => d.id === refit.designId)!;
    if (newDesign.obsolete) return `${newDesign.name} is obsolete`;
    return null;
  }

  const b = buildableById.get(itemId);
  if (!b) return `unknown item ${itemId}`;
  if (DEFERRED_BUILDABLES.has(itemId)) return `${itemId} not available yet`;
  if (itemId === 'construction_ship') {
    if (state.settings.modes.constructionShip !== true) return 'the construction-ship game option is off';
    if (!constructionShipUnlocked(state, empire)) return 'requires every construction field to be researched';
  } else if (!empireKnowsItem(empire, itemId)) {
    return `${itemId} not researched`;
  }
  const planet = planetOf(state, colony);
  if (!climateAllows(itemId, planet)) return `${itemId} cannot operate on ${planet.climate}`;
  if (itemId === 'terraforming') {
    const queuedSteps = colony.queue.filter((q) => q.item === 'terraforming').length;
    const blocked = canTerraform(planet, queuedSteps);
    if (blocked) return blocked;
  }
  if (itemId === 'gaia_transformation') {
    if (planet.climate !== 'terran') return 'habitat transformation requires a terran world';
    // one transformation finishes the job: a duplicate queue entry would burn
    // its full cost on a world that is already gaia by the time it completes
    if (colony.queue.some((q) => q.item === 'gaia_transformation')) {
      return 'a habitat transformation is already queued';
    }
  }
  if (itemId === 'colony_base') {
    const open = unsettledPlanetsInSystem(state, planet.starId).length;
    if (open === 0) return 'no unsettled planet in this system';
    // like terraforming, project the queue: more bases than open planets
    // would complete into nothing and burn their production
    const queued = colony.queue.filter((q) => q.item === 'colony_base').length;
    if (queued >= open) return `only ${open} unsettled planet(s) in this system`;
  }
  if (itemId === 'artificial_planet') {
    const candidates = convertiblePlanetsInSystem(state, planet.starId).length;
    if (candidates === 0) return 'no asteroid belt or gas giant in this system';
    // project the queue like colony_base: more conversions than candidate
    // bodies would complete into nothing and burn their production
    const queued = colony.queue.filter((q) => q.item === 'artificial_planet').length;
    if (queued >= candidates) return `only ${candidates} convertible body(ies) in this system`;
  }
  if (itemId === 'spy') {
    const queued = colony.queue.filter((q) => q.item === 'spy').length;
    if (empire.spies.count + queued >= 10) return 'agent roster is full (10)';
  }
  const isShip = SHIP_BUILDABLES.has(itemId);
  const isProject = PROJECT_BUILDABLES.has(itemId);
  if (!isShip && !isProject) {
    if (colony.buildings.includes(itemId)) return `${itemId} already built`;
    if (colony.queue.some((q) => q.item === itemId)) return `${itemId} already queued`;
  }
  return null;
}

/** All items the colony could add (for UI dropdowns). */
export function buildableItems(state: GameState, colony: Colony): string[] {
  const out: string[] = [];
  for (const id of buildableById.keys()) {
    if (canQueue(state, colony, id) === null) out.push(id);
  }
  out.sort();
  const empire = state.empires.find((e) => e.id === colony.owner);
  if (empire && !colony.outpost) {
    for (const d of empire.designs) {
      if (!d.obsolete) out.push(`design:${d.id}`);
    }
  }
  return out;
}

const EXTRA_LABELS: Record<string, string> = {
  freighter_fleet: 'Freighter Fleet (+5)',
  colony_base: 'Colony Base (settle this system)',
  housing: 'Housing (grow population)',
  trade_goods: 'Trade Goods (prod → BC)',
  spy: 'Train Agent',
  terraforming: 'Terraforming',
  gaia_transformation: 'Gaia Transformation',
};

function titleCase(id: string): string {
  return id
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Display label for any queue item: the application's real name when it has
 * one (e.g. supercomputer -> "Planetary Supercomputer"), else a title-cased id. */
export function itemLabel(state: GameState, ownerId: number, itemId: string): string {
  const designId = parseDesignItem(itemId);
  if (designId !== null) {
    const empire = state.empires.find((e) => e.id === ownerId);
    const design = empire?.designs.find((d) => d.id === designId);
    return design ? `⚔ ${design.name}` : itemId;
  }
  const refit = parseRefitItem(itemId);
  if (refit !== null) {
    const empire = state.empires.find((e) => e.id === ownerId);
    const design = empire?.designs.find((d) => d.id === refit.designId);
    return design ? `⟳ Refit → ${design.name}` : itemId;
  }
  const extra = EXTRA_LABELS[itemId];
  if (extra) return extra;
  const app = applicationById.get(itemId) ?? applicationById.get(BUILDABLE_APP_ALIAS[itemId] ?? '');
  return app?.name ?? titleCase(itemId);
}

/** True when the application exists (guards against typo'd ids in commands). */
export function isKnownApplicationId(appId: string): boolean {
  return applicationById.has(appId);
}
