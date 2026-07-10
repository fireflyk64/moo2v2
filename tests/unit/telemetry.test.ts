// UI telemetry aggregates ride the command log so every peer folds the same
// numbers into the shared state (displayed per empire on the Empires tab).

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyCommand, validateCommand } from '@engine/commands';
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

const cmd = (state: GameState, payload: unknown) => ({
  turn: state.turn,
  playerId: 0,
  kind: 'record_telemetry',
  payload,
});

describe('record_telemetry', () => {
  it('accumulates screen seconds per empire', () => {
    const state = newGame();
    expect(validateCommand(state, cmd(state, { screens: { colonies: 90, map: 12 } }))).toBeNull();
    applyCommand(state, cmd(state, { screens: { colonies: 90, map: 12 } }));
    applyCommand(state, cmd(state, { screens: { colonies: 30 } }));
    expect(state.empires[0]!.telemetry).toEqual({ colonies: 120, map: 12 });
    expect(state.empires[1]!.telemetry).toBeUndefined();
  });

  it('rejects junk payloads', () => {
    const state = newGame();
    expect(validateCommand(state, cmd(state, { screens: {} }))).toBeTruthy();
    expect(validateCommand(state, cmd(state, { screens: { a: -1 } }))).toBeTruthy();
    expect(validateCommand(state, cmd(state, { screens: { a: 1.5 } }))).toBeTruthy();
    expect(validateCommand(state, cmd(state, { screens: { ['x'.repeat(30)]: 5 } }))).toBeTruthy();
    expect(validateCommand(state, cmd(state, [1, 2]))).toBeTruthy();
  });
});
