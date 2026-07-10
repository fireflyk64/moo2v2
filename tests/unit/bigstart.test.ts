// Big-empire start option: every player begins with 10-20 colonies in a
// coherent bubble around the homeworld, each 1/3-1/2 populated.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { colonyMaxPop } from '@engine/economy';
import { starDistance } from '@engine/galaxy';
import type { GameState, GameStateSettings } from '@engine/types';

const SEEDS = ['aaaabbbbccccddddeeeeffff00001111', 'deadbeefdeadbeefdeadbeefdeadbeef', 'cafef00dcafef00dcafef00dcafef00d'];

function game(seed: string, bigStart: boolean, players = 2): GameState {
  const settings: GameStateSettings = {
    galaxySize: 'large',
    startMode: 'average',
    playerCount: players,
    modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
    battleOrdersTimeoutMs: 1000,
    debugCommands: false,
    bigStart,
  };
  return gameEngine.init({
    seed,
    settings,
    players: Array.from({ length: players }, (_, i) => ({
      id: i,
      name: `P${i}`,
      raceJson: JSON.stringify({ presetId: 'solari' }),
    })),
    dataVersion: 'test',
  });
}

describe('big-empire start', () => {
  it('off by default: one homeworld each', () => {
    const state = game(SEEDS[0]!, false);
    for (const e of state.empires) {
      expect(state.colonies.filter((c) => c.owner === e.id && !c.outpost).length).toBe(1);
    }
  });

  it('gives every player 10-20 colonies, 1/3-1/2 full, in a contiguous bubble', () => {
    for (const seed of SEEDS) {
      const state = game(seed, true);
      for (const e of state.empires) {
        const mine = state.colonies.filter((c) => c.owner === e.id && !c.outpost);
        expect(mine.length, `${seed} empire ${e.id} colony count`).toBeGreaterThanOrEqual(10);
        expect(mine.length).toBeLessThanOrEqual(20);

        // population band: each colony 1/3..1/2 of capacity (the homeworld,
        // seeded at 8, is exempt)
        const homeStar = state.planets.find((p) => p.id === mine.find((c) => c.name && state.planets.find((pp) => pp.id === c.planetId)?.homeworldOf === e.id)?.planetId);
        for (const c of mine) {
          const planet = state.planets.find((p) => p.id === c.planetId)!;
          if (planet.homeworldOf === e.id) continue; // homeworld
          const units = c.groups.reduce((n, g) => n + Math.floor(g.popK / 1000), 0);
          const cap = colonyMaxPop(state, c);
          expect(units).toBeGreaterThanOrEqual(Math.max(1, Math.floor(cap / 3) - 1));
          expect(units).toBeLessThanOrEqual(Math.ceil(cap / 2) + 1);
        }
        void homeStar;
      }

      // contiguity/coherence: every colony is closer to its OWN home than to
      // any rival home (non-overlapping bubbles)
      const homeStarOf = new Map<number, number>();
      for (const c of state.colonies) {
        const planet = state.planets.find((p) => p.id === c.planetId)!;
        if (planet.homeworldOf !== null) homeStarOf.set(c.owner, planet.starId);
      }
      for (const c of state.colonies) {
        if (c.outpost) continue;
        const star = state.stars.find((s) => s.id === state.planets.find((p) => p.id === c.planetId)!.starId)!;
        const ownHome = state.stars.find((s) => s.id === homeStarOf.get(c.owner))!;
        const ownD = starDistance(ownHome, star);
        for (const [owner, hs] of homeStarOf) {
          if (owner === c.owner) continue;
          const rivalHome = state.stars.find((s) => s.id === hs)!;
          expect(starDistance(rivalHome, star)).toBeGreaterThanOrEqual(ownD);
        }
      }
    }
  });

  it('never seizes a monster-guarded system', () => {
    const state = game(SEEDS[1]!, true);
    const guarded = new Set(state.monsters.map((m) => m.starId));
    for (const c of state.colonies) {
      const starId = state.planets.find((p) => p.id === c.planetId)!.starId;
      expect(guarded.has(starId)).toBe(false);
    }
  });
});
