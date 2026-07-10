// Battles: encounter detection (S7), building combat inputs from state,
// applying outcomes (S9), and post-victory bombardment (S10).

import { DEFAULT_ORDERS, runBattle, type BattleInput, type BattleOrders, type BattleResult, type CombatShipInit, type BattleTickFrame } from './combat';
import { hullById, weaponById } from './data/index';
import { colonyPopUnits } from './economy';
import { starDistance } from './galaxy';
import { travelTurns } from './movement';
import { leaderCombatBonuses } from './leaders';
import { floorDiv } from './imath';
import { rngFor } from './rng';
import { baseDesign, designStats, knownWeapons, HULLS_BUILDABLE, BASE_HULLS, type ShipDesign } from './shipdesign';
import { shipStyleOf } from './shipstyles';
import { ANTARAN_EMPIRE, antaranRaze, factionOf, guardianReward, monstersAt, monsterToCombat } from './npc';
import type { Colony, Empire, GameState, PendingBattle, Ship, TurnEvent } from './types';

export function relationKey(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

/** Nearest own (non-outpost) colony star to fall back to after a battle, with
 * a distance-honest ETA. state.colonies is id-sorted, so a naive find() would
 * "retreat" every fleet to the homeworld in exactly one turn — free strategic
 * fast-travel. */
function retreatDestination(
  state: GameState,
  ownerId: number,
  fromStarId: number,
): { starId: number; arrivalTurn: number } | null {
  const empire = state.empires.find((e) => e.id === ownerId);
  const from = state.stars.find((st) => st.id === fromStarId);
  if (!empire || !from) return null;
  let best: { starId: number; d: number } | null = null;
  for (const c of state.colonies) {
    if (c.owner !== ownerId || c.outpost) continue;
    const p = state.planets.find((pl) => pl.id === c.planetId);
    if (!p || p.starId === fromStarId) continue;
    const star = state.stars.find((st) => st.id === p.starId);
    if (!star) continue;
    const d = starDistance(from, star);
    if (!best || d < best.d || (d === best.d && star.id < best.starId)) best = { starId: star.id, d };
  }
  if (!best) return null;
  const to = state.stars.find((st) => st.id === best!.starId)!;
  return { starId: best.starId, arrivalTurn: state.turn + travelTurns(state, empire, from, to) };
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
/** Combat-capable: designed warships and (lightly armed) scouts. */
function isWarship(ship: Ship): boolean {
  return ship.shipKind === 'design' || ship.shipKind === 'scout';
}

/** S7: detect pairwise battles at each star (attacker = non-colony side or higher id).
 * NPC forces (monsters -2, Antarans -3) take precedence at their star; the NPC
 * side's orders are pre-filled so only humans are awaited (M2). */
export function detectBattles(state: GameState): PendingBattle[] {
  const battles: PendingBattle[] = [];
  const npcOrders: BattleOrders = { stance: 'hold_range', priority: 'nearest', retreatThresholdPct: 0, bombard: false };
  for (const star of state.stars) {
    const shipsHere = state.ships.filter((s) => s.location.kind === 'star' && s.location.starId === star.id);
    const colonyOwners = new Set(
      state.colonies
        .filter((c) => state.planets.some((p) => p.id === c.planetId && p.starId === star.id))
        .map((c) => c.owner),
    );
    // NPC encounter first: monsters defend their lair; Antaran raiders attack the colony
    const npcs = state.monsters.filter((m) => m.starId === star.id);
    if (npcs.length > 0) {
      const faction = factionOf(npcs[0]!);
      // portal assault: the player charges the Antaran home garrison
      if (state.antarans.assaultBy !== null && npcs.some((m) => m.kind === 'antaran_fortress')) {
        battles.push({
          id: `b${state.turn}-${star.id}-${state.antarans.assaultBy}vantares`,
          starId: star.id,
          attacker: state.antarans.assaultBy,
          defender: ANTARAN_EMPIRE,
          ordersA: null,
          ordersD: npcOrders,
        });
        continue;
      }
      if (faction === ANTARAN_EMPIRE && colonyOwners.size > 0) {
        // the raid resolves against the empire it was AIMED at, not whichever
        // co-located empire has the lowest id
        const intended = npcs.find((m) => m.raidTargetEmpire !== undefined && colonyOwners.has(m.raidTargetEmpire))?.raidTargetEmpire;
        const defender = intended ?? [...colonyOwners].sort((a, b) => a - b)[0]!;
        battles.push({
          id: `b${state.turn}-${star.id}-antaransv${defender}`,
          starId: star.id,
          attacker: ANTARAN_EMPIRE,
          defender,
          ordersA: { ...npcOrders, stance: 'charge' },
          ordersD: null,
        });
        continue;
      }
      const challengers = [...new Set(shipsHere.filter((s) => s.owner >= 0 && isWarship(s)).map((s) => s.owner))].sort((a, b) => a - b);
      if (challengers.length > 0) {
        battles.push({
          id: `b${state.turn}-${star.id}-${challengers[0]}vnpc`,
          starId: star.id,
          attacker: challengers[0]!,
          defender: faction,
          ordersA: null,
          ordersD: npcOrders,
        });
      }
      continue; // one battle per star: the lair fight blocks player-vs-player here
    }
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
  // scouts carry a single laser cannon and CAN fight (bug: "scouts should
  // have 1 laser and be able to fight") — a synthetic frigate-class fit
  if (ship.shipKind === 'scout') {
    const scoutDesign = {
      id: -1,
      name: 'Scout',
      hull: 'frigate',
      computer: 0,
      shield: 0,
      specials: [] as string[],
      weapons: [{ weapon: 'laser_cannon', count: 1, mods: [] as string[] }],
      obsolete: false,
    };
    const stats = designStats(state, empire, scoutDesign);
    if (typeof stats === 'string') return null;
    return {
      shipId: ship.id,
      side,
      hull: 'frigate',
      hullIdx: hullIndexOf('frigate'),
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
        // strike craft (classId 4) hit with their strategic payload
        dmgMin: w.row.classId === 4 ? w.row.strategicDamage.min : w.row.tacticalDamage.min,
        dmgMax: w.row.classId === 4 ? w.row.strategicDamage.max : w.row.tacticalDamage.max,
        // built-in weapon behaviors (mauler 'hit', starlight 'mar/co', ...)
        // ride along with the design-chosen mods
        mods: [...new Set([...w.mods, ...w.row.naturalMods])],
        ammo: w.row.ammo,
        cooldown: 0,
        count: w.count,
        arc: w.arc,
      })),
      startingStructure: Math.max(1, stats.structureHp - ship.dmgStructure),
      startingArmor: Math.max(0, stats.armorHp - ship.dmgArmor),
      specials: [],
      style: shipStyleOf(empire),
      modelIdx: ship.id, // designless hulls: stable per-ship variety
      modelKind: 'scout',
    };
  }
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
      dmgMin: w.row.classId === 4 ? w.row.strategicDamage.min : w.row.tacticalDamage.min,
      dmgMax: w.row.classId === 4 ? w.row.strategicDamage.max : w.row.tacticalDamage.max,
      mods: [...new Set([...w.mods, ...w.row.naturalMods])],
      ammo: w.row.ammo,
      cooldown: 0,
      count: w.count,
      arc: w.arc,
    })),
    startingStructure: Math.max(1, stats.structureHp - ship.dmgStructure),
    startingArmor: Math.max(0, stats.armorHp - ship.dmgArmor),
    specials: design.specials,
    style: shipStyleOf(empire),
    modelIdx: design.modelIdx ?? design.id,
  };
}

function baseToCombat(state: GameState, empire: Empire, colony: Colony, syntheticId: number): CombatShipInit | null {
  const baseBuilding = (['star_fortress', 'battlestation', 'star_base'] as const).find((b) =>
    colony.buildings.includes(b === 'battlestation' ? 'battle_station' : b),
  );
  const hasBatteries = colony.buildings.includes('missile_base') || colony.buildings.includes('ground_batteries');
  if (!baseBuilding && !hasBatteries) return null;
  // ground batteries alone still put up a fight, on star-base-grade emplacements
  const hullId = baseBuilding ? (baseBuilding === 'battlestation' ? 'battlestation' : baseBuilding) : 'star_base';
  const design = baseDesign(state, empire, hullId);
  if (!baseBuilding) design.weapons = []; // no orbital platform of its own
  // colony defense buildings bolt extra mounts onto the defense
  const arsenal = knownWeapons(empire);
  if (colony.buildings.includes('missile_base')) {
    const missile = arsenal.filter((w) => w.classId === 1).sort((a, b) => b.tacticalDamage.max - a.tacticalDamage.max)[0];
    if (missile) design.weapons.push({ weapon: missile.id, count: 4, mods: [] });
  }
  if (colony.buildings.includes('ground_batteries')) {
    const beam = arsenal.filter((w) => w.classId === 0 && w.techId !== 0 && w.availableMods.includes('hv')).sort((a, b) => b.tacticalDamage.max - a.tacticalDamage.max)[0];
    if (beam) design.weapons.push({ weapon: beam.id, count: 6, mods: ['hv'] });
  }
  if (design.weapons.length === 0) return null;
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
      dmgMin: w.row.classId === 4 ? w.row.strategicDamage.min : w.row.tacticalDamage.min,
      dmgMax: w.row.classId === 4 ? w.row.strategicDamage.max : w.row.tacticalDamage.max,
      mods: [...new Set([...w.mods, ...w.row.naturalMods])],
      ammo: w.row.ammo,
      cooldown: 0,
      count: w.count,
      arc: '360' as const, // bases are turrets: full coverage
    })),
    startingStructure: stats.structureHp,
    startingArmor: stats.armorHp,
    style: shipStyleOf(empire),
    modelIdx: colony.id, // stations vary per colony
  };
}

export interface BuiltBattle {
  input: BattleInput;
  baseColonyId: number | null; // colony whose base fights (destroyed if base dies)
}

export function buildBattleInput(state: GameState, battle: PendingBattle): BuiltBattle {
  const attacker = state.empires.find((e) => e.id === battle.attacker);
  const defender = state.empires.find((e) => e.id === battle.defender);
  const ships: CombatShipInit[] = [];
  for (const ship of state.ships) {
    if (ship.location.kind !== 'star' || ship.location.starId !== battle.starId) continue;
    if (attacker && ship.owner === battle.attacker) {
      const cs = shipToCombat(state, attacker, ship, 0);
      if (cs) ships.push(cs);
    } else if (defender && ship.owner === battle.defender) {
      const cs = shipToCombat(state, defender, ship, 1);
      if (cs) ships.push(cs);
    }
  }
  // NPC forces (monsters / Antarans) fill their side from the monster roster
  if (battle.attacker < 0) {
    for (const m of monstersAt(state, battle.starId, battle.attacker)) ships.push(monsterToCombat(m, 0));
  }
  if (battle.defender < 0) {
    for (const m of monstersAt(state, battle.starId, battle.defender)) ships.push(monsterToCombat(m, 1));
  }
  let baseColonyId: number | null = null;
  const defColony = defender
    ? state.colonies.find(
        (c) => c.owner === battle.defender && state.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
      )
    : undefined;
  if (defColony && defender) {
    const base = baseToCombat(state, defender, defColony, 1_000_000 + defColony.id);
    if (base) {
      ships.push(base);
      baseColonyId = defColony.id;
    }
  }
  // ship officers: fleet-wide bonuses per side (L2)
  for (const side of [0, 1] as const) {
    const empire = side === 0 ? attacker : defender;
    if (!empire) continue;
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
  // non-combat ships present: shown in the replay at the field edge (never
  // simulated). Scouts are NOT bystanders — they fight (see shipToCombat).
  const bystanders: Array<{ shipId: number; side: 0 | 1; kind: string }> = [];
  for (const ship of state.ships) {
    if (ship.location.kind !== 'star' || ship.location.starId !== battle.starId || isWarship(ship) || ship.shipKind === 'scout') continue;
    if (ship.owner === battle.attacker) bystanders.push({ shipId: ship.id, side: 0, kind: ship.shipKind });
    else if (ship.owner === battle.defender) bystanders.push({ shipId: ship.id, side: 1, kind: ship.shipKind });
  }
  bystanders.sort((a, b) => a.shipId - b.shipId);
  return {
    input: {
      battleId: battle.id,
      seedLabel: [state.turn, 'battle', battle.id],
      attacker: battle.attacker,
      defender: battle.defender,
      ships: ships.sort((a, b) => a.shipId - b.shipId),
      bystanders,
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
    if (o.shipId >= 2_000_000) {
      // monster / Antaran unit
      const monster = state.monsters.find((m) => 2_000_000 + m.id === o.shipId);
      if (!monster) continue;
      if (o.destroyed) {
        state.monsters = state.monsters.filter((m) => m !== monster);
        events.push({ visibleTo: -1, kind: 'monster_slain', payload: { kind: monster.kind, starId: monster.starId } });
        if (monster.kind === 'guardian') {
          const victor = battle.attacker >= 0 ? battle.attacker : battle.defender;
          guardianReward(state, victor, events);
        }
      } else {
        monster.dmgStructure = Math.max(0, o.structureMax - o.structureLeft);
      }
      continue;
    }
    if (o.shipId >= 1_000_000) {
      // defense base + ground batteries fall together
      if (o.destroyed && built.baseColonyId !== null) {
        const colony = state.colonies.find((c) => c.id === built.baseColonyId);
        if (colony) {
          colony.buildings = colony.buildings.filter(
            (b) => !['star_base', 'battle_station', 'star_fortress', 'missile_base', 'ground_batteries'].includes(b),
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
      const cs = built.input.ships.find((c) => c.shipId === o.shipId);
      if (cs?.specials?.includes('advanced_damage_control')) {
        // damage control crews patch everything after the pass
        ship.dmgStructure = 0;
        ship.dmgArmor = 0;
      } else {
        ship.dmgStructure = Math.max(0, o.structureMax - o.structureLeft);
        ship.dmgArmor = cs ? Math.max(0, cs.armorHp - o.armorLeft) : 0;
      }
      if (o.retreated) {
        // retreat toward the genuinely nearest own colony star (or stay if none)
        const dest = retreatDestination(state, ship.owner, battle.starId);
        if (dest) {
          ship.location = {
            kind: 'transit',
            from: battle.starId,
            to: dest.starId,
            departedTurn: state.turn,
            arrivalTurn: dest.arrivalTurn,
          };
        }
      }
    }
  }
  // loser's unarmed ships at the star are lost if the winner holds the field —
  // UNLESS their escorts withdrew alive: a retreating fleet covers its
  // noncombatants out (so "retreat" really is a way to decline a fight)
  if (result.winner !== null) {
    const loser = result.winner === 0 ? battle.defender : battle.attacker;
    const loserSide = result.winner === 0 ? 1 : 0;
    const escortsEscaped = result.outcomes.some(
      (o) => o.side === loserSide && o.retreated && !o.destroyed,
    );
    for (const ship of state.ships) {
      if (
        ship.owner === loser &&
        ship.location.kind === 'star' &&
        ship.location.starId === battle.starId &&
        !isWarship(ship)
      ) {
        if (escortsEscaped) {
          // fall back with the fleet toward the nearest own colony
          const dest = retreatDestination(state, loser, battle.starId);
          if (dest) {
            ship.location = {
              kind: 'transit',
              from: battle.starId,
              to: dest.starId,
              departedTurn: state.turn,
              arrivalTurn: dest.arrivalTurn,
            };
          }
        } else {
          destroyedIds.add(ship.id);
        }
      }
    }
  }
  state.ships = state.ships.filter((s) => !destroyedIds.has(s.id));

  // Antaran raid victory: they raze the colony and are gone next upkeep (A1)
  if (battle.attacker === ANTARAN_EMPIRE && result.winner === 0) {
    const colony = state.colonies.find(
      (c) => c.owner === battle.defender && state.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
    );
    if (colony) antaranRaze(state, colony.id, events);
  }
  // player assault on the Antaran home: victory ends the game (A1)
  if (battle.defender === ANTARAN_EMPIRE && state.antarans.assaultBy === battle.attacker) {
    if (result.winner === 0 && state.winner === null) {
      state.winner = battle.attacker;
      state.winType = 'antaran';
      events.push({ visibleTo: -1, kind: 'victory', payload: { empireId: battle.attacker, type: 'antaran' } });
    }
    // win or lose, the portal collapses and the garrison is gone
    state.monsters = state.monsters.filter((m) => !(m.starId === battle.starId && factionOf(m) === ANTARAN_EMPIRE));
    state.antarans.assaultBy = null;
  }

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
  // full input + seed label: the viewer re-runs the identical sim as playback.
  // Only the PARTICIPANTS get the replay — spectators would otherwise see
  // both fleets' full compositions for free.
  const audience = [battle.attacker, battle.defender].filter((id) => id >= 0);
  for (const viewer of audience) {
    events.push({
      visibleTo: viewer,
      kind: 'battle_replay',
      payload: { battleId: battle.id, seed: state.seed, input: built.input as unknown as Record<string, unknown>, summary },
    });
  }
  return { battle, result, summary };
}

/** Simple bombardment: each 20 points of bomb damage kills one pop unit; every
 * other threshold destroys a building instead (documented combat-redesign rule). */
function bombard(state: GameState, battle: PendingBattle, events: TurnEvent[]): Record<string, unknown> {
  const colony = state.colonies.find(
    (c) => c.owner === battle.defender && state.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
  );
  if (!colony) return { skipped: true };
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
  // stellar safety shield: half of the barrage is deflected
  if (colony.buildings.includes('stellar_safety_shield')) bombDamage = Math.floor(bombDamage / 2);
  // an undefended outpost has no population to protect it: enough bombs raze
  // it outright (otherwise a cheap outpost denies the planet forever)
  if (colony.outpost) {
    if (bombDamage >= 20) {
      state.colonies = state.colonies.filter((c) => c.id !== colony.id);
      const report = { colonyId: colony.id, bombDamage, outpostDestroyed: true };
      events.push({ visibleTo: -1, kind: 'bombardment', payload: report });
      return report;
    }
    return { skipped: true };
  }
  const rng = rngFor(state.seed, state.turn, 'bombard', battle.id);
  let popKilled = 0;
  let buildingsDestroyed: string[] = [];
  let remaining = bombDamage;
  while (remaining >= 20) {
    remaining -= 20;
    if (rng.chancePct(60) || colony.buildings.length === 0) {
      // kill population: spread across ALL race groups (largest first), and
      // never bomb the last unit out of existence from orbit
      if (colonyPopUnits(colony) <= 1) break;
      const grp = [...colony.groups].sort((a, b) => b.popK - a.popK)[0];
      if (grp && grp.popK >= 1000) {
        grp.popK -= 1000;
        popKilled++;
      } else {
        break; // only fractions left anywhere: nothing more to kill
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
