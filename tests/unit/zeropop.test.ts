// Bug: "colony can't be 0 pop" — a settlement whose population falls below
// one whole colonist unit is gone, not undead at 0/12.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import type { GameState } from '@engine/types';

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
      debugCommands: false,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

function advance(state: GameState): GameState {
  const next = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
  if (next.phase === 'battle_orders') {
    return gameEngine.apply(next, { turn: next.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
  }
  return next;
}

describe('no zero-unit colonies', () => {
  it('a colony starved below one whole unit dies instead of lingering at 0 pop', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
    home.groups = [{ race: 0, popK: 900, farmers: 0, workers: 0, scientists: 0, unrest: false }];
    const after = advance(state);
    expect(after.colonies.some((c) => c.id === home.id)).toBe(false);
  });

  it('starvation stops at the last whole unit — food shortage cannot wipe a colony', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
    home.groups = [{ race: 0, popK: 2000, farmers: 0, workers: 2, scientists: 0, unrest: false }];
    home.foodLackPrev = 50; // catastrophic shortage recorded last turn
    const after = advance(state);
    const still = after.colonies.find((c) => c.id === home.id)!;
    const units = still.groups.reduce((n, g) => n + Math.floor(g.popK / 1000), 0);
    expect(units).toBe(1); // starved down to — but never below — one unit
  });

  it('farmers cannot be assigned where nothing grows (barren)', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
    const planet = state.planets.find((p) => p.id === home.planetId)!;
    planet.climate = 'barren';
    const units = home.groups.reduce((n, g) => n + Math.floor(g.popK / 1000), 0);
    const err = gameEngine.validate(state, {
      turn: state.turn,
      playerId: 0,
      kind: 'set_jobs',
      payload: { colonyId: home.id, groups: [{ race: 0, farmers: 1, workers: units - 1, scientists: 0 }] },
    });
    expect(err).toContain('nothing grows');
    // all-industry is fine
    expect(
      gameEngine.validate(state, {
        turn: state.turn,
        playerId: 0,
        kind: 'set_jobs',
        payload: { colonyId: home.id, groups: [{ race: 0, farmers: 0, workers: units, scientists: 0 }] },
      }),
    ).toBeNull();
  });

  it('a healthy 1-unit colony lives and grows', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
    home.groups = [{ race: 0, popK: 1000, farmers: 1, workers: 0, scientists: 0, unrest: false }];
    const after = advance(state);
    const still = after.colonies.find((c) => c.id === home.id);
    expect(still).toBeDefined();
    expect(still!.groups[0]!.popK).toBeGreaterThanOrEqual(1000);
  });
});
