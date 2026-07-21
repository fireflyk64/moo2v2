// Battles: encounter detection (S7), building combat inputs from state,
// applying outcomes (S9), and post-victory bombardment (S10).

import { DEFAULT_ORDERS, runBattle, type BattleInput, type BattleOrders, type BattleResult, type CombatShipInit, type BattleTickFrame, type ShipOutcome } from './combat';
import { hullById, weaponById, type WeaponRow } from './data/index';
import { colonyPopUnits } from './economy';
import { starDistance } from './galaxy';
import { travelTurns } from './movement';
import { leaderCombatBonuses } from './leaders';
import { floorDiv, roundDiv } from './imath';
import { rngFor } from './rng';
import { BASE_COMBAT_ID, MONSTER_COMBAT_ID } from './ids';
import { baseDesign, designStats, knownWeapons, HULLS_BUILDABLE, BASE_HULLS, type ShipDesign } from './shipdesign';
import { shipStyleOf } from './shipstyles';
import { ANTARAN_EMPIRE, MONSTER_EMPIRE, antaranRaze, factionOf, guardianReward, monstersAt, monsterToCombat, MONSTER_SPECS } from './npc';
import type { Colony, Empire, GameState, PendingBattle, Ship, TurnEvent } from './types';

export function relationKey(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

/** Nearest own (non-outpost) colony star to fall back to after a battle (or
 * when stranded out of fuel range), with a distance-honest ETA. Returns null
 * when the ship is ALREADY at one of its own colony stars ("it is already at
 * a nearest colony" — no move) or when the empire has no colonies to run to.
 * state.colonies is id-sorted, so a naive find() would "retreat" every fleet
 * to the homeworld in exactly one turn — free strategic fast-travel. */
export function retreatDestination(
  state: GameState,
  ownerId: number,
  fromStarId: number,
  opts?: { excludeFrom?: boolean },
): { starId: number; arrivalTurn: number } | null {
  const empire = state.empires.find((e) => e.id === ownerId);
  const from = state.stars.find((st) => st.id === fromStarId);
  if (!empire || !from) return null;
  let best: { starId: number; d: number } | null = null;
  for (const c of state.colonies) {
    if (c.owner !== ownerId || c.outpost) continue;
    const p = state.planets.find((pl) => pl.id === c.planetId);
    if (!p) continue;
    if (p.starId === fromStarId) {
      // fleeing noncombatants shun the besieged colony (bugs.md): the next
      // nearest colony is their haven; without the flag, stay — this IS the
      // nearest colony
      if (opts?.excludeFrom) continue;
      return null;
    }
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

/** Does this empire field ANY combat unit at this star? Warship/scout
 * present, or a colony whose base/batteries can actually fight (mirrors
 * buildBattleInput's defender construction). */
function fieldsCombat(state: GameState, empireId: number, starId: number): boolean {
  if (
    state.ships.some(
      (s) => s.owner === empireId && s.location.kind === 'star' && s.location.starId === starId && isWarship(s),
    )
  ) {
    return true;
  }
  const empire = state.empires.find((e) => e.id === empireId);
  if (!empire) return false;
  const colony = state.colonies.find(
    (c) => c.owner === empireId && state.planets.some((p) => p.id === c.planetId && p.starId === starId),
  );
  return !!colony && baseToCombat(state, empire, colony, BASE_COMBAT_ID + colony.id) !== null;
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
        // defender = colony owner; else the side WITHOUT warships defends
        // (a lower-id fleet catching a naked convoy used to be labeled the
        // "defender", and with no attacker warships the battle silently never
        // happened); else lower id defends
        let attacker: number;
        let defender: number;
        if (aCol && !bCol) {
          defender = a;
          attacker = b;
        } else if (bCol && !aCol) {
          defender = b;
          attacker = a;
        } else if (aWar && !bWar) {
          defender = b;
          attacker = a;
        } else if (bWar && !aWar) {
          defender = a;
          attacker = b;
        } else {
          defender = a;
          attacker = b;
        }
        if (!shipsHere.some((s) => s.owner === attacker && isWarship(s))) continue; // attacker must bring warships
        // a defenseless defender (no warships, no base/batteries that fight)
        // is never prompted for battle orders — there is nothing to order
        // (bugs.md). Passive orders pre-fill exactly like the NPC sides'.
        const defenderFights = fieldsCombat(state, defender, star.id);
        battles.push({
          id: `b${state.turn}-${star.id}-${attacker}v${defender}`,
          starId: star.id,
          attacker,
          defender,
          ordersA: null,
          ordersD: defenderFights ? null : { ...npcOrders },
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
  // colony defense buildings bolt extra mounts onto the defense — fitted to
  // the space that is actually left (an over-space design would silently
  // remove the ENTIRE platform from the battle)
  const arsenal = knownWeapons(empire);
  const fitsHere = (weapons: typeof design.weapons): boolean =>
    typeof designStats(state, empire, { ...design, weapons }) !== 'string';
  const bolt = (weapon: string, want: number, mods: string[]): void => {
    for (let count = want; count >= 1; count--) {
      const attempt = [...design.weapons, { weapon, count, mods: [...mods] }];
      if (fitsHere(attempt)) {
        design.weapons.push({ weapon, count, mods: [...mods] });
        return;
      }
    }
  };
  if (colony.buildings.includes('missile_base')) {
    const missile = arsenal.filter((w) => w.classId === 1).sort((a, b) => b.tacticalDamage.max - a.tacticalDamage.max)[0];
    if (missile) bolt(missile.id, 4, []);
  }
  if (colony.buildings.includes('ground_batteries')) {
    const beam = arsenal.filter((w) => w.classId === 0 && w.techId !== 0 && w.availableMods.includes('hv')).sort((a, b) => b.tacticalDamage.max - a.tacticalDamage.max)[0];
    if (beam) bolt(beam.id, 6, ['hv']);
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
  /** engagement (0.22.0): id of the ENGAGED defender colony (its defenses
   * fight, it takes the bombardment/invasion); null = deep-space fleet action
   * (no colony involved, no bombardment/landing); undefined = legacy orders —
   * classic colony selection everywhere. */
  engagedColonyId?: number | null;
}

/** Resolve WHERE the battle happens from both sides' engagement choices.
 * The attacker's choice dominates: a planet = assault that colony (the
 * defender auto-defends it); null = deep space, unless the defender chose to
 * hold at one of its colonies — then the fight happens under that colony's
 * guns (classic semantics, so "hold" never softens a siege). An ABSENT
 * attacker field means legacy orders: undefined (classic selection). */
function resolveEngagement(state: GameState, battle: PendingBattle): Colony | null | undefined {
  const oA = battle.ordersA as BattleOrders | null;
  const choiceA = oA?.engagePlanetId;
  if (choiceA === undefined) return undefined; // legacy orders / timeout defaults
  const holdings = state.colonies.filter(
    (c) => c.owner === battle.defender && state.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
  );
  if (choiceA !== null) return holdings.find((c) => c.planetId === choiceA) ?? undefined;
  const oD = battle.ordersD as BattleOrders | null;
  const choiceD = oD?.engagePlanetId;
  if (choiceD !== null && choiceD !== undefined) return holdings.find((c) => c.planetId === choiceD) ?? null;
  return null; // both sides meet in deep space
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
  // engagement decides WHICH colony's defenses join the fight — deep space
  // means none at all; legacy orders keep the classic first-colony pick
  const engaged = resolveEngagement(state, battle);
  const defColony =
    engaged !== undefined
      ? (engaged ?? undefined)
      : defender
        ? state.colonies.find(
            (c) => c.owner === battle.defender && state.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
          )
        : undefined;
  if (defColony && defender) {
    const base = baseToCombat(state, defender, defColony, BASE_COMBAT_ID + defColony.id);
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
      // the engaged planet looms in the viewer backdrop; null = deep space
      planetId: defColony ? defColony.planetId : null,
      ships: ships.sort((a, b) => a.shipId - b.shipId),
      bystanders,
      // both sides default to CHARGE — the old hold_range defender default
      // made unordered fleets turn tail (bugs.md "change default to charge")
      ordersA: (battle.ordersA as BattleOrders | null) ?? DEFAULT_ORDERS,
      ordersD: (battle.ordersD as BattleOrders | null) ?? DEFAULT_ORDERS,
      // slewing game option rides the input so replays re-sim identically;
      // the key is only present when ON (legacy inputs stay byte-exact)
      ...(state.settings.slewing === true ? { slewing: true } : {}),
    },
    baseColonyId,
    engagedColonyId: engaged === undefined ? undefined : engaged === null ? null : engaged.id,
  };
}

/** Fleet-mass ladder in frigate-equivalents (user rule: 12 frigates = 6
 * destroyers = 3 cruisers = 2 battleships = 1 titan). Scouts and civilian
 * hulls weigh nothing — only designed warships count. */
export const HULL_WEIGHT: Record<string, number> = {
  frigate: 1,
  destroyer: 2,
  cruiser: 4,
  battleship: 6,
  titan: 12,
  doomstar: 24,
};

/** A fleet massing this many hull-weight points clears an ordinary monster
 * lair outright (deterministic, zero losses) — see resolveBattle. */
export const MONSTER_CLEAR_WEIGHT = 12;

/** Bombardment fleet-mass tiers (per-turn damage caps): weight below
 * MEDIUM is a small fleet, MEDIUM..STRONG-1 medium, STRONG+ strong. */
export const MEDIUM_FLEET_WEIGHT = 6;
export const STRONG_FLEET_WEIGHT = 12;

/** Total hull weight the empire's designed warships mass at this star.
 * Scouts and non-combat hulls contribute 0. */
export function fleetHullWeight(state: GameState, empireId: number, starId: number): number {
  const empire = state.empires.find((e) => e.id === empireId);
  if (!empire) return 0;
  let total = 0;
  for (const ship of state.ships) {
    if (ship.owner !== empireId || ship.location.kind !== 'star' || ship.location.starId !== starId) continue;
    if (ship.shipKind !== 'design' || ship.designId === null) continue;
    const design = empire.designs.find((d) => d.id === ship.designId);
    if (design) total += HULL_WEIGHT[design.hull] ?? 0;
  }
  return total;
}

/** Apply one monster/Antaran combat outcome to world state (shared by the
 * simulated battle path and the deterministic auto-clear). */
function applyMonsterOutcome(state: GameState, battle: PendingBattle, o: ShipOutcome, events: TurnEvent[]): void {
  const monster = state.monsters.find((m) => MONSTER_COMBAT_ID + m.id === o.shipId);
  if (!monster) return;
  if (o.destroyed) {
    state.monsters = state.monsters.filter((m) => m !== monster);
    // the slayer gets the news; broadcasting named an unmet empire's
    // battle site to everyone (fast-phase information leak)
    const victor = battle.attacker >= 0 ? battle.attacker : battle.defender;
    events.push({ visibleTo: victor, kind: 'monster_slain', payload: { kind: monster.kind, starId: monster.starId } });
    if (monster.kind === 'guardian') {
      guardianReward(state, victor, events);
    }
  } else {
    monster.dmgStructure = Math.max(0, o.structureMax - o.structureLeft);
    // armor damage persists between passes exactly like ships' does
    const specArmor = MONSTER_SPECS[monster.kind].armor;
    monster.dmgArmor = Math.max(0, specArmor - o.armorLeft);
  }
}

export interface ResolvedBattle {
  battle: PendingBattle;
  result: BattleResult;
  summary: Record<string, unknown>;
}

/** Resolve one battle and mutate state (ship damage/removal, base destruction,
 * bombardment, non-combat ship capture-kills). */
export function resolveBattle(state: GameState, battle: PendingBattle, events: TurnEvent[]): ResolvedBattle {
  // Deterministic monster clears: a fleet massing MONSTER_CLEAR_WEIGHT hull
  // points (12 frigate-equivalents — 6 destroyers, 3 cruisers, 2 battleships
  // or any titan+) overwhelms an ordinary lair outright: instant victory,
  // zero attacker losses, no sim. Applies to every empire alike. The Orion
  // Guardian and the Antaran faction (id -3) still demand a real battle;
  // below the bar the normal fight runs so light fleets test their mettle.
  if (battle.attacker >= 0 && battle.defender === MONSTER_EMPIRE) {
    const lair = monstersAt(state, battle.starId, MONSTER_EMPIRE);
    if (
      lair.length > 0 &&
      !lair.some((m) => m.kind === 'guardian') &&
      fleetHullWeight(state, battle.attacker, battle.starId) >= MONSTER_CLEAR_WEIGHT
    ) {
      const outcomes: ShipOutcome[] = lair.map((m) => ({
        shipId: MONSTER_COMBAT_ID + m.id,
        side: 1,
        destroyed: true,
        retreated: false,
        crossed: false,
        structureLeft: 0,
        armorLeft: 0,
        structureMax: MONSTER_SPECS[m.kind].structure,
      }));
      const kinds = lair.map((m) => m.kind);
      for (const o of outcomes) applyMonsterOutcome(state, battle, o, events);
      const result: BattleResult = { ticks: 0, outcomes, winner: 0, attackerDamagePct: 0, defenderDamagePct: 100 };
      const summary: Record<string, unknown> = {
        battleId: battle.id,
        starId: battle.starId,
        attacker: battle.attacker,
        defender: battle.defender,
        winner: battle.attacker,
        ticks: 0,
        attackerDamagePct: 0,
        defenderDamagePct: 100,
        destroyed: [],
        autoCleared: true,
        monsters: kinds,
      };
      // NPC battle: the summary goes to the attacker only (see below); a
      // walkover gets no replay — watching nobody fight isn't a show
      events.push({ visibleTo: battle.attacker, kind: 'battle_resolved', payload: summary });
      return { battle, result, summary };
    }
  }
  const built = buildBattleInput(state, battle);
  const rng = rngFor(state.seed, ...built.input.seedLabel);
  const result = runBattle(built.input, rng);

  // apply ship outcomes
  const destroyedIds = new Set<number>();
  for (const o of result.outcomes) {
    if (o.shipId >= MONSTER_COMBAT_ID) {
      // monster / Antaran unit — shared with the auto-clear path
      applyMonsterOutcome(state, battle, o, events);
      continue;
    }
    if (o.shipId >= BASE_COMBAT_ID) {
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
  // loser's unarmed ships at the star: if ANY combatant of theirs was in the
  // fight (won, died, or withdrew — a battle line, however it fared, covers
  // the noncombatants' escape; bugs.md), or the winner ordered mercy
  // (spareNoncombatants), they flee to the nearest OTHER own colony instead
  // of being lost. Only noncombatants caught with no battle line at all are
  // run down when the winner holds the field.
  if (result.winner !== null) {
    const loser = result.winner === 0 ? battle.defender : battle.attacker;
    const loserSide = result.winner === 0 ? 1 : 0;
    const winnerOrders = result.winner === 0 ? built.input.ordersA : built.input.ordersD;
    const spared = winnerOrders.spareNoncombatants === true;
    // ships AND the defense base count as a battle line (monsters don't own
    // noncombatants, so the monster fence is irrelevant here)
    const loserFought = result.outcomes.some((o) => o.side === loserSide && o.shipId < MONSTER_COMBAT_ID);
    for (const ship of state.ships) {
      if (
        ship.owner === loser &&
        ship.location.kind === 'star' &&
        ship.location.starId === battle.starId &&
        !isWarship(ship)
      ) {
        if (loserFought || spared) {
          // flee toward the nearest own colony that is NOT the contested one
          // (staying put only when no other haven exists)
          const dest = retreatDestination(state, loser, battle.starId, { excludeFrom: true });
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

  // bombardment (attacker victory + orders.bombard). A deep-space engagement
  // (engagedColonyId === null) never bombards — the fleet chose to fight away
  // from the planet; legacy orders (undefined) keep the classic target pick.
  const ordersA = built.input.ordersA;
  let bombReport: Record<string, unknown> | null = null;
  if (result.winner === 0 && ordersA.bombard && built.engagedColonyId !== null) {
    const holdings = state.colonies.filter(
      (c) => c.owner === battle.defender && state.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
    );
    const target =
      built.engagedColonyId !== undefined ? holdings.find((c) => c.id === built.engagedColonyId) : holdings[0];
    if (target) bombReport = bombard(state, battle, events, built.engagedColonyId);
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
    destroyed: result.outcomes.filter((o) => o.destroyed && o.shipId < BASE_COMBAT_ID).map((o) => o.shipId),
    ...(bombReport ? { bombardment: bombReport } : {}),
  };
  // PvP battle summaries are galactic news (both sides have obviously met);
  // NPC battle summaries go to the human participant only — broadcasting them
  // revealed an unmet empire's fleet ids, losses, and location to everyone.
  const npcBattle = battle.attacker < 0 || battle.defender < 0;
  if (npcBattle) {
    for (const viewer of [battle.attacker, battle.defender].filter((id) => id >= 0)) {
      events.push({ visibleTo: viewer, kind: 'battle_resolved', payload: summary });
    }
  } else {
    events.push({ visibleTo: -1, kind: 'battle_resolved', payload: summary });
  }
  // full input + seed label: the viewer re-runs the identical sim as playback.
  // Only the PARTICIPANTS get the replay — spectators would otherwise see
  // both fleets' full compositions for free. A walkover (one side fielded no
  // combat unit at all) gets no replay: watching nobody fight isn't a show
  // (bugs.md) — the battle_resolved report above still carries the outcome,
  // including any bombardment.
  const walkover = !built.input.ships.some((s) => s.side === 0) || !built.input.ships.some((s) => s.side === 1);
  const audience = walkover ? [] : [battle.attacker, battle.defender].filter((id) => id >= 0);
  for (const viewer of audience) {
    events.push({
      visibleTo: viewer,
      kind: 'battle_replay',
      payload: { battleId: battle.id, seed: state.seed, input: built.input as unknown as Record<string, unknown>, summary },
    });
  }
  return { battle, result, summary };
}

/** Per-hit damage a colony's best planetary shield blocks from every
 * individual bombardment run (MOO2 rule: a shield outblocking a weapon's
 * whole hit zeroes it no matter how many of that weapon the fleet mounts).
 * The planetary_* tiers are deferred buildables today; their values are here
 * so un-deferring them later needs no engine change. */
const PLANET_SHIELD_BLOCK: Record<string, number> = {
  stellar_safety_shield: 5,
  planetary_stellar_safety_shield: 5,
  planetary_flux_shield: 10,
  planetary_barrier_shield: 20,
};

export function planetShieldBlock(colony: Colony): number {
  let block = 0;
  for (const b of colony.buildings) block = Math.max(block, PLANET_SHIELD_BLOCK[b] ?? 0);
  return block;
}

/** 2× the expected bombardment damage of one weapon mount across all its
 * runs (half-points keep the .5 averages in integer math). MOO2 rules:
 * every mounted weapon attacks the planet with its STRATEGIC damage —
 * bombs and missiles at full strength with one run per point of ammo,
 * beams and torpedoes at half strength, strike craft not at all (no bombing
 * ability on the strategic screen), specials not at all except the stellar
 * converter. The planetary shield blocks its strength from each individual
 * run; sp/emg munitions pierce it entirely and ap skips the flat block,
 * mirroring ship-combat shield semantics. */
function bombardMount2(row: WeaponRow, mods: string[], shieldBlock: number): number {
  const { min, max } = row.strategicDamage;
  if (min + max <= 0) return 0;
  if (row.classId === 4) return 0;
  if (row.classId === 5 && row.id !== 'stellar_converter') return 0;
  const all = row.naturalMods.length > 0 ? [...new Set([...mods, ...row.naturalMods])] : mods;
  let dmg2 = min + max;
  if (all.includes('hv')) dmg2 = roundDiv(dmg2 * 150, 100);
  if (all.includes('ovr')) dmg2 = roundDiv(dmg2 * 150, 100);
  if (all.includes('env')) dmg2 *= 2; // enveloping: wraps the shields
  if (row.classId === 0 || row.classId === 2) dmg2 = floorDiv(dmg2, 2); // beams/torpedoes: half damage vs planets
  if (!all.includes('sp') && !all.includes('emg') && !all.includes('ap')) dmg2 = Math.max(0, dmg2 - shieldBlock * 2);
  let runs = row.ammo > 0 ? row.ammo : 1;
  if (row.classId === 1 && all.includes('mv')) runs *= 4; // MIRV: 4 warheads per launch
  return dmg2 * runs;
}

/** Expected orbital-bombardment damage (whole points) the empire's fleet at
 * this star lands through a planetary shield of the given strength. */
export function fleetBombardDamage(state: GameState, empireId: number, starId: number, shieldBlock: number): number {
  const empire = state.empires.find((e) => e.id === empireId);
  if (!empire) return 0;
  let total2 = 0;
  for (const ship of state.ships) {
    if (ship.owner !== empireId || ship.location.kind !== 'star' || ship.location.starId !== starId) continue;
    if (ship.designId === null) continue;
    const design = empire.designs.find((d) => d.id === ship.designId);
    if (!design) continue;
    for (const w of design.weapons) {
      const row = weaponById.get(w.weapon);
      if (row) total2 += w.count * bombardMount2(row, w.mods, shieldBlock);
    }
  }
  return floorDiv(total2, 2);
}

/** Simple bombardment: each 20 points of bombardment damage kills one pop
 * unit; every other threshold destroys a building instead (documented
 * combat-redesign rule). Damage follows the MOO2 strategic model — see
 * fleetBombardDamage — but the per-turn TOLL is capped by the bombarding
 * fleet's hull weight (see MEDIUM/STRONG_FLEET_WEIGHT). When an engagement
 * choice named a colony (engagedColonyId), THAT colony takes the barrage;
 * legacy orders keep the classic populated-before-outpost pick. */
export function bombard(
  state: GameState,
  battle: PendingBattle,
  events: TurnEvent[],
  engagedColonyId?: number | null,
): Record<string, unknown> {
  const holdings = state.colonies.filter(
    (c) => c.owner === battle.defender && state.planets.some((p) => p.id === c.planetId && p.starId === battle.starId),
  );
  // a populated colony absorbs the barrage before any outpost dome does
  const colony =
    (typeof engagedColonyId === 'number' ? holdings.find((c) => c.id === engagedColonyId) : undefined) ??
    holdings.find((c) => !c.outpost) ??
    holdings[0];
  if (!colony) return { skipped: true };
  const shieldBlock = planetShieldBlock(colony);
  const bombDamage = fleetBombardDamage(state, battle.attacker, battle.starId, shieldBlock);
  // an undefended outpost has no population to protect it: ANY victorious
  // fleet levels the dome — gating this on bomb hardpoints let a cheap
  // outpost deny the planet forever to bomb-less fleets. One dome falls per
  // bombardment; with several, the one squatting on a colonizable planet
  // goes first (outposts are otherwise identical and that one hurts most).
  if (colony.outpost) {
    // an ENGAGED outpost is the one that falls; classic orders prefer the
    // dome squatting on a colonizable planet
    const doomed =
      typeof engagedColonyId === 'number' && colony.id === engagedColonyId
        ? colony
        : (holdings.find((c) => state.planets.some((p) => p.id === c.planetId && p.body === 'planet')) ?? colony);
    state.colonies = state.colonies.filter((c) => c.id !== doomed.id);
    const report = { colonyId: doomed.id, bombDamage, outpostDestroyed: true };
    events.push({ visibleTo: -1, kind: 'bombardment', payload: report });
    return report;
  }
  const rng = rngFor(state.seed, state.turn, 'bombard', battle.id);
  // Per-turn caps by fleet mass (user rule: even a strong fleet removes only
  // 2-3 pop and a building per turn). Strong (weight >= 12) fleets take at
  // most 3 pop + 1 building, medium (6-11) 2 pop + 1 building, small (< 6)
  // 1 pop and only OCCASIONALLY a building (a 25% seeded roll gates whether
  // any may fall; the 60/40 hit rolls below still have to pick one). Caps
  // only ever LOWER the formula's result — a barrage under the cap lands
  // exactly as before.
  const fleetWeight = fleetHullWeight(state, battle.attacker, battle.starId);
  const maxPop = fleetWeight >= STRONG_FLEET_WEIGHT ? 3 : fleetWeight >= MEDIUM_FLEET_WEIGHT ? 2 : 1;
  const maxBuildings = fleetWeight >= MEDIUM_FLEET_WEIGHT ? 1 : rng.chancePct(25) ? 1 : 0;
  let popKilled = 0;
  let buildingsDestroyed: string[] = [];
  let remaining = bombDamage;
  while (remaining >= 20) {
    remaining -= 20;
    // every 20 points is a hit that lands SOMEWHERE: 60/40 pop/building, but
    // a roll with nothing on its side falls through to the other (a barrage
    // over a building-less colony still kills, and vice versa) — the old
    // early-outs made most of a bombardment fizzle silently. A capped-out
    // target no longer counts as "on its side".
    const destructible =
      buildingsDestroyed.length < maxBuildings ? colony.buildings.filter((b) => b !== 'marine_barracks') : [];
    // never bomb the last unit out of existence from orbit; groups holding
    // only fractions of a unit cannot lose a whole one either
    const biggest = [...colony.groups].sort((a, b) => b.popK - a.popK)[0];
    const canKillPop = popKilled < maxPop && colonyPopUnits(colony) > 1 && biggest !== undefined && biggest.popK >= 1000;
    const wantsPop = rng.chancePct(60);
    if (canKillPop && (wantsPop || destructible.length === 0)) {
      // kill population: spread across ALL race groups (largest first)
      biggest.popK -= 1000;
      popKilled++;
    } else if (destructible.length > 0) {
      const b = destructible[rng.int(destructible.length)]!;
      colony.buildings = colony.buildings.filter((x) => x !== b);
      buildingsDestroyed.push(b);
    } else {
      break; // caps reached, or nothing the barrage can still touch
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
  const report = { colonyId: colony.id, bombDamage, popKilled, buildingsDestroyed, ...(shieldBlock > 0 ? { shieldBlock } : {}) };
  events.push({ visibleTo: -1, kind: 'bombardment', payload: report });
  return report;
}

export type { BattleTickFrame };
