// 0.27.0: the income number is honest, and food moves on freighters or not at
// all. Pins the Hairulex bug report: the top bar read "+8" while the treasury
// crept +1/turn because leader salaries (and CP overage, megawealth, traders'
// surplus) were charged for real but never shown — and pins the new rule that
// an empire without free freighters cannot ship food (the chartered civilian
// haulers are gone).
import { describe, expect, it } from 'vitest';
import { foodLogistics, colonyOutput, resolveTraits, selectors, type Colony, type GameState } from '@engine/index';
import { advanceTurn } from '@engine/pipeline';

const { empireSummary, projectedFoodShortages } = selectors;

function makeState(opts: {
  freighters?: number;
  homeFarmers?: number;
  bc?: number;
  leaders?: Array<{ leaderId: string; colonyId: number | null; level: number }>;
  homePopK?: number;
}): GameState {
  const freighters = opts.freighters ?? 0;
  const homeFarmers = opts.homeFarmers ?? 6;
  const homePopK = opts.homePopK ?? 8000;
  const homeUnits = Math.floor(homePopK / 1000);
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
    groups: [
      { race: 0, popK: homePopK, farmers: homeFarmers, workers: homeUnits - homeFarmers, scientists: 0, unrest: false },
    ],
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
      { id: 11, starId: 1, orbit: 3, body: 'planet', sizeClass: 5, climate: 'terran', minerals: 'abundant', gravity: 'normal', special: null, homeworldOf: 0, terraformSteps: 0 },
    ],
    empires: [
      {
        id: 0,
        name: 'Tester',
        raceName: 'Test Race',
        picks: ['dictatorship'],
        government: resolveTraits(['dictatorship']).government,
        bc: opts.bc ?? 1000,
        freighters,
        research: { fieldNum: null, targetApp: null, accumRP: 0, extraQueue: [], extraAccumRP: 0, hyperLevels: {} },
        knownApps: [],
        completedFields: [],
        exploredStars: [1],
        designs: [],
        spies: { count: 0, target: null, mode: 'steal' },
        leaders: (opts.leaders ?? []).map((l) => ({ ...l, xp: 0 })),
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

describe('no freighters, no food shipping (0.27.0)', () => {
  it('a deficit colony gets nothing without freighters, however big the surplus and treasury', () => {
    const state = makeState({ freighters: 0, homeFarmers: 6, bc: 1000 });
    // home has surplus, barren has a deficit — but zero freighters
    expect(colonyOutput(state, state.colonies[1]!).foodNet).toBeGreaterThan(0);
    const deficit = -colonyOutput(state, state.colonies[0]!).foodNet;
    expect(deficit).toBeGreaterThan(0);
    expect(projectedFoodShortages(state, 0).get(100)).toBe(deficit); // fully uncovered
    const logi = foodLogistics(state, state.empires[0]!, (c) => colonyOutput(state, c));
    expect(logi.freighterFood).toBe(0);
    expect(logi.freighterUpkeep).toBe(0);
    // and the pipeline starves it rather than quietly billing a charter
    const before = state.empires[0]!.bc;
    const { events } = advanceTurn(state) as { events: Array<{ kind: string; payload: Record<string, unknown> }> };
    const starve = events.filter((e) => e.kind === 'starvation');
    expect(starve.length).toBe(1);
    expect(starve[0]!.payload['colonyId']).toBe(100);
    expect(events.some((e) => e.kind === 'food_chartered')).toBe(false);
    // treasury moved by colony income alone — no shipping charges of any kind
    const summaryDelta = state.empires[0]!.bc - before;
    expect(summaryDelta).toBeGreaterThan(0);
  });

  it('freighters ship within capacity; the projection and the pipeline agree', () => {
    const state = makeState({ freighters: 5, homeFarmers: 6, bc: 1000 });
    const lack = projectedFoodShortages(state, 0).get(100)!;
    const logi = foodLogistics(state, state.empires[0]!, (c) => colonyOutput(state, c));
    expect(logi.freighterFood).toBeGreaterThan(0);
    expect(logi.freighterUpkeep).toBe(Math.ceil(logi.freightersInUse / 2));
    const { events } = advanceTurn(state) as { events: Array<{ kind: string; payload: Record<string, unknown> }> };
    const starve = events.find((e) => e.kind === 'starvation');
    expect(starve ? (starve.payload['lack'] as number) : 0).toBe(lack);
    expect(state.colonies.find((c) => c.id === 100)!.foodLackPrev).toBe(lack);
  });
});

describe('empireSummary.bcDelta is the actual treasury change', () => {
  function actualDelta(state: GameState): number {
    const before = state.empires[0]!.bc;
    advanceTurn(state);
    return state.empires[0]!.bc - before;
  }

  it('plain empire: prediction == what the pipeline applies', () => {
    const predicted = empireSummary(makeState({}), 0);
    expect(predicted.bcDelta).toBe(actualDelta(makeState({})));
    // and the breakdown sums to the delta
    const b = predicted.bcBreakdown;
    expect(b.colonyIncome + b.tradeSurplusBC + b.megawealth - b.freighterUpkeep - b.leaderSalaries - b.cpOverage).toBe(
      predicted.bcDelta,
    );
  });

  it('leader salaries show up in the delta (the Hairulex "+8 shown, +1 real" bug)', () => {
    // Lord Torg: farming*/financial*/labor* + commando = 7 points = 7 BC/turn
    const opts = { leaders: [{ leaderId: 'torg', colonyId: 101, level: 1 }] };
    const predicted = empireSummary(makeState(opts), 0);
    expect(predicted.bcBreakdown.leaderSalaries).toBe(7);
    expect(predicted.bcDelta).toBe(actualDelta(makeState(opts)));
    // without the leader the delta is exactly 7 BC/turn better
    const bare = empireSummary(makeState({}), 0);
    expect(bare.bcDelta - predicted.bcDelta).toBe(7 - (predicted.bcBreakdown.colonyIncome - bare.bcBreakdown.colonyIncome));
  });

  it('freighter upkeep shows up in the delta', () => {
    const opts = { freighters: 5 };
    const predicted = empireSummary(makeState(opts), 0);
    expect(predicted.bcBreakdown.freighterUpkeep).toBeGreaterThan(0);
    expect(predicted.bcDelta).toBe(actualDelta(makeState(opts)));
  });
});

describe('farming/financial leaders do apply — across the whole system', () => {
  it('a financial leader raises colony income, including sibling colonies in the system', () => {
    // level 2 enhanced financial = 20%: home (8 pop) +1, sibling barren (5 pop) +1
    const withL = makeState({ leaders: [{ leaderId: 'torg', colonyId: 101, level: 2 }] });
    const bare = makeState({});
    const homeGain =
      colonyOutput(withL, withL.colonies[1]!).bcIncome - colonyOutput(bare, bare.colonies[1]!).bcIncome;
    const siblingGain =
      colonyOutput(withL, withL.colonies[0]!).bcIncome - colonyOutput(bare, bare.colonies[0]!).bcIncome;
    expect(homeGain).toBeGreaterThan(0);
    // torg is seated on colony 101 but administers the STAR (0.16.0 rule):
    // the sibling colony at the same star gains income too
    expect(siblingGain).toBeGreaterThan(0);
  });

  it('a farming leader raises food output', () => {
    const withL = makeState({ leaders: [{ leaderId: 'torg', colonyId: 101, level: 2 }] });
    const bare = makeState({});
    expect(colonyOutput(withL, withL.colonies[1]!).food).toBeGreaterThan(colonyOutput(bare, bare.colonies[1]!).food);
  });

  it('level 1 magnitudes on small colonies floor to nearly nothing (documented reality)', () => {
    // 10% financial on a 10-pop colony is exactly +1 BC — while torg costs 7
    const withL = makeState({ homePopK: 10000, leaders: [{ leaderId: 'torg', colonyId: 101, level: 1 }] });
    const bare = makeState({ homePopK: 10000 });
    const gain = colonyOutput(withL, withL.colonies[1]!).bcIncome - colonyOutput(bare, bare.colonies[1]!).bcIncome;
    expect(gain).toBe(1);
  });
});
