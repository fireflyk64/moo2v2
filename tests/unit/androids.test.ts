// Android population units (bugs.md, cybertechnics): buildable projects that
// add hardwired pop units — +3 in their category, 1 production upkeep, no
// food, no income, immune to morale, compact subterranean housing (own cap),
// never change jobs, destroyed on capture. They CAN relocate to another
// colony, keeping their built job forever (movecolonists.test.ts).
import { describe, expect, it } from 'vitest';
import { ANDROID_RACE, canQueue, resolveTraits, type Colony, type GameState } from '@engine/index';
import { colonyOutput, groupGrowthK, colonyMaxPop } from '@engine/economy';
import { advanceTurn } from '@engine/pipeline';
import { validateCommand } from '@engine/commands';

function makeState(opts?: { known?: boolean }): GameState {
  const colony: Colony = {
    id: 100,
    planetId: 10,
    owner: 0,
    name: 'Home',
    groups: [{ race: 0, popK: 8000, farmers: 4, workers: 4, scientists: 0, unrest: false }],
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
        picks: ['dictatorship'],
        government: resolveTraits(['dictatorship']).government,
        bc: 1000,
        freighters: 0,
        research: { fieldNum: null, targetApp: null, accumRP: 0, extraQueue: [], extraAccumRP: 0, hyperLevels: {} },
        knownApps: opts?.known === false ? [] : ['android_workers', 'android_farmers', 'android_scientists'],
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
  return state;
}

const androidGroup = (c: Colony) => c.groups.find((g) => g.race === ANDROID_RACE);

describe('android units', () => {
  it('are gated on research and on the subterranean compartment cap', () => {
    const unknown = makeState({ known: false });
    expect(canQueue(unknown, unknown.colonies[0]!, 'android_workers')).toMatch(/not researched/);
    const state = makeState();
    expect(canQueue(state, state.colonies[0]!, 'android_workers')).toBeNull();
    // cap = 2 × sizeClass(3) = 6 — a full complement blocks further builds
    state.colonies[0]!.groups.push({ race: ANDROID_RACE, popK: 6000, farmers: 0, workers: 6, scientists: 0, unrest: false });
    expect(canQueue(state, state.colonies[0]!, 'android_workers')).toMatch(/compartments full/);
  });

  it('completion adds one hardwired unit of the built job', () => {
    const state = makeState();
    const colony = state.colonies[0]!;
    colony.queue.push({ item: 'android_scientists' });
    colony.storedProd = 500; // > 120 cost
    advanceTurn(state);
    const grp = androidGroup(colony)!;
    expect(grp).toBeTruthy();
    expect(Math.floor(grp.popK / 1000)).toBe(1);
    expect(grp.scientists).toBe(1);
    expect(grp.farmers + grp.workers).toBe(0);
  });

  it('android workers add flat output, eat production not food, pay no taxes', () => {
    const state = makeState();
    const colony = state.colonies[0]!;
    const before = colonyOutput(state, colony);
    colony.groups.push({ race: ANDROID_RACE, popK: 2000, farmers: 0, workers: 2, scientists: 0, unrest: false });
    const after = colonyOutput(state, colony);
    // abundant world: (3 base + 3 bonus) × 2 workers, minus 2×(1/2)=1 upkeep
    // rounded up to 2? prodConsumed adds ceil(4 halves / 2) = 2 over before's
    expect(after.prod - before.prod).toBe(12 - 2);
    expect(after.foodConsumed).toBe(before.foodConsumed); // no food
    expect(after.prodConsumed - before.prodConsumed).toBe(2); // 1 prod per unit
    expect(after.bcIncome).toBe(before.bcIncome); // no income from androids
  });

  it('android scientists research at 6 each regardless of morale', () => {
    const state = makeState();
    const colony = state.colonies[0]!;
    colony.groups.push({ race: ANDROID_RACE, popK: 2000, farmers: 0, workers: 0, scientists: 2, unrest: false });
    const out = colonyOutput(state, colony);
    expect(out.research).toBe(12); // (3 base + 3 bonus) × 2, organics do no science here
  });

  it('never grow, never crowd organic growth, stay hardwired to their built job', () => {
    const state = makeState();
    const colony = state.colonies[0]!;
    const maxPop = colonyMaxPop(state, colony);
    const organic = colony.groups[0]!;
    const growthWithout = groupGrowthK(state, colony, organic, maxPop, 8);
    colony.groups.push({ race: ANDROID_RACE, popK: 4000, farmers: 0, workers: 4, scientists: 0, unrest: false });
    const grp = androidGroup(colony)!;
    // androids themselves never grow
    expect(groupGrowthK(state, colony, grp, maxPop, 12)).toBe(0);
    // organic growth ignores android units (their housing is separate)
    expect(groupGrowthK(state, colony, organic, maxPop, 12)).toBe(growthWithout);
    // job rewiring is rejected (0.29.0 restores the rule 0.28.1 broke):
    // a worker built is a worker forever, here or on any other colony
    const rewire = validateCommand(state, {
      turn: 1,
      playerId: 0,
      kind: 'set_jobs',
      payload: { colonyId: 100, groups: [{ race: ANDROID_RACE, farmers: 4, workers: 0, scientists: 0 }] },
    } as never);
    expect(rewire).toMatch(/hardwired/);
    // the split must still account for every android unit
    const short = validateCommand(state, {
      turn: 1,
      playerId: 0,
      kind: 'set_jobs',
      payload: { colonyId: 100, groups: [{ race: ANDROID_RACE, farmers: 1, workers: 0, scientists: 0 }] },
    } as never);
    expect(short).toBeTruthy();
    // restating the same split verbatim is fine
    const okay = validateCommand(state, {
      turn: 1,
      playerId: 0,
      kind: 'set_jobs',
      payload: { colonyId: 100, groups: [{ race: ANDROID_RACE, farmers: 0, workers: 4, scientists: 0 }] },
    } as never);
    expect(okay).toBeNull();
  });
});
