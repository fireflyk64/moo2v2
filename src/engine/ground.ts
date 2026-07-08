// Ground operations: transport loading, invasion combat (G1 documented rule),
// capture with unrest, and per-turn assimilation (S11).
//
// G1 invasion rule (our documented approximation; classic values unpublished):
// - each loaded transport carries 2 troop units of the owner's race
// - militia = ceil(pop/2) + 2 per barracks building (marine/armor)
// - unit strength = 20 + racial ground pick + 5 per barracks (defenders only)
// - rounds: P(attacker kills) = attackerPower/(attackerPower+defenderPower);
//   the losing side loses one unit; militia losses kill civilians 1:1 (floor 1)
// - capture: surviving civilians switch owner with unrest; troops land as pop
// - assimilation: each unrest group clears with chance 1/N per turn
//   (N: dictatorship/feudal 8, democracy 4, unification 20)

import { rngFor } from './rng';
import { ceilDiv } from './imath';
import { colonyPopUnits, empireOf, traitsOf } from './economy';
import { areAtWar } from './battles';
import { normalizeJobsForGroup } from './commands';
import type { Colony, GameState, Ship, TurnEvent } from './types';

export const TROOPS_PER_TRANSPORT = 2;

function groundStrength(state: GameState, empireId: number, defending: boolean, colony?: Colony): number {
  const empire = state.empires.find((e) => e.id === empireId);
  let str = 20;
  if (empire) str += traitsOf(empire).groundPct;
  if (defending && colony) {
    if (colony.buildings.includes('marine_barracks')) str += 5;
    if (colony.buildings.includes('armor_barracks')) str += 5;
  }
  return Math.max(5, str);
}

/** S10: resolve invasions — loaded hostile transports at a colony star with no
 * defending warships remaining. */
export function resolveInvasions(state: GameState, events: TurnEvent[]): void {
  for (const colony of [...state.colonies]) {
    if (colony.outpost) continue;
    const planet = state.planets.find((p) => p.id === colony.planetId)!;
    const starId = planet.starId;
    const invaders = state.ships.filter(
      (s) =>
        s.shipKind === 'transport' &&
        s.cargoPopUnits > 0 &&
        s.location.kind === 'star' &&
        s.location.starId === starId &&
        s.owner !== colony.owner &&
        areAtWar(state, s.owner, colony.owner),
    );
    if (!invaders.length) continue;
    // defenders present? warships block the landing
    const defended = state.ships.some(
      (s) =>
        s.owner === colony.owner &&
        s.shipKind === 'design' &&
        s.location.kind === 'star' &&
        s.location.starId === starId,
    );
    if (defended) continue;

    const attackerId = invaders.reduce((min, s) => Math.min(min, s.owner), 99);
    const force = invaders.filter((s) => s.owner === attackerId);
    let troops = force.reduce((sum, s) => sum + s.cargoPopUnits, 0);
    const pop = colonyPopUnits(colony);
    let militia = ceilDiv(pop, 2);
    if (colony.buildings.includes('marine_barracks')) militia += 2;
    if (colony.buildings.includes('armor_barracks')) militia += 2;

    const atkStr = groundStrength(state, attackerId, false);
    const defStr = groundStrength(state, colony.owner, true, colony);
    const rng = rngFor(state.seed, state.turn, 'ground', colony.id);

    const startTroops = troops;
    const startMilitia = militia;
    let civilianLosses = 0;
    while (troops > 0 && militia > 0) {
      const atkPower = troops * atkStr;
      const defPower = militia * defStr;
      if (rng.int(atkPower + defPower) < atkPower) {
        militia--;
        if (pop - civilianLosses > 1) civilianLosses++;
      } else {
        troops--;
      }
    }

    // apply civilian losses to groups (largest first, keep at least 1 unit total)
    let toKill = Math.min(civilianLosses, Math.max(0, colonyPopUnits(colony) - 1));
    const sortedGroups = [...colony.groups].sort((a, b) => b.popK - a.popK || a.race - b.race);
    for (const g of sortedGroups) {
      while (toKill > 0 && g.popK > 1000) {
        g.popK -= 1000;
        toKill--;
      }
    }
    colony.groups = colony.groups.filter((g) => g.popK > 0);
    for (const g of colony.groups) normalizeJobsForGroup(g);

    const captured = militia <= 0 && troops > 0;
    if (captured) {
      const oldOwner = colony.owner;
      colony.owner = attackerId;
      colony.queue = [];
      colony.storedProd = 0;
      colony.stickyInvested = {};
      // existing civilians become conquered (unrest)
      for (const g of colony.groups) g.unrest = true;
      // surviving troops settle
      const own = colony.groups.find((g) => g.race === attackerId);
      if (own) {
        own.popK += troops * 1000;
        own.unrest = false;
        normalizeJobsForGroup(own);
      } else {
        colony.groups.push({
          race: attackerId,
          popK: troops * 1000,
          farmers: 0,
          workers: troops,
          scientists: 0,
          unrest: false,
        });
        colony.groups.sort((a, b) => a.race - b.race);
      }
      // 20% of non-barracks structures are wrecked in the fighting
      const keep: string[] = [];
      for (const b of colony.buildings) {
        if (b !== 'marine_barracks' && rng.chancePct(20)) continue;
        keep.push(b);
      }
      colony.buildings = keep.sort();
      events.push({
        visibleTo: -1,
        kind: 'colony_captured',
        payload: { colonyId: colony.id, from: oldOwner, to: attackerId, troopsLost: startTroops - troops, defendersLost: startMilitia },
      });
    } else {
      events.push({
        visibleTo: -1,
        kind: 'invasion_repelled',
        payload: { colonyId: colony.id, attacker: attackerId, troopsLost: startTroops, defendersLost: startMilitia - militia, civilianLosses },
      });
    }

    // consume the landed transports
    const usedIds = new Set(force.map((s) => s.id));
    state.ships = state.ships.filter((s) => !usedIds.has(s.id));
  }
}

/** S11: unrest groups assimilate with chance 1/N by government. */
export function assimilate(state: GameState, events: TurnEvent[]): void {
  for (const colony of state.colonies) {
    const empire = state.empires.find((e) => e.id === colony.owner);
    if (!empire) continue;
    const gov = traitsOf(empire).government;
    const n = gov === 'democracy' ? 4 : gov === 'unification' ? 20 : 8;
    for (const g of colony.groups) {
      if (!g.unrest) continue;
      const rng = rngFor(state.seed, state.turn, 'assimilate', colony.id, g.race);
      if (rng.int(n) === 0) {
        g.unrest = false;
        events.push({
          visibleTo: colony.owner,
          kind: 'assimilated',
          payload: { colonyId: colony.id, race: g.race },
        });
      }
    }
  }
}

/** Is this colony blockaded (hostile warships present, none of ours)? */
export function isBlockaded(state: GameState, colony: Colony): boolean {
  const planet = state.planets.find((p) => p.id === colony.planetId);
  if (!planet) return false;
  const starId = planet.starId;
  let hostile = false;
  let friendly = false;
  for (const s of state.ships) {
    if (s.shipKind !== 'design' || s.location.kind !== 'star' || s.location.starId !== starId) continue;
    if (s.owner === colony.owner) friendly = true;
    else if (areAtWar(state, s.owner, colony.owner)) hostile = true;
  }
  return hostile && !friendly;
}

export function transportAt(state: GameState, shipId: number): Ship | null {
  const s = state.ships.find((x) => x.id === shipId);
  return s && s.shipKind === 'transport' ? s : null;
}
