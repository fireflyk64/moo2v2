// Espionage (E1 documented rule; classic formulas unpublished):
// - spies are built at colonies (50 PP each, cap 10 per empire)
// - orders: all defensive (target null), or offensive vs one empire in
//   'steal' or 'sabotage' mode
// - each offensive spy attempts once per turn:
//     chance% = clamp(15 + ourOffense - theirDefense - 4×theirDefensiveSpies, 2, 60)
//   ourOffense = race spying pick + tech spy_offense modifiers
//   theirDefense = race spying pick/2 (defensive halves, per racepicks docs)
//     + tech spy_defense modifiers + government defense
//     (dictatorship +20, unification +15, democracy -10)
// - steal: learn one application the target knows and we don't
// - sabotage: destroy a random non-barracks building on a random colony
// - each attempt risks 25% exposure -> spy lost + incident event

import { clamp, floorDiv } from './imath';
import { empireAccum } from './effects';
import { traitsOf } from './economy';
import { leaderEmpireBonuses } from './leaders';
import { grantApp } from './research';
import { rngFor } from './rng';
import type { Empire, GameState, TurnEvent } from './types';

export const SPY_CAP = 10;

function govSpyDefense(gov: string): number {
  switch (gov) {
    case 'dictatorship':
      return 20;
    case 'unification':
      return 15;
    case 'democracy':
      return -10;
    default:
      return 0;
  }
}

function offenseOf(state: GameState, empire: Empire): number {
  return traitsOf(empire).spyingPct + empireAccum(state, empire).spyOffense + leaderEmpireBonuses(empire).spyOffense;
}

function defenseOf(state: GameState, empire: Empire): number {
  // alien management centers harden the whole empire (non-cumulative)
  const amc = state.colonies.some((c) => c.owner === empire.id && c.buildings.includes('alien_management_center'))
    ? 10
    : 0;
  return (
    floorDiv(traitsOf(empire).spyingPct, 2) +
    empireAccum(state, empire).spyDefense +
    govSpyDefense(traitsOf(empire).government) +
    amc
  );
}

/** S11 espionage resolution. */
export function resolveEspionage(state: GameState, events: TurnEvent[]): void {
  for (const empire of state.empires) {
    if (empire.eliminated || empire.spies.target === null || empire.spies.count <= 0) continue;
    const target = state.empires.find((e) => e.id === empire.spies.target);
    if (!target || target.eliminated) {
      empire.spies.target = null;
      continue;
    }
    const defendingSpies = target.spies.target === null ? target.spies.count : 0;
    const chance = clamp(15 + offenseOf(state, empire) - defenseOf(state, target) - 4 * defendingSpies, 2, 60);
    const rng = rngFor(state.seed, state.turn, 'spy', empire.id);

    // assassin leaders on the defending side pick off an incoming agent first
    const assassin = leaderEmpireBonuses(target).assassinPct;
    if (assassin > 0 && empire.spies.count > 0 && rng.chancePct(assassin)) {
      empire.spies.count--;
      events.push({ visibleTo: empire.id, kind: 'spy_lost', payload: { target: target.id, assassinated: true } });
      events.push({ visibleTo: target.id, kind: 'spy_assassinated', payload: { from: empire.id } });
      if (empire.spies.count <= 0) continue;
    }

    for (let i = 0; i < empire.spies.count; i++) {
      if (rng.chancePct(chance)) {
        if (empire.spies.mode === 'steal') {
          const stealable = target.knownApps.filter((a) => !empire.knownApps.includes(a));
          if (stealable.length) {
            const app = stealable[rng.int(stealable.length)]!;
            grantApp(empire, app);
            events.push({ visibleTo: empire.id, kind: 'tech_stolen', payload: { from: target.id, app } });
            events.push({ visibleTo: target.id, kind: 'tech_theft_suffered', payload: { app } });
          }
        } else {
          const colonies = state.colonies.filter((c) => c.owner === target.id && !c.outpost);
          if (colonies.length) {
            const colony = colonies[rng.int(colonies.length)]!;
            const destructible = colony.buildings.filter((b) => b !== 'marine_barracks');
            if (destructible.length) {
              const b = destructible[rng.int(destructible.length)]!;
              colony.buildings = colony.buildings.filter((x) => x !== b);
              events.push({ visibleTo: empire.id, kind: 'sabotage_success', payload: { colonyId: colony.id, building: b } });
              events.push({ visibleTo: target.id, kind: 'sabotage_suffered', payload: { colonyId: colony.id, building: b } });
            }
          }
        }
      }
      if (rng.chancePct(25)) {
        empire.spies.count--;
        events.push({ visibleTo: empire.id, kind: 'spy_lost', payload: { target: target.id } });
        events.push({ visibleTo: target.id, kind: 'spy_caught', payload: { from: empire.id } });
        if (empire.spies.count <= 0) break;
      }
    }
  }
}
