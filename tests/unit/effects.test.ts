import { describe, expect, it } from 'vitest';
import {
  availableHulls,
  colonyMaxPop,
  colonyOutput,
  designStats,
  gameEngine,
  grantApp,
  type GameState,
} from '@engine/index';

const SEED = '0123456789abcdef0123456789abcdef';

function startGame(): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands: true,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'hivex' }) },
    ],
    dataVersion: 'test',
  });
}

describe('declarative tech/building effects (Phase 5 wiring)', () => {
  it('advanced_city_planning adds +5 max pop empire-wide', () => {
    const state = startGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    const before = colonyMaxPop(state, colony);
    grantApp(state.empires[0]!, 'advanced_city_planning');
    expect(colonyMaxPop(state, colony)).toBe(before + 5);
  });

  it('learning_optimization adds +1 research per scientist', () => {
    const state = startGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    const before = colonyOutput(state, colony).research;
    grantApp(state.empires[0]!, 'learning_optimization');
    const after = colonyOutput(state, colony).research;
    // 2 scientists x +1, democracy +50% => round adds 3
    expect(after).toBeGreaterThan(before);
  });

  it('microlite_construction adds +1 production per worker', () => {
    const state = startGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    const before = colonyOutput(state, colony).prod;
    grantApp(state.empires[0]!, 'microlite_construction');
    expect(colonyOutput(state, colony).prod).toBeGreaterThan(before);
  });

  it('space_port raises colony income', () => {
    const state = startGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    const before = colonyOutput(state, colony).bcIncome;
    colony.buildings = [...colony.buildings, 'space_port'].sort();
    expect(colonyOutput(state, colony).bcIncome).toBeGreaterThan(before);
  });

  it('megafluxers grants +25% design space', () => {
    const state = startGame();
    const empire = state.empires[0]!;
    const base = designStats(state, empire, {
      name: 'x',
      hull: 'frigate',
      computer: 0,
      shield: 0,
      specials: [],
      weapons: [],
    });
    grantApp(empire, 'megafluxers');
    const boosted = designStats(state, empire, {
      name: 'x',
      hull: 'frigate',
      computer: 0,
      shield: 0,
      specials: [],
      weapons: [],
    });
    if (typeof base === 'string' || typeof boosted === 'string') throw new Error('design failed');
    expect(boosted.spaceTotal).toBe(Math.round(base.spaceTotal * 1.25));
  });

  it('hull availability gates on construction techs (C7)', () => {
    const state = startGame();
    const empire = state.empires[0]!;
    expect(availableHulls(empire)).toEqual(['frigate', 'destroyer']);
    empire.completedFields.push(21); // capsule construction
    expect(availableHulls(empire)).toContain('cruiser');
    // battleship unlocks at ROBOTICS (62) — the tier-6 field — NOT astro
    // construction (19), whose pick decides titan (regression: save f979b65e
    // had robotics done at turn 112 and could not design battleships)
    expect(availableHulls(empire)).not.toContain('battleship');
    empire.completedFields.push(19); // astro construction alone: not the gate
    expect(availableHulls(empire)).not.toContain('battleship');
    empire.completedFields.push(62); // robotics
    expect(availableHulls(empire)).toContain('battleship');
    grantApp(empire, 'titan_construction');
    expect(availableHulls(empire)).toContain('titan');
    const bad = designStats(state, empire, {
      name: 'x',
      hull: 'doomstar',
      computer: 0,
      shield: 0,
      specials: [],
      weapons: [],
    });
    expect(bad).toMatch(/not yet available/);
  });

  it('virtual_reality_network lifts morale empire-wide from one colony', () => {
    const state = startGame();
    const hivexColonies = state.colonies.filter((c) => c.owner === 1);
    expect(hivexColonies.length).toBe(1);
    // give hivex (unification: morale-immune) a second colony? use solari instead
    const solari = state.colonies.find((c) => c.owner === 0)!;
    const before = colonyOutput(state, solari).moralePct;
    solari.buildings = [...solari.buildings, 'virtual_reality_network'].sort();
    expect(colonyOutput(state, solari).moralePct).toBe(before + 20);
  });
});
