import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { validateCommand } from '@engine/commands';
import { itemCost } from '@engine/items';
import { type GameState } from '@engine/types';

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
  const after = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
  return after.phase === 'battle_orders'
    ? gameEngine.apply(after, { turn: after.turn, playerId: -1, kind: 'resolve_combat', payload: {} })
    : after;
}

describe('repeat build (0.30.0: the entry stays at the head and builds again)', () => {
  it('accepts repeat on ships/projects, refuses it on unique buildings', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    colony.buildings = colony.buildings.filter((b) => b !== 'marine_barracks'); // so it is queueable at all
    expect(
      validateCommand(state, {
        turn: state.turn,
        playerId: 0,
        kind: 'set_build_queue',
        payload: { colonyId: colony.id, items: [{ item: 'spy', repeat: true }] },
      }),
    ).toBeNull();
    expect(
      validateCommand(state, {
        turn: state.turn,
        playerId: 0,
        kind: 'set_build_queue',
        payload: { colonyId: colony.id, items: [{ item: 'marine_barracks', repeat: true }] },
      }),
    ).toMatch(/cannot repeat/);
    // plain strings still work (classic form, no flag)
    expect(
      validateCommand(state, {
        turn: state.turn,
        playerId: 0,
        kind: 'set_build_queue',
        payload: { colonyId: colony.id, items: ['marine_barracks', 'spy'] },
      }),
    ).toBeNull();
  });

  it('a repeating spy completes and stays queued for the next copy', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    colony.queue = [{ item: 'spy', repeat: true }];
    const cost = itemCost(state, 0, 'spy', colony)!;
    colony.storedProd = cost; // exactly one copy this turn
    const before = state.empires[0]!.spies.count;
    const after = advance(state);
    const c2 = after.colonies.find((x) => x.id === colony.id)!;
    expect(after.empires[0]!.spies.count).toBe(before + 1);
    expect(c2.queue[0]).toEqual({ item: 'spy', repeat: true }); // still building spies
  });

  it('retires when the colony cannot take another copy (roster full)', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    state.empires[0]!.spies.count = 9; // one short of the 10 cap
    colony.queue = [{ item: 'spy', repeat: true }];
    colony.storedProd = itemCost(state, 0, 'spy', colony)!;
    const after = advance(state);
    const c2 = after.colonies.find((x) => x.id === colony.id)!;
    expect(after.empires[0]!.spies.count).toBe(10);
    expect(c2.queue).toHaveLength(0); // roster full: the repeat entry retired
  });

  it('builds several copies in one turn when production covers them', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    colony.queue = [{ item: 'spy', repeat: true }];
    const cost = itemCost(state, 0, 'spy', colony)!;
    colony.storedProd = cost * 3;
    const before = state.empires[0]!.spies.count;
    const after = advance(state);
    expect(after.empires[0]!.spies.count).toBeGreaterThanOrEqual(before + 3);
    expect(after.colonies.find((x) => x.id === colony.id)!.queue[0]?.item).toBe('spy');
  });
});
