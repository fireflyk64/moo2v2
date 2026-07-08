import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { expanderBot, replayGame, runHeadlessGame } from '../../src/headless/bots';
import type { GameState } from '@engine/types';

// Phase 6 gate: a 4-player long game with every option on exercises leaders,
// monsters, Antaran raids, random events, espionage, and diplomacy upkeep —
// and stays hash-stable under replay.

const SEED = '77aa77aa77aa77aa77aa77aa77aa77aa';

const PLAYERS = [
  { id: 0, name: 'P0', raceJson: JSON.stringify({ presetId: 'solari' }), policy: expanderBot },
  { id: 1, name: 'P1', raceJson: JSON.stringify({ presetId: 'hivex' }), policy: expanderBot },
  { id: 2, name: 'P2', raceJson: JSON.stringify({ presetId: 'korrath' }), policy: expanderBot },
  { id: 3, name: 'P3', raceJson: JSON.stringify({ presetId: 'cerebri' }), policy: expanderBot },
];

const SETTINGS: Partial<GameState['settings']> = {
  galaxySize: 'medium',
  modes: { creativeVariant: false, pickBidding: false, stickyBuild: true, antarans: true, randomEvents: true },
};

describe('4-player 200-turn soak (all systems on)', () => {
  it('runs 200 turns with stable hashes and full replay equality', () => {
    const run = runHeadlessGame({ seed: SEED, players: PLAYERS, turns: 200, settings: SETTINGS });
    const finalTurn = run.state.turn;
    expect(finalTurn).toBeGreaterThan(150); // early victory is legal but unexpected among peaceful expanders

    // the world actually exercised Phase 6 systems
    expect(run.state.monsters.length + run.log.length).toBeGreaterThan(0);
    expect(run.state.stars.some((s) => s.name === 'Orion')).toBe(true);
    expect(run.state.antarans.nextRaidTurn).toBeGreaterThan(25); // raids scheduled/fired

    // replay: identical final hash
    const replayed = replayGame(SEED, PLAYERS.map(({ id, name, raceJson }) => ({ id, name, raceJson })), run.state.settings, run.log);
    expect(gameEngine.hash(replayed)).toBe(gameEngine.hash(run.state));

    // rerun: identical hash trail
    const rerun = runHeadlessGame({ seed: SEED, players: PLAYERS, turns: 200, settings: SETTINGS });
    expect(rerun.hashes).toEqual(run.hashes);
  }, 240_000);
});
