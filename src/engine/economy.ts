// Colony economy: output, morale, pollution, money, max population, growth.
// Implements the formula decisions F1-F14 documented in data/README.md, all in
// integer math (roundDiv = spreadsheet ROUND, floorDiv = ROUNDDOWN, ceilDiv =
// ROUNDUP semantics for the non-negative quantities involved).

import { buildableById } from './data/index';
import { colonyAccum, type ColonyAccum } from './effects';
import { effectiveClimate } from './terraform';
import { isBlockaded } from './ground';
import { ceilDiv, floorDiv, roundDiv } from './imath';
import { isqrt } from './isqrt';
import { hasAdvancedGov, gravitySteps, resolveTraits, type RaceTraits } from './race';
import { ANDROID_RACE, NATIVE_RACE } from './types';
import type { Climate, Colony, Empire, GameState, Minerals, Planet, PopGroup } from './types';

// ---------- lookup helpers ----------

export function traitsOf(empire: Empire): RaceTraits {
  return resolveTraits(empire.picks);
}

/** Freighters tied up hauling colonists between systems (5 per unit) — they
 * cannot move food while en route. */
export function busyFreighters(state: GameState, empireId: number): number {
  let n = 0;
  for (const t of state.popTransits ?? []) {
    if (t.empireId === empireId) n += 5 * t.units;
  }
  return n;
}

/** Freighters available for food logistics right now. */
export function freeFreighters(state: GameState, empire: Empire): number {
  return Math.max(0, empire.freighters - busyFreighters(state, empire.id));
}

/** One empire's food shipping for a turn, resolved. Food moves ONLY on owned
 * freighter fleets (no freighters = no shipping — a deficit colony starves no
 * matter how much food rots elsewhere); blockaded colonies receive nothing.
 * This is THE food-logistics arithmetic: the turn pipeline charges from it and
 * the UI projects from it, so the number on screen is the number that happens. */
export interface FoodLogistics {
  /** food units hauled colony-to-colony by owned freighters this turn */
  freighterFood: number;
  /** freighters in use: food hauls + colonists in transit (5 per unit) */
  freightersInUse: number;
  /** upkeep for freighters in use, 0.5 BC each rounded up (idle hulls free) */
  freighterUpkeep: number;
  /** colonyId -> food units still short after shipping (starvation applies) */
  lack: Map<number, number>;
  /** surplus left after shipping (fantastic traders mint it into BC) */
  leftoverSurplus: number;
}

export function foodLogistics(
  state: GameState,
  empire: Empire,
  outputOf: (colony: Colony) => { foodNet: number },
): FoodLogistics {
  const mine = state.colonies.filter((c) => c.owner === empire.id && !c.outpost);
  let surplus = 0;
  const deficits: Array<{ colony: Colony; lack: number }> = [];
  for (const c of mine) {
    const net = outputOf(c).foodNet;
    if (net >= 0) surplus += net;
    else deficits.push({ colony: c, lack: -net });
  }
  let capacity = freeFreighters(state, empire); // 1 food per freighter (5 per fleet)
  let freighterFood = 0;
  const lack = new Map<number, number>();
  deficits.sort((a, b) => a.colony.id - b.colony.id);
  for (const d of deficits) {
    // blockaded colonies cannot receive deliveries at all
    const moved = isBlockaded(state, d.colony) ? 0 : Math.min(d.lack, surplus, capacity);
    surplus -= moved;
    capacity -= moved;
    freighterFood += moved;
    d.lack -= moved;
    lack.set(d.colony.id, d.lack);
  }
  const freightersInUse = freighterFood + busyFreighters(state, empire.id);
  return {
    freighterFood,
    freightersInUse,
    freighterUpkeep: freightersInUse > 0 ? ceilDiv(freightersInUse, 2) : 0,
    lack,
    leftoverSurplus: surplus,
  };
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

// ---------- marines ----------
// Marines are trained garrison counters (no food, no jobs): barracks train
// one per MARINE_TRAIN_TURNS up to MARINE_CAP_PER_BARRACKS each; a transport
// boards a full squad of MARINES_PER_TRANSPORT at build time and invasions
// are fought marines-vs-marines (ground.ts).

export const BARRACKS_BUILDINGS = ['marine_barracks', 'armor_barracks'] as const;
export const MARINES_PER_TRANSPORT = 4;
export const MARINE_TRAIN_TURNS = 5;
export const MARINE_CAP_PER_BARRACKS = 4;

export function barracksCount(colony: Colony): number {
  return BARRACKS_BUILDINGS.filter((b) => colony.buildings.includes(b)).length;
}

export function marineCap(colony: Colony): number {
  return MARINE_CAP_PER_BARRACKS * barracksCount(colony);
}

/** Trained marines garrisoned at the colony. Saves from before the marine
 * system default to one full squad per standing barracks — an old fortified
 * colony loads defended, not stripped. */
export function marinesOf(colony: Colony): number {
  return colony.marines ?? MARINES_PER_TRANSPORT * barracksCount(colony);
}

/** Marines aboard a transport (older saves carried none). */
export function shipMarines(ship: { marines?: number }): number {
  return ship.marines ?? 0;
}

export function groupUnits(g: PopGroup): number {
  return floorDiv(g.popK, 1000);
}

/** android units on a colony (their compact compartments have their own cap) */
export function androidUnitsOf(colony: Colony): number {
  let units = 0;
  for (const g of colony.groups) if (g.race === ANDROID_RACE) units += groupUnits(g);
  return units;
}

/** organic units only: the count every climate-population-cap comparison must
 * use — androids never occupy organic housing (bugs.md). One helper so the
 * validators, the growth pipeline, and the transit landings cannot disagree. */
export function organicUnitsOf(colony: Colony): number {
  return colonyPopUnits(colony) - androidUnitsOf(colony);
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

export function maxPopulation(planet: Planet, traits: RaceTraits, bonusPop = 0, climateOverride?: Climate): number {
  const climate = climateOverride ?? planet.climate;
  let pct = CLIMATE_POP_PCT[climate];
  if (traits.aquatic) {
    if (climate === 'ocean' || climate === 'terran') pct = 100;
    else if (climate === 'tundra' || climate === 'swamp') pct = 80;
  }
  if (traits.tolerant && climate !== 'terran' && climate !== 'gaia') {
    pct = Math.min(100, pct + 25);
  }
  const sizeMult = planet.sizeClass * 5; // tiny 5 .. huge 25
  let max = roundDiv(sizeMult * pct, 100);
  if (traits.subterranean) max += 2 * planet.sizeClass;
  return max + bonusPop;
}

/** Max population including building/tech bonuses (habitat domes, city planning). */
export function colonyMaxPop(state: GameState, colony: Colony): number {
  const empire = empireOf(state, colony.owner);
  const acc = colonyAccum(state, colony, empire);
  const planet = state.planets.find((p) => p.id === colony.planetId)!;
  return maxPopulation(planet, traitsOf(empire), acc.maxPop, effectiveClimate(planet, colony));
}

// ---------- F3/F4/F5: per-colonist coefficients ----------

/** Per-farmer food coefficient in HALF units: climate base + race pick (the
 * farming picks come in half steps: farming1 is a true -0.5) + tech/buildings.
 * On any life-bearing world a farmer always coaxes out at least 1 food (the
 * -0.5 pick is a real penalty, not a way to zero out farming). */
export function farmCoeffHalves(climate: Climate, gTraits: RaceTraits, accFarmCoeff: number): number {
  const base = foodPerFarmerBase(climate, gTraits.aquatic);
  const halves = Math.max(0, base * 2 + gTraits.farmingHalf + accFarmCoeff * 2);
  return base > 0 ? Math.max(2, halves) : halves;
}

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


// ---------- F10: morale ----------

export function moralePct(state: GameState, colony: Colony, acc?: ColonyAccum): number {
  const empire = empireOf(state, colony.owner);
  const traits = traitsOf(empire);
  if (traits.government === 'unification') return 0; // immune either way
  let morale = 0;
  if (traits.government === 'dictatorship' || traits.government === 'feudal') {
    if (!has(colony, 'marine_barracks') && !has(colony, 'armor_barracks')) morale -= 20;
  }
  morale += (acc ?? colonyAccum(state, colony, empire)).moralePct;
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
  /** BC minted by the empire tax rate (2 taxed prod -> 1 BC) */
  taxBC: number;
  /** whether prod goes to the build queue (false when housing/trade goods active) */
  prodToQueue: number;
}

type OutputKind = 'farm' | 'prod' | 'sci';

function cTotalPct(kind: OutputKind, traits: RaceTraits, morale: number, advanced = false): number {
  if (traits.government === 'unification') {
    // galactic unification doubles the classic +50% farm/prod bonus
    return kind === 'sci' ? 0 : advanced ? 100 : 50;
  }
  let c = morale;
  if (kind === 'sci') {
    if (traits.government === 'democracy') c += advanced ? 75 : 50; // federation
    if (traits.government === 'feudal') c -= advanced ? 25 : 50; // confederation
  }
  return c;
}

/** Can farmers produce ANY food on this colony's world for its owner? False
 * on barren/dead worlds until tech (hydroponics lattice etc.) makes farming
 * viable — assigning farmers there would waste hands producing nothing. */
export function farmingViable(state: GameState, colony: Colony): boolean {
  const owner = empireOf(state, colony.owner);
  const acc = colonyAccum(state, colony, owner);
  const planet = planetOf(state, colony);
  const effClim = effectiveClimate(planet, colony);
  for (const g of colony.groups) {
    const gTraits = g.race === colony.owner ? traitsOf(owner) : groupTraits(state, g.race, traitsOf(owner));
    if (farmCoeffHalves(effClim, gTraits, acc.farmCoeff) > 0) return true;
  }
  // an empty/outpost colony: judge by the owner's own race
  return farmCoeffHalves(effClim, traitsOf(owner), acc.farmCoeff) > 0;
}

export function colonyOutput(state: GameState, colony: Colony): ColonyOutput {
  const planet = planetOf(state, colony.planetId ? colony : colony); // keep call sites simple
  return computeOutput(state, colony, planet);
}

function computeOutput(state: GameState, colony: Colony, planet: Planet): ColonyOutput {
  const owner = empireOf(state, colony.owner);
  const ownerTraits = traitsOf(owner);
  const acc = colonyAccum(state, colony, owner);
  const morale = moralePct(state, colony, acc);
  const popUnits = colonyPopUnits(colony);
  const effClim = effectiveClimate(planet, colony); // stellar safety shield on hostile worlds
  const maxPop = maxPopulation(planet, ownerTraits, acc.maxPop, effClim);

  // per-kind: base (Σ colonists × coeff) and per-colonist penalties
  let farmBase = 0;
  let prodBase = 0;
  let sciBase = 0;
  let farmPenalty = 0;
  let prodPenalty = 0;
  let sciPenalty = 0;
  let foodNeedHalves = 0; // per-unit consumption in half-food units
  let prodNeedHalves = 0;

  const blockaded = isBlockaded(state, colony);
  // androids (data effect text): +3 in their hardwired category on top of a
  // no-bonus colonist's coefficient, unaffected by morale/government/gravity
  // (machines), 1 production upkeep per unit instead of food, no income.
  // They bypass the percentage multipliers below via the flat-output path.
  let androidFood = 0;
  let androidProd = 0;
  let androidSci = 0;
  let androidUnits = 0;
  for (const g of colony.groups) {
    if (g.race === ANDROID_RACE) {
      const units = groupUnits(g);
      androidUnits += units;
      const farmHalves = farmCoeffHalves(effClim, NEUTRAL_TRAITS, acc.farmCoeff) + 6;
      let aFood = floorDiv(g.farmers * farmHalves, 2);
      let aProd = g.workers * (Math.max(1, MINERAL_PROD[planet.minerals] + acc.prodCoeff) + 3);
      if (blockaded) {
        // a siege interdicts supply lines, machines included — only the
        // morale/government/gravity multipliers are android-exempt
        aFood -= roundDiv(aFood * 50, 100);
        aProd -= roundDiv(aProd * 50, 100);
      }
      androidFood += aFood;
      androidProd += aProd;
      androidSci += g.scientists * (Math.max(1, 3 + acc.sciCoeff) + 3 + (planet.special === 'ancient_artifacts' ? 2 : 0));
      prodNeedHalves += units * 2; // 1 production per unit keeps them spry
      continue;
    }
    const gTraits = g.race === colony.owner ? ownerTraits : groupTraits(state, g.race, ownerTraits);
    const units = groupUnits(g);
    let gravPen = planetHasGravityFix(colony) ? 0 : gravitySteps(gTraits.gravityPref, planet.gravity) * 25;
    if (g.unrest) gravPen += 25; // conquered colonists (SW-Calc penalty)

    const farmHalves = farmCoeffHalves(effClim, gTraits, acc.farmCoeff);
    const prodCoeff = Math.max(1, MINERAL_PROD[planet.minerals] + gTraits.industry + acc.prodCoeff);
    let sciCoeff = Math.max(1, 3 + gTraits.science + acc.sciCoeff);
    if (planet.special === 'ancient_artifacts') sciCoeff += 2;

    const gFarm = floorDiv(g.farmers * farmHalves, 2);
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
    if (blockaded) {
      farmPenalty += roundDiv(gFarm * 50, 100);
      prodPenalty += roundDiv(gProd * 50, 100);
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

  // farming: unification/morale multiplier + leader %, then flat buildings
  const advGov = hasAdvancedGov(owner);
  const farmWorker =
    roundDiv(farmBase * (100 + cTotalPct('farm', ownerTraits, morale, advGov) + acc.farmPct), 100) - farmPenalty;
  const food = Math.max(0, farmWorker) + acc.farmFlat + androidFood;

  // production before pollution
  const prodWorkerRaw =
    roundDiv(prodBase * (100 + cTotalPct('prod', ownerTraits, morale, advGov) + acc.prodPct), 100) - prodPenalty;
  const prodWorker = Math.max(0, prodWorkerRaw);

  // F8 pollution (flat building production exempt)
  let pollution = 0;
  if (!acc.pollutionZero) {
    const divisor = acc.pollutionDivisorMult;
    let tolNum = 0;
    let tolDen = 0;
    for (const g of colony.groups) {
      if (g.race === ANDROID_RACE) continue; // machines: their output is pollution-exempt
      const gTraits = g.race === colony.owner ? ownerTraits : groupTraits(state, g.race, ownerTraits);
      const units = groupUnits(g);
      tolDen += units;
      if (!gTraits.tolerant) tolNum += units;
    }
    if (tolDen > 0 && tolNum > 0) {
      let absorb = 2 * planet.sizeClass;
      if (acc.pollutionAbsorbX2) absorb *= 2;
      absorb += acc.pollutionAbsorbFlat; // environmentalist leaders etc.
      const scaled = roundDiv(prodWorker * tolNum, divisor * tolDen);
      pollution = Math.max(0, ceilDiv(Math.max(0, scaled - absorb), 2));
    }
  }
  const prodGross = Math.max(0, prodWorker + acc.prodFlat + androidProd - pollution);
  const prodConsumed = ceilDiv(prodNeedHalves, 2);
  const prodLack = Math.max(0, prodConsumed - prodGross);
  const prod = Math.max(0, prodGross - prodConsumed);

  // research
  const sciWorker =
    roundDiv(sciBase * (100 + cTotalPct('sci', ownerTraits, morale, advGov) + acc.sciPct), 100) - sciPenalty;
  const research = Math.max(0, sciWorker) + acc.sciFlat + androidSci;

  // ---------- F7 money ----------
  const special = planet.special === 'gem_deposits' ? 10 : planet.special === 'gold_deposits' ? 5 : 0;
  // androids generate no income (data effect text): only organics pay taxes
  const popIncome = roundDiv((popUnits - androidUnits) * (2 + ownerTraits.bcHalves), 2);
  let bonusIncome = 0;
  const baseForBonus = special + popIncome;
  if (acc.moneyCoeffHalves > 0) bonusIncome += floorDiv(baseForBonus * acc.moneyCoeffHalves, 2);
  if (acc.bcPct > 0) bonusIncome += floorDiv(baseForBonus * acc.bcPct, 100); // financial leader
  if (ownerTraits.government === 'democracy') {
    // federation raises the civilian-economy bonus from ×0.5 to ×0.75
    bonusIncome += advGov ? floorDiv(baseForBonus * 3, 4) : floorDiv(baseForBonus, 2);
  }
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

  // food replicators: cover shortages by converting 2 production -> 1 food
  let food2 = food;
  let prodAfterFood = prod;
  if (food2 < foodConsumed && has(colony, 'food_replicators')) {
    const cover = Math.min(foodConsumed - food2, floorDiv(prodAfterFood, 2));
    food2 += cover;
    prodAfterFood -= cover * 2;
  }

  // build diversion: housing / trade goods
  const active = colony.queue[0]?.item ?? null;
  let housingPP = 0;
  let tradeBC = 0;
  let prodToQueue = prodAfterFood;
  if (active === 'housing') {
    housingPP = prodAfterFood;
    prodToQueue = 0;
  } else if (active === 'trade_goods') {
    tradeBC = ownerTraits.fantasticTraders ? prodAfterFood : floorDiv(prodAfterFood, 2);
    prodToQueue = 0;
  }

  // empire tax: a slice of queue production is minted into BC (2 prod -> 1 BC)
  const taxRate = owner.taxRatePct ?? 0;
  let taxBC = 0;
  if (taxRate > 0 && prodToQueue > 0) {
    const taxedProd = floorDiv(prodToQueue * taxRate, 100);
    prodToQueue -= taxedProd;
    taxBC = floorDiv(taxedProd, 2);
  }

  return {
    food: food2,
    foodConsumed,
    foodNet: food2 - foodConsumed,
    prod: prodAfterFood,
    prodConsumed,
    prodLack,
    pollution,
    research,
    bcIncome: bcIncome + tradeBC + taxBC,
    maintenance,
    moralePct: morale,
    maxPop,
    popUnits,
    housingPP,
    tradeBC,
    taxBC,
    prodToQueue,
  };
}

// ---------- output breakdown (UI tooltips: where every point comes from) ----------

export interface OutputExplain {
  farm: string[];
  prod: string[];
  sci: string[];
  bc: string[];
}

/** Human-readable per-source breakdown of a colony's output. Mirrors
 * computeOutput's arithmetic in words; display-only. */
export function explainOutput(state: GameState, colony: Colony): OutputExplain {
  const planet = planetOf(state, colony);
  const owner = empireOf(state, colony.owner);
  const ownerTraits = traitsOf(owner);
  const acc = colonyAccum(state, colony, owner);
  const morale = moralePct(state, colony, acc);
  const effClim = effectiveClimate(planet, colony);
  const out: OutputExplain = { farm: [], prod: [], sci: [], bc: [] };

  for (const g of colony.groups) {
    if (g.race === ANDROID_RACE) {
      // mirror computeOutput's android branch: +3 category bonus on neutral
      // coefficients, no morale/gravity, upkeep shown as its own line below
      const farmHalves = farmCoeffHalves(effClim, NEUTRAL_TRAITS, acc.farmCoeff) + 6;
      const prodC = Math.max(1, MINERAL_PROD[planet.minerals] + acc.prodCoeff) + 3;
      const sciC = Math.max(1, 3 + acc.sciCoeff) + 3 + (planet.special === 'ancient_artifacts' ? 2 : 0);
      if (g.farmers) out.farm.push(`${g.farmers} android farmer${g.farmers === 1 ? '' : 's'} × ${farmHalves / 2} (+3 android)`);
      if (g.workers) out.prod.push(`${g.workers} android worker${g.workers === 1 ? '' : 's'} × ${prodC} (+3 android)`);
      if (g.scientists) out.sci.push(`${g.scientists} android scientist${g.scientists === 1 ? '' : 's'} × ${sciC} (+3 android)`);
      continue;
    }
    const gTraits = g.race === colony.owner ? ownerTraits : groupTraits(state, g.race, ownerTraits);
    const gravPen = planetHasGravityFix(colony) ? 0 : gravitySteps(gTraits.gravityPref, planet.gravity) * 25;
    const farmBase = foodPerFarmerBase(effClim, gTraits.aquatic);
    const farmHalves = farmCoeffHalves(effClim, gTraits, acc.farmCoeff);
    const farmCoeff = farmHalves % 2 === 0 ? `${farmHalves / 2}` : `${(farmHalves - (farmHalves % 2)) / 2}.5`;
    const racePart = gTraits.farmingHalf ? `, ${gTraits.farmingHalf > 0 ? '+' : ''}${gTraits.farmingHalf / 2} race` : '';
    out.farm.push(
      `${g.farmers} farmer${g.farmers === 1 ? '' : 's'} × ${farmCoeff} (${farmBase} ${effClim}${racePart}${acc.farmCoeff ? `, +${acc.farmCoeff} tech/buildings` : ''})`,
    );
    const prodCoeff = Math.max(1, MINERAL_PROD[planet.minerals] + gTraits.industry + acc.prodCoeff);
    out.prod.push(
      `${g.workers} worker${g.workers === 1 ? '' : 's'} × ${prodCoeff} (${MINERAL_PROD[planet.minerals]} ${planet.minerals}${gTraits.industry ? `, ${gTraits.industry > 0 ? '+' : ''}${gTraits.industry} race` : ''}${acc.prodCoeff ? `, +${acc.prodCoeff} tech/buildings` : ''})`,
    );
    let sciCoeff = Math.max(1, 3 + gTraits.science + acc.sciCoeff);
    if (planet.special === 'ancient_artifacts') sciCoeff += 2;
    out.sci.push(
      `${g.scientists} scientist${g.scientists === 1 ? '' : 's'} × ${sciCoeff} (3 base${gTraits.science ? `, ${gTraits.science > 0 ? '+' : ''}${gTraits.science} race` : ''}${acc.sciCoeff ? `, +${acc.sciCoeff} tech/buildings` : ''}${planet.special === 'ancient_artifacts' ? ', +2 artifacts' : ''})`,
    );
    if (gravPen > 0) {
      const line = `−${gravPen}% ${planet.gravity} gravity penalty`;
      out.farm.push(line);
      out.prod.push(line);
      out.sci.push(line);
    }
  }
  const moraleLine = (kind: OutputKind) => {
    const pct = cTotalPct(kind, ownerTraits, morale, hasAdvancedGov(owner));
    return pct !== 0 ? `${pct > 0 ? '+' : ''}${pct}% ${ownerTraits.government === 'unification' ? 'unification' : 'morale/government'}` : null;
  };
  for (const [kind, lines, pctAcc, flat] of [
    ['farm', out.farm, acc.farmPct, acc.farmFlat],
    ['prod', out.prod, acc.prodPct, acc.prodFlat],
    ['sci', out.sci, acc.sciPct, acc.sciFlat],
  ] as Array<[OutputKind, string[], number, number]>) {
    const m = moraleLine(kind);
    if (m) lines.push(m);
    if (pctAcc) lines.push(`${pctAcc > 0 ? '+' : ''}${pctAcc}% tech/buildings/leader`);
    if (flat) lines.push(`+${flat} flat from buildings`);
  }
  if (isBlockaded(state, colony)) {
    out.farm.push('−50% blockade');
    out.prod.push('−50% blockade');
  }
  const o = colonyOutput(state, colony);
  if (o.pollution > 0) out.prod.push(`−${o.pollution} pollution`);
  if (o.prodConsumed > 0) out.prod.push(`−${o.prodConsumed} cybernetic/android upkeep`);
  out.farm.push(`− ${o.foodConsumed} eaten = net ${o.foodNet >= 0 ? '+' : ''}${o.foodNet}`);
  const taxpayers = o.popUnits - androidUnitsOf(colony); // androids pay no taxes
  out.bc.push(`${taxpayers} pop × ${(2 + ownerTraits.bcHalves) / 2} BC`);
  if (planet.special === 'gem_deposits') out.bc.push('+10 gem deposits');
  if (planet.special === 'gold_deposits') out.bc.push('+5 gold deposits');
  if (o.tradeBC) out.bc.push(`+${o.tradeBC} trade goods`);
  if (o.taxBC) out.bc.push(`+${o.taxBC} tax (${owner.taxRatePct ?? 0}%)`);
  if (o.maintenance) out.bc.push(`−${o.maintenance} building maintenance`);
  return out;
}

/** Baseline traits for planetary natives: no racial bonuses at all
 * (planet_specials.md — "the natives do not gain racial bonuses of your
 * race"). Government is irrelevant at group level. */
const NEUTRAL_TRAITS: RaceTraits = resolveTraits(['dictatorship']);

/** Traits for non-owner pop groups (conquered races, natives). */
function groupTraits(state: GameState, race: number, fallback: RaceTraits): RaceTraits {
  if (race === NATIVE_RACE || race === ANDROID_RACE) return NEUTRAL_TRAITS;
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
  /** projection mode (UI estimates): use THIS turn's planned food/prod/housing
   * results instead of the stored previous-turn values the pipeline applies */
  projected?: { foodLack: number; prodLack: number; housingPP: number },
): number {
  // androids are built, not grown — and their subterranean compartments
  // never crowd organic housing, so they drop out of both sides of the
  // capacity math
  if (group.race === ANDROID_RACE) return 0;
  totalUnits -= androidUnitsOf(colony);
  const owner = empireOf(state, colony.owner);
  const ownerTraits = traitsOf(owner);
  const gTraits = group.race === colony.owner ? ownerTraits : groupTraits(state, group.race, ownerTraits);
  const acc = colonyAccum(state, colony, owner);
  const c = groupUnits(group);
  const free = Math.max(0, maxPop - totalUnits);
  if (c <= 0) return group.popK > 0 && free > 0 ? 20 : 0; // fractional seed group still grows slowly
  const basic = maxPop > 0 ? isqrt(floorDiv(2000 * c * free, maxPop)) : 0;

  const housingPP = projected?.housingPP ?? colony.housingPPPrev;
  const foodLack = projected?.foodLack ?? colony.foodLackPrev;
  const prodLack = projected?.prodLack ?? colony.prodLackPrev;

  let bonusPct = gTraits.growthPct + acc.growthPct;
  // housing: colony-wide PP split across ALL colonists — applying the full
  // pool to every race group would multiply the boost per group
  if (housingPP > 0 && totalUnits > 0) {
    bonusPct += floorDiv(housingPP * 40, totalUnits);
  }

  let inc = floorDiv(basic * (100 + Math.max(-90, bonusPct)), 100);
  // growth-center style flat bonuses are per COLONY: each group gets its share
  inc += totalUnits > 0 ? floorDiv(acc.growthFlatK * c, totalUnits) : acc.growthFlatK;

  // food shortage penalty: the colony-wide lack is split by population share
  // (an N-race colony must not starve N times as fast)
  if (foodLack > 0 || prodLack > 0) {
    const share = (pen: number) => (totalUnits > 0 ? ceilDiv(pen * c, totalUnits) : pen);
    if (gTraits.cybernetic) {
      inc -= share(25 * foodLack + 25 * prodLack);
    } else {
      inc -= share(50 * foodLack);
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
