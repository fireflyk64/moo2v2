import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { generateGalaxy, starDistance, MAP_SIZE } from '@engine/galaxy';
import { validateCommand } from '@engine/commands';
import { resolveTraits } from '@engine/race';
import { racePresetById } from '@engine/data/index';
import type { GameState, GameStateSettings } from '@engine/types';

const SEEDS = [
  'aaaabbbbccccddddeeeeffff00001111',
  '0123456789abcdef0123456789abcdef',
  'deadbeefdeadbeefdeadbeefdeadbeef',
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

function newGame(coreWorlds: 'central' | 'random', playerCount = 2): GameState {
  return gameEngine.init({
    seed: SEEDS[0],
    settings: settingsOf({ galaxySize: 'small', playerCount, coreWorlds, debugCommands: true }),
    players: Array.from({ length: playerCount }, (_, i) => ({
      id: i,
      name: `P${i}`,
      raceJson: JSON.stringify({ presetId: 'solari' }),
    })),
    dataVersion: 'test',
  });
}

function advance(state: GameState): GameState {
  const next = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
  if (next.phase === 'battle_orders') {
    return gameEngine.apply(next, { turn: next.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
  }
  return next;
}

describe('core worlds generation', () => {
  for (const mode of ['central', 'random'] as const) {
    for (const seed of SEEDS) {
      it(`${mode} @${seed.slice(0, 8)}: players+2 green stars, each with a designated real world`, () => {
        for (const players of [2, 4, 8]) {
          const g = generateGalaxy(seed, settingsOf({ coreWorlds: mode, playerCount: players }), traitsFor(players));
          const greens = g.stars.filter((s) => s.color === 'green');
          expect(greens.length).toBe(players + 2);
          expect(g.coreWorlds?.length).toBe(players + 2);
          // one designated world per green star, and it is a real planet there
          const starOfWorld = new Set<number>();
          for (const pid of g.coreWorlds!) {
            const p = g.planets.find((x) => x.id === pid)!;
            expect(p.body).toBe('planet');
            expect(g.stars.find((s) => s.id === p.starId)!.color).toBe('green');
            starOfWorld.add(p.starId);
          }
          expect(starOfWorld.size).toBe(players + 2);
          // green is exclusive to core stars, and they never host homes/wormholes
          for (const s of greens) {
            expect(s.wormholeTo).toBeNull();
            expect(g.planets.some((p) => p.starId === s.id && p.homeworldOf !== null)).toBe(false);
          }
        }
      });
    }
  }

  it('central mode rings the stars around the exact map center', () => {
    for (const seed of SEEDS) {
      const settings = settingsOf({ coreWorlds: 'central', playerCount: 4 });
      const g = generateGalaxy(seed, settings, traitsFor(4));
      const { w, h } = MAP_SIZE[settings.galaxySize];
      const c = { x: w >> 1, y: h >> 1 };
      const radii = g.stars.filter((s) => s.color === 'green').map((s) => starDistance(s, c));
      const mean = Math.round(radii.reduce((a, b) => a + b, 0) / radii.length);
      for (const r of radii) expect(Math.abs(r - mean)).toBeLessThanOrEqual(2); // fixed-point rounding
      expect(mean).toBeGreaterThan(150);
    }
  });

  it('random mode scatters them (not all near the center) with minimum separation', () => {
    for (const seed of SEEDS) {
      const settings = settingsOf({ coreWorlds: 'random', playerCount: 4 });
      const g = generateGalaxy(seed, settings, traitsFor(4));
      const greens = g.stars.filter((s) => s.color === 'green');
      for (let i = 0; i < greens.length; i++) {
        for (let j = i + 1; j < greens.length; j++) {
          expect(starDistance(greens[i]!, greens[j]!)).toBeGreaterThanOrEqual(150);
        }
      }
      const { w, h } = MAP_SIZE[settings.galaxySize];
      const c = { x: w >> 1, y: h >> 1 };
      const ringRadius = Math.min(c.x, c.y) / 3;
      // a scatter should not accidentally be the central ring
      expect(greens.some((s) => Math.abs(starDistance(s, c) - ringRadius) > 60)).toBe(true);
    }
  });

  it('variant off: no green stars, no designated worlds, mirror still honored', () => {
    const g = generateGalaxy(SEEDS[0], settingsOf({}), traitsFor(2));
    expect(g.stars.some((s) => s.color === 'green')).toBe(false);
    expect(g.coreWorlds).toBeUndefined();
    const m = generateGalaxy(SEEDS[0], settingsOf({ mirror: true }), traitsFor(2));
    expect(m.stars.some((s) => s.sym === 0)).toBe(true); // mirror hub exists
  });

  it('core worlds supersede mirror and never draw keepers or Orion', () => {
    const state = gameEngine.init({
      seed: SEEDS[1],
      settings: settingsOf({ coreWorlds: 'central', mirror: true, playerCount: 2 }),
      players: [
        { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
        { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
      ],
      dataVersion: 'test',
    });
    expect(state.stars.filter((s) => s.color === 'green').length).toBe(4);
    expect(state.stars.some((s) => s.sym === 0)).toBe(false); // no mirror hub
    const greenIds = new Set(state.stars.filter((s) => s.color === 'green').map((s) => s.id));
    for (const m of state.monsters) expect(greenIds.has(m.starId)).toBe(false);
    expect(state.stars.find((s) => s.name === 'Orion' && greenIds.has(s.id))).toBeUndefined();
  });

  it('advanced and big starts never pre-settle a core world', () => {
    for (const startMode of ['advanced', 'average'] as const) {
      const state = gameEngine.init({
        seed: SEEDS[2],
        settings: settingsOf({
          coreWorlds: 'random',
          startMode,
          ...(startMode === 'average' ? { bigStart: true } : {}),
        }),
        players: [
          { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
          { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
        ],
        dataVersion: 'test',
      });
      const greenIds = new Set(state.stars.filter((s) => s.color === 'green').map((s) => s.id));
      for (const c of state.colonies) {
        const p = state.planets.find((x) => x.id === c.planetId)!;
        expect(greenIds.has(p.starId)).toBe(false);
      }
    }
  });
});

describe('core worlds victory', () => {
  it('holding every designated world with 1+ pop wins; the table may keep playing', () => {
    let state = newGame('central');
    expect(state.coreWorlds!.length).toBe(4);
    // hand player 0 all but one core world
    const all = state.coreWorlds!;
    for (const pid of all.slice(0, -1)) {
      state = gameEngine.apply(state, { turn: state.turn, playerId: 0, kind: 'debug_found_colony', payload: { planetId: pid } });
    }
    state = advance(state);
    expect(state.winner).toBeNull();
    // the last one closes the set
    state = gameEngine.apply(state, { turn: state.turn, playerId: 0, kind: 'debug_found_colony', payload: { planetId: all[all.length - 1] } });
    state = advance(state);
    expect(state.winner).toBe(0);
    expect(state.winType).toBe('core_worlds');
    expect(gameEngine.winnerOf(state)).toBe(0);

    // continue_game: only valid after a win, resumes turn flow
    expect(validateCommand(state, { turn: state.turn, playerId: 1, kind: 'continue_game', payload: {} })).toBeNull();
    state = gameEngine.apply(state, { turn: state.turn, playerId: 1, kind: 'continue_game', payload: {} });
    expect(state.victoryContinued).toBe(true);
    expect(state.winner).toBe(0); // the win stays on record
    expect(gameEngine.winnerOf(state)).toBeNull(); // but the protocol plays on
    expect(validateCommand(state, { turn: state.turn, playerId: 1, kind: 'continue_game', payload: {} })).toMatch(/already/);
    const turn = state.turn;
    state = advance(state);
    expect(state.turn).toBe(turn + 1);
  });

  it('an outpost or empty colony does not count toward the win', () => {
    let state = newGame('central');
    const all = state.coreWorlds!;
    for (const pid of all) {
      state = gameEngine.apply(state, { turn: state.turn, playerId: 0, kind: 'debug_found_colony', payload: { planetId: pid } });
    }
    // zero out one of them: no longer a >=1-pop colony
    const hollow = state.colonies.find((c) => c.planetId === all[0])!;
    hollow.groups[0]!.popK = 500;
    state = advance(state);
    expect(state.winner).toBeNull();
  });

  it('continue_game is rejected while nobody has won', () => {
    const state = newGame('random');
    expect(validateCommand(state, { turn: state.turn, playerId: 0, kind: 'continue_game', payload: {} })).toMatch(/no victory/);
  });
});
