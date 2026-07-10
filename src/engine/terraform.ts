// Terraforming (T1 documented decision, mirroring the classic step chains):
// - terraforming project: one climate step per completion —
//   barren→desert OR tundra (per the docs; deterministic by planet id),
//   desert→arid, arid→terran, tundra→swamp, swamp→terran, ocean→terran.
//   Both barren branches reach terran in three steps.
//   Cost rises 250 + 250 per prior step on the planet.
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
// (gaia's cost comes from the buildable table like any other project)

export function terraformCost(planet: Planet): number {
  return TERRAFORM_BASE_COST + TERRAFORM_STEP_COST * planet.terraformSteps;
}

export function canTerraform(planet: Planet, queuedSteps = 0): string | null {
  if (planet.body !== 'planet') return 'only planets can be terraformed';
  if (planet.climate === 'hostile' || planet.climate === 'energized') {
    return `${planet.climate} worlds cannot be terraformed`;
  }
  // validate against the climate PROJECTED past steps already in the queue —
  // a second step queued past the top of the chain would burn full production
  // for nothing
  let climate: Climate | undefined = planet.climate;
  for (let i = 0; i < queuedSteps; i++) {
    climate = climate === 'barren' && planet.id % 2 === 1 ? 'tundra' : NEXT_TERRAFORM[climate!];
    if (!climate) return 'terraforming already queued to the top of the chain';
  }
  if (!NEXT_TERRAFORM[climate!]) return `${climate} cannot be improved further`;
  return null;
}

export function applyTerraformStep(planet: Planet): Climate | null {
  let next = NEXT_TERRAFORM[planet.climate];
  if (!next) return null;
  // docs: "Barren becomes desert or tundra" — decided deterministically by
  // the planet's id so every peer folds the same climate
  if (planet.climate === 'barren' && planet.id % 2 === 1) next = 'tundra';
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
