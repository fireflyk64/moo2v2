// Leaders runtime: hiring offers (S11), salaries, XP/levels, and the bonus
// accessors the rest of the engine consumes. Rules L1-L4 in data/leaders.ts.

import {
  LEADERS,
  MAX_LEADERS_PER_KIND,
  leaderById,
  leaderPoints,
  levelForXp,
  skillMagnitude,
  MAX_LEVEL,
  LEVEL_XP,
  type LeaderRow,
  type LeaderSkillId,
} from './data/leaders';
import { anyEmpireContact } from './contact';
import type { Modifier } from './effects';
import { floorDiv } from './imath';
import { resolveTraits } from './race';
import { rngFor } from './rng';
import type { Empire, GameState, HiredLeader, TurnEvent } from './types';

export { LEADERS, leaderById, leaderPoints, MAX_LEADERS_PER_KIND, MAX_LEVEL, LEVEL_XP };

function skillTotal(empire: Empire, skill: LeaderSkillId, kind?: 'colony' | 'ship'): number {
  let total = 0;
  for (const hired of empire.leaders) {
    const row = leaderById.get(hired.leaderId);
    if (!row) continue;
    if (kind && row.kind !== kind) continue;
    for (const sk of row.skills) {
      if (sk.skill === skill) total += skillMagnitude(sk, hired.level);
    }
  }
  return total;
}

function bestSkill(empire: Empire, skill: LeaderSkillId): number {
  let best = 0;
  for (const hired of empire.leaders) {
    const row = leaderById.get(hired.leaderId);
    if (!row) continue;
    for (const sk of row.skills) {
      if (sk.skill === skill) best = Math.max(best, skillMagnitude(sk, hired.level));
    }
  }
  return best;
}

/** Colony-scope modifiers from colony leaders administering this colony's
 * star system. Colony leaders are system administrators (MOO2 rule, bugs.md):
 * a leader stationed at ANY of the empire's colonies in a system boosts every
 * colony of that empire in the same system, not just their seat. */
export function leaderColonyModifiers(state: GameState, empire: Empire, colonyId: number): Modifier[] {
  const starOf = (cid: number): number | undefined => {
    const col = state.colonies.find((c) => c.id === cid);
    if (!col) return undefined;
    return state.planets.find((p) => p.id === col.planetId)?.starId;
  };
  const myStar = starOf(colonyId);
  const mods: Modifier[] = [];
  for (const hired of empire.leaders) {
    if (hired.colonyId === null) continue;
    if (hired.colonyId !== colonyId) {
      // system administration reaches sibling colonies the empire still owns
      if (myStar === undefined || starOf(hired.colonyId) !== myStar) continue;
      if (!state.colonies.some((c) => c.id === hired.colonyId && c.owner === empire.id)) continue;
    }
    const row = leaderById.get(hired.leaderId);
    if (!row) continue;
    for (const sk of row.skills) {
      const amount = skillMagnitude(sk, hired.level);
      switch (sk.skill) {
        case 'farming_leader':
          mods.push({ target: 'farm_pct', amount, scope: 'colony' });
          break;
        case 'labor_leader':
          mods.push({ target: 'prod_pct', amount, scope: 'colony' });
          break;
        case 'science_leader':
          mods.push({ target: 'sci_pct', amount, scope: 'colony' });
          break;
        case 'financial_leader':
          mods.push({ target: 'bc_pct', amount, scope: 'colony' });
          break;
        case 'spiritual_leader':
          mods.push({ target: 'morale_pct', amount, scope: 'colony' });
          break;
        case 'environmentalist':
          mods.push({ target: 'pollution_absorb_flat', amount, scope: 'colony' });
          break;
        case 'medicine':
          mods.push({ target: 'growth_pct', amount, scope: 'colony' });
          break;
        default:
          break;
      }
    }
  }
  return mods;
}

export interface LeaderEmpireBonuses {
  bcFlat: number; // megawealth
  rpFlat: number; // researcher
  cpFlat: number; // operations
  spyOffense: number; // spy master + telepath
  groundAttack: number; // commando
  groundDefense: number; // commando + security
  hireDiscountPct: number; // famous (capped 50)
  offerChancePct: number; // famous 2%/level
  tradeTreatyPct: number; // trader
  councilWeightPct: number; // diplomat
  assassinPct: number; // best assassin
  engineerRepair: boolean; // fleet repairs anywhere
  navigatorSpeed: number; // +parsecs/turn
  scanBonus: number; // galactic lore
  instructorXp: number; // best instructor
  telepathAssimilate: boolean;
}

export function leaderEmpireBonuses(empire: Empire): LeaderEmpireBonuses {
  let famousLevels = 0;
  let navigator = 0;
  let engineer = false;
  let telepath = false;
  for (const hired of empire.leaders) {
    const row = leaderById.get(hired.leaderId);
    if (!row) continue;
    for (const sk of row.skills) {
      if (sk.skill === 'famous') famousLevels += hired.level * (sk.enhanced ? 2 : 1);
      if (sk.skill === 'engineer') engineer = true;
      if (sk.skill === 'telepath') telepath = true;
      if (sk.skill === 'navigator') {
        // +1 pc/turn per 2 levels; per level when enhanced (L1)
        navigator = Math.max(navigator, sk.enhanced ? hired.level : floorDiv(hired.level, 2));
      }
    }
  }
  return {
    bcFlat: skillTotal(empire, 'megawealth'),
    rpFlat: skillTotal(empire, 'researcher'),
    cpFlat: skillTotal(empire, 'operations'),
    spyOffense: skillTotal(empire, 'spy_master') + skillTotal(empire, 'telepath'),
    groundAttack: skillTotal(empire, 'commando'),
    groundDefense: skillTotal(empire, 'commando') + skillTotal(empire, 'security'),
    hireDiscountPct: Math.min(50, famousLevels * 10),
    offerChancePct: famousLevels * 2,
    tradeTreatyPct: Math.min(200, skillTotal(empire, 'trader')),
    councilWeightPct: skillTotal(empire, 'diplomat'),
    assassinPct: bestSkill(empire, 'assassin'),
    engineerRepair: engineer,
    navigatorSpeed: navigator,
    scanBonus: skillTotal(empire, 'galactic_lore'),
    instructorXp: bestSkill(empire, 'instructor'),
    telepathAssimilate: telepath,
  };
}

export interface LeaderCombatBonuses {
  beamAttack: number; // weaponry
  beamDefense: number; // helmsman
  dmgMaxPct: number; // ordnance
  speedPct: number; // tactics
  fighterDmgPct: number; // fighter pilot
}

export function leaderCombatBonuses(empire: Empire): LeaderCombatBonuses {
  return {
    beamAttack: skillTotal(empire, 'weaponry', 'ship'),
    beamDefense: skillTotal(empire, 'helmsman', 'ship'),
    dmgMaxPct: skillTotal(empire, 'ordnance', 'ship'),
    // like every other combat skill, tactics applies from SHIP officers only
    // (L2); a colony administrator with tactics contributes nothing in battle
    speedPct: skillTotal(empire, 'tactics', 'ship'),
    fighterDmgPct: skillTotal(empire, 'fighter_pilot', 'ship'),
  };
}

export function hireCostOf(row: LeaderRow, empire: Empire): number {
  const base = 50 + 25 * leaderPoints(row);
  const discount = leaderEmpireBonuses(empire).hireDiscountPct + (resolveTraits(empire.picks).charismatic ? 25 : 0);
  return Math.max(10, floorDiv(base * (100 - Math.min(75, discount)), 100));
}

export function salaryOf(row: LeaderRow): number {
  return leaderPoints(row);
}

function hiredAnywhere(state: GameState, leaderId: string): boolean {
  return state.empires.some((e) => e.leaders.some((l) => l.leaderId === leaderId));
}

export function countKind(empire: Empire, kind: 'colony' | 'ship'): number {
  let n = 0;
  for (const l of empire.leaders) {
    if (leaderById.get(l.leaderId)?.kind === kind) n++;
  }
  return n;
}

export const OFFER_TTL = 8;
export const OFFER_BASE_CHANCE = 8; // %/turn with an open slot

/** S11: expire offers, generate new offers, pay salaries, award XP.
 *
 * PRE-CONTACT the leader market is per-empire: strangers' hires neither
 * cancel an empire's standing offers nor shrink its candidate pool — an
 * empire's offer stream must be a pure function of the seed and its OWN state
 * (the fast-start invariant: while no two empires have met, nothing one
 * player does may change another's world). The same unique leader can
 * therefore serve two empires that hired them before anyone met; that is
 * accepted and harmless (skills are per-empire). Once ANY contact exists the
 * classic global market applies. */
export function leadersUpkeep(state: GameState, events: TurnEvent[]): void {
  const globalMarket = anyEmpireContact(state);
  const takenFor = (empireId: number, leaderId: string): boolean =>
    globalMarket
      ? hiredAnywhere(state, leaderId)
      : (state.empires.find((e) => e.id === empireId)?.leaders.some((l) => l.leaderId === leaderId) ?? false);
  // expire old offers + offers for since-hired leaders
  state.leaderOffers = state.leaderOffers.filter(
    (o) => o.expiresTurn > state.turn && !takenFor(o.empireId, o.leaderId),
  );

  for (const empire of state.empires) {
    if (empire.eliminated) continue;
    // unassign leaders whose colony was lost or captured
    for (const hired of empire.leaders) {
      if (hired.colonyId !== null && !state.colonies.some((c) => c.id === hired.colonyId && c.owner === empire.id)) {
        hired.colonyId = null;
      }
    }
    const bonuses = leaderEmpireBonuses(empire);
    const traits = resolveTraits(empire.picks);
    const rng = rngFor(state.seed, state.turn, 'leaders', empire.id);

    // ---- new offer? ----
    const openKinds: Array<'colony' | 'ship'> = [];
    if (countKind(empire, 'colony') < MAX_LEADERS_PER_KIND) openKinds.push('colony');
    if (countKind(empire, 'ship') < MAX_LEADERS_PER_KIND) openKinds.push('ship');
    if (openKinds.length > 0) {
      let chance = OFFER_BASE_CHANCE + bonuses.offerChancePct;
      if (traits.charismatic) chance += 4;
      if (traits.repulsive) chance = floorDiv(chance, 2);
      // word gets out fast early on: empires with no leader yet see offers sooner
      if (empire.leaders.length === 0 && !state.leaderOffers.some((o) => o.empireId === empire.id)) chance += 6;
      if (rng.chancePct(chance)) {
        const pool = LEADERS.filter(
          (l) =>
            openKinds.includes(l.kind) &&
            // Loknar is the Guardian's bounty (guardianReward), never a
            // walk-in — the game's biggest PvE prize must not turn up in the
            // ordinary offer stream for list price
            l.id !== 'loknar' &&
            !takenFor(empire.id, l.id) &&
            !state.leaderOffers.some((o) => o.empireId === empire.id && o.leaderId === l.id),
        );
        if (pool.length > 0) {
          const row = pool[rng.int(pool.length)]!;
          state.leaderOffers.push({
            empireId: empire.id,
            leaderId: row.id,
            priceBc: hireCostOf(row, empire),
            expiresTurn: state.turn + OFFER_TTL,
          });
          events.push({
            visibleTo: empire.id,
            kind: 'leader_offer',
            payload: { leaderId: row.id, name: row.name, price: hireCostOf(row, empire), kind: row.kind },
          });
        }
      }
    }

    // ---- salaries ----
    let salary = 0;
    for (const hired of empire.leaders) {
      const row = leaderById.get(hired.leaderId);
      if (row) salary += salaryOf(row);
    }
    empire.bc -= salary;
    // broke: leaders quit, most expensive first, until the books balance
    while (empire.bc < 0 && empire.leaders.length > 0) {
      let worst: HiredLeader | null = null;
      let worstPay = -1;
      for (const hired of empire.leaders) {
        const row = leaderById.get(hired.leaderId);
        const pay = row ? salaryOf(row) : 0;
        if (pay > worstPay) {
          worstPay = pay;
          worst = hired;
        }
      }
      if (!worst) break;
      empire.leaders = empire.leaders.filter((l) => l !== worst);
      empire.bc += worstPay; // they leave unpaid this turn
      events.push({ visibleTo: empire.id, kind: 'leader_quit', payload: { leaderId: worst.leaderId } });
    }

    // ---- XP + levels ----
    const academy = state.colonies.some((c) => c.owner === empire.id && c.buildings.includes('space_academy'));
    const xpGain = 1 + bonuses.instructorXp + (academy ? 1 : 0);
    for (const hired of empire.leaders) {
      if (hired.level >= MAX_LEVEL) continue;
      hired.xp += xpGain;
      const level = Math.min(MAX_LEVEL, levelForXp(hired.xp));
      if (level > hired.level) {
        hired.level = level;
        events.push({
          visibleTo: empire.id,
          kind: 'leader_level',
          payload: { leaderId: hired.leaderId, level },
        });
      }
    }
  }
}
