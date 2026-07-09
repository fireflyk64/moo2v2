import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { OFFER_TTL } from '@engine/leaders';
import type { GameState, TurnEvent } from '@engine/types';

const SEEDS = [
  'aaaabbbbccccddddeeeeffff00001111',
  '0123456789abcdef0123456789abcdef',
  'deadbeefdeadbeefdeadbeefdeadbeef',
] as const;

function newGame(seed: string): GameState {
  return gameEngine.init({
    seed,
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

describe('leader offers actually happen (bug: leaders were never encountered)', () => {
  it('every empire sees colony AND ship leader offers within 80 turns', () => {
    for (const seed of SEEDS) {
      let state = newGame(seed);
      const offers = new Map<number, Set<string>>([[0, new Set()], [1, new Set()]]);
      for (let t = 0; t < 80; t++) {
        state = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
        if (state.phase === 'battle_orders') {
          state = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
        }
        const events = gameEngine.takeEvents() as TurnEvent[];
        for (const e of events) {
          if (e.kind === 'leader_offer') {
            offers.get(e.visibleTo)?.add(String(e.payload['kind']));
          }
        }
      }
      for (const [empireId, kinds] of offers) {
        expect(kinds.size, `seed ${seed} empire ${empireId} saw offer kinds: ${[...kinds].join(',') || 'none'}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('offers stay on the table for the advertised TTL', () => {
    expect(OFFER_TTL).toBeGreaterThanOrEqual(8);
  });
});
