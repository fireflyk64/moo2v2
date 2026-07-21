// Ground operations: marine invasions (G1 documented rule), capture with
// unrest, and per-turn assimilation (S11).
//
// G1 invasion rule (marine redesign; classic values unpublished):
// - invasions land MARINES, never colonists: each transport boards a squad of
//   4 marines at build time (economy.MARINES_PER_TRANSPORT); civilian-loaded
//   transports are migration ships and cannot invade
// - defenders = colony marine garrison (trained by barracks, marines die
//   first) + civilian militia of ceil(pop/2)
// - unit strength = 20 + racial ground pick + 5 per barracks (defenders only)
// - rounds: P(attacker kills) = attackerPower/(attackerPower+defenderPower);
//   the losing side loses one unit; militia losses kill civilians 1:1 (floor 1)
// - capture: surviving civilians switch owner with unrest; the surviving
//   attacker marines stay as the colony's new garrison (no pop settlement)
// - after a battle, landing happens ONLY via the attacker's invade order
//   (resolved in the pipeline right after the battle); the S10 auto-landing
//   below covers naked marine convoys reaching an undefended colony
// - assimilation: each unrest group clears with chance 1/N per turn
//   (N: dictatorship/feudal 8, democracy 4, unification 20)

import { rngFor } from './rng';
import { generateTerrain, groundModifiers, isAttackTactic, isDefenseTactic } from './groundTactics';
import { ceilDiv } from './imath';
import { barracksCount, colonyPopUnits, farmingViable, marineCap, MARINE_TRAIN_TURNS, marinesOf, shipMarines, traitsOf } from './economy';
import { leaderEmpireBonuses } from './leaders';
import { areAtWar } from './battles';
import { normalizeJobsForGroup } from './commands';
import { ANDROID_RACE, type Colony, type GameState, type Ship, type TurnEvent } from './types';

function groundStrength(state: GameState, empireId: number, defending: boolean, colony?: Colony): number {
  const empire = state.empires.find((e) => e.id === empireId);
  let str = 20;
  if (empire) {
    str += traitsOf(empire).groundPct;
    const lb = leaderEmpireBonuses(empire); // commando / security leaders
    str += defending ? lb.groundDefense : lb.groundAttack;
  }
  if (defending && colony) {
    if (colony.buildings.includes('marine_barracks')) str += 5;
    if (colony.buildings.includes('armor_barracks')) str += 5;
  }
  return Math.max(5, str);
}

/** S10: auto-landings — marine transports at an at-war colony star with no
 * defending warships AND no battle fought there by that empire this turn
 * (post-battle landings are order-gated: see the invade order in pipeline). */
export function resolveInvasions(state: GameState, events: TurnEvent[], foughtAt: ReadonlySet<string> = new Set()): void {
  for (const colony of [...state.colonies]) {
    if (colony.outpost) continue;
    const planet = state.planets.find((p) => p.id === colony.planetId)!;
    const starId = planet.starId;
    const invaders = state.ships.filter(
      (s) =>
        s.shipKind === 'transport' &&
        shipMarines(s) > 0 &&
        s.location.kind === 'star' &&
        s.location.starId === starId &&
        s.owner !== colony.owner &&
        areAtWar(state, s.owner, colony.owner),
    );
    if (!invaders.length) continue;
    // defenders present? warships (armed scouts included) block the landing
    const defended = state.ships.some(
      (s) =>
        s.owner === colony.owner &&
        (s.shipKind === 'design' || s.shipKind === 'scout') &&
        s.location.kind === 'star' &&
        s.location.starId === starId,
    );
    if (defended) continue;

    const attackerId = invaders.reduce((min, s) => Math.min(min, s.owner), 99);
    // an empire that fought here this turn chose (or declined) its landing in
    // the battle-orders dialog — never auto-land behind that decision
    if (foughtAt.has(`${attackerId}:${starId}`)) continue;
    landInvasion(state, colony, attackerId, events);
  }
}

/** Land an empire's marine transports at the colony and fight it out. The
 * transports are consumed; on capture the surviving marines stay as the
 * colony's new garrison. No-op when no marines are in orbit. */
export function landInvasion(
  state: GameState,
  colony: Colony,
  attackerId: number,
  events: TurnEvent[],
  /** attacker's chosen ground tactic (invade order); absent = legacy neutral */
  atkTactic?: string,
): void {
  const planet = state.planets.find((p) => p.id === colony.planetId)!;
  const starId = planet.starId;
  const force = state.ships.filter(
    (s) =>
      s.owner === attackerId &&
      s.shipKind === 'transport' &&
      shipMarines(s) > 0 &&
      s.location.kind === 'star' &&
      s.location.starId === starId,
  );
  let troops = force.reduce((sum, s) => sum + shipMarines(s), 0);
  if (troops === 0) return;
  const pop = colonyPopUnits(colony);
  // the trained garrison holds the line first; civilians only fight (and die)
  // once the marines are gone
  let defMarines = marinesOf(colony);
  let militia = ceilDiv(pop, 2);

  // tactics + terrain (bugs.md round 6): the planet's one deterministic map
  // and the two doctrines scale each side's per-round strength. Both tactics
  // absent (old logs, unset colonies) = 1/1 — exact legacy math.
  const terrain = generateTerrain(planet.id, planet.climate);
  const atk = isAttackTactic(atkTactic) ? atkTactic : undefined;
  const def = isDefenseTactic(colony.groundTactic) ? colony.groundTactic : undefined;
  const mods = groundModifiers(atk, def, atk || def ? terrain : null);
  // integer strengths keep rng.int's bound exact (mult 1 rounds to itself)
  const atkStr = Math.max(1, Math.round(groundStrength(state, attackerId, false) * mods.atkMult));
  const defStr = Math.max(1, Math.round(groundStrength(state, colony.owner, true, colony) * mods.defMult));
  const rng = rngFor(state.seed, state.turn, 'ground', colony.id);

  const startTroops = troops;
  const startMilitia = defMarines + militia;
  const startGarrison = defMarines;
  // scenery facts for the invasion playback (judged before any losses)
  const farming = farmingViable(state, colony);
  let civilianLosses = 0;
  // round-by-round record for the ground-battle replay (participants only)
  const roundsLog: Array<{ t: number; m: number }> = [{ t: troops, m: defMarines + militia }];
  while (troops > 0 && defMarines + militia > 0) {
    const atkPower = troops * atkStr;
    const defPower = (defMarines + militia) * defStr;
    if (rng.int(atkPower + defPower) < atkPower) {
      if (defMarines > 0) {
        defMarines--;
      } else {
        militia--;
        if (pop - civilianLosses > 1) civilianLosses++;
      }
    } else {
      troops--;
    }
    roundsLog.push({ t: troops, m: defMarines + militia });
  }
  // long sieges get thinned so the replay payload stays small
  const rounds =
    roundsLog.length <= 60
      ? roundsLog
      : roundsLog.filter((_, i) => i % Math.ceil(roundsLog.length / 60) === 0 || i === roundsLog.length - 1);

  // apply civilian losses to groups (largest first). The colony as a WHOLE
  // keeps at least one unit (the cap below); a single group may be wiped
  // out entirely — the old per-group `> 1000` floor made multi-race
  // colonies of 1-unit groups immune to civilian deaths while the battle
  // report still claimed casualties.
  const toKillStart = Math.min(civilianLosses, Math.max(0, colonyPopUnits(colony) - 1));
  let toKill = toKillStart;
  const sortedGroups = [...colony.groups].sort((a, b) => b.popK - a.popK || a.race - b.race);
  for (const g of sortedGroups) {
    while (toKill > 0 && g.popK >= 1000 && colonyPopUnits(colony) > 1) {
      g.popK -= 1000;
      toKill--;
    }
  }
  civilianLosses = toKillStart - toKill; // report what actually happened
  colony.groups = colony.groups.filter((g) => g.popK > 0);
  for (const g of colony.groups) normalizeJobsForGroup(g);

  const captured = defMarines + militia <= 0 && troops > 0;
  // the invasion replay goes to the two participants only
  for (const viewer of new Set([attackerId, colony.owner])) {
    events.push({
      visibleTo: viewer,
      kind: 'ground_battle',
      payload: {
        colonyId: colony.id,
        colonyName: colony.name,
        starId,
        attacker: attackerId,
        defender: colony.owner,
        captured,
        civilianLosses,
        startTroops,
        startMilitia,
        startGarrison,
        climate: planet.climate,
        farming,
        rounds,
        // top-down tabletop replay data (viewer regenerates the map from
        // these; optional so old entries still play back)
        terrain,
        ...(atk ? { atkTactic: atk } : {}),
        ...(def ? { defTactic: def } : {}),
      },
    });
  }
  if (captured) {
    const oldOwner = colony.owner;
    colony.owner = attackerId;
    colony.queue = [];
    colony.storedProd = 0;
    colony.stickyInvested = {};
    // androids self-destruct rather than serve a conqueror (MOO2 rule:
    // destroyed, never captured)
    colony.groups = colony.groups.filter((g) => g.race !== ANDROID_RACE);
    // existing civilians become conquered (unrest)
    for (const g of colony.groups) g.unrest = true;
    // the surviving marines stay as the conqueror's garrison — soldiers,
    // not settlers: population is never minted by an invasion
    colony.marines = troops;
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
    colony.marines = defMarines; // the garrison's survivors stand down
    events.push({
      visibleTo: -1,
      kind: 'invasion_repelled',
      payload: { colonyId: colony.id, attacker: attackerId, troopsLost: startTroops, defendersLost: startMilitia - (defMarines + militia), civilianLosses },
    });
  }

  // consume the landed transports
  const usedIds = new Set(force.map((s) => s.id));
  state.ships = state.ships.filter((s) => !usedIds.has(s.id));
}

/** S11: barracks train marines — one recruit per barracks building every
 * MARINE_TRAIN_TURNS turns, up to the colony's cap (marineCap). */
export function trainMarines(state: GameState): void {
  if (state.turn % MARINE_TRAIN_TURNS !== 0) return;
  for (const colony of state.colonies) {
    if (colony.outpost) continue;
    const cap = marineCap(colony);
    if (cap <= 0) continue;
    const cur = marinesOf(colony);
    if (cur < cap) colony.marines = Math.min(cap, cur + barracksCount(colony));
  }
}

/** S11: unrest groups assimilate with chance 1/N by government. */
export function assimilate(state: GameState, events: TurnEvent[]): void {
  for (const colony of state.colonies) {
    const empire = state.empires.find((e) => e.id === colony.owner);
    if (!empire) continue;
    const gov = traitsOf(empire).government;
    let n = gov === 'democracy' ? 4 : gov === 'unification' ? 20 : 8;
    // telepath leaders, alien management centers, and the capitol halve resistance
    if (leaderEmpireBonuses(empire).telepathAssimilate) n = Math.max(2, ceilDiv(n, 2));
    if (colony.buildings.includes('alien_management_center') || colony.buildings.includes('capitol')) {
      n = Math.max(2, ceilDiv(n, 2));
    }
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
    // armed scouts count on both sides of a blockade, same as in battle
    if ((s.shipKind !== 'design' && s.shipKind !== 'scout') || s.location.kind !== 'star' || s.location.starId !== starId) continue;
    if (s.owner === colony.owner) friendly = true;
    else if (areAtWar(state, s.owner, colony.owner)) hostile = true;
  }
  return hostile && !friendly;
}

export function transportAt(state: GameState, shipId: number): Ship | null {
  const s = state.ships.find((x) => x.id === shipId);
  return s && s.shipKind === 'transport' ? s : null;
}
