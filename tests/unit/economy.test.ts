import { describe, expect, it } from 'vitest';
import {
  buyCost,
  colonyOutput,
  foodPerFarmerBase,
  groupGrowthK,
  maxPopulation,
  gameEngine,
  moralePct,
  resolveTraits,
  type Colony,
  type GameState,
} from '@engine/index';

// Hand-built minimal state for formula fixtures (F1-F14 in data/README.md).

function fixtureState(picks: string[], overrides?: Partial<{ climate: string; minerals: string; gravity: string; buildings: string[]; sizeClass: number; pop: number; farmers: number; workers: number; scientists: number; queue: string[] }>): { state: GameState; colony: Colony } {
  const o = {
    climate: 'terran',
    minerals: 'abundant',
    gravity: 'normal',
    buildings: ['marine_barracks'],
    sizeClass: 3,
    pop: 8,
    farmers: 4,
    workers: 2,
    scientists: 2,
    queue: [] as string[],
    ...(overrides ?? {}),
  };
  const colony: Colony = {
    id: 100,
    planetId: 10,
    owner: 0,
    name: 'Test',
    groups: [{ race: 0, popK: o.pop * 1000, farmers: o.farmers, workers: o.workers, scientists: o.scientists, unrest: false }],
    buildings: [...o.buildings].sort(),
    queue: o.queue.map((item) => ({ item })),
    storedProd: 0,
    stickyInvested: {},
    boughtThisTurn: false,
    foodLackPrev: 0,
    prodLackPrev: 0,
    housingPPPrev: 0,
    outpost: false,
  };
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
      {
        id: 10,
        starId: 1,
        orbit: 3,
        body: 'planet',
        sizeClass: o.sizeClass,
        climate: o.climate,
        minerals: o.minerals,
        gravity: o.gravity,
        special: null,
        homeworldOf: 0,
        terraformSteps: 0,
      },
    ],
    empires: [
      {
        id: 0,
        name: 'Tester',
        raceName: 'Test Race',
        picks: [...picks].sort(),
        government: resolveTraits(picks).government,
        bc: 1000,
        freighters: 0,
        research: { fieldNum: null, targetApp: null, accumRP: 0, extraQueue: [], extraAccumRP: 0, hyperLevels: {} },
        knownApps: [],
        completedFields: [],
        exploredStars: [1],
        designs: [],
        spies: { count: 0, target: null, mode: 'steal' },
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
    winner: null,
    winType: null,
  } as unknown as GameState;
  state.colonies.push(colony);
  return { state, colony };
}

describe('F2/F7: colony output goldens (hand-computed)', () => {
  it('democracy 8-pop terran abundant: food 8, prod 6, res 9, bc 8+4-3', () => {
    const { state, colony } = fixtureState(['charismatic', 'democracy'], {
      buildings: ['marine_barracks', 'star_base'],
    });
    const out = colonyOutput(state, colony);
    expect(out.food).toBe(8); // 4 farmers x 2 (terran)
    expect(out.foodConsumed).toBe(8);
    expect(out.prod).toBe(6); // 2 workers x 3 (abundant), pollution 6 <= absorb 6
    expect(out.pollution).toBe(0);
    expect(out.research).toBe(9); // 2 x 3 = 6, democracy +50% => 9
    // money: popIncome 8, democracy floor(8*.5)=4, maint 1+2=3
    expect(out.bcIncome).toBe(9);
    expect(out.moralePct).toBe(0);
  });

  it('dictatorship without barracks suffers -20% morale', () => {
    const { state, colony } = fixtureState(['dictatorship'], { buildings: [] });
    expect(moralePct(state, colony)).toBe(-20);
    const out = colonyOutput(state, colony);
    expect(out.food).toBe(6); // round(8 * 0.8) = 6 (half-up on 6.4)
    expect(out.research).toBe(5); // round(6*0.8) = 5 (4.8)
  });

  it('unification ignores morale and boosts farm/prod by 50%', () => {
    const { state, colony } = fixtureState(['unification'], { buildings: [] });
    const out = colonyOutput(state, colony);
    expect(out.food).toBe(12); // round(8 * 1.5)
    expect(out.pollution).toBe(2); // ceil((9-6)/2)
    expect(out.prod).toBe(7); // round(6*1.5)=9 minus pollution 2
  });

  it('cybernetic industry race: +2 prod coeff, half food + half prod upkeep', () => {
    const { state, colony } = fixtureState(['industry3', 'cybernetic', 'dictatorship']);
    const out = colonyOutput(state, colony);
    // prodBase = 2 x (3+2) = 10; pollution ceil((10-6)/2)=2 => gross 8; upkeep ceil(8/2)=4 => 4
    expect(out.pollution).toBe(2);
    expect(out.prodConsumed).toBe(4);
    expect(out.prod).toBe(4);
    expect(out.foodConsumed).toBe(4); // half food per unit
  });

  it('gravity penalty: low-g race on normal world loses 25% of per-colonist output', () => {
    const { state, colony } = fixtureState(['lowg_world', 'dictatorship']);
    const out = colonyOutput(state, colony);
    // farm: base 8, penalty round(8*25/100)=2 -> 6
    expect(out.food).toBe(6);
    // sci: base 6, penalty round(6*.25)=2 (1.5 rounds to 2) -> 4
    expect(out.research).toBe(4);
  });

  it('tolerant race generates no pollution; lithovore eats nothing', () => {
    const { state, colony } = fixtureState(['tolerant', 'lithovore', 'dictatorship'], {
      minerals: 'ultra_rich',
      farmers: 0,
      workers: 6,
      scientists: 2,
    });
    const out = colonyOutput(state, colony);
    expect(out.pollution).toBe(0);
    expect(out.prod).toBe(48); // 6 x 8
    expect(out.foodConsumed).toBe(0);
  });

  it('trade goods divert production to BC at 2:1', () => {
    const { state, colony } = fixtureState(['dictatorship'], { queue: ['trade_goods'] });
    const out = colonyOutput(state, colony);
    expect(out.prodToQueue).toBe(0);
    expect(out.tradeBC).toBe(Math.floor(out.prod / 2));
  });
});

describe('F6: max population', () => {
  const norm = resolveTraits(['dictatorship']);
  const aqua = resolveTraits(['aquatic', 'dictatorship']);
  const sub = resolveTraits(['subterranean', 'dictatorship']);
  const tol = resolveTraits(['tolerant', 'dictatorship']);
  const planet = (climate: string, sizeClass = 3) =>
    ({ id: 1, starId: 1, orbit: 1, body: 'planet', sizeClass, climate, minerals: 'abundant', gravity: 'normal', special: null, homeworldOf: null }) as never;

  it('follows the size x climate table', () => {
    expect(maxPopulation(planet('gaia'), norm)).toBe(15);
    expect(maxPopulation(planet('terran'), norm)).toBe(12);
    expect(maxPopulation(planet('arid'), norm)).toBe(9);
    expect(maxPopulation(planet('swamp'), norm)).toBe(6);
    expect(maxPopulation(planet('ocean'), norm)).toBe(4); // round(15*0.25)
    expect(maxPopulation(planet('terran', 5), norm)).toBe(20);
  });

  it('aquatic/tolerant/subterranean modifiers', () => {
    expect(maxPopulation(planet('ocean'), aqua)).toBe(15);
    expect(maxPopulation(planet('tundra'), aqua)).toBe(12);
    expect(maxPopulation(planet('desert'), tol)).toBe(8); // 25+25=50% of 15 => 7.5 -> 8
    expect(maxPopulation(planet('terran'), sub)).toBe(18); // 12 + 2*3
  });
});

describe('F1: growth', () => {
  it('basic increment matches floor(sqrt(2000*c*free/cap))', () => {
    const { state, colony } = fixtureState(['dictatorship'], { buildings: ['marine_barracks'] });
    const inc = groupGrowthK(state, colony, colony.groups[0]!, 12, 8);
    expect(inc).toBe(73); // sqrt(2000*8*4/12) = sqrt(5333.33) -> 73
  });

  it('growth pick and housing multiply the base increment', () => {
    const { state, colony } = fixtureState(['growth3', 'dictatorship']);
    expect(groupGrowthK(state, colony, colony.groups[0]!, 12, 8)).toBe(146); // x2
    colony.housingPPPrev = 9;
    // housing adds floor(9*40/8)=45% => 100+100+45 = 245%
    expect(groupGrowthK(state, colony, colony.groups[0]!, 12, 8)).toBe(Math.floor((73 * 245) / 100));
  });

  it('food shortage shrinks population', () => {
    const { state, colony } = fixtureState(['dictatorship']);
    colony.foodLackPrev = 3;
    const inc = groupGrowthK(state, colony, colony.groups[0]!, 12, 8);
    expect(inc).toBe(73 - 150);
  });
});

describe('F9: buy cost', () => {
  it('matches the piecewise table', () => {
    expect(buyCost(100, 0)).toBe(400);
    expect(buyCost(100, 5)).toBe(350);
    expect(buyCost(100, 10)).toBe(300);
    expect(buyCost(100, 30)).toBe(200);
    expect(buyCost(100, 50)).toBe(100);
    expect(buyCost(100, 75)).toBe(50);
    expect(buyCost(100, 100)).toBe(0);
  });
});

describe('F3: food per farmer', () => {
  it('non-aquatic and aquatic tables', () => {
    expect(foodPerFarmerBase('terran', false)).toBe(2);
    expect(foodPerFarmerBase('gaia', false)).toBe(3);
    expect(foodPerFarmerBase('tundra', false)).toBe(1);
    expect(foodPerFarmerBase('barren', false)).toBe(0);
    expect(foodPerFarmerBase('tundra', true)).toBe(2);
    expect(foodPerFarmerBase('ocean', true)).toBe(3);
  });
});

describe('engine adapter basics', () => {
  it('initializes a deterministic 2-empire game', () => {
    const start = {
      seed: '0123456789abcdef0123456789abcdef',
      settings: fixtureState(['dictatorship']).state.settings,
      players: [
        { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'cerebri' }) },
        { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'hivex' }) },
      ],
      dataVersion: 'test',
    };
    const s1 = gameEngine.init(start);
    const s2 = gameEngine.init(start);
    expect(gameEngine.hash(s1)).toBe(gameEngine.hash(s2));
    expect(s1.colonies.length).toBe(2);
    expect(s1.ships.length).toBe(4); // scout + colony ship each
    expect(s1.empires[0]!.knownApps.length).toBeGreaterThan(10);
    // serialization round-trip
    expect(gameEngine.hash(gameEngine.deserialize(gameEngine.serialize(s1)))).toBe(gameEngine.hash(s1));
  });
});
