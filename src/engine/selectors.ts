// Selectors: every number a display (or test bot) needs, derived from state.
// UIs must not compute game math themselves — anything shown on screen comes
// from here so alternate front ends and headless bots agree exactly.

import { buildableById, fieldByNum, applicationsOfField, FIELD_SUBJECTS, type FieldRow } from './data/index';
import { buyCost, colonyOutput, colonyPopUnits, maxPopulation, traitsOf, type ColonyOutput } from './economy';
import { buildableItems } from './items';
import { driveSpeed, fuelRangeCp, inRange, supportStars } from './movement';
import { availableFields, fieldCost } from './research';
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
}

export function colonyRows(state: GameState, empireId: number): ColonyRow[] {
  const rows: ColonyRow[] = [];
  for (const colony of state.colonies) {
    if (colony.owner !== empireId) continue;
    rows.push(colonyRow(state, colony));
  }
  return rows;
}

export function colonyRow(state: GameState, colony: Colony): ColonyRow {
  const planet = state.planets.find((p) => p.id === colony.planetId)!;
  const star = state.stars.find((s) => s.id === planet.starId)!;
  const empire = state.empires.find((e) => e.id === colony.owner)!;
  const output = colony.outpost
    ? emptyOutput()
    : colonyOutput(state, colony);
  const active = colony.queue[0]?.item ?? null;
  const activeCost = active ? (buildableById.get(active)?.cost ?? 0) : 0;
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
  return {
    id: colony.id,
    name: colony.name,
    starName: star.name,
    owner: colony.owner,
    planet,
    popUnits: colonyPopUnits(colony),
    popK,
    maxPop: colony.outpost ? 0 : maxPopulation(planet, traitsOf(empire), colony),
    jobs,
    output,
    activeItem: active,
    queue: colony.queue.map((q) => q.item),
    storedProd: colony.storedProd,
    activeCost,
    turnsLeft,
    buyPrice,
    canBuy: buyPrice !== null && !colony.boughtThisTurn && empire.bc >= (buyPrice ?? 0),
    buildable: colony.outpost ? [] : buildableItems(state, colony),
    buildings: colony.buildings,
    outpost: colony.outpost,
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
  colonies: number;
  researching: string | null;
  researchTurnsLeft: number | null;
  researchTarget: string | null;
  extraQueue: string[];
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
    colonies,
    researching: field?.id ?? (empire.research.extraQueue[0] ? `extra: ${empire.research.extraQueue[0]}` : null),
    researchTurnsLeft:
      field && rp > 0 ? ceilDiv(Math.max(0, fieldCost(empire, field) - empire.research.accumRP), rp) : null,
    researchTarget: empire.research.targetApp,
    extraQueue: empire.research.extraQueue,
  };
}

export interface ResearchChoice {
  field: FieldRow;
  subject: string;
  cost: number;
  apps: Array<{ id: string; name: string; known: boolean }>;
}

export function researchChoices(state: GameState, empireId: number): ResearchChoice[] {
  const empire = state.empires.find((e) => e.id === empireId)!;
  return availableFields(empire).map((field) => ({
    field,
    subject: subjectLabel(field),
    cost: fieldCost(empire, field),
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
  planets: Planet[];
  colonies: Array<{ id: number; owner: number; name: string; outpost: boolean }>;
  ships: Array<{ id: number; owner: number; kind: string }>;
  inRange: boolean;
}

export function galaxyView(state: GameState, empireId: number): StarView[] {
  const empire = state.empires.find((e) => e.id === empireId)!;
  const explored = new Set(empire.exploredStars);
  return state.stars.map((star) => {
    const planets = state.planets.filter((p) => p.starId === star.id);
    const colonies = state.colonies
      .filter((c) => planets.some((p) => p.id === c.planetId))
      .map((c) => ({ id: c.id, owner: c.owner, name: c.name, outpost: c.outpost }));
    const ships = state.ships
      .filter((s) => s.location.kind === 'star' && s.location.starId === star.id)
      .filter((s) => s.owner === empireId || explored.has(star.id))
      .map((s) => ({ id: s.id, owner: s.owner, kind: s.shipKind }));
    return {
      star,
      explored: explored.has(star.id),
      planets: explored.has(star.id) ? planets : [],
      colonies: colonies.filter((c) => c.owner === empireId || explored.has(star.id)),
      ships,
      inRange: inRange(state, empireId, star),
    };
  });
}

export interface FleetRow {
  ship: Ship;
  kind: string;
  location: string;
  atStarId: number | null;
  etaTurns: number | null;
  canColonizeHere: number[]; // planet ids
  canOutpostHere: number[];
}

export function fleetRows(state: GameState, empireId: number): FleetRow[] {
  const rows: FleetRow[] = [];
  for (const ship of state.ships) {
    if (ship.owner !== empireId) continue;
    let location: string;
    let atStarId: number | null = null;
    let eta: number | null = null;
    if (ship.location.kind === 'star') {
      const star = state.stars.find((s) => s.id === (ship.location as { starId: number }).starId)!;
      location = star.name;
      atStarId = star.id;
    } else {
      const to = state.stars.find((s) => s.id === (ship.location as { to: number }).to)!;
      eta = (ship.location as { arrivalTurn: number }).arrivalTurn - state.turn;
      location = `→ ${to.name} (${eta}t)`;
    }
    const settleTargets = (kind: 'colony_ship' | 'outpost_ship'): number[] => {
      if (ship.shipKind !== kind || atStarId === null) return [];
      return state.planets
        .filter(
          (p) =>
            p.starId === atStarId &&
            (kind === 'outpost_ship' || p.body === 'planet') &&
            !state.colonies.some((c) => c.planetId === p.id),
        )
        .map((p) => p.id);
    };
    rows.push({
      ship,
      kind: ship.shipKind,
      location,
      atStarId,
      etaTurns: eta,
      canColonizeHere: settleTargets('colony_ship'),
      canOutpostHere: settleTargets('outpost_ship'),
    });
  }
  return rows;
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
      const reachable = support.some((sup) => starDistance(sup, s) <= range);
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
