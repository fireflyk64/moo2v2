// Captured colonists (bug: "how do we distinguish them"): pop groups keep
// their original race; set_jobs updates one group WITHOUT touching the
// others, and the colony row exposes the per-race breakdown the UI renders.

import { describe, expect, it } from 'vitest';
import { gameEngine, selectors } from '@engine/index';
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
      { id: 1, name: 'B', raceJson: JSON.stringify({ raceName: 'The Captured', picks: ['dictatorship'] }) },
    ],
    dataVersion: 'test',
  });
}

/** graft a captured group of race 1 onto player 0's home colony */
function withCaptives(state: GameState) {
  const home = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
  home.groups.push({ race: 1, popK: 2000, farmers: 0, workers: 2, scientists: 0, unrest: true });
  home.groups.sort((a, b) => a.race - b.race);
  return home;
}

describe('multi-race colonies (captured colonists)', () => {
  it('set_jobs for one race leaves the other groups untouched', () => {
    const state = newGame();
    const home = withCaptives(state);
    const own = home.groups.find((g) => g.race === 0)!;
    const ownUnits = Math.floor(own.popK / 1000);
    const c = {
      turn: state.turn,
      playerId: 0,
      kind: 'set_jobs',
      payload: { colonyId: home.id, groups: [{ race: 0, farmers: 0, workers: 0, scientists: ownUnits }] },
    };
    expect(validateCommand(state, c)).toBeNull();
    applyCommand(state, c);
    expect(home.groups.find((g) => g.race === 0)!.scientists).toBe(ownUnits);
    const captured = home.groups.find((g) => g.race === 1)!;
    expect(captured.workers).toBe(2); // untouched
    expect(captured.unrest).toBe(true);
  });

  it('a captured group can be re-jobbed on its own', () => {
    const state = newGame();
    const home = withCaptives(state);
    const c = {
      turn: state.turn,
      playerId: 0,
      kind: 'set_jobs',
      payload: { colonyId: home.id, groups: [{ race: 1, farmers: 2, workers: 0, scientists: 0 }] },
    };
    expect(validateCommand(state, c)).toBeNull();
    applyCommand(state, c);
    expect(home.groups.find((g) => g.race === 1)!.farmers).toBe(2);
  });

  it('the colony row exposes per-race groups with names and unrest', () => {
    const state = newGame();
    const home = withCaptives(state);
    const row = selectors.colonyRow(state, home);
    expect(row.groups.length).toBe(2);
    const captured = row.groups.find((g) => g.race === 1)!;
    expect(captured.raceName).toBe('The Captured');
    expect(captured.units).toBe(2);
    expect(captured.unrest).toBe(true);
    // the summed jobs still add up across races
    expect(row.jobs.farmers + row.jobs.workers + row.jobs.scientists).toBe(row.popUnits);
  });

  it('captured colonists can be freighter-shuttled within the system as their own race', () => {
    const state = newGame();
    const home = withCaptives(state);
    const homeStar = state.planets.find((p) => p.id === home.planetId)!.starId;
    const sibling = state.planets.find((p) => p.starId === homeStar && p.id !== home.planetId && p.body === 'planet')!;
    state.colonies.push({
      ...structuredClone(home),
      id: state.nextId++,
      planetId: sibling.id,
      name: 'Second',
      groups: [{ race: 0, popK: 2000, farmers: 0, workers: 2, scientists: 0, unrest: false }],
    });
    const second = state.colonies[state.colonies.length - 1]!;
    const c = {
      turn: state.turn,
      playerId: 0,
      kind: 'move_colonists',
      payload: { fromColonyId: home.id, toColonyId: second.id, race: 1, count: 1 },
    };
    expect(validateCommand(state, c)).toBeNull();
    applyCommand(state, c);
    expect(second.groups.find((g) => g.race === 1)?.popK).toBe(1000);
  });
});
