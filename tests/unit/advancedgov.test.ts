import { describe, expect, it } from 'vitest';
import { colonyOutput, commandPoints, designStats, hasAdvancedGov, resolveTraits, type Colony, type Empire, type GameState } from '@engine/index';

// Advanced governments (sociology field 6): each application upgrades its
// matching base government. Mismatched apps (a democracy holding imperium)
// do nothing.

function makeState(picks: string[], knownApps: string[] = []): { state: GameState; colony: Colony; empire: Empire } {
  const colony: Colony = {
    id: 100,
    planetId: 10,
    owner: 0,
    name: 'Test',
    groups: [{ race: 0, popK: 8000, farmers: 4, workers: 2, scientists: 2, unrest: false }],
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
      { id: 10, starId: 1, orbit: 3, body: 'planet', sizeClass: 3, climate: 'terran', minerals: 'abundant', gravity: 'normal', special: null, homeworldOf: 0, terraformSteps: 0 },
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
        knownApps: [...knownApps],
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
  state.colonies.push(colony);
  return { state, colony, empire: state.empires[0]! };
}

const DESIGN = { name: 'x', hull: 'frigate', computer: 0, shield: 0, specials: [], weapons: [{ weapon: 'laser_cannon', count: 1, mods: [], arc: 'F' as const }] };

describe('advanced governments', () => {
  it('only the matching application upgrades the government', () => {
    expect(hasAdvancedGov(makeState(['democracy'], ['federation']).empire)).toBe(true);
    expect(hasAdvancedGov(makeState(['democracy'], ['imperium']).empire)).toBe(false);
    expect(hasAdvancedGov(makeState(['dictatorship'], ['imperium']).empire)).toBe(true);
  });

  it('galactic unification doubles the farm/prod bonus to +100%', () => {
    const base = colonyOutput(...(() => { const { state, colony } = makeState(['unification']); return [state, colony] as const; })());
    const adv = colonyOutput(...(() => { const { state, colony } = makeState(['unification'], ['galactic_unification']); return [state, colony] as const; })());
    expect(base.food).toBe(12); // 8 base * 1.5
    expect(adv.food).toBe(16); // 8 base * 2.0
  });

  it('federation raises democracy research and income from +50% to +75%', () => {
    const { state, colony } = makeState(['democracy']);
    const base = colonyOutput(state, colony);
    const advCase = makeState(['democracy'], ['federation']);
    const adv = colonyOutput(advCase.state, advCase.colony);
    expect(base.research).toBe(9); // 6 * 1.5
    expect(adv.research).toBe(11); // round(6 * 1.75) = 11 (10.5 half-up)
    expect(adv.bcIncome).toBeGreaterThan(base.bcIncome);
  });

  it('confederation softens the feudal research penalty and cuts warship cost to 1/3', () => {
    const feud = makeState(['feudal']);
    const conf = makeState(['feudal'], ['confederation']);
    const dict = makeState(['dictatorship']);
    expect(colonyOutput(conf.state, conf.colony).research).toBeGreaterThan(colonyOutput(feud.state, feud.colony).research);
    const dictCost = (designStats(dict.state, dict.empire, DESIGN) as { cost: number }).cost;
    const feudCost = (designStats(feud.state, feud.empire, DESIGN) as { cost: number }).cost;
    const confCost = (designStats(conf.state, conf.empire, DESIGN) as { cost: number }).cost;
    expect(feudCost).toBe(Math.round((dictCost * 2) / 3));
    expect(confCost).toBe(Math.max(1, Math.round(dictCost / 3)));
  });

  it('imperium grants +50% command points', () => {
    const dict = makeState(['dictatorship']);
    const imp = makeState(['dictatorship'], ['imperium']);
    const base = commandPoints(dict.state, dict.empire).sources;
    const adv = commandPoints(imp.state, imp.empire).sources;
    expect(adv).toBe(base + Math.floor(base / 2));
  });
});
