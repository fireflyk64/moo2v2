import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { gzip } from '@storage/gzip';
import { expanderBot, runHeadlessGame } from '../../src/headless/bots';
import type { GameState } from '@engine/types';

// Phase 8 budgets: an 8-player, large-galaxy late game must advance a turn in
// well under 2 s, and its gzipped snapshot must stay far below the 8 MiB
// transport ceiling (lobbylink reliable cap is 16 MiB; we chunk above 8).

const SEED = 'cafef00dcafef00dcafef00dcafef00d';
const PRESETS = ['solari', 'hivex', 'korrath', 'cerebri', 'skyshear', 'urgok', 'lumini', 'ferron'];

describe('performance + size budgets', () => {
  it('8-player 100-turn late game: turn < 2s, gzip snapshot < 8 MiB', async () => {
    const players = PRESETS.map((presetId, i) => ({
      id: i,
      name: `P${i}`,
      raceJson: JSON.stringify({ presetId }),
      policy: expanderBot,
    }));
    const settings: Partial<GameState['settings']> = {
      galaxySize: 'large',
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: true, randomEvents: true },
    };
    const run = runHeadlessGame({ seed: SEED, players, turns: 100, settings, stopOnVictory: false });
    expect(run.state.turn).toBeGreaterThan(95);
    expect(run.state.colonies.length).toBeGreaterThan(8); // empires actually expanded

    // turn-advance budget on the late-game state
    const t0 = performance.now();
    gameEngine.apply(run.state, { turn: run.state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
    gameEngine.takeEvents();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);

    // snapshot budget
    const json = gameEngine.serialize(run.state);
    const zipped = await gzip(new TextEncoder().encode(json));
    expect(zipped.length).toBeLessThan(8 * 1024 * 1024);
    // eslint-disable-next-line no-console
    console.info(`[budget] turn=${elapsed.toFixed(1)}ms snapshot=${(zipped.length / 1024).toFixed(0)}KiB raw=${(json.length / 1024).toFixed(0)}KiB colonies=${run.state.colonies.length}`);
  }, 300_000);
});
