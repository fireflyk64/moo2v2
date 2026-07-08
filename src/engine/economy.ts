// Colony economy: output, morale, pollution, money, max population, growth.
// Implements the formula decisions F1-F14 documented in data/README.md, all in
// integer math (roundDiv = spreadsheet ROUND, floorDiv = ROUNDDOWN, ceilDiv =
// ROUNDUP semantics for the non-negative quantities involved).

import { buildableById } from './data/index';
import { ceilDiv, floorDiv, roundDiv } from './imath';
import { isqrt } from './isqrt';
import { gravitySteps, resolveTraits, type RaceTraits } from './race';
import type { Climate, Colony, Empire, GameState, Minerals, Planet, PopGroup } from './types';

// ---------- lookup helpers ----------

export function traitsOf(empire: Empire): RaceTraits {
  return resolveTraits(empire.picks);
}

export function planetOf(state: GameState, colony: Colony): Planet {
  const p = state.planets.find((x) => x.id === colony.planetId);
  if (!p) throw new Error(`colony ${colony.id} planet missing`);
  return p;
}

export function empireOf(state: GameState, id: number): Empire {
  const e = state.empires.find((x) => x.id === id);
  if (!e) throw new Error(`empire ${id} missing`);
  return e;
}

export function colonyPopUnits(colony: Colony): number {
  let units = 0;
  for (const g of colony.groups) units += floorDiv(g.popK, 1000);
  return units;
}

export function groupUnits(g: PopGroup): number {
  return floorDiv(g.popK, 1000);
}

function has(colony: Colony, building: string): boolean {
  return colony.buildings.includes(building);
}

function knows(empire: Empire, app: string): boolean {
  return empire.knownApps.includes(app);
}

// ---------- F6: max population ----------

const CLIMATE_POP_PCT: Record<Climate, number> = {
  hostile: 25,
  energized: 25,
  barren: 25,
  desert: 25,
  tundra: 25,
  ocean: 25,
  swamp: 40,
  arid: 60,
  terran: 80,
  gaia: 100,
};

export function maxPopulation(planet: Planet, traits: RaceTraits, colony?: Colony): number {
  let pct = CLIMATE_POP_PCT[planet.climate];
  if (traits.aquatic) {
    if (planet.climate === 'ocean' || planet.climate === 'terran') pct = 100;
    else if (planet.climate === 'tundra' || planet.climate === 'swamp') pct = 80;
  }
  if (traits.tolerant && planet.climate !== 'terran' && planet.climate !== 'gaia') {
    pct = Math.min(100, pct + 25);
  }
  const sizeMult = planet.sizeClass * 5; // tiny 5 .. huge 25
  let max = roundDiv(sizeMult * pct, 100);
  if (traits.subterranean) max += 2 * planet.sizeClass;
  if (colony) {
    if (has(colony, 'habitat_domes')) max += 2;
  }
  return max;
}

// ---------- F3/F4/F5: per-colonist coefficients ----------

export function foodPerFarmerBase(climate: Climate, aquatic: boolean): number {
  if (aquatic) {
    if (climate === 'ocean' || climate === 'terran' || climate === 'gaia') return 3;
    if (climate === 'tundra' || climate === 'swamp') return 2;
    if (climate === 'desert' || climate === 'arid') return 1;
    return 0;
  }
  switch (climate) {
    case 'gaia':
      return 3;
    case 'swamp':
    case 'ocean':
    case 'terran':
      return 2;
    case 'desert':
    case 'arid':
    case 'tundra':
      return 1;
    default:
      return 0;
  }
}

const MINERAL_PROD: Record<Minerals, number> = {
  ultra_poor: 1,
  poor: 2,
  abundant: 3,
  rich: 5,
  ultra_rich: 8,
};

// building coefficient / flat tables (F2 + SW-Calc constants)
const FARM_COEFF_BUILDINGS: Array<[string, number]> = [
  ['soil_enrichment', 1],
  ['weather_controller', 2],
  ['astro_university', 1],
];
const FARM_FLAT_BUILDINGS: Array<[string, number]> = [
  ['hydroponic_farm', 2],
  ['subterranean_farms', 4],
];
const PROD_COEFF_BUILDINGS: Array<[string, number]> = [
  ['automated_factory', 1],
  ['robo_miner_plant', 2],
  ['deep_core_mine', 3],
  ['astro_university', 1],
];
const PROD_FLAT_BUILDINGS: Array<[string, number]> = [
  ['automated_factory', 5],
  ['robo_miner_plant', 10],
  ['deep_core_mine', 15],
];
const SCI_COEFF_BUILDINGS: Array<[string, number]> = [
  ['research_lab', 1],
  ['supercomputer', 2],
  ['galactic_cybernet', 3],
  ['astro_university', 1],
];
const SCI_FLAT_BUILDINGS: Array<[string, number]> = [
  ['research_lab', 5],
  ['supercomputer', 10],
  ['galactic_cybernet', 15],
  ['autolab', 30],
];

function buildingSum(colony: Colony, table: Array<[string, number]>): number {
  let s = 0;
  for (const [id, v] of table) if (has(colony, id)) s += v;
  return s;
}

// ---------- F10: morale ----------

export function moralePct(state: GameState, colony: Colony): number {
  const empire = empireOf(state, colony.owner);
  const traits = traitsOf(empire);
  if (traits.government === 'unification') return 0; // immune either way
  let morale = 0;
  if (traits.government === 'dictatorship' || traits.government === 'feudal') {
    if (!has(colony, 'marine_barracks') && !has(colony, 'armor_barracks')) morale -= 20;
  }
  if (has(colony, 'holo_simulator')) morale += 20;
  if (has(colony, 'pleasure_dome')) morale += 30;
  if (knows(empire, 'civic_insight') && traits.government === 'dictatorship') morale += 10;
  return morale;
}

// ---------- F2: colony output ----------

export interface ColonyOutput {
  food: number;
  foodConsumed: number;
  foodNet: number;
  prod: number; // net production after pollution + cybernetic upkeep
  prodConsumed: number; // cybernetic races eat half a production point per unit
  prodLack: number;
  pollution: number;
  research: number;
  bcIncome: number; // before empire-level costs, after building maintenance
  maintenance: number;
  moralePct: number;
  maxPop: number;
  popUnits: number;
  /** production diverted to housing this turn (0 unless active item is housing) */
  housingPP: number;
  /** BC from trade goods diversion */
  tradeBC: number;
  /** whether prod goes to the build queue (false when housing/trade goods active) */
  prodToQueue: number;
}

type OutputKind = 'farm' | 'prod' | 'sci';

function cTotalPct(kind: OutputKind, traits: RaceTraits, morale: number): number {
  if (traits.government === 'unification') {
    return kind === 'sci' ? 0 : 50;
  }
  let c = morale;
  if (kind === 'sci') {
    if (traits.government === 'democracy') c += 50;
    if (traits.government === 'feudal') c -= 50;
  }
  return c;
}

export function colonyOutput(state: GameState, colony: Colony): ColonyOutput {
  const planet = planetOf(state, colony.planetId ? colony : colony); // keep call sites simple
  return computeOutput(state, colony, planet);
}

function computeOutput(state: GameState, colony: Colony, planet: Planet): ColonyOutput {
  const owner = empireOf(state, colony.owner);
  const ownerTraits = traitsOf(owner);
  const morale = moralePct(state, colony);
  const popUnits = colonyPopUnits(colony);
  const maxPop = maxPopulation(planet, ownerTraits, colony);

  // per-kind: base (Σ colonists × coeff) and per-colonist penalties
  let farmBase = 0;
  let prodBase = 0;
  let sciBase = 0;
  let farmPenalty = 0;
  let prodPenalty = 0;
  let sciPenalty = 0;
  let foodNeedHalves = 0; // per-unit consumption in half-food units
  let prodNeedHalves = 0;

  for (const g of colony.groups) {
    const gTraits = g.race === colony.owner ? ownerTraits : groupTraits(state, g.race, ownerTraits);
    const units = groupUnits(g);
    const gravPen = planetHasGravityFix(colony) ? 0 : gravitySteps(gTraits.gravityPref, planet.gravity) * 25;

    const farmCoeff = Math.max(
      0,
      foodPerFarmerBase(planet.climate, gTraits.aquatic) + gTraits.farming + buildingSum(colony, FARM_COEFF_BUILDINGS),
    );
    const prodCoeff = Math.max(1, MINERAL_PROD[planet.minerals] + gTraits.industry + buildingSum(colony, PROD_COEFF_BUILDINGS));
    let sciCoeff = Math.max(1, 3 + gTraits.science + buildingSum(colony, SCI_COEFF_BUILDINGS));
    if (planet.special === 'ancient_artifacts') sciCoeff += 2;

    const gFarm = g.farmers * farmCoeff;
    const gProd = g.workers * prodCoeff;
    const gSci = g.scientists * sciCoeff;
    farmBase += gFarm;
    prodBase += gProd;
    sciBase += gSci;

    if (gravPen > 0) {
      farmPenalty += roundDiv(gFarm * gravPen, 100);
      prodPenalty += roundDiv(gProd * gravPen, 100);
      sciPenalty += roundDiv(gSci * gravPen, 100);
    }

    if (gTraits.lithovore) {
      // no food
    } else if (gTraits.cybernetic) {
      foodNeedHalves += units;
      prodNeedHalves += units;
    } else {
      foodNeedHalves += units * 2;
    }
  }

  // farming: unification/morale multiplier, then flat buildings
  const farmWorker = roundDiv(farmBase * (100 + cTotalPct('farm', ownerTraits, morale)), 100) - farmPenalty;
  const food = Math.max(0, farmWorker) + buildingSum(colony, FARM_FLAT_BUILDINGS);

  // production before pollution
  const prodWorkerRaw = roundDiv(prodBase * (100 + cTotalPct('prod', ownerTraits, morale)), 100) - prodPenalty;
  const prodWorker = Math.max(0, prodWorkerRaw);

  // F8 pollution (flat building production exempt)
  let pollution = 0;
  if (!has(colony, 'core_waste_dump')) {
    let divisor = 1;
    if (has(colony, 'pollution_processor')) divisor *= 2;
    if (has(colony, 'atmospheric_renewer')) divisor *= 4;
    let tolNum = 0;
    let tolDen = 0;
    for (const g of colony.groups) {
      const gTraits = g.race === colony.owner ? ownerTraits : groupTraits(state, g.race, ownerTraits);
      const units = groupUnits(g);
      tolDen += units;
      if (!gTraits.tolerant) tolNum += units;
    }
    if (tolDen > 0 && tolNum > 0) {
      let absorb = 2 * planet.sizeClass;
      if (knows(owner, 'nano_disassemblers')) absorb *= 2;
      const scaled = roundDiv(prodWorker * tolNum, divisor * tolDen);
      pollution = Math.max(0, ceilDiv(Math.max(0, scaled - absorb), 2));
    }
  }
  const prodGross = Math.max(0, prodWorker + buildingSum(colony, PROD_FLAT_BUILDINGS) - pollution);
  const prodConsumed = ceilDiv(prodNeedHalves, 2);
  const prodLack = Math.max(0, prodConsumed - prodGross);
  const prod = Math.max(0, prodGross - prodConsumed);

  // research
  const sciWorker = roundDiv(sciBase * (100 + cTotalPct('sci', ownerTraits, morale)), 100) - sciPenalty;
  const research = Math.max(0, sciWorker) + buildingSum(colony, SCI_FLAT_BUILDINGS);

  // ---------- F7 money ----------
  const special = planet.special === 'gem_deposits' ? 10 : planet.special === 'gold_deposits' ? 5 : 0;
  const popIncome = roundDiv(popUnits * (2 + ownerTraits.bcHalves), 2);
  let bonusIncome = 0;
  const baseForBonus = special + popIncome;
  if (has(colony, 'stock_exchange')) bonusIncome += floorDiv(baseForBonus * 2, 2); // ×1
  if (has(colony, 'galactic_currency_exchange')) bonusIncome += floorDiv(baseForBonus, 2); // ×0.5
  if (ownerTraits.government === 'democracy') bonusIncome += floorDiv(baseForBonus, 2); // ×0.5
  if (ownerTraits.government !== 'unification') {
    bonusIncome += roundDiv(popIncome * morale, 100);
  }
  let maintBase = 0;
  for (const b of colony.buildings) {
    maintBase += state.settings ? maintenanceOf(b) : 0;
  }
  const maintPenalty = planet.climate === 'hostile' ? 50 : planet.climate === 'energized' || planet.climate === 'desert' ? 25 : 0;
  const maintenance = roundDiv(maintBase * (100 + maintPenalty), 100);
  const bcIncome = special + popIncome + bonusIncome - maintenance;

  // food consumption
  const foodConsumed = ceilDiv(foodNeedHalves, 2);

  // build diversion: housing / trade goods
  const active = colony.queue[0]?.item ?? null;
  let housingPP = 0;
  let tradeBC = 0;
  let prodToQueue = prod;
  if (active === 'housing') {
    housingPP = prod;
    prodToQueue = 0;
  } else if (active === 'trade_goods') {
    tradeBC = ownerTraits.fantasticTraders ? prod : floorDiv(prod, 2);
    prodToQueue = 0;
  }

  return {
    food,
    foodConsumed,
    foodNet: food - foodConsumed,
    prod,
    prodConsumed,
    prodLack,
    pollution,
    research,
    bcIncome: bcIncome + tradeBC,
    maintenance,
    moralePct: morale,
    maxPop,
    popUnits,
    housingPP,
    tradeBC,
    prodToQueue,
  };
}

/** Traits for non-owner pop groups (natives etc.). Phase 6 refines this. */
function groupTraits(state: GameState, race: number, fallback: RaceTraits): RaceTraits {
  if (race >= 0) {
    const e = state.empires.find((x) => x.id === race);
    if (e) return traitsOf(e);
  }
  return fallback;
}

function planetHasGravityFix(colony: Colony): boolean {
  return colony.buildings.includes('gravity_generator');
}

export function maintenanceOf(buildingId: string): number {
  return buildableById.get(buildingId)?.maintenance ?? 0;
}

// ---------- F1: population growth ----------

export interface GrowthInput {
  /** growth-affecting tech/leader bonuses in percent (medicine etc.) */
  medicinePct: number;
}

export function groupGrowthK(
  state: GameState,
  colony: Colony,
  group: PopGroup,
  maxPop: number,
  totalUnits: number,
): number {
  const owner = empireOf(state, colony.owner);
  const ownerTraits = traitsOf(owner);
  const gTraits = group.race === colony.owner ? ownerTraits : groupTraits(state, group.race, ownerTraits);
  const c = groupUnits(group);
  const free = Math.max(0, maxPop - totalUnits);
  if (c <= 0) return group.popK > 0 && free > 0 ? 20 : 0; // fractional seed group still grows slowly
  if (free <= 0 && group.popK >= c * 1000) {
    // full planet: no natural growth (housing/growth center still apply below via 0 base)
  }
  const basic = maxPop > 0 ? isqrt(floorDiv(2000 * c * free, maxPop)) : 0;

  let bonusPct = gTraits.growthPct;
  if (knows(owner, 'universal_wellness_protocol')) bonusPct += 50;
  else if (knows(owner, 'wellness_systems')) bonusPct += 25;
  // housing: % = floor(housingPP * 40 / colonists-of-this-race)
  if (colony.housingPPPrev > 0 && c > 0) {
    bonusPct += floorDiv(colony.housingPPPrev * 40, c);
  }

  let inc = floorDiv(basic * (100 + Math.max(-90, bonusPct)), 100);
  if (has(colony, 'population_growth_center')) inc += 100;

  // food shortage penalty (colony-wide lack attributed to this group's share)
  if (colony.foodLackPrev > 0 || colony.prodLackPrev > 0) {
    if (gTraits.cybernetic) {
      inc -= 25 * colony.foodLackPrev + 25 * colony.prodLackPrev;
    } else {
      inc -= 50 * colony.foodLackPrev;
    }
  }
  return inc;
}

// ---------- F9: buy cost ----------

export function buyCost(totalCost: number, invested: number): number {
  const x = totalCost;
  const y = Math.min(invested, x);
  if (y >= x) return 0;
  if (y * 10 < x) return 4 * x - 10 * y; // <10% done
  if (y * 2 < x) return floorDiv(7 * x - 10 * y, 2); // 10-50%: 3.5X - 5Y
  return 2 * (x - y); // >=50%
}
