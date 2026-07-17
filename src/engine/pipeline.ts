// Turn resolution pipeline (WEGO). Stage order follows the mechanics docs'
// twelve-step sequence with the colony-internal ordering of §04; population
// growth consumes the PREVIOUS turn's food shortage / housing production.
// Phase 3 implements S0-S6 + S12/S13; encounters/combat (S7-S10) and empire
// upkeep systems (S11) arrive in Phases 4-6.

import { detectBattles, resolveBattle, retreatDestination } from './battles';
import { diplomacyUpkeep } from './diplomacy';
import { resolveEspionage } from './espionage';
import { assimilate, isBlockaded, resolveInvasions } from './ground';
import { leaderEmpireBonuses, leadersUpkeep } from './leaders';
import { antaranUpkeep, hostileMonsterAt, randomEventsUpkeep } from './npc';
import { allocId } from './ids';
import { ANDROID_ITEMS, itemCost, parseDesignItem, parseRefitItem } from './items';
import { commandPoints, inRange, supportStars } from './movement';
import { availableHulls, defaultDesign, designLoadoutKey } from './shipdesign';
import { ceilDiv } from './imath';
import { applyTerraformStep, constructAsBarren, convertiblePlanetsInSystem, terraformCost, unsettledPlanetsInSystem } from './terraform';
import { busyFreighters, colonyMaxPop, colonyOutput, colonyPopUnits, farmingViable, freeFreighters, groupGrowthK, maxPopulation, organicUnitsOf, traitsOf } from './economy';
import { applyFoundingSpecials, normalizeJobsForGroup } from './commands';
import { rngFor } from './rng';
import { applyResearch, appPickableBy, availableFields, grantApp } from './research';
import { applicationsOfField } from './data/index';
import { ANDROID_RACE, NATIVE_RACE, type Colony, type GameState, type TurnEvent } from './types';

export interface AdvanceResult {
  events: TurnEvent[];
}

/** advance_turn: S1-S7. If battles are detected the state pauses in the
 * battle_orders phase; the resolve_combat system command finishes the turn. */
export function advanceTurn(state: GameState): AdvanceResult {
  const events: TurnEvent[] = [];

  s1_population(state, events);
  const outputs = s2_colonyOutput(state, events);
  s3_buildAdvance(state, outputs, events);
  s4_research(state, outputs, events);
  // S5 spawn happens inside s3 (completions instantiate immediately at the colony's star)
  s6_movement(state, events);
  s6b_discoveries(state, events);

  // S7 encounters
  const battles = detectBattles(state);
  if (battles.length > 0) {
    state.pendingBattles = battles;
    state.phase = 'battle_orders';
    for (const b of battles) {
      events.push({
        visibleTo: -1,
        kind: 'battle_pending',
        payload: { battleId: b.id, starId: b.starId, attacker: b.attacker, defender: b.defender },
      });
    }
    return { events };
  }

  finishTurn(state, events);
  return { events };
}

/** resolve_combat: S9-S13 after the battle-orders sub-phase (or immediately
 * when no battles were pending). */
export function resolveCombat(state: GameState): AdvanceResult {
  const events: TurnEvent[] = [];
  for (const battle of state.pendingBattles) {
    resolveBattle(state, battle, events);
  }
  state.pendingBattles = [];
  state.phase = 'planning';
  finishTurn(state, events);
  return { events };
}

function finishTurn(state: GameState, events: TurnEvent[]): void {
  resolveInvasions(state, events); // S10 ground operations
  s10_strandedRetreat(state, events); // ships beyond fuel range limp home
  s10_shipUpkeep(state, events);
  s11_diplomacyUpkeep(state); // peace handshakes
  assimilate(state, events); // S11 conquered populations settle in
  resolveEspionage(state, events); // S11 spies act
  leadersUpkeep(state, events); // S11 leader offers, salaries, XP
  antaranUpkeep(state, events); // S11 raid cadence + withdrawals
  randomEventsUpkeep(state, events); // S11 option-gated events
  diplomacyUpkeep(state, events); // S11 treaties, proposals, council
  s11_defaultDesignRefresh(state, events); // default designs track the new tech
  s12_victory(state, events);
  s13_endTurn(state);
}

// ---------- S11: default designs track research ----------

/** Engine-maintained default warship designs (design.auto): one per available
 * hull class, refitted with the best known computer, shield and beam/missile
 * mix whenever this turn's research (or espionage steal, or a tech trade)
 * improved the fit. Runs AFTER every app-granting step so all of them are
 * covered. The old version is obsoleted — ships already in space keep flying
 * their old fit; upgrades cost a refit, never arrive free — and queued builds
 * and refits migrate to the refreshed design so no production is dropped.
 * Obsoleting an auto design by command just means it comes back refreshed
 * here; player-saved designs are never touched. */
function s11_defaultDesignRefresh(state: GameState, events: TurnEvent[]): void {
  for (const empire of state.empires) {
    if (empire.eliminated) continue;
    for (const hull of availableHulls(empire)) {
      const desired = defaultDesign(state, empire, hull);
      const current = empire.designs.find((d) => d.auto && !d.obsolete && d.hull === hull);
      if (current && designLoadoutKey(current) === designLoadoutKey(desired)) continue;
      const design = {
        id: allocId(state, empire.id),
        ...desired,
        // a refresh keeps the name the player knows the class by
        ...(current ? { name: current.name } : {}),
        obsolete: false,
        auto: true,
      };
      empire.designs.push(design);
      if (current) {
        current.obsolete = true;
        for (const colony of state.colonies) {
          if (colony.owner !== empire.id) continue;
          for (const q of colony.queue) {
            if (q.item === `design:${current.id}`) q.item = `design:${design.id}`;
            const refit = parseRefitItem(q.item);
            if (refit !== null && refit.designId === current.id) q.item = `refit:${refit.shipId}:${design.id}`;
          }
        }
      }
      events.push({
        visibleTo: empire.id,
        kind: 'design_updated',
        payload: { hull, designId: design.id, name: design.name, replaced: current?.id ?? null },
      });
    }
  }
}

// ---------- S10: stranded ships limp home ----------

/** Any ship sitting at a star BEYOND its empire's fuel range — it arrived on
 * a wormhole/valid order and the network then shrank (colony lost, outpost
 * scrapped), or it was moved before range tightened — automatically retreats
 * toward the nearest own colony. It fights first (battles resolve before
 * this step), then withdraws; a ship already at one of its own colony stars
 * is in range by definition and never moves. Ships whose empire has no
 * colony to run to hold position. inRange extends supply through wormholes,
 * so a fleet at either end holds station as long as the other end is inside
 * the network. */
function s10_strandedRetreat(state: GameState, events: TurnEvent[]): void {
  for (const empire of state.empires) {
    if (empire.eliminated) continue;
    const support = supportStars(state, empire.id);
    if (support.length === 0) continue; // no network at all: nowhere to be stranded FROM
    for (const ship of state.ships) {
      if (ship.owner !== empire.id || ship.location.kind !== 'star') continue;
      const star = state.stars.find((s) => s.id === (ship.location as { starId: number }).starId);
      if (!star) continue;
      if (inRange(state, empire.id, star)) continue; // in supply (incl. via wormhole)
      const dest = retreatDestination(state, empire.id, star.id);
      if (!dest) continue; // no colony to run to: hold position
      ship.location = {
        kind: 'transit',
        from: star.id,
        to: dest.starId,
        departedTurn: state.turn,
        arrivalTurn: dest.arrivalTurn,
      };
      events.push({
        visibleTo: empire.id,
        kind: 'ship_stranded_retreat',
        payload: { shipId: ship.id, from: star.id, to: dest.starId, arrivalTurn: dest.arrivalTurn },
      });
    }
  }
}

// ---------- S10-lite: ship repair + command point upkeep ----------

function s10_shipUpkeep(state: GameState, events: TurnEvent[]): void {
  // repair at own colony stars (engineer officers repair anywhere)
  for (const ship of state.ships) {
    if ((ship.dmgStructure > 0 || ship.dmgArmor > 0) && ship.location.kind === 'star') {
      const starId = ship.location.starId;
      const empire = state.empires.find((e) => e.id === ship.owner);
      const repaired =
        (empire && leaderEmpireBonuses(empire).engineerRepair) ||
        state.colonies.some(
          (c) => c.owner === ship.owner && !c.outpost && state.planets.some((p) => p.id === c.planetId && p.starId === starId),
        );
      if (repaired) {
        ship.dmgStructure = 0;
        ship.dmgArmor = 0;
      }
    }
  }
  // command points: overage costs 10 BC per point (documented combat-redesign rule)
  for (const empire of state.empires) {
    if (empire.eliminated) continue;
    const cp = commandPoints(state, empire);
    const over = cp.usage - cp.sources;
    if (over > 0) {
      empire.bc -= over * 10;
      events.push({ visibleTo: empire.id, kind: 'cp_overage', payload: { over, bc: over * 10 } });
    }
  }
}

// ---------- S11-lite: peace handshakes ----------

function s11_diplomacyUpkeep(state: GameState): void {
  for (const rel of state.relations) {
    if (rel.status === 'war' && rel.peaceOfferedBy.includes(rel.a) && rel.peaceOfferedBy.includes(rel.b)) {
      rel.status = 'peace';
      rel.peaceOfferedBy = [];
    }
  }
}

// ---------- S1 population ----------

function s1_population(state: GameState, events: TurnEvent[]): void {
  for (const colony of state.colonies) {
    if (colony.outpost || colony.groups.length === 0) continue;
    const maxPop = colonyMaxPop(state, colony);
    const totalUnits = colonyPopUnits(colony);
    const capK = maxPop * 1000;

    // androids never occupy organic housing: the climate-cap clamp counts
    // organics only, matching groupGrowthK and the movement validators
    let colonyPopK = colony.groups.reduce((s, g) => s + (g.race === ANDROID_RACE ? 0 : g.popK), 0);
    for (const g of colony.groups) {
      const inc = groupGrowthK(state, colony, g, maxPop, totalUnits);
      if (inc > 0) {
        const room = Math.max(0, capK - colonyPopK);
        const applied = Math.min(inc, room);
        g.popK += applied;
        colonyPopK += applied;
      } else if (inc < 0) {
        // starvation never wipes a settlement out: the last whole colonist
        // unit survives on scraps (bug: "food should not starve below 1 pop")
        const spare = Math.max(0, colonyPopK - 1000);
        const loss = Math.min(-inc, g.popK, spare);
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
    // a colony can never linger below one whole unit of TOTAL population.
    // The total matters, not any single group: a two-race colony starved to
    // 750K + 790K still holds its "last colonist" (the starvation floor above
    // keeps the sum >= 1000K) — culling because no SINGLE group held a whole
    // unit wiped exactly the multi-race colonies the guard was meant to save.
    const totalPopK = colony.groups.reduce((s, g) => s + g.popK, 0);
    if (totalPopK < 1000) colony.groups = [];
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
    let capacity = freeFreighters(state, empire); // 1 food per freighter (5 per fleet)
    // chartered civilian haulers beyond freighter capacity: 1 BC per food unit
    let charterBudget = Math.max(0, empire.bc + (empireBC.get(empire.id) ?? 0));
    let charterSpent = 0;
    let freighterFood = 0; // food units hauled by OWN freighters this turn
    deficits = deficits.sort((a, b) => a.colony.id - b.colony.id);
    for (const d of deficits) {
      // blockaded colonies cannot receive deliveries at all
      const blockaded = isBlockaded(state, d.colony);
      const moved = blockaded ? 0 : Math.min(d.lack, surplus, capacity);
      surplus -= moved;
      capacity -= moved;
      freighterFood += moved;
      d.lack -= moved;
      const chartered = blockaded ? 0 : Math.min(d.lack, surplus, charterBudget);
      if (chartered > 0) {
        surplus -= chartered;
        charterBudget -= chartered;
        charterSpent += chartered;
        d.lack -= chartered;
      }
      d.colony.foodLackPrev = d.lack;
      if (d.lack > 0) {
        events.push({
          visibleTo: empire.id,
          kind: 'starvation',
          payload: { colonyId: d.colony.id, lack: d.lack },
        });
      }
    }
    if (charterSpent > 0) {
      empireBC.set(empire.id, (empireBC.get(empire.id) ?? 0) - charterSpent);
      events.push({ visibleTo: empire.id, kind: 'food_chartered', payload: { units: charterSpent, bc: charterSpent } });
    }
    // freighter maintenance: 0.5 BC per freighter IN USE this turn (one per
    // food unit hauled, five per colonist unit in transit); idle hulls are
    // free. Integer ledger: charge rounds up.
    const freightersInUse = freighterFood + busyFreighters(state, empire.id);
    if (freightersInUse > 0) {
      const upkeep = ceilDiv(freightersInUse, 2);
      empireBC.set(empire.id, (empireBC.get(empire.id) ?? 0) - upkeep);
      events.push({ visibleTo: empire.id, kind: 'freighter_upkeep', payload: { inUse: freightersInUse, bc: upkeep } });
    }
    for (const c of mine) {
      if (!deficits.some((d) => d.colony.id === c.id)) c.foodLackPrev = 0;
      c.prodLackPrev = perColony.get(c.id)?.prodLack ?? 0;
    }
    // leftover surplus: fantastic traders turn it into BC (documented in racepicks)
    if (surplus > 0 && traitsOf(empire).fantasticTraders) {
      empireBC.set(empire.id, (empireBC.get(empire.id) ?? 0) + surplus);
    }
    empire.bc += (empireBC.get(empire.id) ?? 0) + leaderEmpireBonuses(empire).bcFlat;
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
    const idleAllTurn = colony.queue.length === 0;
    colony.storedProd += out.prodToQueue;

    let guard = 0;
    while (colony.queue.length > 0 && guard++ < 10) {
      const active = colony.queue[0]!.item;
      if (active === 'housing' || active === 'trade_goods') break; // never "complete"
      const cost = itemCost(state, colony.owner, active, colony);
      if (cost === null) {
        colony.queue.shift(); // design was obsoleted/removed; drop the entry
        continue;
      }
      if (colony.storedProd < cost) break;
      colony.storedProd -= cost;
      colony.queue.shift();
      completeItem(state, colony, active, events);
    }
    // production stored on a queue that was empty ALL turn evaporates
    // (classic behavior) — banking it indefinitely lets an idle colony buy a
    // Star Fortress "for free" the turn it finally queues one. Overflow from
    // an item that just completed still carries to next turn's queue.
    if (idleAllTurn && colony.queue.length === 0) colony.storedProd = 0;
  }
}

function completeItem(state: GameState, colony: Colony, item: string, events: TurnEvent[]): void {
  const planet = state.planets.find((p) => p.id === colony.planetId)!;
  const empire = state.empires.find((e) => e.id === colony.owner)!;

  if (item === 'spy') {
    empire.spies.count = Math.min(10, empire.spies.count + 1);
    events.push({ visibleTo: colony.owner, kind: 'spy_trained', payload: { colonyId: colony.id, count: empire.spies.count } });
    return;
  }
  if (item === 'terraforming') {
    const next = applyTerraformStep(planet);
    if (next === null) {
      // the chain topped out before this step landed: refund instead of
      // silently burning hundreds of PP
      colony.storedProd += terraformCost(planet);
      return;
    }
    events.push({ visibleTo: colony.owner, kind: 'terraformed', payload: { colonyId: colony.id, climate: next } });
    return;
  }
  if (item === 'gaia_transformation') {
    if (planet.climate === 'terran') {
      planet.climate = 'gaia';
      events.push({ visibleTo: colony.owner, kind: 'terraformed', payload: { colonyId: colony.id, climate: 'gaia' } });
    } else {
      // the world already transformed (duplicate queue entry): refund instead
      // of silently burning ~500 PP — same rule as topped-out terraforming
      colony.storedProd += itemCost(state, colony.owner, 'gaia_transformation', colony) ?? 0;
    }
    return;
  }
  if (item === 'artificial_planet') {
    const target = convertiblePlanetsInSystem(state, planet.starId)[0];
    if (!target) {
      // every belt/giant here already converted (duplicate queue entry):
      // refund instead of burning 500 PP — same rule as gaia_transformation
      colony.storedProd += itemCost(state, colony.owner, 'artificial_planet', colony) ?? 0;
      return;
    }
    constructAsBarren(target);
    events.push({
      visibleTo: colony.owner,
      kind: 'planet_constructed',
      payload: { colonyId: colony.id, planetId: target.id, orbit: target.orbit },
    });
    return;
  }
  if (item === 'colony_base') {
    const open = unsettledPlanetsInSystem(state, planet.starId);
    const target = open[0];
    if (!target) {
      // the system filled up before this base launched (duplicate entry or a
      // rival settled first): refund the production instead of burning it
      colony.storedProd += itemCost(state, colony.owner, 'colony_base', colony) ?? 0;
      return;
    }
    if (target) {
      const star = state.stars.find((st) => st.id === planet.starId)!;
      const romans = ['I', 'II', 'III', 'IV', 'V'];
      state.colonies.push({
        id: allocId(state, colony.owner),
        planetId: target.id,
        owner: colony.owner,
        name: `${star.name} ${romans[target.orbit - 1] ?? target.orbit}`,
        groups: [{ race: colony.owner, popK: 1000, farmers: 1, workers: 0, scientists: 0, unrest: false }],
        buildings: [],
        queue: [],
        storedProd: 0,
        stickyInvested: {},
        boughtThisTurn: false,
        foodLackPrev: 0,
        prodLackPrev: 0,
        housingPPPrev: 0,
        outpost: false,
      });
      // seed a worker, not a farmer, where farming is impossible
      const settled = state.colonies[state.colonies.length - 1]!;
      if (!farmingViable(state, settled)) {
        settled.groups[0]!.farmers = 0;
        settled.groups[0]!.workers = 1;
      }
      // founding consumes one-time specials exactly like the colonize command
      // (space-debris salvage, splinter colonists, native integration)
      applyFoundingSpecials(state, target, settled, events);
      state.colonies.sort((a, b) => a.id - b.id);
      events.push({ visibleTo: colony.owner, kind: 'colony_founded', payload: { planetId: target.id, viaBase: true } });
    }
    return;
  }
  if (item === 'freighter_fleet') {
    empire.freighters += 5;
    events.push({ visibleTo: colony.owner, kind: 'freighters_built', payload: { colonyId: colony.id } });
    return;
  }
  if ((ANDROID_ITEMS as readonly string[]).includes(item)) {
    // one android unit rolls off the line, hardwired to its job for life
    const job = item.slice('android_'.length) as 'farmers' | 'workers' | 'scientists';
    let grp = colony.groups.find((g) => g.race === ANDROID_RACE);
    if (!grp) {
      grp = { race: ANDROID_RACE, popK: 0, farmers: 0, workers: 0, scientists: 0, unrest: false };
      colony.groups.push(grp);
      colony.groups.sort((a, b) => a.race - b.race);
    }
    grp.popK += 1000;
    grp[job] += 1;
    events.push({ visibleTo: colony.owner, kind: 'android_built', payload: { colonyId: colony.id, job } });
    return;
  }
  const refit = parseRefitItem(item);
  if (refit !== null) {
    const ship = state.ships.find((s) => s.id === refit.shipId && s.owner === colony.owner);
    const design = empire.designs.find((d) => d.id === refit.designId);
    if (
      ship &&
      design &&
      ship.shipKind === 'design' &&
      ship.location.kind === 'star' &&
      ship.location.starId === planet.starId
    ) {
      ship.designId = refit.designId;
      // the yard overhauls the ship while rebuilding it
      ship.dmgStructure = 0;
      ship.dmgArmor = 0;
      events.push({
        visibleTo: colony.owner,
        kind: 'ship_refitted',
        payload: { colonyId: colony.id, shipId: ship.id, designId: refit.designId },
      });
    } else {
      // the ship sailed (or died) before the yard finished: salvage half back
      const cost = itemCost(state, colony.owner, item, colony) ?? 0;
      empire.bc += Math.floor(cost / 2);
      events.push({
        visibleTo: colony.owner,
        kind: 'refit_failed',
        payload: { colonyId: colony.id, shipId: refit.shipId, refundBC: Math.floor(cost / 2) },
      });
    }
    return;
  }
  const designId = parseDesignItem(item);
  if (designId !== null) {
    state.ships.push({
      id: allocId(state, colony.owner),
      owner: colony.owner,
      shipKind: 'design',
      designId,
      location: { kind: 'star', starId: planet.starId },
      cargoPopUnits: 0,
      cargoRace: colony.owner,
      dmgStructure: 0,
      dmgArmor: 0,
    });
    events.push({ visibleTo: colony.owner, kind: 'ship_built', payload: { colonyId: colony.id, item } });
    return;
  }
  if (item === 'colony_ship' || item === 'outpost_ship' || item === 'transport' || item === 'construction_ship') {
    state.ships.push({
      id: allocId(state, colony.owner),
      owner: colony.owner,
      shipKind: item,
      designId: null,
      location: { kind: 'star', starId: planet.starId },
      cargoPopUnits: 0,
      cargoRace: colony.owner,
      dmgStructure: 0,
      dmgArmor: 0,
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
    const rp = (outputs.empireRP.get(empire.id) ?? 0) + leaderEmpireBonuses(empire).rpFlat;
    const rng = rngFor(state.seed, state.turn, 'research', empire.id);
    applyResearch(state, empire, rp, rng, events);
  }
}

// ---------- S6 movement ----------

function s6_movement(state: GameState, events: TurnEvent[]): void {
  // this advance produces turn (state.turn + 1): anything due then is placed
  // at its star now, so a "1 turn" ETA really is one turn boundary away
  const arrivingBy = state.turn + 1;
  for (const ship of state.ships) {
    if (ship.location.kind !== 'transit') continue;
    if (ship.location.arrivalTurn > arrivingBy) continue;
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
    // settling opportunity alert: a colony ship just reached a system with an
    // open (unguarded) planet — the map view surfaces this like a breakthrough
    if (ship.shipKind === 'colony_ship' && !hostileMonsterAt(state, starId)) {
      const open = unsettledPlanetsInSystem(state, starId);
      if (open.length > 0) {
        events.push({
          visibleTo: ship.owner,
          kind: 'colony_ship_arrived',
          payload: { shipId: ship.id, starId, planetId: open[0]!.id },
        });
      }
    }
  }

  // colonists riding freighters land the same way (their 5-per-unit
  // freighter allocation frees up on arrival or loss)
  if (state.popTransits?.length) {
    const remaining: typeof state.popTransits = [];
    for (const t of state.popTransits) {
      if (t.arrivalTurn > arrivingBy) {
        remaining.push(t);
        continue;
      }
      const colony = state.colonies.find((c) => c.id === t.toColonyId);
      if (!colony || colony.owner !== t.empireId || colony.outpost) {
        events.push({
          visibleTo: t.empireId,
          kind: 'colonists_lost',
          payload: { toColonyId: t.toColonyId, units: t.units },
        });
        continue;
      }
      // organic units only — validateMoveColonists admits the trip on the
      // same measure, so a validated transfer always has its room on arrival
      const room = Math.max(0, colonyMaxPop(state, colony) - organicUnitsOf(colony));
      const landed = Math.min(t.units, room);
      if (landed > 0) {
        let dst = colony.groups.find((g) => g.race === t.race);
        if (!dst) {
          dst = { race: t.race, popK: 0, farmers: 0, workers: 0, scientists: 0, unrest: false };
          colony.groups.push(dst);
          colony.groups.sort((a, b) => a.race - b.race);
        }
        dst.popK += landed * 1000;
        dst.workers += landed;
        events.push({
          visibleTo: t.empireId,
          kind: 'colonists_arrived',
          payload: { colonyId: colony.id, units: landed },
        });
      }
      if (landed < t.units) {
        events.push({
          visibleTo: t.empireId,
          kind: 'colonists_lost',
          payload: { toColonyId: t.toColonyId, units: t.units - landed },
        });
      }
    }
    state.popTransits = remaining;
  }
}

// ---------- S6b discovery payouts ----------

/** Unclaimed planet specials pay out to the first empire that VISITS the
 * system — a ship (or colony) present and no hostile keeper, so guarded
 * prizes pay only after the monster falls (planet_specials.md):
 * - ancient_artifacts: one free technology for the discoverer; the planet's
 *   +2-research special itself stays forever.
 * - splinter_colony: the settlement joins the discoverer outright with up to
 *   3 farm-only native units (they never relocate — NATIVE_RACE rules).
 * When two empires arrive the same turn, the lower empire id claims (the
 * same deterministic tiebreak the rest of the engine uses). */
function s6b_discoveries(state: GameState, events: TurnEvent[]): void {
  const romans = ['I', 'II', 'III', 'IV', 'V'];
  for (const planet of state.planets) {
    if (planet.body !== 'planet') continue;
    const splinter = planet.special === 'splinter_colony' && !state.colonies.some((c) => c.planetId === planet.id);
    const artifact = planet.special === 'ancient_artifacts' && planet.artifactsLooted !== true;
    if (!splinter && !artifact) continue;
    if (hostileMonsterAt(state, planet.starId)) continue;
    let claimant: number | null = null;
    for (const ship of state.ships) {
      if (ship.owner < 0 || ship.location.kind !== 'star' || ship.location.starId !== planet.starId) continue;
      if (claimant === null || ship.owner < claimant) claimant = ship.owner;
    }
    for (const colony of state.colonies) {
      const p = state.planets.find((x) => x.id === colony.planetId);
      if (p?.starId !== planet.starId) continue;
      if (claimant === null || colony.owner < claimant) claimant = colony.owner;
    }
    if (claimant === null) continue;
    const empire = state.empires.find((e) => e.id === claimant);
    if (!empire || empire.eliminated) continue;

    if (artifact) {
      planet.artifactsLooted = true;
      // one free technology from the fields the empire could research right
      // now (near-term knowledge, not an endgame lottery); hyper-advanced
      // repeatables excluded. Nothing learnable = the cache is just dust.
      const candidates: string[] = [];
      for (const field of availableFields(empire)) {
        if (field.id.startsWith('advf_')) continue;
        for (const app of applicationsOfField(field.id)) {
          if (!empire.knownApps.includes(app.id) && appPickableBy(empire, app.id)) candidates.push(app.id);
        }
      }
      candidates.sort();
      if (candidates.length) {
        const rng = rngFor(state.seed, state.turn, 'artifact', planet.id);
        const appId = candidates[rng.int(candidates.length)]!;
        grantApp(empire, appId);
        events.push({
          visibleTo: claimant,
          kind: 'artifact_tech',
          payload: { planetId: planet.id, starId: planet.starId, appId },
        });
      }
    }

    if (splinter) {
      planet.special = null;
      const star = state.stars.find((s) => s.id === planet.starId)!;
      const units = Math.max(1, Math.min(3, maxPopulation(planet, traitsOf(empire))));
      const colony: Colony = {
        id: allocId(state, claimant),
        planetId: planet.id,
        owner: claimant,
        name: `${star.name} ${romans[planet.orbit - 1] ?? planet.orbit}`,
        groups: [{ race: NATIVE_RACE, popK: units * 1000, farmers: units, workers: 0, scientists: 0, unrest: false }],
        buildings: [],
        queue: [],
        storedProd: 0,
        stickyInvested: {},
        boughtThisTurn: false,
        foodLackPrev: 0,
        prodLackPrev: 0,
        housingPPPrev: 0,
        outpost: false,
      };
      state.colonies.push(colony);
      state.colonies.sort((a, b) => a.id - b.id);
      events.push({
        visibleTo: claimant,
        kind: 'splinter_joined',
        payload: { colonyId: colony.id, starId: planet.starId, units },
      });
    }
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
      // scrub the dead empire's leftovers like resign/surrender do — ghost
      // fleets would otherwise blockade, fight, and invade forever
      empire.leaders = [];
      empire.spies = { count: 0, target: null, mode: 'steal' };
      state.ships = state.ships.filter((s) => s.owner !== empire.id);
      state.colonies = state.colonies.filter((c) => c.owner !== empire.id);
      state.proposals = state.proposals.filter((p) => p.from !== empire.id && p.to !== empire.id);
      state.leaderOffers = state.leaderOffers.filter((o) => o.empireId !== empire.id);
      events.push({ visibleTo: -1, kind: 'empire_eliminated', payload: { empireId: empire.id } });
    }
  }
  const alive = state.empires.filter((e) => !e.eliminated);
  if (alive.length === 1 && state.empires.length > 1 && state.winner === null) {
    state.winner = alive[0]!.id;
    state.winType = 'conquest';
    events.push({ visibleTo: -1, kind: 'victory', payload: { empireId: state.winner, type: 'conquest' } });
  }
}

// ---------- S13 end turn ----------

function s13_endTurn(state: GameState): void {
  for (const colony of state.colonies) {
    colony.boughtThisTurn = false;
    if (colony.soldThisTurn) colony.soldThisTurn = false;
  }
  state.turn += 1;
}
