import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
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

describe('overflow production survives an empty queue (bug: saved prod lost)', () => {
  it('keeps completion overflow across idle turns, evaporates idle earnings', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    const cost = itemCost(state, 0, 'spy', colony)!;
    colony.queue = [{ item: 'spy' }];
    colony.storedProd = cost - 1; // completes this turn; the rest overflows
    const t1 = advance(state);
    const c1 = t1.colonies.find((x) => x.id === colony.id)!;
    expect(c1.queue).toHaveLength(0);
    const overflow = c1.storedProd;
    expect(overflow).toBeGreaterThan(0); // colony out-produces the 1 missing point

    // a full turn with the queue empty: the overflow stays, but nothing new banks
    const t2 = advance(t1);
    const c2 = t2.colonies.find((x) => x.id === colony.id)!;
    expect(c2.storedProd).toBe(overflow);

    // and it is spendable on the next thing queued
    const queued = gameEngine.apply(t2, {
      turn: t2.turn,
      playerId: 0,
      kind: 'set_build_queue',
      payload: { colonyId: colony.id, items: ['spy'] },
    });
    const spiesBefore = queued.empires[0]!.spies.count;
    const t3 = advance(queued);
    const c3 = t3.colonies.find((x) => x.id === colony.id)!;
    if (t3.empires[0]!.spies.count === spiesBefore) {
      // not done yet: the banked overflow plus this turn's output all count
      expect(c3.storedProd).toBeGreaterThan(overflow);
    } else {
      // done: the overflow paid part of the bill
      expect(c3.storedProd).toBeGreaterThanOrEqual(0);
    }
  });

  it('still evaporates production on a colony idle from the start of turn', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    colony.queue = [];
    colony.storedProd = 0;
    const t1 = advance(state);
    const c1 = t1.colonies.find((x) => x.id === colony.id)!;
    expect(c1.storedProd).toBe(0); // never-queued colony banks nothing
  });
});
