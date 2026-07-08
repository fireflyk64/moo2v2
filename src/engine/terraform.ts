// Terraforming (T1 documented decision, mirroring the classic step chains):
// - terraforming project: one climate step per completion —
//   barren→desert, desert→arid, arid→terran, tundra→swamp, swamp→terran,
//   ocean→terran. Cost rises 250 + 250 per prior step on the planet.
// - hostile planets cannot be terraformed, but a Stellar Safety Shield makes
//   the colony live as if barren (economy uses effectiveClimate).
// - energized (toxic-analog) planets can never be terraformed.
// - gaia_transformation: terran→gaia, requires the habitat transformation app.

import type { Climate, Colony, GameState, Planet } from './types';

export const NEXT_TERRAFORM: Partial<Record<Climate, Climate>> = {
  barren: 'desert',
  desert: 'arid',
  arid: 'terran',
  tundra: 'swamp',
  swamp: 'terran',
  ocean: 'terran',
};

export const TERRAFORM_BASE_COST = 250;
export const TERRAFORM_STEP_COST = 250;
export const GAIA_COST = 500;

export function terraformCost(planet: Planet): number {
  return TERRAFORM_BASE_COST + TERRAFORM_STEP_COST * planet.terraformSteps;
}

export function canTerraform(planet: Planet): string | null {
  if (planet.body !== 'planet') return 'only planets can be terraformed';
  if (planet.climate === 'hostile' || planet.climate === 'energized') {
    return `${planet.climate} worlds cannot be terraformed`;
  }
  if (!NEXT_TERRAFORM[planet.climate]) return `${planet.climate} cannot be improved further`;
  return null;
}

export function applyTerraformStep(planet: Planet): Climate | null {
  const next = NEXT_TERRAFORM[planet.climate];
  if (!next) return null;
  planet.climate = next;
  planet.terraformSteps += 1;
  return next;
}

/** Stellar Safety Shield lets a hostile-world colony operate as if barren. */
export function effectiveClimate(planet: Planet, colony: Colony | null): Climate {
  if (planet.climate === 'hostile' && colony && colony.buildings.includes('stellar_safety_shield')) {
    return 'barren';
  }
  return planet.climate;
}

export function unsettledPlanetsInSystem(state: GameState, starId: number): Planet[] {
  return state.planets
    .filter(
      (p) =>
        p.starId === starId &&
        p.body === 'planet' &&
        !state.colonies.some((c) => c.planetId === p.id),
    )
    .sort((a, b) => a.orbit - b.orbit || a.id - b.id);
}
