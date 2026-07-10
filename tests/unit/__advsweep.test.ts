import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/adapter';
import { advanceTurn } from '@engine/pipeline';
import { STAR_COUNTS } from '@engine/galaxy';
import type { GameState, GameStateSettings } from '@engine/types';

function mk(seed: string, size: GameStateSettings['galaxySize'], races: [string, string]): GameState {
  return gameEngine.init({
    seed,
    settings: { galaxySize: size, startMode: 'advanced', playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
      battleOrdersTimeoutMs: 1000, debugCommands: false },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: races[0] }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: races[1] }) },
    ],
    dataVersion: 'test',
  });
}
const SEEDS = ['0123456789abcdef0123456789abcdef','deadbeefdeadbeefdeadbeefdeadbeef','cafef00dcafef00dcafef00dcafef00d','11111111222222223333333344444444','fedcba9876543210fedcba9876543210','5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a'];
const RACES: Array<[string, string]> = [['solari','solari'],['hivex','lithor'],['cerebri','tidari'],['sauren','korrath']];
describe('advanced start sweep', () => {
  it('starves nobody and stays balanced across seeds/sizes/races', () => {
    const sizes: GameStateSettings['galaxySize'][] = ['small','medium','large','huge'];
    for (const size of sizes) for (const seed of SEEDS) {
      const races = RACES[(seed.charCodeAt(0) + size.length) % RACES.length]!;
      const s = mk(seed, size, races);
      const stars0 = new Set(s.colonies.filter(c=>c.owner===0).map(c=>s.planets.find(p=>p.id===c.planetId)!.starId));
      const stars1 = new Set(s.colonies.filter(c=>c.owner===1).map(c=>s.planets.find(p=>p.id===c.planetId)!.starId));
      expect(stars0.size, `${size}/${seed.slice(0,8)} region size equal`).toBe(stars1.size);
      for (const id of stars0) expect(stars1.has(id)).toBe(false);
      const total = stars0.size + stars1.size;
      expect(total, `${size}/${seed.slice(0,8)} coverage`).toBeGreaterThanOrEqual(Math.floor(STAR_COUNTS[size]*0.2));
      expect(total).toBeLessThanOrEqual(Math.ceil(STAR_COUNTS[size]*0.45));
      for (const owner of [0,1]) expect(s.ships.filter(x=>x.owner===owner&&x.shipKind==='scout').length, 'scouts').toBe(5);
      for (const m of s.monsters) { expect(stars0.has(m.starId)).toBe(false); expect(stars1.has(m.starId)).toBe(false); }
      const { events } = advanceTurn(s);
      const starv = events.filter(e=>e.kind==='starvation');
      expect(starv, `${size}/${seed.slice(0,8)} ${races} starvation`).toHaveLength(0);
    }
  }, 120_000);
});
