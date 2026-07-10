// Point-to-point FTL: any star to any star within fuel range of the empire's
// support network (colonies/outposts). Speeds come from the best known drive,
// empire-wide, per the drive application effects.

import { ceilDiv } from './imath';
import { starDistance } from './galaxy';
import { leaderEmpireBonuses } from './leaders';
import { CP_SOURCES, CP_USAGE } from './data/index';
import { effectsOf, empireAccum } from './effects';
import type { Empire, GameState, Ship, Star } from './types';

/** best known drive speed in parsecs/turn */
export function driveSpeed(empire: Empire): number {
  const k = (app: string) => empire.knownApps.includes(app);
  let speed = 2; // nuclear drive baseline (starting tech)
  if (k('fusion_drive')) speed = 3;
  if (k('ion_drive')) speed = 4;
  if (k('anti_matter_drive')) speed = 5;
  if (k('hyper_drive')) speed = 6;
  if (k('interphased_drive')) speed = 7;
  if (empire.picks.includes('trans_dimensional')) speed += 2;
  speed += leaderEmpireBonuses(empire).navigatorSpeed;
  return speed;
}

/** fuel range in centiparsecs (thorium = effectively unlimited) */
export function fuelRangeCp(empire: Empire): number {
  const k = (app: string) => empire.knownApps.includes(app);
  let range = 400; // standard fuel cells: 4 parsecs
  if (k('deuterium_fuel_cells')) range = 600;
  if (k('iridium_fuel_cells')) range = 900;
  if (k('uridium_fuel_cells')) range = 1200;
  if (k('thorium_fuel_cells')) range = 1_000_000;
  return range;
}

/** stars that anchor the empire's fuel network (own colonies + outposts) */
export function supportStars(state: GameState, empireId: number): Star[] {
  const starIds = new Set<number>();
  for (const c of state.colonies) {
    if (c.owner !== empireId) continue;
    const planet = state.planets.find((p) => p.id === c.planetId);
    if (planet) starIds.add(planet.starId);
  }
  return state.stars.filter((s) => starIds.has(s.id));
}

export function inRange(state: GameState, empireId: number, dest: Star): boolean {
  const empire = state.empires.find((e) => e.id === empireId);
  if (!empire) return false;
  const range = fuelRangeCp(empire);
  return supportStars(state, empireId).some((s) => starDistance(s, dest) <= range);
}

export function travelTurns(state: GameState, empire: Empire, from: Star, to: Star): number {
  if (from.wormholeTo === to.id) return 1;
  const dist = starDistance(from, to);
  const speed = driveSpeed(empire) * 100; // centiparsecs per turn
  return Math.max(1, ceilDiv(dist, speed));
}

// Orbital-base command points come solely from the buildings' cp_flat effect
// modifiers (star base +2 / battlestation +4 / star fortress +6, matching the
// CP_SOURCES table) — a second hardcoded table here double-counted them 1.5x.

export interface CommandPointInfo {
  sources: number;
  usage: number;
}

/** Command point ledger: colonies + bases + tech + officers vs fleet upkeep.
 * Going over costs 10 BC per point each turn (combat-redesign rule). */
export function commandPoints(state: GameState, empire: Empire): CommandPointInfo {
  let sources = empireAccum(state, empire).cpFlat; // tachyon communications etc.
  sources += leaderEmpireBonuses(empire).cpFlat; // operations officers
  for (const colony of state.colonies) {
    if (colony.owner !== empire.id) continue;
    if (!colony.outpost) sources += CP_SOURCES['colony'] ?? 1;
    for (const b of colony.buildings) {
      for (const m of effectsOf(b)?.modifiers ?? []) {
        if (m.target === 'cp_flat' && m.scope === 'colony') sources += m.amount;
      }
    }
  }
  if (empire.picks.includes('warlord')) sources += CP_SOURCES['warlord_pick_bonus'] ?? 2;
  let usage = 0;
  for (const ship of state.ships) {
    if (ship.owner !== empire.id || ship.designId === null) continue;
    const design = empire.designs.find((d) => d.id === ship.designId);
    if (design) usage += CP_USAGE[design.hull] ?? 0;
  }
  return { sources, usage };
}

export function shipStar(state: GameState, ship: Ship): Star | null {
  if (ship.location.kind !== 'star') return null;
  return state.stars.find((s) => s.id === (ship.location as { starId: number }).starId) ?? null;
}
