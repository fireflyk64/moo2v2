// Battles: encounter detection (S7), building combat inputs from state,
// applying outcomes (S9), and post-victory bombardment (S10).

import { DEFAULT_ORDERS, runBattle, type BattleInput, type BattleOrders, type BattleResult, type CombatShipInit, type BattleTickFrame } from './combat';
import { hullById, weaponById } from './data/index';
import { colonyPopUnits } from './economy';
import { leaderCombatBonuses } from './leaders';
import { floorDiv } from './imath';
import { rngFor } from './rng';
import { baseDesign, designStats, HULLS_BUILDABLE, BASE_HULLS, type ShipDesign } from './shipdesign';
import type { Colony, Empire, GameState, PendingBattle, Ship, TurnEvent } from './types';

export function relationKey(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

export function areAtWar(state: GameState, a: number, b: number): boolean {
  const [x, y] = relationKey(a, b);
  return state.relations.some((r) => r.a === x && r.b === y && r.status === 'war');
}

export function setRelation(state: GameState, a: number, b: number, status: 'peace' | 'war'): void {
  const [x, y] = relationKey(a, b);
  const existing = state.relations.find((r) => r.a === x && r.b === y);
  if (existing) {
    existing.status = status;
    existing.peaceOfferedBy = [];
  } else {
    state.relations.push({
      a: x,
      b: y,
      status,
      peaceOfferedBy: [],
      treaties: { nap: false, alliance: false, trade: false, research: false },
    });
    state.relations.sort((r1, r2) => r1.a - r2.a || r1.b - r2.b);
  }
}

/** True if the ship fights (has a design or is a defended base-side unit). */
function isWarship(ship: Ship): boolean {
  return ship.shipKind === 'design';
}

/** S7: detect pairwise battles at each star (attacker = non-colony side or higher id). */
export function detectBattles(state: GameState): PendingBattle[] {
  const battles: PendingBattle[] = [];
  for (const star of state.stars) {
    const shipsHere = state.ships.filter((s) => s.location.kind === 'star' && s.location.starId === star.id);
    const colonyOwners = new Set(
      state.colonies
        .filter((c) => state.planets.some((p) => p.id === c.planetId && p.starId === star.id))
        .map((c) => c.owner),
    );
    const presence = new Set<number>([...shipsHere.map((s) => s.owner), ...colonyOwners]);
    const list = [...presence].sort((a, b) => a - b);
    let made = false;
    for (let i = 0; i < list.length && !made; i++) {
      for (let j = i + 1; j < list.length && !made; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (!areAtWar(state, a, b)) continue;
        // a battle needs at least one side with warships present
        const aWar = shipsHere.some((s) => s.owner === a && isWarship(s));
        const bWar = shipsHere.some((s) => s.owner === b && isWarship(s));
        const aCol = colonyOwners.has(a);
        const bCol = colonyOwners.has(b);
        if (!aWar && !bWar) continue;
        // defender = colony owner; else lower id defends
        let attacker: number;
        let defender: number;
        if (aCol && !bCol) {
          defender = a;
          attacker = b;
        } else if (bCol && !aCol) {
          defender = b;
          attacker = a;
        } else {
          defender = a;
          attacker = b;
        }
        if (!shipsHere.some((s) => s.owner === attacker && isWarship(s))) continue; // attacker must bring warships
        battles.push({
          id: `b${state.turn}-${star.id}-${attacker}v${defender}`,
          starId: star.id,
          attacker,
          defender,
          ordersA: null,
          ordersD: null,
        });
        made = true; // one battle per star per turn; others queue next turn
      }
    }
  }
  return battles;
}

function hullIndexOf(hull: string): number {
  const i = (HULLS_BUILDABLE as readonly string[]).indexOf(hull);
  if (i >= 0) return i + 1;
  const j = (BASE_HULLS as readonly string[]).indexOf(hull);
  return j >= 0 ? j + 7 : 3;
}

function shipToCombat(state: GameState, empire: Empire, ship: Ship, side: 0 | 1): CombatShipInit | null {
  if (!isWarship(ship) || ship.designId === null) return null;
  const design = empire.designs.find((d) => d.id === ship.designId);
  if (!design) return null;
  const stats = designStats(state, empire, design);
  if (typeof stats === 'string') return null;
  return {
    shipId: ship.id,
    side,
    hull: design.hull,
    hullIdx: hullIndexOf(design.hull),
    isBase: false,
    beamAttack: stats.beamAttack,
    beamDefense: stats.beamDefense,
    speed: stats.combatSpeed,
    armorHp: stats.armorHp,
    structureHp: stats.structureHp,
    shieldPool: stats.shieldPool,
    shieldFlat: stats.shieldFlat,
    weapons: stats.weapons.map((w) => ({
      weaponId: w.row.id,
      classId: w.row.classId,
      dmgMin: w.row.tacticalDamage.min,
      dmgMax: w.row.tacticalDamage.max,
      mods: w.mods,
      ammo: w.row.ammo,
      cooldown: 0,
      count: w.count,
    })),
    startingStructure: Math.max(1, stats.structureHp - ship.dmgStructure),
    startingArmor: Math.max(0, stats.armorHp - ship.dmgArmor),
  };
}

function baseToCombat(state: GameState, empire: Empire, colony: Colony, syntheticId: number): CombatShipInit | null {
  const baseBuilding = (['star_fortress', 'battlestation', 'star_base'] as const).find((b) =>
    colony.buildings.includes(b === 'battlestation' ? 'battle_station' : b),
  );
  if (!baseBuilding) return null;
  const hullId = baseBuilding === 'battlestation' ? 'battlestation' : baseBuilding;
  const design = baseDesign(state, empire, hullId);
  const stats = designStats(state, empire, { ...design, weapons: design.weapons });
  if (typeof stats === 'string') return null;
  return {
    shipId: syntheticId,
    side: 1,
    hull: hullId,
    hullIdx: hullIndexOf(hullId),
    isBase: true,
    beamAttack: stats.beamAttack,
    beamDefense: stats.beamDefense,
    speed: 0,
    armorHp: stats.armorHp,
    structureHp: stats.structureHp,
    shieldPool: stats.shieldPool,
    shieldFlat: stats.shieldFlat,
    weapons: stats.weapons.map((w) => ({
      weaponId: w.row.id,
      classId: w.row.classId,
      dmgMin: w.row.tacticalDamage.min,
      dmgMax: w.row.tacticalDamage.max,
      mods: w.mods,
      ammo: w.row.ammo,
      cooldown: 0,
      count: w.count,
    })),
    startingStructure: stats.structureHp,
    startingArmor: stats.armorHp,
  };
}

export interface BuiltBattle {
  input: BattleInput;
  baseColonyId: number | null; // colony whose base fights (destroyed if base dies)
}

export function buildBattleInput(state: GameState, battle: PendingBattle): BuiltBattle {
  const attacker = state.empires.find((e) => e.id === battle.attacker)!;
  const defender = state.empires.find((e) => e.id === battle.defender)!;
  const ships: CombatShipInit[] = [];
  for (const ship of state.ships) {
    if (ship.location.kind !== 'star' || ship.location.starId !== battle.starId) continue;
    if (ship.owner === battle.attacker) {
      const cs = shipToCombat(state, attacker, ship, 0);
      if (cs) ships.push(cs);
    } else if (ship.owner === battle.defender) {
      const cs = shipToCombat(state, defender, ship, 1);
      if (cs) ships.push(cs);
    }
  }
  let baseColonyId: number | null = null;
  const defColony = state.colonies.find(
    (c) => c.owner === battle.defender && state.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
  );
  if (defColony) {
    const base = baseToCombat(state, defender, defColony, 1_000_000 + defColony.id);
    if (base) {
      ships.push(base);
      baseColonyId = defColony.id;
    }
  }
  // ship officers: fleet-wide bonuses per side (L2)
  for (const side of [0, 1] as const) {
    const empire = side === 0 ? attacker : defender;
    const lb = leaderCombatBonuses(empire);
    if (lb.beamAttack === 0 && lb.beamDefense === 0 && lb.dmgMaxPct === 0 && lb.speedPct === 0) continue;
    for (const cs of ships) {
      if (cs.side !== side) continue;
      cs.beamAttack += lb.beamAttack;
      cs.beamDefense += lb.beamDefense;
      if (lb.speedPct > 0) cs.speed += floorDiv(cs.speed * lb.speedPct, 100);
      if (lb.dmgMaxPct > 0) {
        for (const w of cs.weapons) {
          w.dmgMax += floorDiv(w.dmgMax * lb.dmgMaxPct, 100);
        }
      }
    }
  }
  return {
    input: {
      battleId: battle.id,
      seedLabel: [state.turn, 'battle', battle.id],
      attacker: battle.attacker,
      defender: battle.defender,
      ships: ships.sort((a, b) => a.shipId - b.shipId),
      ordersA: (battle.ordersA as BattleOrders | null) ?? DEFAULT_ORDERS,
      ordersD: (battle.ordersD as BattleOrders | null) ?? { ...DEFAULT_ORDERS, stance: 'hold_range' },
    },
    baseColonyId,
  };
}

export interface ResolvedBattle {
  battle: PendingBattle;
  result: BattleResult;
  summary: Record<string, unknown>;
}

/** Resolve one battle and mutate state (ship damage/removal, base destruction,
 * bombardment, non-combat ship capture-kills). */
export function resolveBattle(state: GameState, battle: PendingBattle, events: TurnEvent[]): ResolvedBattle {
  const built = buildBattleInput(state, battle);
  const rng = rngFor(state.seed, ...built.input.seedLabel);
  const result = runBattle(built.input, rng);

  // apply ship outcomes
  const destroyedIds = new Set<number>();
  for (const o of result.outcomes) {
    if (o.shipId >= 1_000_000) {
      // defense base
      if (o.destroyed && built.baseColonyId !== null) {
        const colony = state.colonies.find((c) => c.id === built.baseColonyId);
        if (colony) {
          colony.buildings = colony.buildings.filter(
            (b) => !['star_base', 'battle_station', 'star_fortress'].includes(b),
          );
        }
      }
      continue;
    }
    const ship = state.ships.find((s) => s.id === o.shipId);
    if (!ship) continue;
    if (o.destroyed) {
      destroyedIds.add(o.shipId);
    } else {
      ship.dmgStructure = Math.max(0, o.structureMax - o.structureLeft);
      const cs = built.input.ships.find((c) => c.shipId === o.shipId);
      ship.dmgArmor = cs ? Math.max(0, cs.armorHp - o.armorLeft) : 0;
      if (o.retreated) {
        // retreat toward nearest own colony star (or stay if none)
        const empire = state.empires.find((e) => e.id === ship.owner)!;
        const home = state.colonies.find((c) => c.owner === empire.id && !c.outpost);
        const homePlanet = home ? state.planets.find((p) => p.id === home.planetId) : null;
        if (homePlanet && homePlanet.starId !== battle.starId) {
          ship.location = {
            kind: 'transit',
            from: battle.starId,
            to: homePlanet.starId,
            departedTurn: state.turn,
            arrivalTurn: state.turn + 1,
          };
        }
      }
    }
  }
  // loser's unarmed ships at the star are lost if the winner holds the field
  if (result.winner !== null) {
    const loser = result.winner === 0 ? battle.defender : battle.attacker;
    for (const ship of state.ships) {
      if (
        ship.owner === loser &&
        ship.location.kind === 'star' &&
        ship.location.starId === battle.starId &&
        !isWarship(ship)
      ) {
        destroyedIds.add(ship.id);
      }
    }
  }
  state.ships = state.ships.filter((s) => !destroyedIds.has(s.id));

  // bombardment (attacker victory + orders.bombard)
  const ordersA = built.input.ordersA;
  let bombReport: Record<string, unknown> | null = null;
  if (result.winner === 0 && ordersA.bombard && built.baseColonyId !== null) {
    bombReport = bombard(state, battle, events);
  } else if (result.winner === 0 && ordersA.bombard) {
    const colony = state.colonies.find(
      (c) => c.owner === battle.defender && state.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
    );
    if (colony) bombReport = bombard(state, battle, events);
  }

  const summary: Record<string, unknown> = {
    battleId: battle.id,
    starId: battle.starId,
    attacker: battle.attacker,
    defender: battle.defender,
    winner: result.winner === null ? null : result.winner === 0 ? battle.attacker : battle.defender,
    ticks: result.ticks,
    attackerDamagePct: result.attackerDamagePct,
    defenderDamagePct: result.defenderDamagePct,
    destroyed: result.outcomes.filter((o) => o.destroyed && o.shipId < 1_000_000).map((o) => o.shipId),
    ...(bombReport ? { bombardment: bombReport } : {}),
  };
  events.push({ visibleTo: -1, kind: 'battle_resolved', payload: summary });
  // full input + seed label: the viewer re-runs the identical sim as playback
  events.push({
    visibleTo: -1,
    kind: 'battle_replay',
    payload: { battleId: battle.id, seed: state.seed, input: built.input as unknown as Record<string, unknown>, summary },
  });
  return { battle, result, summary };
}

/** Simple bombardment: each 20 points of bomb damage kills one pop unit; every
 * other threshold destroys a building instead (documented combat-redesign rule). */
function bombard(state: GameState, battle: PendingBattle, events: TurnEvent[]): Record<string, unknown> {
  const colony = state.colonies.find(
    (c) => c.owner === battle.defender && state.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
  );
  if (!colony || colony.outpost) return { skipped: true };
  const attacker = state.empires.find((e) => e.id === battle.attacker)!;
  let bombDamage = 0;
  for (const ship of state.ships) {
    if (ship.owner !== battle.attacker || ship.location.kind !== 'star' || ship.location.starId !== battle.starId) continue;
    if (ship.designId === null) continue;
    const design = attacker.designs.find((d) => d.id === ship.designId);
    if (!design) continue;
    for (const w of design.weapons) {
      const row = weaponById.get(w.weapon);
      if (row && row.classId === 3) {
        bombDamage += ((row.tacticalDamage.min + row.tacticalDamage.max) / 2) * w.count * 10; // 10 bombing runs per ammo load
      }
    }
  }
  bombDamage = Math.floor(bombDamage);
  const rng = rngFor(state.seed, state.turn, 'bombard', battle.id);
  let popKilled = 0;
  let buildingsDestroyed: string[] = [];
  let remaining = bombDamage;
  while (remaining >= 20) {
    remaining -= 20;
    if (rng.chancePct(60) || colony.buildings.length === 0) {
      // kill population
      const grp = colony.groups[0];
      if (grp && grp.popK > 1000) {
        grp.popK -= 1000;
        popKilled++;
      } else if (grp && colonyPopUnits(colony) <= 1) {
        break; // never bomb a colony out of existence from orbit (last unit survives)
      }
    } else {
      const destructible = colony.buildings.filter((b) => b !== 'marine_barracks');
      if (destructible.length) {
        const b = destructible[rng.int(destructible.length)]!;
        colony.buildings = colony.buildings.filter((x) => x !== b);
        buildingsDestroyed.push(b);
      }
    }
  }
  for (const g of colony.groups) {
    // jobs re-normalized after losses
    const units = Math.floor(g.popK / 1000);
    while (g.farmers + g.workers + g.scientists > units) {
      if (g.scientists > 0) g.scientists--;
      else if (g.workers > 0) g.workers--;
      else g.farmers--;
    }
  }
  const report = { colonyId: colony.id, bombDamage, popKilled, buildingsDestroyed };
  events.push({ visibleTo: -1, kind: 'bombardment', payload: report });
  return report;
}

export type { BattleTickFrame };
