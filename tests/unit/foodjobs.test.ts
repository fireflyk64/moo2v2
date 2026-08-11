// bugs.md: job preset sweeps must not pull farmers whose food the rest of
// the empire depends on; "fix food" concentrates farming on the best worlds.
import { describe, expect, it } from 'vitest';
import { gameEngine, selectors } from '@engine/index';
import { colonyOutput } from '@engine/economy';
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
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

/** homeworld + a barren mining colony that cannot farm and eats imports */
function stageBreadbasket(state: GameState) {
  const home = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
  // make the homeworld the breadbasket: everyone farms
  for (const g of home.groups) {
    const units = Math.floor(g.popK / 1000);
    g.farmers = units;
    g.workers = 0;
    g.scientists = 0;
  }
  // second colony on a barren world: 3 units, all workers, needs imports
  const barren = state.planets.find(
    (p) => p.climate === 'barren' && !state.colonies.some((c) => c.planetId === p.id),
  )!;
  state.colonies.push({
    id: 900001,
    planetId: barren.id,
    owner: 0,
    name: 'Mine',
    groups: [{ race: 0, popK: 3000, farmers: 0, workers: 3, scientists: 0, unrest: false }],
    buildings: [],
    queue: [],
    storedProd: 0,
    stickyInvested: {},
    boughtThisTurn: false,
    foodLackPrev: 0,
    prodLackPrev: 0,
    housingPPPrev: 0,
    outpost: false,
  });
  state.colonies.sort((a, b) => a.id - b.id);
  return { home, mine: state.colonies.find((c) => c.id === 900001)! };
}

describe('job presets vs empire food', () => {
  it('research preset keeps the farmers the empire depends on', () => {
    const state = newGame();
    const { home, mine } = stageBreadbasket(state);
    const mineNeed = -colonyOutput(state, mine).foodNet;
    expect(mineNeed).toBeGreaterThan(0); // the mine really eats imports

    const groups = selectors.presetJobs(state, home.id, 'research')!;
    expect(groups).toBeTruthy();
    for (const g of groups) {
      const target = home.groups.find((x) => x.race === g.race)!;
      target.farmers = g.farmers;
      target.workers = g.workers;
      target.scientists = g.scientists;
    }
    // the breadbasket must still export what the mine needs
    expect(colonyOutput(state, home).foodNet).toBeGreaterThanOrEqual(mineNeed);
  });

  it('fix-food concentrates farming and feeds the empire', () => {
    const state = newGame();
    const { home, mine } = stageBreadbasket(state);
    // start from a broken state: nobody farms anywhere
    for (const g of home.groups) {
      const units = Math.floor(g.popK / 1000);
      g.farmers = 0;
      g.workers = units;
      g.scientists = 0;
    }
    const plan = selectors.fixFoodJobs(state, [home.id, mine.id]);
    expect(plan.size).toBeGreaterThan(0);
    for (const [colonyId, groups] of plan) {
      const colony = state.colonies.find((c) => c.id === colonyId)!;
      for (const g of groups) {
        const target = colony.groups.find((x) => x.race === g.race)!;
        target.farmers = g.farmers;
        target.workers = g.workers;
        target.scientists = g.scientists;
      }
    }
    const net =
      colonyOutput(state, home).foodNet + colonyOutput(state, mine).foodNet;
    expect(net).toBeGreaterThanOrEqual(0); // the empire is fed again
    // and the farming landed on the fertile world, not the barren mine
    expect(mine.groups[0]!.farmers).toBe(0);
    expect(home.groups.reduce((n, g) => n + g.farmers, 0)).toBeGreaterThan(0);
  });

  it('fix-food keeps the worker:scientist ratio it found (bugs.md)', () => {
    const state = newGame();
    const { home, mine } = stageBreadbasket(state);
    // 2 workers per scientist and zero farmers: food is broken but the
    // colony's split is unambiguous — fixing food must not rewrite it
    for (const g of home.groups) {
      const units = Math.floor(g.popK / 1000);
      const sci = Math.floor(units / 3);
      g.farmers = 0;
      g.scientists = sci;
      g.workers = units - sci;
    }
    const plan = selectors.fixFoodJobs(state, [home.id, mine.id]);
    for (const [colonyId, groups] of plan) {
      const colony = state.colonies.find((c) => c.id === colonyId)!;
      for (const g of groups) {
        const target = colony.groups.find((x) => x.race === g.race)!;
        target.farmers = g.farmers;
        target.workers = g.workers;
        target.scientists = g.scientists;
      }
    }
    const net = colonyOutput(state, home).foodNet + colonyOutput(state, mine).foodNet;
    expect(net).toBeGreaterThanOrEqual(0); // still actually fixes the food
    const w = home.groups.reduce((n, g) => n + g.workers, 0);
    const s = home.groups.reduce((n, g) => n + g.scientists, 0);
    expect(w + s).toBeGreaterThan(0); // farmers must not swallow the colony
    // ~2:1 survives the farming draft (± rounding on a small population)
    expect(Math.abs(w - 2 * s)).toBeLessThanOrEqual(2);
    // the old behavior put EVERYONE on science — guard against regressing
    expect(w).toBeGreaterThan(s);
  });
});

describe('incremental presets (keepFarmers — the autopilot food fix)', () => {
  it('keepFarmers preserves a deliberate farming surplus exactly, per group', () => {
    const state = newGame();
    const { home } = stageBreadbasket(state);
    // the player hand-set MORE farmers than the minimum (a deliberate buffer)
    const minimal = selectors.presetJobs(state, home.id, 'industry')!;
    const minFarmers = minimal.reduce((n, g) => n + g.farmers, 0);
    const surplus = minFarmers + 1;
    let left = surplus;
    for (const g of home.groups) {
      const units = Math.floor(g.popK / 1000);
      g.farmers = Math.min(units, left);
      left -= g.farmers;
      g.workers = units - g.farmers;
      g.scientists = 0;
    }
    const before = home.groups.map((g) => g.farmers);
    const kept = selectors.presetJobs(state, home.id, 'research', { keepFarmers: true })!;
    // farmer counts untouched, group by group — only the rest was reassigned
    kept.forEach((g, i) => expect(g.farmers).toBe(before[i]));
    expect(kept.reduce((n, g) => n + g.farmers, 0)).toBe(surplus);
    // and the research preset really moved the non-farmers to science
    expect(kept.reduce((n, g) => n + g.scientists, 0)).toBeGreaterThan(0);
    expect(kept.reduce((n, g) => n + g.workers, 0)).toBe(0);
  });

  it('without keepFarmers the preset still minimizes farmers (unchanged)', () => {
    const state = newGame();
    const { home } = stageBreadbasket(state);
    const minimal = selectors.presetJobs(state, home.id, 'industry')!;
    const minFarmers = minimal.reduce((n, g) => n + g.farmers, 0);
    // over-farm, then run the classic preset: the surplus is reclaimed
    for (const g of home.groups) {
      const units = Math.floor(g.popK / 1000);
      g.farmers = units;
      g.workers = 0;
      g.scientists = 0;
    }
    const swept = selectors.presetJobs(state, home.id, 'industry')!;
    expect(swept.reduce((n, g) => n + g.farmers, 0)).toBe(minFarmers);
  });
});
