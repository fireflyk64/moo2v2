// Selectors: every number a display (or test bot) needs, derived from state.
// UIs must not compute game math themselves — anything shown on screen comes
// from here so alternate front ends and headless bots agree exactly.

import { fieldByNum, applicationsOfField, FIELD_SUBJECTS, type FieldRow } from './data/index';
import { buyCost, colonyMaxPop, colonyOutput, colonyPopUnits, farmingViable, freeFreighters, groupGrowthK, type ColonyOutput } from './economy';
import { buildableItems, itemCost, refitCost, SHIPYARD_BASES } from './items';
import { empireAccum } from './effects';
import { isBlockaded } from './ground';
import { leaderById } from './leaders';
import { commandPoints, driveSpeed, fuelRangeCp, inRange, supportStars } from './movement';
import { hostileMonsterAt } from './npc';
import { availableFields, fieldCost, fieldGrantsAll } from './research';
import { starDistance } from './galaxy';
import { ceilDiv } from './imath';
import type { Colony, Empire, GameState, Planet, Ship, Star } from './types';

export interface ColonyRow {
  id: number;
  name: string;
  starName: string;
  owner: number;
  planet: Planet;
  popUnits: number;
  popK: number;
  maxPop: number;
  jobs: { farmers: number; workers: number; scientists: number };
  /** governor assigned to this colony (null = none) */
  leaderName: string | null;
  /** per-race population groups (captured colonists appear as their own race) */
  groups: Array<{
    race: number;
    raceName: string;
    units: number;
    farmers: number;
    workers: number;
    scientists: number;
    unrest: boolean;
  }>;
  output: ColonyOutput;
  activeItem: string | null;
  queue: string[];
  storedProd: number;
  activeCost: number;
  turnsLeft: number | null;
  buyPrice: number | null;
  canBuy: boolean;
  buildable: string[];
  buildings: string[];
  outpost: boolean;
  /** sticky-build mode: parked production per switched-away item */
  stickyInvested: Record<string, number>;
  /** projected population change next turn, in popK (1000 = one colonist unit) */
  growthK: number;
  /** buildings that may be sold this turn, with the BC refund for each */
  sellables: Array<{ id: string; refund: number }>;
  canSell: boolean;
  /** player-set organizational tags (subset of COLONY_TAGS) */
  tags: string[];
  /** false when farmers can produce no food here (barren etc.) */
  farmable: boolean;
}

/** Project this turn's food distribution (mirrors the pipeline: surpluses
 * cover deficits within freighter capacity, then chartered haulers within the
 * treasury; blockaded colonies get nothing) → uncovered lack per colony.
 * Pure read: powers the LIVE growth estimate so reassigning farmers moves the
 * projection immediately instead of one turn late. */
export function projectedFoodShortages(state: GameState, empireId: number): Map<number, number> {
  const empire = state.empires.find((e) => e.id === empireId)!;
  const mine = state.colonies.filter((c) => c.owner === empireId && !c.outpost);
  const out = new Map<number, number>();
  let surplus = 0;
  let bcIncome = 0;
  const deficits: Array<{ colony: Colony; lack: number }> = [];
  for (const c of mine) {
    const o = colonyOutput(state, c);
    bcIncome += o.bcIncome;
    if (o.foodNet >= 0) surplus += o.foodNet;
    else deficits.push({ colony: c, lack: -o.foodNet });
    out.set(c.id, 0);
  }
  let capacity = freeFreighters(state, empire); // 1 food per freighter (matches pipeline)
  let charterBudget = Math.max(0, empire.bc + bcIncome);
  deficits.sort((a, b) => a.colony.id - b.colony.id);
  for (const d of deficits) {
    const blockaded = isBlockaded(state, d.colony);
    const moved = blockaded ? 0 : Math.min(d.lack, surplus, capacity);
    surplus -= moved;
    capacity -= moved;
    d.lack -= moved;
    const chartered = blockaded ? 0 : Math.min(d.lack, surplus, charterBudget);
    surplus -= chartered;
    charterBudget -= chartered;
    d.lack -= chartered;
    out.set(d.colony.id, d.lack);
  }
  return out;
}

export function colonyRows(state: GameState, empireId: number): ColonyRow[] {
  const shortages = projectedFoodShortages(state, empireId);
  const rows: ColonyRow[] = [];
  for (const colony of state.colonies) {
    if (colony.owner !== empireId) continue;
    rows.push(colonyRow(state, colony, shortages.get(colony.id) ?? 0));
  }
  return rows;
}

export function colonyRow(state: GameState, colony: Colony, projectedFoodLack?: number): ColonyRow {
  const planet = state.planets.find((p) => p.id === colony.planetId)!;
  const star = state.stars.find((s) => s.id === planet.starId)!;
  const empire = state.empires.find((e) => e.id === colony.owner)!;
  const output = colony.outpost
    ? emptyOutput()
    : colonyOutput(state, colony);
  const active = colony.queue[0]?.item ?? null;
  const activeCost = active ? (itemCost(state, colony.owner, active, colony) ?? 0) : 0;
  const isProject = active === 'housing' || active === 'trade_goods';
  const turnsLeft =
    active && !isProject
      ? output.prodToQueue > 0
        ? ceilDiv(Math.max(0, activeCost - colony.storedProd), output.prodToQueue)
        : null
      : null;
  const buyPrice = active && !isProject && colony.storedProd < activeCost ? buyCost(activeCost, colony.storedProd) : null;
  const jobs = { farmers: 0, workers: 0, scientists: 0 };
  let popK = 0;
  for (const g of colony.groups) {
    jobs.farmers += g.farmers;
    jobs.workers += g.workers;
    jobs.scientists += g.scientists;
    popK += g.popK;
  }
  let growthK = 0;
  if (!colony.outpost && colony.groups.length > 0) {
    const maxPop = colonyMaxPop(state, colony);
    const totalUnits = colonyPopUnits(colony);
    // live estimate: use THIS turn's planned food/housing results, so moving
    // farmers around updates the projection immediately
    const foodLack =
      projectedFoodLack ?? projectedFoodShortages(state, colony.owner).get(colony.id) ?? 0;
    const growthInputs = { foodLack, prodLack: output.prodLack, housingPP: output.housingPP };
    let projected = popK;
    for (const g of colony.groups) {
      const inc = groupGrowthK(state, colony, g, maxPop, totalUnits, growthInputs);
      const applied = inc > 0 ? Math.min(inc, Math.max(0, maxPop * 1000 - projected)) : Math.max(inc, -g.popK);
      projected += applied;
      growthK += applied;
    }
  }
  return {
    id: colony.id,
    name: colony.name,
    starName: star.name,
    owner: colony.owner,
    planet,
    popUnits: colonyPopUnits(colony),
    popK,
    maxPop: colony.outpost ? 0 : colonyMaxPop(state, colony),
    jobs,
    leaderName: (() => {
      const hired = empire.leaders.find((l) => l.colonyId === colony.id);
      return hired ? (leaderById.get(hired.leaderId)?.name ?? null) : null;
    })(),
    groups: colony.groups.map((g) => ({
      race: g.race,
      raceName: state.empires.find((e) => e.id === g.race)?.raceName ?? `race ${g.race}`,
      units: Math.floor(g.popK / 1000),
      farmers: g.farmers,
      workers: g.workers,
      scientists: g.scientists,
      unrest: g.unrest,
    })),
    output,
    activeItem: active,
    stickyInvested: colony.stickyInvested,
    queue: colony.queue.map((q) => q.item),
    storedProd: colony.storedProd,
    activeCost,
    turnsLeft,
    buyPrice,
    canBuy: buyPrice !== null && !colony.boughtThisTurn && empire.bc >= (buyPrice ?? 0),
    buildable: colony.outpost ? [] : buildableItems(state, colony),
    buildings: colony.buildings,
    outpost: colony.outpost,
    growthK,
    sellables: colony.buildings.map((b) => ({
      id: b,
      refund: Math.floor((itemCost(state, colony.owner, b) ?? 0) / 2),
    })),
    canSell: !colony.soldThisTurn,
    tags: colony.tags ?? [],
    farmable: !colony.outpost && farmingViable(state, colony),
  };
}

function emptyOutput(): ColonyOutput {
  return {
    food: 0,
    foodConsumed: 0,
    foodNet: 0,
    prod: 0,
    prodConsumed: 0,
    prodLack: 0,
    pollution: 0,
    research: 0,
    bcIncome: 0,
    maintenance: 0,
    moralePct: 0,
    maxPop: 0,
    popUnits: 0,
    housingPP: 0,
    tradeBC: 0,
    taxBC: 0,
    prodToQueue: 0,
  };
}

export interface EmpireSummary {
  id: number;
  name: string;
  raceName: string;
  bc: number;
  bcDelta: number;
  foodNet: number;
  researchPerTurn: number;
  freighters: number;
  freightersNeeded: number;
  /** freighters not tied up hauling colonists between systems */
  freightersFree: number;
  /** colonist units currently riding freighters */
  colonistsInTransit: number;
  colonies: number;
  researching: string | null;
  researchTurnsLeft: number | null;
  /** progress toward the current field, 0-100 (null when no field selected) */
  researchProgressPct: number | null;
  researchTarget: string | null;
  extraQueue: string[];
  taxRatePct: number;
  cpUsage: number;
  cpSources: number;
}

export function empireSummary(state: GameState, empireId: number): EmpireSummary {
  const empire = state.empires.find((e) => e.id === empireId)!;
  let bcDelta = 0;
  let foodNet = 0;
  let rp = 0;
  let freightersNeeded = 0;
  let colonies = 0;
  for (const c of state.colonies) {
    if (c.owner !== empireId || c.outpost) continue;
    colonies++;
    const out = colonyOutput(state, c);
    bcDelta += out.bcIncome;
    foodNet += out.foodNet;
    rp += out.research;
    if (out.foodNet < 0) freightersNeeded += -out.foodNet;
  }
  const field = empire.research.fieldNum !== null ? fieldByNum.get(empire.research.fieldNum) : null;
  const fieldCostNow = field ? fieldCost(state, empire, field) : 0;
  const cp = commandPoints(state, empire);
  return {
    id: empireId,
    name: empire.name,
    raceName: empire.raceName,
    bc: empire.bc,
    bcDelta,
    foodNet,
    researchPerTurn: rp,
    freighters: empire.freighters,
    freightersNeeded: ceilDiv(freightersNeeded, 5) * 5,
    freightersFree: freeFreighters(state, empire),
    colonistsInTransit: (state.popTransits ?? []).reduce(
      (n, t) => n + (t.empireId === empireId ? t.units : 0),
      0,
    ),
    colonies,
    researching: field?.id ?? (empire.research.extraQueue[0] ? `extra: ${empire.research.extraQueue[0]}` : null),
    researchTurnsLeft:
      field && rp > 0 ? ceilDiv(Math.max(0, fieldCostNow - empire.research.accumRP), rp) : null,
    researchProgressPct:
      field && fieldCostNow > 0 ? Math.min(100, Math.floor((empire.research.accumRP * 100) / fieldCostNow)) : null,
    researchTarget: empire.research.targetApp,
    extraQueue: empire.research.extraQueue,
    taxRatePct: empire.taxRatePct ?? 0,
    cpUsage: cp.usage,
    cpSources: cp.sources,
  };
}

export type JobPreset = 'research' | 'industry' | 'blend';

/** Bulk job presets for the colonies screen. Farmers are set to the fewest
 * that keep the colony fed (0 if farming cannot feed it — freighters cover
 * shortfalls); the rest go to science ('research'), industry ('industry'), or
 * industry capped at pollution <= 2 with the remainder on science ('blend'). */
export function presetJobs(
  state: GameState,
  colonyId: number,
  preset: JobPreset,
): Array<{ race: number; farmers: number; workers: number; scientists: number }> | null {
  const colony = state.colonies.find((c) => c.id === colonyId);
  if (!colony || colony.outpost || colony.groups.length === 0) return null;
  const probe: Colony = structuredClone(colony);
  const unitsOf = (g: { popK: number }) => Math.floor(g.popK / 1000);
  const total = probe.groups.reduce((n, g) => n + unitsOf(g), 0);
  if (total === 0) return null;

  const assign = (farmers: number, workers: number): void => {
    let f = farmers;
    let w = workers;
    for (const g of probe.groups) {
      const units = unitsOf(g);
      g.farmers = Math.min(units, f);
      f -= g.farmers;
      g.workers = Math.min(units - g.farmers, w);
      w -= g.workers;
      g.scientists = units - g.farmers - g.workers;
    }
  };

  // fewest farmers that feed the colony (foodNet is monotone in farmers)
  let farmers = 0;
  let fed = false;
  for (let f = 0; f <= total; f++) {
    assign(f, 0);
    if (colonyOutput(state, probe).foodNet >= 0) {
      farmers = f;
      fed = true;
      break;
    }
  }
  if (!fed) farmers = 0; // farming cannot feed this world: do not waste hands

  const rest = total - farmers;
  let workers = 0;
  if (preset === 'industry') {
    workers = rest;
  } else if (preset === 'blend') {
    for (let w = rest; w >= 0; w--) {
      assign(farmers, w);
      if (colonyOutput(state, probe).pollution <= 2) {
        workers = w;
        break;
      }
    }
  }
  assign(farmers, workers);
  return probe.groups.map((g) => ({
    race: g.race,
    farmers: g.farmers,
    workers: g.workers,
    scientists: g.scientists,
  }));
}

export interface ResearchChoice {
  field: FieldRow;
  subject: string;
  cost: number;
  /** "(General)" fields deliver every application at once (no target choice) */
  grantsAll: boolean;
  apps: Array<{ id: string; name: string; known: boolean }>;
}

export function researchChoices(state: GameState, empireId: number): ResearchChoice[] {
  const empire = state.empires.find((e) => e.id === empireId)!;
  return availableFields(empire).map((field) => ({
    field,
    subject: subjectLabel(field),
    cost: fieldCost(state, empire, field),
    grantsAll: fieldGrantsAll(field),
    apps: applicationsOfField(field.id).map((a) => ({
      id: a.id,
      name: a.name,
      known: empire.knownApps.includes(a.id),
    })),
  }));
}

function subjectLabel(field: FieldRow): string {
  return FIELD_SUBJECTS[field.id] ?? 'unknown';
}

export interface StarView {
  star: Star;
  explored: boolean;
  /** inside the empire's scanner envelope (reveals activity + wormholes) */
  scanned: boolean;
  /** the wormhole from this star may be drawn (an endpoint is known) */
  wormholeVisible: boolean;
  planets: Planet[];
  colonies: Array<{ id: number; owner: number; name: string; outpost: boolean }>;
  ships: Array<{ id: number; owner: number; kind: string; hull: string | null }>;
  inRange: boolean;
}

/** base scanner envelope in centiparsecs; scanner techs add +1 parsec per
 * scan point (Space Scanner +2 … Tachyon Scanner +7) */
const BASE_SCAN_CP = 200;

/** Stars inside the empire's scanner envelope: around every colony and every
 * own ship parked at a star. Scanners reveal ship activity and wormholes —
 * you still have to visit a system to survey its planets. */
export function scannedStars(state: GameState, empireId: number): Set<number> {
  const empire = state.empires.find((e) => e.id === empireId)!;
  const range = BASE_SCAN_CP + empireAccum(state, empire).scan * 100;
  const sources: Star[] = [];
  for (const c of state.colonies) {
    if (c.owner !== empireId) continue;
    const p = state.planets.find((x) => x.id === c.planetId)!;
    const star = state.stars.find((s) => s.id === p.starId);
    if (star) sources.push(star);
  }
  for (const ship of state.ships) {
    if (ship.owner !== empireId || ship.location.kind !== 'star') continue;
    const star = state.stars.find((s) => s.id === (ship.location as { starId: number }).starId);
    if (star) sources.push(star);
  }
  const out = new Set<number>();
  for (const star of state.stars) {
    if (sources.some((src) => starDistance(src, star) <= range)) out.add(star.id);
  }
  return out;
}

export function galaxyView(state: GameState, empireId: number): StarView[] {
  const empire = state.empires.find((e) => e.id === empireId)!;
  const explored = new Set(empire.exploredStars);
  const scanned = scannedStars(state, empireId);
  const known = (id: number) => explored.has(id) || scanned.has(id);
  return state.stars.map((star) => {
    const planets = state.planets.filter((p) => p.starId === star.id);
    const colonies = state.colonies
      .filter((c) => planets.some((p) => p.id === c.planetId))
      .map((c) => ({ id: c.id, owner: c.owner, name: c.name, outpost: c.outpost }));
    const ships = state.ships
      .filter((s) => s.location.kind === 'star' && s.location.starId === star.id)
      .filter((s) => s.owner === empireId || known(star.id))
      .map((s) => {
        // warship hull class is visible at scanner range (know what you face)
        let hull: string | null = null;
        if (s.shipKind === 'design' && s.designId !== null) {
          const owner = state.empires.find((e) => e.id === s.owner);
          hull = owner?.designs.find((d) => d.id === s.designId)?.hull ?? null;
        } else if (s.shipKind === 'scout') {
          hull = 'frigate';
        }
        return { id: s.id, owner: s.owner, kind: s.shipKind, hull };
      });
    return {
      star,
      explored: explored.has(star.id),
      scanned: scanned.has(star.id),
      // a wormhole stays hidden until you visit or scan one of its ends
      wormholeVisible: star.wormholeTo !== null && (known(star.id) || known(star.wormholeTo)),
      planets: explored.has(star.id) ? planets : [],
      colonies: colonies.filter((c) => c.owner === empireId || explored.has(star.id)),
      ships,
      inRange: inRange(state, empireId, star),
    };
  });
}

export interface RefitOption {
  designId: number;
  name: string;
  cost: number;
}

/** Refit choices for a warship parked at a star: same-hull designs, priced by
 * the MOO2 formula, buildable at this system's shipyard colony (star base or
 * better). colonyId null = no yard here (options still listed for info). */
export function refitOptions(
  state: GameState,
  empireId: number,
  shipId: number,
): { colonyId: number | null; options: RefitOption[] } {
  const empire = state.empires.find((e) => e.id === empireId);
  const ship = state.ships.find((s) => s.id === shipId);
  if (!empire || !ship || ship.owner !== empireId || ship.shipKind !== 'design' || ship.location.kind !== 'star') {
    return { colonyId: null, options: [] };
  }
  const starId = ship.location.starId;
  const colony = state.colonies.find(
    (c) =>
      c.owner === empireId &&
      !c.outpost &&
      SHIPYARD_BASES.some((b) => c.buildings.includes(b)) &&
      state.planets.some((p) => p.id === c.planetId && p.starId === starId),
  );
  const options: RefitOption[] = [];
  for (const d of empire.designs) {
    if (d.obsolete) continue;
    const cost = refitCost(state, empireId, shipId, d.id);
    if (cost !== null) options.push({ designId: d.id, name: d.name, cost });
  }
  return { colonyId: colony?.id ?? null, options };
}

export interface FleetRow {
  ship: Ship;
  kind: string;
  /** display name: the design's name for warships, a friendly kind otherwise */
  name: string;
  location: string;
  atStarId: number | null;
  etaTurns: number | null;
  /** in-flight (or ordered-this-turn) route info for map rendering */
  transit: { fromStarId: number; toStarId: number; departedTurn: number; arrivalTurn: number } | null;
  /** the pending order was issued this turn and can still be re-routed */
  reroutable: boolean;
  canColonizeHere: number[]; // planet ids
  canOutpostHere: number[];
  /** transports: own colony here that colonists can be loaded from / landed on */
  canLoadFromColonyId: number | null;
  canUnloadToColonyId: number | null;
}

const SHIP_KIND_NAMES: Record<string, string> = {
  scout: 'Scout',
  colony_ship: 'Colony Ship',
  outpost_ship: 'Outpost Ship',
  transport: 'Transport',
};

export function fleetRows(state: GameState, empireId: number): FleetRow[] {
  const rows: FleetRow[] = [];
  const empire = state.empires.find((e) => e.id === empireId);
  for (const ship of state.ships) {
    if (ship.owner !== empireId) continue;
    let location: string;
    let atStarId: number | null = null;
    let eta: number | null = null;
    let transit: FleetRow['transit'] = null;
    if (ship.location.kind === 'star') {
      const star = state.stars.find((s) => s.id === (ship.location as { starId: number }).starId)!;
      location = star.name;
      atStarId = star.id;
    } else {
      const loc = ship.location as { from: number; to: number; departedTurn: number; arrivalTurn: number };
      const to = state.stars.find((s) => s.id === loc.to)!;
      eta = loc.arrivalTurn - state.turn;
      location = `→ ${to.name} (${eta}t)`;
      transit = { fromStarId: loc.from, toStarId: loc.to, departedTurn: loc.departedTurn, arrivalTurn: loc.arrivalTurn };
    }
    const settleTargets = (kind: 'colony_ship' | 'outpost_ship'): number[] => {
      if (ship.shipKind !== kind || atStarId === null) return [];
      // a keeper blocks settling: offering the button anyway just produces a
      // silently-rejected command
      if (hostileMonsterAt(state, atStarId)) return [];
      return state.planets
        .filter(
          (p) =>
            p.starId === atStarId &&
            (kind === 'outpost_ship' || p.body === 'planet') &&
            !state.colonies.some((c) => c.planetId === p.id),
        )
        .map((p) => p.id);
    };
    let name = SHIP_KIND_NAMES[ship.shipKind] ?? ship.shipKind;
    if (ship.shipKind === 'design' && ship.designId !== null) {
      const design = empire?.designs.find((d) => d.id === ship.designId);
      name = design ? design.name : 'Warship';
    }
    const colonyHere = (need: 'load' | 'unload'): number | null => {
      if (ship.shipKind !== 'transport' || atStarId === null) return null;
      if (need === 'load' && ship.cargoPopUnits > 0) return null;
      if (need === 'unload' && ship.cargoPopUnits <= 0) return null;
      const c = state.colonies.find(
        (x) =>
          x.owner === empireId &&
          !x.outpost &&
          state.planets.some((p) => p.id === x.planetId && p.starId === atStarId) &&
          (need === 'unload' ||
            x.groups.some((g) => g.race === empireId && !g.unrest && Math.floor(g.popK / 1000) > 2)),
      );
      return c ? c.id : null;
    };
    rows.push({
      ship,
      kind: ship.shipKind,
      name,
      location,
      atStarId,
      etaTurns: eta,
      transit,
      reroutable: transit !== null && transit.departedTurn === state.turn,
      canColonizeHere: settleTargets('colony_ship'),
      canOutpostHere: settleTargets('outpost_ship'),
      canLoadFromColonyId: colonyHere('load'),
      canUnloadToColonyId: colonyHere('unload'),
    });
  }
  return rows;
}

/** Race discovery: empires you have actually met — you explored a star holding
 * one of their colonies, your forces share a star with theirs, or you already
 * have dealings (relations entry, proposal, or their spies caught yours…). */
export function metEmpireIds(state: GameState, empireId: number): Set<number> {
  const met = new Set<number>([empireId]);
  const me = state.empires.find((e) => e.id === empireId);
  if (!me) return met;
  const explored = new Set(me.exploredStars);
  const starOfPlanet = new Map(state.planets.map((p) => [p.id, p.starId]));
  for (const c of state.colonies) {
    if (c.owner === empireId) continue;
    const starId = starOfPlanet.get(c.planetId);
    if (starId !== undefined && explored.has(starId)) met.add(c.owner);
  }
  const myStars = new Set<number>();
  for (const s of state.ships) {
    if (s.owner === empireId && s.location.kind === 'star') myStars.add(s.location.starId);
  }
  for (const c of state.colonies) {
    if (c.owner !== empireId) continue;
    const starId = starOfPlanet.get(c.planetId);
    if (starId !== undefined) myStars.add(starId);
  }
  for (const s of state.ships) {
    if (s.owner !== empireId && s.owner >= 0 && s.location.kind === 'star' && myStars.has(s.location.starId)) {
      met.add(s.owner);
    }
  }
  for (const r of state.relations) {
    if (r.a === empireId) met.add(r.b);
    if (r.b === empireId) met.add(r.a);
  }
  for (const p of state.proposals) {
    if (p.to === empireId) met.add(p.from);
    if (p.from === empireId) met.add(p.to);
  }
  return met;
}

/** Pairs of live empires that have met, in either direction (one side seeing
 * the other's colony counts). This is fast-start's contact tripwire: while it
 * is empty the empires cannot interact, so turns may resolve asynchronously. */
export function empireContactPairs(state: GameState): Array<[number, number]> {
  const alive = state.empires.filter((e) => !e.eliminated).map((e) => e.id);
  const met = new Map<number, Set<number>>();
  for (const id of alive) met.set(id, metEmpireIds(state, id));
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i]!;
      const b = alive[j]!;
      if (met.get(a)!.has(b) || met.get(b)!.has(a)) pairs.push([a, b]);
    }
  }
  return pairs;
}

export interface MoveOption {
  starId: number;
  name: string;
  distanceCp: number;
  turns: number;
  reachable: boolean;
}

export function moveOptions(state: GameState, empireId: number, fromStarId: number): MoveOption[] {
  const empire = state.empires.find((e) => e.id === empireId)!;
  const from = state.stars.find((s) => s.id === fromStarId)!;
  const range = fuelRangeCp(empire);
  const support = supportStars(state, empireId);
  const speed = driveSpeed(empire) * 100;
  return state.stars
    .filter((s) => s.id !== fromStarId)
    .map((s) => {
      const d = starDistance(from, s);
      // wormholes carry ships regardless of fuel range
      const reachable = from.wormholeTo === s.id || support.some((sup) => starDistance(sup, s) <= range);
      return {
        starId: s.id,
        name: s.name,
        distanceCp: d,
        turns: from.wormholeTo === s.id ? 1 : Math.max(1, ceilDiv(d, speed)),
        reachable,
      };
    })
    .sort((a, b) => a.distanceCp - b.distanceCp);
}
