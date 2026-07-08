// Turn resolution pipeline (WEGO). Stage order follows the mechanics docs'
// twelve-step sequence with the colony-internal ordering of §04; population
// growth consumes the PREVIOUS turn's food shortage / housing production.
// Phase 3 implements S0-S6 + S12/S13; encounters/combat (S7-S10) and empire
// upkeep systems (S11) arrive in Phases 4-6.

import { buildableById } from './data/index';
import { colonyOutput, colonyPopUnits, groupGrowthK, maxPopulation, traitsOf } from './economy';
import { normalizeJobsForGroup } from './commands';
import { rngFor } from './rng';
import { applyResearch } from './research';
import type { Colony, GameState, TurnEvent } from './types';

export interface AdvanceResult {
  events: TurnEvent[];
}

export function advanceTurn(state: GameState): AdvanceResult {
  const events: TurnEvent[] = [];

  s1_population(state, events);
  const outputs = s2_colonyOutput(state, events);
  s3_buildAdvance(state, outputs, events);
  s4_research(state, outputs, events);
  // S5 spawn happens inside s3 (completions instantiate immediately at the colony's star)
  s6_movement(state, events);
  // S7-S11: later phases
  s12_victory(state, events);
  s13_endTurn(state);

  return { events };
}

// ---------- S1 population ----------

function s1_population(state: GameState, events: TurnEvent[]): void {
  for (const colony of state.colonies) {
    if (colony.outpost || colony.groups.length === 0) continue;
    const planet = state.planets.find((p) => p.id === colony.planetId)!;
    const empire = state.empires.find((e) => e.id === colony.owner)!;
    const maxPop = maxPopulation(planet, traitsOf(empire), colony);
    const totalUnits = colonyPopUnits(colony);
    const capK = maxPop * 1000;

    let colonyPopK = colony.groups.reduce((s, g) => s + g.popK, 0);
    for (const g of colony.groups) {
      const inc = groupGrowthK(state, colony, g, maxPop, totalUnits);
      if (inc > 0) {
        const room = Math.max(0, capK - colonyPopK);
        const applied = Math.min(inc, room);
        g.popK += applied;
        colonyPopK += applied;
      } else if (inc < 0) {
        const loss = Math.min(-inc, g.popK);
        g.popK -= loss;
        colonyPopK -= loss;
        if (loss > 0) {
          events.push({
            visibleTo: colony.owner,
            kind: 'population_lost',
            payload: { colonyId: colony.id, lostK: loss },
          });
        }
      }
      normalizeJobsForGroup(g);
    }
    colony.groups = colony.groups.filter((g) => g.popK > 0);
    if (colony.groups.length === 0) {
      events.push({ visibleTo: colony.owner, kind: 'colony_died', payload: { colonyId: colony.id } });
    }
  }
  state.colonies = state.colonies.filter((c) => c.outpost || c.groups.length > 0);
}

// ---------- S2 colony output + empire rollup ----------

interface TurnOutputs {
  perColony: Map<number, ReturnType<typeof colonyOutput>>;
  empireRP: Map<number, number>;
}

function s2_colonyOutput(state: GameState, events: TurnEvent[]): TurnOutputs {
  const perColony = new Map<number, ReturnType<typeof colonyOutput>>();
  const empireRP = new Map<number, number>();
  const empireBC = new Map<number, number>();

  for (const colony of state.colonies) {
    if (colony.outpost) continue;
    const out = colonyOutput(state, colony);
    perColony.set(colony.id, out);
    empireRP.set(colony.owner, (empireRP.get(colony.owner) ?? 0) + out.research);
    empireBC.set(colony.owner, (empireBC.get(colony.owner) ?? 0) + out.bcIncome);
    colony.housingPPPrev = out.housingPP;
  }

  // food redistribution per empire: surpluses cover deficits within freighter capacity
  for (const empire of state.empires) {
    if (empire.eliminated) continue;
    const mine = state.colonies.filter((c) => c.owner === empire.id && !c.outpost);
    let surplus = 0;
    let deficits: Array<{ colony: Colony; lack: number }> = [];
    for (const c of mine) {
      const out = perColony.get(c.id);
      if (!out) continue;
      if (out.foodNet >= 0) surplus += out.foodNet;
      else deficits.push({ colony: c, lack: -out.foodNet });
    }
    let capacity = empire.freighters * 5;
    deficits = deficits.sort((a, b) => a.colony.id - b.colony.id);
    for (const d of deficits) {
      const moved = Math.min(d.lack, surplus, capacity);
      surplus -= moved;
      capacity -= moved;
      d.lack -= moved;
      d.colony.foodLackPrev = d.lack;
      if (d.lack > 0) {
        events.push({
          visibleTo: empire.id,
          kind: 'starvation',
          payload: { colonyId: d.colony.id, lack: d.lack },
        });
      }
    }
    for (const c of mine) {
      if (!deficits.some((d) => d.colony.id === c.id)) c.foodLackPrev = 0;
      c.prodLackPrev = perColony.get(c.id)?.prodLack ?? 0;
    }
    // leftover surplus: fantastic traders turn it into BC (documented in racepicks)
    if (surplus > 0 && traitsOf(empire).fantasticTraders) {
      empireBC.set(empire.id, (empireBC.get(empire.id) ?? 0) + surplus);
    }
    empire.bc += empireBC.get(empire.id) ?? 0;
    if (empire.bc < 0) {
      events.push({ visibleTo: empire.id, kind: 'treasury_deficit', payload: { bc: empire.bc } });
    }
  }

  return { perColony, empireRP };
}

// ---------- S3 build advance (+S5 spawn) ----------

function s3_buildAdvance(state: GameState, outputs: TurnOutputs, events: TurnEvent[]): void {
  for (const colony of state.colonies) {
    if (colony.outpost) continue;
    const out = outputs.perColony.get(colony.id);
    if (!out) continue;
    colony.storedProd += out.prodToQueue;

    let guard = 0;
    while (colony.queue.length > 0 && guard++ < 10) {
      const active = colony.queue[0]!.item;
      if (active === 'housing' || active === 'trade_goods') break; // never "complete"
      const cost = buildableById.get(active)?.cost ?? 0;
      if (colony.storedProd < cost) break;
      colony.storedProd -= cost;
      colony.queue.shift();
      completeItem(state, colony, active, events);
    }
    // production stored on an empty queue evaporates (classic behavior: keep it)
  }
}

function completeItem(state: GameState, colony: Colony, item: string, events: TurnEvent[]): void {
  const planet = state.planets.find((p) => p.id === colony.planetId)!;
  const empire = state.empires.find((e) => e.id === colony.owner)!;

  if (item === 'freighter_fleet') {
    empire.freighters += 5;
    events.push({ visibleTo: colony.owner, kind: 'freighters_built', payload: { colonyId: colony.id } });
    return;
  }
  if (item === 'colony_ship' || item === 'outpost_ship' || item === 'transport') {
    state.ships.push({
      id: state.nextId++,
      owner: colony.owner,
      shipKind: item,
      designId: null,
      location: { kind: 'star', starId: planet.starId },
      cargoPopUnits: 0,
      cargoRace: colony.owner,
    });
    events.push({
      visibleTo: colony.owner,
      kind: 'ship_built',
      payload: { colonyId: colony.id, item },
    });
    return;
  }
  // building
  if (!colony.buildings.includes(item)) {
    colony.buildings.push(item);
    colony.buildings.sort();
  }
  events.push({
    visibleTo: colony.owner,
    kind: 'building_complete',
    payload: { colonyId: colony.id, item },
  });
}

// ---------- S4 research ----------

function s4_research(state: GameState, outputs: TurnOutputs, events: TurnEvent[]): void {
  for (const empire of state.empires) {
    if (empire.eliminated) continue;
    const rp = outputs.empireRP.get(empire.id) ?? 0;
    const rng = rngFor(state.seed, state.turn, 'research', empire.id);
    applyResearch(state, empire, rp, rng, events);
  }
}

// ---------- S6 movement ----------

function s6_movement(state: GameState, events: TurnEvent[]): void {
  for (const ship of state.ships) {
    if (ship.location.kind !== 'transit') continue;
    if (ship.location.arrivalTurn > state.turn) continue;
    const starId = ship.location.to;
    ship.location = { kind: 'star', starId };
    const empire = state.empires.find((e) => e.id === ship.owner)!;
    if (!empire.exploredStars.includes(starId)) {
      empire.exploredStars.push(starId);
      empire.exploredStars.sort((a, b) => a - b);
      events.push({ visibleTo: ship.owner, kind: 'star_explored', payload: { starId } });
    }
    events.push({
      visibleTo: ship.owner,
      kind: 'ship_arrived',
      payload: { shipId: ship.id, starId },
    });
  }
}

// ---------- S12 victory ----------

function s12_victory(state: GameState, events: TurnEvent[]): void {
  for (const empire of state.empires) {
    if (empire.eliminated) continue;
    const hasColony = state.colonies.some((c) => c.owner === empire.id && !c.outpost);
    const hasSeedShip = state.ships.some((s) => s.owner === empire.id && s.shipKind === 'colony_ship');
    if (!hasColony && !hasSeedShip) {
      empire.eliminated = true;
      events.push({ visibleTo: -1, kind: 'empire_eliminated', payload: { empireId: empire.id } });
    }
  }
  const alive = state.empires.filter((e) => !e.eliminated);
  if (alive.length === 1 && state.empires.length > 1 && state.winner === null) {
    state.winner = alive[0]!.id;
    events.push({ visibleTo: -1, kind: 'victory', payload: { empireId: state.winner, type: 'conquest' } });
  }
}

// ---------- S13 end turn ----------

function s13_endTurn(state: GameState): void {
  for (const colony of state.colonies) colony.boughtThisTurn = false;
  state.turn += 1;
}
