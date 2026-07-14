import { describe, expect, it } from 'vitest';
import { selectors, colonyOutput, resolveTraits, type Colony, type GameState } from '@engine/index';
import { advanceTurn } from '@engine/pipeline';

const { colonyRow } = selectors;

// Reported bug: a starving barren colony's growth appeared to DROP after
// freighters were built. The engine's food redistribution treats freighters
// and chartered civilian haulers interchangeably (both limited by the same
// empire-wide surplus), so freighters must never make growth worse — these
// tests pin that down, plus the new foodLack exposure on ColonyRow that lets
// the UI show whether a deficit is actually covered.

function makeState(freighters: number, homeFarmers = 6, bc = 1000): GameState {
  const barren: Colony = {
    id: 100,
    planetId: 10,
    owner: 0,
    name: 'Barren',
    groups: [{ race: 0, popK: 5000, farmers: 0, workers: 3, scientists: 2, unrest: false }],
    buildings: ['hydroponic_farm', 'population_growth_center'].sort(),
    queue: [],
    storedProd: 0,
    stickyInvested: {},
    boughtThisTurn: false,
    foodLackPrev: 0,
    prodLackPrev: 0,
    housingPPPrev: 0,
    outpost: false,
  } as unknown as Colony;
  const home: Colony = {
    id: 101,
    planetId: 11,
    owner: 0,
    name: 'Home',
    groups: [{ race: 0, popK: 8000, farmers: homeFarmers, workers: 8 - homeFarmers, scientists: 0, unrest: false }],
    buildings: ['marine_barracks'],
    queue: [],
    storedProd: 0,
    stickyInvested: {},
    boughtThisTurn: false,
    foodLackPrev: 0,
    prodLackPrev: 0,
    housingPPPrev: 0,
    outpost: false,
  } as unknown as Colony;
  const state = {
    turn: 1,
    seed: '0123456789abcdef0123456789abcdef',
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 1,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands: false,
    },
    nextId: 1000,
    stars: [{ id: 1, name: 'Alpha', x: 0, y: 0, color: 'yellow', wormholeTo: null }],
    planets: [
      { id: 10, starId: 1, orbit: 2, body: 'planet', sizeClass: 5, climate: 'barren', minerals: 'abundant', gravity: 'normal', special: null, homeworldOf: null, terraformSteps: 0 },
      { id: 11, starId: 1, orbit: 3, body: 'planet', sizeClass: 3, climate: 'terran', minerals: 'abundant', gravity: 'normal', special: null, homeworldOf: 0, terraformSteps: 0 },
    ],
    empires: [
      {
        id: 0,
        name: 'Tester',
        raceName: 'Test Race',
        picks: ['dictatorship'],
        government: resolveTraits(['dictatorship']).government,
        bc,
        freighters,
        research: { fieldNum: null, targetApp: null, accumRP: 0, extraQueue: [], extraAccumRP: 0, hyperLevels: {} },
        knownApps: [],
        completedFields: [],
        exploredStars: [1],
        designs: [],
        spies: { count: 0, target: null, mode: 'steal' },
        leaders: [],
        eliminated: false,
      },
    ],
    colonies: [] as Colony[],
    ships: [],
    phase: 'planning',
    pendingBattles: [],
    relations: [],
    proposals: [],
    council: { nextVoteTurn: 25, pending: null },
    leaderOffers: [],
    winner: null,
    winType: null,
    monsters: [],
    replays: [],
    groundBattles: [],
    events: [],
  } as unknown as GameState;
  state.colonies.push(barren, home);
  return state;
}

describe('freighters and starving-colony growth', () => {
  it('adding freighters never reduces projected growth (all surplus/BC combos)', () => {
    for (const homeFarmers of [6, 5, 4]) {
      for (const bc of [1000, 3, 0]) {
        const without = colonyRow(makeState(0, homeFarmers, bc), makeState(0, homeFarmers, bc).colonies[0]!);
        const withF = colonyRow(makeState(5, homeFarmers, bc), makeState(5, homeFarmers, bc).colonies[0]!);
        expect(withF.growthK).toBeGreaterThanOrEqual(without.growthK);
      }
    }
  });

  it('adding freighters never reduces applied pipeline growth over several turns', () => {
    const pops: number[] = [];
    for (const f of [0, 5]) {
      const state = makeState(f, 5, 50);
      for (let t = 0; t < 3; t++) advanceTurn(state);
      pops.push(state.colonies.find((c) => c.id === 100)!.groups.reduce((s, g) => s + g.popK, 0));
    }
    expect(pops[1]!).toBeGreaterThanOrEqual(pops[0]!);
  });

  it('exposes the uncovered shortage on ColonyRow (surplus-limited coverage)', () => {
    // home surplus 2 < deficit 3: one unit stays uncovered no matter what
    const state = makeState(5, 5, 1000);
    const row = colonyRow(state, state.colonies[0]!);
    expect(state.colonies[0]!.name).toBe('Barren');
    expect(row.output.foodNet).toBe(-3);
    expect(row.foodLack).toBe(1);
    // ample surplus: fully covered, no starvation flag
    const fed = makeState(5, 6, 1000);
    const fedRow = colonyRow(fed, fed.colonies[0]!);
    expect(fedRow.foodLack).toBe(0);
  });
});
