import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { generateGalaxy, starDistance, HOP_RANGE_CP } from '@engine/galaxy';
import { resolveTraits } from '@engine/race';
import { racePresetById } from '@engine/data/index';
import type { GameState, GameStateSettings, Planet, Star } from '@engine/types';

const SEEDS = [
  'aaaabbbbccccddddeeeeffff00001111',
  '0123456789abcdef0123456789abcdef',
  'deadbeefdeadbeefdeadbeefdeadbeef',
  'cafef00dcafef00dcafef00dcafef00d',
  '11112222333344445555666677778888',
] as const;

function settingsOf(partial: Partial<GameStateSettings>): GameStateSettings {
  return {
    galaxySize: 'medium',
    startMode: 'average',
    playerCount: 2,
    modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
    battleOrdersTimeoutMs: 1000,
    debugCommands: false,
    ...partial,
  };
}

function traitsFor(n: number) {
  const solari = resolveTraits([...racePresetById.get('solari')!.picks]);
  return Array.from({ length: n }, () => solari);
}

/** all home stars must sit in one component of the <=400cp hop graph over
 * systems that hold at least one body (colonizable/outpostable) */
function homesConnected(stars: Star[], planets: Planet[], homeStars: Star[]): boolean {
  const nodes = stars.filter((s) => planets.some((p) => p.starId === s.id));
  const idx = new Map(nodes.map((s, i) => [s.id, i]));
  const seen = new Set<number>([homeStars[0]!.id]);
  const queue = [homeStars[0]!];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const n of nodes) {
      if (seen.has(n.id)) continue;
      if (starDistance(cur, n) <= HOP_RANGE_CP) {
        seen.add(n.id);
        queue.push(n);
      }
    }
  }
  void idx;
  return homeStars.every((h) => seen.has(h.id));
}

function homeStarsOf(g: ReturnType<typeof generateGalaxy>): Star[] {
  return g.homePlanets.map((pid) => {
    const p = g.planets.find((x) => x.id === pid)!;
    return g.stars.find((s) => s.id === p.starId)!;
  });
}

describe('galaxy connectivity guarantee (bug: path between all players at range 4)', () => {
  for (const size of ['small', 'medium', 'large', 'huge'] as const) {
    it(`${size}: every seed connects all homes with <=400cp hops`, () => {
      for (const seed of SEEDS) {
        for (const players of [2, 3, 4]) {
          const g = generateGalaxy(seed, settingsOf({ galaxySize: size, playerCount: players }), traitsFor(players));
          expect(homesConnected(g.stars, g.planets, homeStarsOf(g))).toBe(true);
        }
      }
    });
  }

  it('bridge stars are marked sym=-1 and always hold at least one body', () => {
    for (const seed of SEEDS) {
      const g = generateGalaxy(seed, settingsOf({ galaxySize: 'huge', playerCount: 4 }), traitsFor(4));
      for (const s of g.stars.filter((x) => x.sym === -1)) {
        expect(g.planets.some((p) => p.starId === s.id)).toBe(true);
      }
    }
  });

  it('no size-1 planets, and home systems never carry a wormhole', () => {
    for (const seed of SEEDS) {
      for (const players of [2, 4] as const) {
        const g = generateGalaxy(seed, settingsOf({ galaxySize: 'large', playerCount: players }), traitsFor(players));
        for (const p of g.planets) {
          if (p.body === 'planet') expect(p.sizeClass).toBeGreaterThanOrEqual(2);
        }
        const homeStarIds = new Set(g.homePlanets.map((pid) => g.planets.find((p) => p.id === pid)!.starId));
        for (const s of g.stars) {
          if (homeStarIds.has(s.id)) expect(s.wormholeTo).toBeNull();
        }
      }
    }
  });

  it('empty systems are rare (a visited star usually offers something)', () => {
    let stars = 0;
    let empty = 0;
    for (const seed of SEEDS) {
      const g = generateGalaxy(seed, settingsOf({ galaxySize: 'large', playerCount: 2 }), traitsFor(2));
      for (const s of g.stars) {
        stars++;
        if (!g.planets.some((p) => p.starId === s.id)) empty++;
      }
    }
    expect(empty / stars).toBeLessThan(0.15);
  });

  it('prize systems (ultra-rich / gaia / specials) are guarded far more often than plain ones', () => {
    let prizeGuarded = 0;
    let prizeTotal = 0;
    let plainGuarded = 0;
    let plainTotal = 0;
    for (const seed of SEEDS) {
      const state: GameState = gameEngine.init({
        seed,
        settings: settingsOf({ galaxySize: 'huge', playerCount: 2 }),
        players: [
          { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
          { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
        ],
        dataVersion: 'test',
      });
      const homeStarIds = new Set(state.colonies.map((c) => state.planets.find((p) => p.id === c.planetId)!.starId));
      const guarded = new Set(state.monsters.map((m) => m.starId));
      for (const s of state.stars) {
        if (homeStarIds.has(s.id) || s.name === 'Orion') continue;
        if (!state.planets.some((p) => p.starId === s.id && p.body === 'planet')) continue;
        const prize = state.planets.some(
          (p) =>
            p.starId === s.id &&
            p.body === 'planet' &&
            (p.minerals === 'ultra_rich' || p.climate === 'gaia' || p.climate === 'terran' || p.special !== null),
        );
        if (prize) {
          prizeTotal++;
          if (guarded.has(s.id)) prizeGuarded++;
        } else {
          plainTotal++;
          if (guarded.has(s.id)) plainGuarded++;
        }
      }
    }
    expect(prizeTotal).toBeGreaterThan(10);
    expect(prizeGuarded / prizeTotal).toBeGreaterThan(0.35);
    expect(plainGuarded / Math.max(1, plainTotal)).toBeLessThan(0.2);
  });
});

describe('home-system parity (bug: same other planets for all players)', () => {
  it("good start: exactly one sibling, ultra-rich, identical across players", () => {
    for (const seed of SEEDS) {
      const g = generateGalaxy(seed, settingsOf({ homeStart: 'good' }), traitsFor(2));
      const homes = homeStarsOf(g);
      for (const [i, star] of homes.entries()) {
        const sys = g.planets.filter((p) => p.starId === star.id);
        expect(sys).toHaveLength(2);
        const sibling = sys.find((p) => p.homeworldOf === null)!;
        expect(sibling.minerals).toBe('ultra_rich');
        expect(sibling.body).toBe('planet');
        expect(sibling.sizeClass).toBe(3);
        void i;
      }
      // both siblings identical (minus ids/starId)
      const sibs = homes.map((star) => {
        const { id, starId, ...rest } = g.planets.find((p) => p.starId === star.id && p.homeworldOf === null)!;
        void id;
        void starId;
        return rest;
      });
      expect(sibs[0]).toEqual(sibs[1]);
    }
  });

  it('min start: the sibling is abundant instead', () => {
    const g = generateGalaxy(SEEDS[0], settingsOf({ homeStart: 'min' }), traitsFor(2));
    for (const star of homeStarsOf(g)) {
      const sibling = g.planets.find((p) => p.starId === star.id && p.homeworldOf === null)!;
      expect(sibling.minerals).toBe('abundant');
    }
  });
});

describe('mirror mode (bug: replicated rotated starts, players on the edge)', () => {
  for (const players of [2, 3, 4] as const) {
    it(`${players} players: identical wedges up to rotation`, () => {
      const g = generateGalaxy(SEEDS[0], settingsOf({ mirror: true, playerCount: players }), traitsFor(players));
      const homes = homeStarsOf(g);
      expect(homes).toHaveLength(players);

      // hub exists at the exact center
      const hub = g.stars.find((s) => s.sym === 0)!;
      expect(hub).toBeDefined();

      // every home is equidistant from the hub (edge ring) up to rounding
      const dists = homes.map((h) => starDistance(h, hub));
      for (const d of dists) expect(Math.abs(d - dists[0]!)).toBeLessThanOrEqual(2);

      // every symmetry group has one copy per player with identical color and
      // identical planet rosters
      const groups = new Map<number, Star[]>();
      for (const s of g.stars) {
        if ((s.sym ?? -2) >= 1) groups.set(s.sym!, [...(groups.get(s.sym!) ?? []), s]);
      }
      for (const [sym, members] of groups) {
        expect(members, `group ${sym}`).toHaveLength(players);
        const colors = new Set(members.map((m) => m.color));
        expect(colors.size).toBe(1);
        const rosters = members.map((m) =>
          g.planets
            .filter((p) => p.starId === m.id)
            .map(({ id, starId, homeworldOf, ...rest }) => {
              void id;
              void starId;
              void homeworldOf;
              return JSON.stringify(rest);
            })
            .sort(),
        );
        for (const r of rosters) expect(r).toEqual(rosters[0]);
      }

      // connectivity holds in mirror mode too (hub excluded: it becomes Orion)
      const nonHub = g.stars.filter((s) => s.id !== hub.id);
      expect(homesConnected(nonHub, g.planets, homes)).toBe(true);
    });
  }

  it('a full mirrored game seeds Orion on the hub and symmetric keepers', () => {
    const state: GameState = gameEngine.init({
      seed: SEEDS[1],
      settings: settingsOf({ mirror: true, playerCount: 2, modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: true, randomEvents: false } }),
      players: [
        { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
        { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
      ],
      dataVersion: 'test',
    });
    const hub = state.stars.find((s) => s.sym === 0)!;
    expect(hub.name).toBe('Orion');
    expect(state.monsters.some((m) => m.kind === 'guardian' && m.starId === hub.id)).toBe(true);
    // non-guardian keepers appear symmetrically: same kinds per symmetry group
    const bySym = new Map<number, string[]>();
    for (const m of state.monsters) {
      if (m.kind === 'guardian') continue;
      const star = state.stars.find((s) => s.id === m.starId)!;
      expect(star.sym).toBeGreaterThanOrEqual(2); // never homes, bridges, or hub
      bySym.set(star.sym!, [...(bySym.get(star.sym!) ?? []), m.kind]);
    }
    for (const [, kinds] of bySym) {
      expect(kinds).toHaveLength(2); // one per player copy
      expect(new Set(kinds).size).toBe(1); // identical kind
    }
  });
});
