// bugs.md 2026-07-16:
// - a defenseless defender must not be prompted for battle orders, and a
//   walkover battle must not produce a nobody-fights replay (the resolved
//   report, including bombardment, still lands);
// - noncombatant ships on a losing side that fielded ANY battle line (ships
//   or the defense base — even if it was wiped out) escape to the nearest
//   OTHER own colony instead of being destroyed.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyCommand } from '@engine/commands';
import { detectBattles, resolveBattle } from '@engine/battles';
import type { GameState, Ship, TurnEvent } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands: true,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

function homeStarOf(state: GameState, owner: number): number {
  const colony = state.colonies.find((c) => c.owner === owner)!;
  return state.planets.find((p) => p.id === colony.planetId)!.starId;
}

function addScouts(state: GameState, owner: number, starId: number, n: number): void {
  for (let i = 0; i < n; i++) {
    state.ships.push({
      id: state.nextId++,
      owner,
      shipKind: 'scout',
      designId: null,
      location: { kind: 'star', starId },
      cargoPopUnits: 0,
      cargoRace: owner,
      dmgStructure: 0,
      dmgArmor: 0,
    } as Ship);
  }
}

/** strip everything that could fight from a colony's orbit */
function disarmColony(state: GameState, owner: number): void {
  const colony = state.colonies.find((c) => c.owner === owner)!;
  colony.buildings = colony.buildings.filter(
    (b) => !['star_base', 'battle_station', 'star_fortress', 'missile_base', 'ground_batteries'].includes(b),
  );
  const starId = homeStarOf(state, owner);
  state.ships = state.ships.filter(
    (s) => !(s.owner === owner && s.location.kind === 'star' && s.location.starId === starId && (s.shipKind === 'design' || s.shipKind === 'scout')),
  );
}

describe('defenseless defender', () => {
  it('is not prompted for orders and the walkover gets no replay', () => {
    const state = newGame();
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'declare_war', payload: { target: 1 } });
    disarmColony(state, 1);
    const enemyStar = homeStarOf(state, 1);
    addScouts(state, 0, enemyStar, 1);

    const battle = detectBattles(state).find((b) => b.starId === enemyStar)!;
    expect(battle).toBeDefined();
    expect(battle.attacker).toBe(0);
    // nothing to order: the defender side is pre-filled like an NPC's
    expect(battle.ordersD).not.toBeNull();

    const events: TurnEvent[] = [];
    resolveBattle(state, battle, events);
    expect(events.some((e) => e.kind === 'battle_resolved')).toBe(true);
    expect(events.some((e) => e.kind === 'battle_replay')).toBe(false); // nobody fought — nothing to watch
  });

  it('a defended colony still prompts and still gets a replay', () => {
    const state = newGame();
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'declare_war', payload: { target: 1 } });
    const enemyStar = homeStarOf(state, 1); // home keeps its star base
    addScouts(state, 0, enemyStar, 1);

    const battle = detectBattles(state).find((b) => b.starId === enemyStar)!;
    expect(battle.ordersD).toBeNull(); // the defender has a base to command

    battle.ordersA = { stance: 'charge', priority: 'nearest', retreatThresholdPct: 0, bombard: false };
    battle.ordersD = { stance: 'charge', priority: 'nearest', retreatThresholdPct: 0, bombard: false };
    const events: TurnEvent[] = [];
    resolveBattle(state, battle, events);
    expect(events.some((e) => e.kind === 'battle_replay')).toBe(true);
  });
});

describe('noncombatants on a losing side', () => {
  it('escape toward another colony when their side fielded a battle line', () => {
    const state = newGame();
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'declare_war', payload: { target: 1 } });
    const enemyStar = homeStarOf(state, 1);
    // give the defender a second colony at another star (the flee haven)
    const freePlanet = state.planets.find(
      (p) =>
        p.body === 'planet' &&
        p.starId !== enemyStar &&
        !state.colonies.some((c) => c.planetId === p.id) &&
        !state.monsters.some((m) => m.starId === p.starId),
    )!;
    applyCommand(state, { turn: state.turn, playerId: 1, kind: 'debug_found_colony', payload: { planetId: freePlanet.id } });
    // the defender's line: one scout (the base is stripped so the outcome is
    // decided by the hopeless 1-vs-8 ship fight)
    disarmColony(state, 1);
    addScouts(state, 1, enemyStar, 1);
    addScouts(state, 0, enemyStar, 8);
    const colonyShip = state.ships.find((s) => s.owner === 1 && s.shipKind === 'colony_ship')!;
    colonyShip.location = { kind: 'star', starId: enemyStar };

    const battle = detectBattles(state).find((b) => b.starId === enemyStar)!;
    battle.ordersA = { stance: 'charge', priority: 'nearest', retreatThresholdPct: 0, bombard: false };
    battle.ordersD = battle.ordersD ?? { stance: 'charge', priority: 'nearest', retreatThresholdPct: 0, bombard: false };
    const events: TurnEvent[] = [];
    const { result } = resolveBattle(state, battle, events);
    expect(result.winner).toBe(0); // 8 scouts overwhelm the lone escort

    const survivor = state.ships.find((s) => s.id === colonyShip.id);
    expect(survivor).toBeDefined(); // the base's stand covered the escape
    expect(survivor!.location.kind).toBe('transit');
    const dest = (survivor!.location as { kind: 'transit'; to: number }).to;
    expect(dest).toBe(freePlanet.starId); // fled to the OTHER colony, not the besieged one
  });

  it('are lost when caught with no battle line at all', () => {
    const state = newGame();
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'declare_war', payload: { target: 1 } });
    // a lone colony ship at a neutral star, attacker warship on top of it
    const enemyStar = homeStarOf(state, 1);
    const neutralStar = state.stars.find(
      (st) =>
        st.id !== enemyStar &&
        st.id !== homeStarOf(state, 0) &&
        !state.monsters.some((m) => m.starId === st.id),
    )!;
    const colonyShip = state.ships.find((s) => s.owner === 1 && s.shipKind === 'colony_ship')!;
    colonyShip.location = { kind: 'star', starId: neutralStar.id };
    addScouts(state, 0, neutralStar.id, 1);

    const battle = detectBattles(state).find((b) => b.starId === neutralStar.id)!;
    expect(battle.ordersD).not.toBeNull(); // nothing to order here either
    battle.ordersA = { stance: 'charge', priority: 'nearest', retreatThresholdPct: 0, bombard: false };
    const events: TurnEvent[] = [];
    const { result } = resolveBattle(state, battle, events);
    expect(result.winner).toBe(0);
    expect(state.ships.find((s) => s.id === colonyShip.id)).toBeUndefined(); // run down
  });
});
