// Advanced-start property sweep: across seeds, galaxy sizes and race pairs
// the generator must always produce equal disjoint regions (~1/3 of the map
// in total), five scouts each, keeper-free starting space, and an empire that
// feeds itself from turn one (workers→farmers balancing + pre-built
// hydroponics + a covering freighter pool).

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/adapter';
import { advanceTurn } from '@engine/pipeline';
import { STAR_COUNTS } from '@engine/galaxy';
import { empireContactPairs } from '@engine/selectors';
import type { GameState, GameStateSettings } from '@engine/types';

function mk(seed: string, size: GameStateSettings['galaxySize'], races: [string, string]): GameState {
  return gameEngine.init({
    seed,
    settings: {
      galaxySize: size,
      startMode: 'advanced',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands: false,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: races[0] }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: races[1] }) },
    ],
    dataVersion: 'test',
  });
}

const SEEDS = [
  '0123456789abcdef0123456789abcdef',
  'deadbeefdeadbeefdeadbeefdeadbeef',
  'cafef00dcafef00dcafef00dcafef00d',
  '11111111222222223333333344444444',
  'fedcba9876543210fedcba9876543210',
  '5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a',
];
const RACES: Array<[string, string]> = [
  ['solari', 'solari'],
  ['hivex', 'lithor'],
  ['cerebri', 'tidari'],
  ['sauren', 'korrath'],
];

describe('advanced start sweep', () => {
  it('equal disjoint fed regions across seeds, sizes and races', () => {
    const sizes: GameStateSettings['galaxySize'][] = ['small', 'medium', 'large', 'huge'];
    for (const size of sizes) {
      for (const seed of SEEDS) {
        const races = RACES[(seed.charCodeAt(0) + size.length) % RACES.length]!;
        const tag = `${size}/${seed.slice(0, 8)}/${races.join('+')}`;
        const s = mk(seed, size, races);
        const starsOf = (owner: number) =>
          new Set(s.colonies.filter((c) => c.owner === owner).map((c) => s.planets.find((p) => p.id === c.planetId)!.starId));
        const r0 = starsOf(0);
        const r1 = starsOf(1);
        expect(r0.size, `${tag} equal regions`).toBe(r1.size);
        for (const id of r0) expect(r1.has(id), `${tag} disjoint`).toBe(false);
        const total = r0.size + r1.size;
        expect(total, `${tag} coverage low`).toBeGreaterThanOrEqual(Math.floor(STAR_COUNTS[size] * 0.2));
        expect(total, `${tag} coverage high`).toBeLessThanOrEqual(Math.ceil(STAR_COUNTS[size] * 0.45));
        for (const owner of [0, 1]) {
          expect(s.ships.filter((x) => x.owner === owner && x.shipKind === 'scout'), `${tag} scouts`).toHaveLength(5);
        }
        for (const m of s.monsters) {
          expect(r0.has(m.starId) || r1.has(m.starId), `${tag} keeper inside a region`).toBe(false);
        }
        // fast start relies on this: developed neighbours must still be strangers
        expect(empireContactPairs(s), `${tag} no initial contact`).toHaveLength(0);
        const { events } = advanceTurn(s);
        expect(events.filter((e) => e.kind === 'starvation'), `${tag} starvation`).toHaveLength(0);
      }
    }
  }, 120_000);
});
