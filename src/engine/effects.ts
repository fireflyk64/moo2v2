// Pluggable effects: declarative modifiers on data rows plus handler tags for
// coded systems. Buildings contribute at colony scope (structure present);
// techs contribute at empire scope (application known). A coverage test keeps
// every tech application accounted for (modifier | handler | explicit stub).

import { EFFECTS, EFFECT_ALIASES, type EffectSpec } from './data/effectsMap';
import { leaderColonyModifiers } from './leaders';
import type { Colony, Empire, GameState, Minerals } from './types';

export type ModifierTarget =
  | 'farm_coeff'
  | 'prod_coeff'
  | 'sci_coeff'
  | 'farm_flat'
  | 'prod_flat'
  | 'sci_flat'
  | 'farm_pct'
  | 'prod_pct'
  | 'sci_pct'
  | 'bc_pct'
  | 'morale_pct'
  | 'max_pop'
  | 'growth_pct'
  | 'growth_flat_k'
  | 'money_coeff_halves'
  | 'pollution_divisor_mult'
  | 'pollution_absorb_x2'
  | 'pollution_absorb_flat'
  | 'pollution_zero'
  | 'spy_offense'
  | 'spy_defense'
  | 'scan'
  | 'stealth'
  | 'cp_flat';

export interface Modifier {
  target: ModifierTarget;
  amount: number;
  scope: 'colony' | 'empire';
}

export function effectsOf(id: string): EffectSpec | undefined {
  return EFFECTS[EFFECT_ALIASES[id] ?? id];
}

export interface ColonyAccum {
  farmCoeff: number;
  prodCoeff: number;
  sciCoeff: number;
  farmFlat: number;
  prodFlat: number;
  sciFlat: number;
  farmPct: number;
  prodPct: number;
  sciPct: number;
  bcPct: number;
  pollutionAbsorbFlat: number;
  moralePct: number;
  maxPop: number;
  growthPct: number;
  growthFlatK: number;
  moneyCoeffHalves: number;
  pollutionDivisorMult: number;
  pollutionAbsorbX2: boolean;
  pollutionZero: boolean;
  cpFlat: number;
  spyOffense: number;
  spyDefense: number;
  scan: number;
  stealth: number;
}

function blank(): ColonyAccum {
  return {
    farmCoeff: 0,
    prodCoeff: 0,
    sciCoeff: 0,
    farmFlat: 0,
    prodFlat: 0,
    sciFlat: 0,
    farmPct: 0,
    prodPct: 0,
    sciPct: 0,
    bcPct: 0,
    pollutionAbsorbFlat: 0,
    moralePct: 0,
    maxPop: 0,
    growthPct: 0,
    growthFlatK: 0,
    moneyCoeffHalves: 0,
    pollutionDivisorMult: 1,
    pollutionAbsorbX2: false,
    pollutionZero: false,
    cpFlat: 0,
    spyOffense: 0,
    spyDefense: 0,
    scan: 0,
    stealth: 0,
  };
}

function fold(acc: ColonyAccum, mods: Modifier[] | undefined, scope: 'colony' | 'empire'): void {
  if (!mods) return;
  for (const m of mods) {
    if (m.scope !== scope) continue;
    switch (m.target) {
      case 'farm_coeff':
        acc.farmCoeff += m.amount;
        break;
      case 'prod_coeff':
        acc.prodCoeff += m.amount;
        break;
      case 'sci_coeff':
        acc.sciCoeff += m.amount;
        break;
      case 'farm_flat':
        acc.farmFlat += m.amount;
        break;
      case 'prod_flat':
        acc.prodFlat += m.amount;
        break;
      case 'sci_flat':
        acc.sciFlat += m.amount;
        break;
      case 'farm_pct':
        acc.farmPct += m.amount;
        break;
      case 'prod_pct':
        acc.prodPct += m.amount;
        break;
      case 'sci_pct':
        acc.sciPct += m.amount;
        break;
      case 'bc_pct':
        acc.bcPct += m.amount;
        break;
      case 'pollution_absorb_flat':
        acc.pollutionAbsorbFlat += m.amount;
        break;
      case 'morale_pct':
        acc.moralePct += m.amount;
        break;
      case 'max_pop':
        acc.maxPop += m.amount;
        break;
      case 'growth_pct':
        acc.growthPct += m.amount;
        break;
      case 'growth_flat_k':
        acc.growthFlatK += m.amount;
        break;
      case 'money_coeff_halves':
        acc.moneyCoeffHalves += m.amount;
        break;
      case 'pollution_divisor_mult':
        acc.pollutionDivisorMult *= m.amount;
        break;
      case 'pollution_absorb_x2':
        acc.pollutionAbsorbX2 = true;
        break;
      case 'pollution_zero':
        acc.pollutionZero = true;
        break;
      case 'spy_offense':
        acc.spyOffense += m.amount;
        break;
      case 'spy_defense':
        acc.spyDefense += m.amount;
        break;
      case 'scan':
        acc.scan += m.amount;
        break;
      case 'stealth':
        acc.stealth += m.amount;
        break;
      case 'cp_flat':
        acc.cpFlat += m.amount;
        break;
    }
  }
}

const ROBOTIC_FACTORY_PROD: Record<Minerals, number> = {
  ultra_poor: 5,
  poor: 10,
  abundant: 15,
  rich: 20,
  ultra_rich: 25,
};

/** Combined building (colony scope) + tech (empire scope) accumulation. */
export function colonyAccum(state: GameState, colony: Colony, empire: Empire): ColonyAccum {
  const acc = blank();
  for (const b of colony.buildings) {
    const spec = effectsOf(b);
    fold(acc, spec?.modifiers, 'colony');
  }
  for (const app of empire.knownApps) {
    const spec = effectsOf(app);
    fold(acc, spec?.modifiers, 'empire');
  }
  // colony leaders administer the whole star system (Phase 6; bugs.md)
  fold(acc, leaderColonyModifiers(state, empire, colony.id), 'colony');

  // ---- coded colony handlers ----
  if (colony.buildings.includes('robotic_factory')) {
    const planet = state.planets.find((p) => p.id === colony.planetId);
    if (planet) acc.prodFlat += ROBOTIC_FACTORY_PROD[planet.minerals];
  }
  // recyclotron: +1 production per population unit, pollution-free (flat is exempt)
  if (colony.buildings.includes('recyclotron')) {
    let units = 0;
    for (const g of colony.groups) units += Math.floor(g.popK / 1000);
    acc.prodFlat += units;
  }
  // virtual reality network lifts morale empire-wide from any one colony
  if (
    !colony.buildings.includes('virtual_reality_network') &&
    state.colonies.some((c) => c.owner === empire.id && c.buildings.includes('virtual_reality_network'))
  ) {
    acc.moralePct += 20;
  }
  // universal wellness supersedes wellness systems (not cumulative)
  if (empire.knownApps.includes('universal_wellness_protocol') && empire.knownApps.includes('wellness_systems')) {
    acc.growthPct -= 25; // remove the superseded +25
  }
  return acc;
}

/** Empire-only accumulation (for CP, spies, scanning — no colony context). */
export function empireAccum(state: GameState, empire: Empire): ColonyAccum {
  const acc = blank();
  for (const app of empire.knownApps) {
    const spec = effectsOf(app);
    fold(acc, spec?.modifiers, 'empire');
  }
  return acc;
}
