// RECONCILIATION: the board-game alternative simulation (complextask.md task 4).
//
// Each async-played save contributes one empire's recorded script — research,
// ship production, colonization, population deltas, buildings, garrisons,
// spy rosters, all per turn. The reconciliation walks the shared base state
// forward applying ONLY those scripts for economy: there is no production
// beyond recorded production. Movement, space battles, bombardment, ground
// invasions and elimination run under the REAL rules with bots at the helm.
//
// Colonization is predetermined and one-shot: the earliest claim on a world
// wins it; a later claimant's colonization goes ON HOLD until the holder
// loses the world, then activates instantly WITH the intervening population
// deltas and buildings (capped by the world's capacity).
//
// Spies follow the reconciliation doctrine: sabotage destroys DEFENSIVE
// structures; espionage copies PASSIVE technologies (armor class, drives,
// fuel range) and only lands with a large offense advantage or against a
// democracy — and only if the spy rolls land.

import { areAtWar } from './battles';
import { applyFoundingSpecials, normalizeJobsForGroup } from './commands';
import { metEmpireIds } from './contact';
import { relationOf } from './diplomacy';
import { colonyMaxPop, farmingViable, MARINES_PER_TRANSPORT, traitsOf } from './economy';
import { defenseOf, offenseOf, SPY_CAP } from './espionage';
import { starDistance } from './galaxy';
import { allocId } from './ids';
import { clamp } from './imath';
import { grantApp } from './research';
import { rngFor } from './rng';
import { ARMOR_APPS, DRIVE_APPS, hullIndexOf } from './shipdesign';
import type { Colony, Empire, GameState, ReconcileSchedule, ShipKind, TurnEvent } from './types';

const FUEL_APPS = ['deuterium_fuel_cells', 'iridium_fuel_cells', 'uridium_fuel_cells', 'thorium_fuel_cells'];
/** the passive technologies a reconciliation spy ring may copy */
export const PASSIVE_APPS: ReadonlyArray<string> = [...ARMOR_APPS, ...DRIVE_APPS, ...FUEL_APPS];
/** advantage bar for copying passives ("large advantage or against democracy") */
export const SPY_PASSIVE_ADV = 10;

const DEFENSIVE_STRUCTURES = ['star_base', 'battle_station', 'star_fortress', 'missile_base', 'ground_batteries'];
const CIVILIAN_KINDS: ReadonlyArray<string> = ['colony_ship', 'outpost_ship', 'transport', 'scout', 'construction_ship'];

export function reconcileActive(state: GameState): boolean {
  return state.reconcile !== undefined;
}

function scheduleOf(state: GameState, empireId: number): ReconcileSchedule | undefined {
  return state.reconcile?.schedules.find((s) => s.empireId === empireId);
}

function ownedColonyOn(state: GameState, empireId: number, planetId: number): Colony | undefined {
  return state.colonies.find((c) => c.planetId === planetId && c.owner === empireId && !c.outpost);
}

function addPopUnits(state: GameState, colony: Colony, empireId: number, units: number): number {
  const current = colony.groups.reduce((n, g) => n + Math.floor(g.popK / 1000), 0);
  const room = Math.max(0, colonyMaxPop(state, colony) - current);
  const add = Math.min(units, room);
  if (add <= 0) return 0;
  let grp = colony.groups.find((g) => g.race === empireId);
  if (!grp) {
    grp = { race: empireId, popK: 0, farmers: 0, workers: 0, scientists: 0, unrest: false };
    colony.groups.push(grp);
    colony.groups.sort((a, b) => a.race - b.race);
  }
  grp.popK += add * 1000;
  normalizeJobsForGroup(grp);
  return add;
}

function addBuilding(colony: Colony, building: string): void {
  if (colony.buildings.includes(building)) return;
  colony.buildings.push(building);
  colony.buildings.sort();
}

/** found the scripted colony (the reconcile analogue of a colony-ship landing) */
function foundScripted(
  state: GameState,
  empire: Empire,
  planetId: number,
  outpost: boolean,
  events: TurnEvent[],
): Colony {
  const planet = state.planets.find((p) => p.id === planetId)!;
  const star = state.stars.find((s) => s.id === planet.starId)!;
  const colony: Colony = {
    id: allocId(state, empire.id),
    planetId,
    owner: empire.id,
    name: star.name,
    groups: outpost
      ? []
      : [
          {
            race: empire.id,
            popK: 1000,
            farmers: 0,
            workers: 0,
            scientists: 0,
            unrest: false,
          },
        ],
    buildings: [],
    queue: [],
    storedProd: 0,
    stickyInvested: {},
    boughtThisTurn: false,
    foodLackPrev: 0,
    prodLackPrev: 0,
    housingPPPrev: 0,
    outpost,
  };
  if (!outpost) {
    const g = colony.groups[0]!;
    if (farmingViable(state, colony)) g.farmers = 1;
    else g.workers = 1;
  }
  state.colonies.push(colony);
  state.colonies.sort((a, b) => a.id - b.id);
  if (!outpost) applyFoundingSpecials(state, planet, colony, events);
  if (!empire.exploredStars.includes(star.id)) {
    empire.exploredStars.push(star.id);
    empire.exploredStars.sort((a, b) => a - b);
  }
  events.push({
    visibleTo: -1,
    kind: outpost ? 'reconcile_outpost' : 'reconcile_colonized',
    payload: { empireId: empire.id, planetId, starId: star.id },
  });
  return colony;
}

function applyTerraform(state: GameState, planetId: number, climate: GameState['planets'][number]['climate'], steps: number): void {
  const planet = state.planets.find((p) => p.id === planetId);
  if (!planet || planet.body !== 'planet') return;
  planet.climate = climate;
  planet.terraformSteps = steps;
}

/** catch a late-activated claim up on its recorded history through `turn` */
function catchUp(state: GameState, empire: Empire, colony: Colony, sched: ReconcileSchedule, fromTurn: number, turn: number): void {
  // terraforming first: the climate sets the capacity the pop catch-up fills
  for (const t of sched.terraform ?? []) {
    if (t.planetId === colony.planetId && t.turn >= fromTurn && t.turn <= turn) applyTerraform(state, t.planetId, t.climate, t.steps);
  }
  for (const b of sched.buildings) {
    if (b.planetId === colony.planetId && b.turn >= fromTurn && b.turn <= turn) addBuilding(colony, b.building);
  }
  if (!colony.outpost) {
    for (const p of sched.pop) {
      if (p.planetId === colony.planetId && p.turn >= fromTurn && p.turn <= turn) {
        addPopUnits(state, colony, empire.id, p.units);
      }
    }
  }
  const marineRecords = sched.marines.filter((m) => m.planetId === colony.planetId && m.turn <= turn);
  if (marineRecords.length) colony.marines = marineRecords[marineRecords.length - 1]!.count;
}

/** the whole scripted-economy stage: replaces S1-S5 while reconcile is active */
export function applyReconcileSchedules(state: GameState, events: TurnEvent[]): void {
  const rec = state.reconcile!;
  const turn = state.turn;
  const living = state.empires.filter((e) => !e.eliminated);
  const empireOf = new Map(state.empires.map((e) => [e.id, e]));

  // ---- r1: predetermined colonization (one-shot claims; earliest turn wins,
  // later claims hold until the world frees up, then activate with catch-up) ----
  const used = new Set(rec.usedClaims.map((u) => `${u.planetId}:${u.empireId}`));
  const pendingByPlanet = new Map<number, Array<{ empireId: number; turn: number; outpost: boolean; units: number }>>();
  for (const sched of rec.schedules) {
    const empire = empireOf.get(sched.empireId);
    if (!empire || empire.eliminated) continue;
    for (const c of sched.colonize) {
      if (c.turn > turn) continue;
      if (used.has(`${c.planetId}:${sched.empireId}`)) continue;
      const list = pendingByPlanet.get(c.planetId) ?? [];
      list.push({ empireId: sched.empireId, turn: c.turn, outpost: c.outpost === true, units: c.units ?? 1 });
      pendingByPlanet.set(c.planetId, list);
    }
  }
  for (const [planetId, claims] of [...pendingByPlanet.entries()].sort((a, b) => a[0] - b[0])) {
    const standing = state.colonies.find((c) => c.planetId === planetId);
    if (standing && !standing.outpost) continue; // held — claims stay on hold
    // a colonization claim beats a squatting outpost: the dome is packed up
    if (standing) state.colonies = state.colonies.filter((c) => c !== standing);
    claims.sort((a, b) => a.turn - b.turn || a.empireId - b.empireId);
    const claim = claims[0]!;
    const empire = empireOf.get(claim.empireId)!;
    const colony = foundScripted(state, empire, planetId, claim.outpost, events);
    rec.usedClaims.push({ planetId, empireId: claim.empireId });
    if (!claim.outpost && claim.units > 1) addPopUnits(state, colony, empire.id, claim.units - 1);
    catchUp(state, empire, colony, scheduleOf(state, claim.empireId)!, claim.turn, turn);
  }
  rec.usedClaims.sort((a, b) => a.planetId - b.planetId || a.empireId - b.empireId);

  for (const empire of living) {
    const sched = scheduleOf(state, empire.id);
    if (!sched) continue;

    // ---- r2: scripted research ----
    for (const r of sched.research) {
      if (r.turn === turn) {
        if (grantApp(empire, r.app)) {
          events.push({ visibleTo: -1, kind: 'reconcile_research', payload: { empireId: empire.id, app: r.app } });
        }
      }
    }
    for (const f of sched.fields) {
      if (f.turn === turn && !empire.completedFields.includes(f.fieldNum)) {
        empire.completedFields.push(f.fieldNum);
        empire.completedFields.sort((a, b) => a - b);
      }
    }

    // ---- r3/r4/r5: scripted terraforming, growth, construction, garrisons —
    // only while the recorded owner actually holds the world (zeroed/lost
    // colonies get nothing; an applied terraform is permanent) ----
    for (const t of sched.terraform ?? []) {
      if (t.turn !== turn) continue;
      if (ownedColonyOn(state, empire.id, t.planetId)) applyTerraform(state, t.planetId, t.climate, t.steps);
    }
    for (const p of sched.pop) {
      if (p.turn !== turn) continue;
      const colony = ownedColonyOn(state, empire.id, p.planetId);
      if (colony) addPopUnits(state, colony, empire.id, p.units);
    }
    for (const b of sched.buildings) {
      if (b.turn !== turn) continue;
      const colony = state.colonies.find((c) => c.planetId === b.planetId && c.owner === empire.id);
      if (colony) addBuilding(colony, b.building);
    }
    for (const m of sched.marines) {
      if (m.turn !== turn) continue;
      const colony = state.colonies.find((c) => c.planetId === m.planetId && c.owner === empire.id);
      if (colony) colony.marines = m.count;
    }
    for (const s of sched.spies) {
      if (s.turn === turn) empire.spies.count = Math.min(SPY_CAP, s.count);
    }

    // ---- r6: scripted ship production — hulls pop out at the colony nearest
    // to where they were actually produced ----
    const myStars = new Set<number>();
    for (const c of state.colonies) {
      if (c.owner !== empire.id) continue;
      const planet = state.planets.find((p) => p.id === c.planetId);
      if (planet) myStars.add(planet.starId);
    }
    for (const entry of sched.ships) {
      if (entry.turn !== turn) continue;
      if (myStars.size === 0) break; // colonyless (about to be eliminated)
      let spawnStar: number;
      if (myStars.has(entry.starId)) {
        spawnStar = entry.starId;
      } else {
        const recorded = state.stars.find((s) => s.id === entry.starId);
        spawnStar = [...myStars].sort((a, b) => {
          if (!recorded) return a - b;
          const sa = state.stars.find((s) => s.id === a)!;
          const sb = state.stars.find((s) => s.id === b)!;
          return starDistance(sa, recorded) - starDistance(sb, recorded) || a - b;
        })[0]!;
      }
      let designId: number | null = null;
      let shipKind: ShipKind | 'design' = 'design';
      if (entry.kind.startsWith('design:')) {
        const hull = entry.kind.slice('design:'.length);
        const candidates = empire.designs.filter((d) => !d.obsolete);
        const exact = candidates.filter((d) => d.hull === hull).sort((a, b) => Number(b.auto ?? false) - Number(a.auto ?? false) || a.id - b.id);
        const pick =
          exact[0] ??
          candidates
            .filter((d) => hullIndexOf(d.hull) <= hullIndexOf(hull))
            .sort((a, b) => hullIndexOf(b.hull) - hullIndexOf(a.hull) || Number(b.auto ?? false) - Number(a.auto ?? false) || a.id - b.id)[0];
        if (!pick) continue; // no design can stand in for the record
        designId = pick.id;
      } else if (CIVILIAN_KINDS.includes(entry.kind)) {
        shipKind = entry.kind as ShipKind;
      } else {
        continue;
      }
      const ship = {
        id: allocId(state, empire.id),
        owner: empire.id,
        shipKind,
        designId,
        location: { kind: 'star' as const, starId: spawnStar },
        cargoPopUnits: 0,
        cargoRace: empire.id,
        dmgStructure: 0,
        dmgArmor: 0,
      };
      if (shipKind === 'transport') {
        const yard = state.colonies.find((c) => {
          if (c.owner !== empire.id) return false;
          const planet = state.planets.find((p) => p.id === c.planetId);
          return planet?.starId === spawnStar;
        });
        const aboard = Math.min(MARINES_PER_TRANSPORT, yard?.marines ?? 0);
        if (yard && aboard > 0) {
          yard.marines = (yard.marines ?? 0) - aboard;
          (ship as { marines?: number }).marines = aboard;
        }
      }
      state.ships.push(ship);
      events.push({ visibleTo: -1, kind: 'reconcile_ship', payload: { empireId: empire.id, starId: spawnStar, kind: entry.kind } });
    }
  }
  // ---- r7: reach insurance — wars can burn colonies faster than any script
  // replaces them, cutting the survivors off from each other. Every 5th turn
  // each living empire's strongest industrial world cranks out an outpost
  // ship (if it has none), so bots can re-anchor fuel range across razed
  // territory. Scheduled colonization landing on such an outpost evicts it.
  if (turn % 5 === 0) {
    for (const empire of living) {
      const hasOutpostShip = state.ships.some((s) => s.owner === empire.id && s.shipKind === 'outpost_ship');
      if (hasOutpostShip) continue;
      const yard = state.colonies
        .filter((c) => c.owner === empire.id && !c.outpost)
        .sort((a, b) => {
          const pa = a.groups.reduce((n, g) => n + g.popK, 0);
          const pb = b.groups.reduce((n, g) => n + g.popK, 0);
          return pb - pa || a.id - b.id;
        })[0];
      if (!yard) continue;
      const planet = state.planets.find((p) => p.id === yard.planetId)!;
      state.ships.push({
        id: allocId(state, empire.id),
        owner: empire.id,
        shipKind: 'outpost_ship',
        designId: null,
        location: { kind: 'star', starId: planet.starId },
        cargoPopUnits: 0,
        cargoRace: empire.id,
        dmgStructure: 0,
        dmgArmor: 0,
      });
    }
  }
  state.ships.sort((a, b) => a.id - b.id);
}

/** Scoring: the reconciliation is decided once the save games run out of
 * turns (ReconcileState.endTurn = min last-turn across the submitted saves).
 * If nobody has won outright by then, the population that remains elects a
 * leader — the biggest empire by people takes a council-style victory. */
export function reconcileFinalScoring(state: GameState, events: TurnEvent[]): void {
  const endTurn = state.reconcile?.endTurn;
  if (endTurn === undefined || state.turn < endTurn || state.winner !== null) return;
  const living = state.empires.filter((e) => !e.eliminated);
  if (!living.length) return;
  const popOf = (id: number) =>
    state.colonies.filter((c) => c.owner === id).reduce((n, c) => n + c.groups.reduce((m, g) => m + g.popK, 0), 0);
  const leader = living.sort((a, b) => popOf(b.id) - popOf(a.id) || a.id - b.id)[0]!;
  state.winner = leader.id;
  state.winType = 'council';
  events.push({ visibleTo: -1, kind: 'victory', payload: { empireId: leader.id, type: 'council', reconciled: true } });
}

/** reconciliation espionage: auto-targeted rings, passive-tech theft only,
 * sabotage aimed at defensive structures */
export function reconcileEspionage(state: GameState, events: TurnEvent[]): void {
  // auto-targeting: the ring watches the strongest MET rival (most core
  // worlds held, then most colonies); wartime rings switch to sabotage
  const coreIds = new Set(state.coreWorlds ?? []);
  for (const empire of state.empires) {
    if (empire.eliminated || empire.spies.count <= 0) continue;
    const met = metEmpireIds(state, empire.id);
    const rivals = state.empires.filter((e) => e.id !== empire.id && !e.eliminated && met.has(e.id));
    if (!rivals.length) {
      empire.spies.target = null;
      continue;
    }
    const strength = (e: Empire): [number, number] => {
      let cores = 0;
      let colonies = 0;
      for (const c of state.colonies) {
        if (c.owner !== e.id || c.outpost) continue;
        colonies++;
        if (coreIds.has(c.planetId)) cores++;
      }
      return [cores, colonies];
    };
    const target = rivals.sort((a, b) => {
      const [ca, na] = strength(a);
      const [cb, nb] = strength(b);
      return cb - ca || nb - na || a.id - b.id;
    })[0]!;
    empire.spies.target = target.id;
    empire.spies.mode = areAtWar(state, empire.id, target.id) ? 'sabotage' : 'steal';
  }

  for (const empire of state.empires) {
    if (empire.eliminated || empire.spies.target === null || empire.spies.count <= 0) continue;
    const target = state.empires.find((e) => e.id === empire.spies.target);
    if (!target || target.eliminated) continue;
    const defendingSpies = target.spies.target === null ? target.spies.count : 0;
    const offense = offenseOf(state, empire);
    const defense = defenseOf(state, target);
    const chance = clamp(15 + offense - defense - 4 * defendingSpies, 2, 60);
    const rng = rngFor(state.seed, state.turn, 'reconcile_spy', empire.id);
    const attempts = empire.spies.count;
    for (let i = 0; i < attempts && empire.spies.count > 0; i++) {
      if (rng.chancePct(chance)) {
        if (empire.spies.mode === 'steal') {
          // passives only, and only with a LARGE advantage or vs a democracy
          const allowed = offense - defense >= SPY_PASSIVE_ADV || traitsOf(target).government === 'democracy';
          const stealable = allowed
            ? PASSIVE_APPS.filter((a) => target.knownApps.includes(a) && !empire.knownApps.includes(a))
            : [];
          if (stealable.length) {
            const app = stealable[rng.int(stealable.length)]!;
            grantApp(empire, app);
            events.push({ visibleTo: empire.id, kind: 'tech_stolen', payload: { from: target.id, app } });
            events.push({ visibleTo: target.id, kind: 'tech_theft_suffered', payload: { app } });
          }
        } else {
          // sabotage goes for the guns: orbital works and ground defenses
          const targets: Array<{ colony: Colony; building: string }> = [];
          for (const colony of state.colonies) {
            if (colony.owner !== target.id || colony.outpost) continue;
            for (const b of colony.buildings) {
              if (DEFENSIVE_STRUCTURES.includes(b)) targets.push({ colony, building: b });
            }
          }
          if (targets.length) {
            const hit = targets[rng.int(targets.length)]!;
            hit.colony.buildings = hit.colony.buildings.filter((x) => x !== hit.building);
            events.push({ visibleTo: empire.id, kind: 'sabotage_success', payload: { colonyId: hit.colony.id, building: hit.building } });
            events.push({ visibleTo: target.id, kind: 'sabotage_suffered', payload: { colonyId: hit.colony.id, building: hit.building } });
          }
        }
      }
      if (rng.chancePct(25)) {
        empire.spies.count--;
        relationOf(state, empire.id, target.id);
        events.push({ visibleTo: empire.id, kind: 'spy_lost', payload: { target: target.id } });
        events.push({ visibleTo: target.id, kind: 'spy_caught', payload: { from: empire.id } });
        if (empire.spies.count <= 0) break;
      }
    }
  }
}
