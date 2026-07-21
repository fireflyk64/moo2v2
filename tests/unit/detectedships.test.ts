import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import * as selectors from '@engine/selectors';
import type { GameState, Ship } from '@engine/types';

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

function homeStarId(state: GameState, empireId: number): number {
  const home = state.colonies.find((c) => c.owner === empireId)!;
  return state.planets.find((p) => p.id === home.planetId)!.starId;
}

/** the count the map actually draws: foreign ships across galaxyView */
function mapCount(state: GameState, empireId: number): number {
  let n = 0;
  for (const sv of selectors.galaxyView(state, empireId))
    for (const sh of sv.ships) if (sh.owner !== empireId && sh.owner >= 0) n++;
  return n;
}

function spawnAt(state: GameState, owner: number, starId: number): Ship {
  const ship: Ship = {
    id: 900001 + state.ships.length,
    owner,
    shipKind: 'scout',
    designId: null,
    location: { kind: 'star', starId },
    cargoPopUnits: 0,
    cargoRace: 0,
    dmgStructure: 0,
    dmgArmor: 0,
  };
  state.ships.push(ship);
  return ship;
}

describe('detectedEnemyShips (scanner threat count)', () => {
  it('always matches what galaxyView shows on the map', () => {
    const state = newGame();
    for (const id of [0, 1]) {
      expect(selectors.detectedEnemyShips(state, id)).toBe(mapCount(state, id));
    }
  });

  it('counts an enemy ship parked at a known star, and matches the map', () => {
    const state = newGame();
    const before = selectors.detectedEnemyShips(state, 0);
    spawnAt(state, 1, homeStarId(state, 0)); // enemy scout over the capital
    expect(selectors.detectedEnemyShips(state, 0)).toBe(before + 1);
    expect(selectors.detectedEnemyShips(state, 0)).toBe(mapCount(state, 0));
  });

  it('ignores own ships, NPC (negative-owner) ships, and ships in transit', () => {
    const state = newGame();
    const home = homeStarId(state, 0);
    const before = selectors.detectedEnemyShips(state, 0);
    spawnAt(state, 0, home); // own ship: not an enemy
    spawnAt(state, -2, home); // monster: lives outside empire threat count
    const transit = spawnAt(state, 1, home);
    transit.location = { kind: 'transit', from: home, to: home, departedTurn: 0, arrivalTurn: 1 };
    expect(selectors.detectedEnemyShips(state, 0)).toBe(before);
  });

  it('does not count enemy ships at stars that are neither explored nor scanned', () => {
    const state = newGame();
    const empire = state.empires.find((e) => e.id === 0)!;
    const scanned = selectors.scannedStars(state, 0);
    const explored = new Set(empire.exploredStars);
    const hidden = state.stars.find((s) => !scanned.has(s.id) && !explored.has(s.id));
    // a small map may be fully covered; only assert when a hidden star exists
    if (hidden) {
      const before = selectors.detectedEnemyShips(state, 0);
      spawnAt(state, 1, hidden.id);
      expect(selectors.detectedEnemyShips(state, 0)).toBe(before);
    }
  });
});
