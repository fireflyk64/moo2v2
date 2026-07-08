// Buildable availability: what a given colony may place in its build queue.
// Buildings are unique per colony; ships/projects repeat. Availability derives
// from the empire's known applications plus the always-known starting items.

import { ALWAYS_KNOWN_ITEMS, applicationById, buildableById } from './data/index';
import type { Colony, Empire, GameState, Planet } from './types';
import { planetOf } from './economy';
import { designStats } from './shipdesign';

/** Ship-like buildables that spawn units instead of colony structures. */
export const SHIP_BUILDABLES = new Set([
  'colony_ship',
  'outpost_ship',
  'transport',
  'freighter_fleet',
]);

/** Repeatable non-building projects. */
export const PROJECT_BUILDABLES = new Set(['housing', 'trade_goods', 'spy']);

/** Buildables intentionally unavailable until later phases (documented). */
const DEFERRED = new Set([
  'spy', // espionage arrives in Phase 6
  'colony_base',
  'artificial_planet',
  'habitat_dome_terraforming',
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

function empireKnowsItem(empire: Empire, itemId: string): boolean {
  if ((ALWAYS_KNOWN_ITEMS as readonly string[]).includes(itemId)) return true;
  if (empire.knownApps.includes(itemId)) return true;
  // buildables whose application id differs but maps 1:1 (colony/outpost/transport ships)
  const alias: Record<string, string> = {
    freighter_fleet: 'freighters',
    transport: 'transport',
    colony_ship: 'colony_ship',
    outpost_ship: 'outpost_ship',
    housing: 'housing',
    trade_goods: 'trade_goods',
  };
  const app = alias[itemId];
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

export function itemCost(state: GameState, ownerId: number, itemId: string): number | null {
  const designId = parseDesignItem(itemId);
  if (designId !== null) {
    const empire = state.empires.find((e) => e.id === ownerId);
    const design = empire?.designs.find((d) => d.id === designId);
    if (!empire || !design) return null;
    const stats = designStats(state, empire, design);
    return typeof stats === 'string' ? null : stats.cost;
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

  const b = buildableById.get(itemId);
  if (!b) return `unknown item ${itemId}`;
  if (DEFERRED.has(itemId)) return `${itemId} not available yet`;
  if (!empireKnowsItem(empire, itemId)) return `${itemId} not researched`;
  const planet = planetOf(state, colony);
  if (!climateAllows(itemId, planet)) return `${itemId} cannot operate on ${planet.climate}`;
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

/** Display label for any queue item. */
export function itemLabel(state: GameState, ownerId: number, itemId: string): string {
  const designId = parseDesignItem(itemId);
  if (designId !== null) {
    const empire = state.empires.find((e) => e.id === ownerId);
    const design = empire?.designs.find((d) => d.id === designId);
    return design ? `⚔ ${design.name}` : itemId;
  }
  return itemId;
}

/** True when the application exists (guards against typo'd ids in commands). */
export function isKnownApplicationId(appId: string): boolean {
  return applicationById.has(appId);
}
