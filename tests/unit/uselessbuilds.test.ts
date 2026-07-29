// 0.28.0: builds that can never do anything are not offered. Gravity
// generators where nobody fights gravity, morale buildings for unification
// (whose colonists are morale-immune) — plus the default-design model roll
// that makes every refreshed mark look different from the one it replaces.
import { describe, expect, it } from 'vitest';
import { buildableItems, canQueue } from '@engine/items';
import { rollModelIdx } from '@engine/shipdesign';
import { resolveTraits, type Colony, type GameState } from '@engine/index';

function makeState(opts: { gravity?: 'low' | 'normal' | 'high'; picks?: string[] }): GameState {
  const colony: Colony = {
    id: 100,
    planetId: 10,
    owner: 0,
    name: 'Home',
    groups: [{ race: 0, popK: 8000, farmers: 4, workers: 4, scientists: 0, unrest: false }],
    buildings: [],
    queue: [],
    storedProd: 0,
    stickyInvested: {},
    boughtThisTurn: false,
    foodLackPrev: 0,
    prodLackPrev: 0,
    housingPPPrev: 0,
    outpost: false,
  } as unknown as Colony;
  const picks = opts.picks ?? ['dictatorship'];
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
      { id: 10, starId: 1, orbit: 2, body: 'planet', sizeClass: 5, climate: 'terran', minerals: 'abundant', gravity: opts.gravity ?? 'normal', special: null, homeworldOf: 0, terraformSteps: 0 },
    ],
    empires: [
      {
        id: 0,
        name: 'Tester',
        raceName: 'Test Race',
        picks,
        government: resolveTraits(picks).government,
        bc: 1000,
        freighters: 0,
        research: { fieldNum: null, targetApp: null, accumRP: 0, extraQueue: [], extraAccumRP: 0, hyperLevels: {} },
        knownApps: ['gravity_generator', 'holo_simulator', 'pleasure_dome', 'virtual_reality_network'],
        completedFields: [],
        exploredStars: [1],
        designs: [],
        spies: { count: 0, target: null, mode: 'steal' },
        leaders: [],
        eliminated: false,
      },
    ],
    colonies: [colony],
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
  return state;
}

describe('useless-tech build gates (0.28.0)', () => {
  it('gravity generator: blocked on a penalty-free world, offered where gravity bites', () => {
    const normal = makeState({ gravity: 'normal' });
    expect(canQueue(normal, normal.colonies[0]!, 'gravity_generator')).not.toBeNull();
    expect(buildableItems(normal, normal.colonies[0]!)).not.toContain('gravity_generator');
    const heavy = makeState({ gravity: 'high' });
    expect(canQueue(heavy, heavy.colonies[0]!, 'gravity_generator')).toBeNull();
    expect(buildableItems(heavy, heavy.colonies[0]!)).toContain('gravity_generator');
  });

  it('morale buildings: blocked for unification, offered for everyone else', () => {
    const uni = makeState({ picks: ['unification'] });
    for (const b of ['holo_simulator', 'pleasure_dome', 'virtual_reality_network']) {
      expect(canQueue(uni, uni.colonies[0]!, b), b).not.toBeNull();
    }
    const dict = makeState({ picks: ['dictatorship'] });
    for (const b of ['holo_simulator', 'pleasure_dome', 'virtual_reality_network']) {
      expect(canQueue(dict, dict.colonies[0]!, b), b).toBeNull();
    }
  });
});

describe('default-design model roll (0.28.0)', () => {
  it('is deterministic and always changes the rendered model on refresh', () => {
    expect(rollModelIdx('1:frigate:42')).toBe(rollModelIdx('1:frigate:42'));
    for (let prev = 0; prev < 12; prev++) {
      for (let n = 0; n < 20; n++) {
        const next = rollModelIdx(`e:${n}:hull:${prev}`, prev);
        // visibly different under BOTH art wrap counts (4 for warships, 3 for titans)
        expect(next % 4, `prev ${prev} roll ${n}`).not.toBe(prev % 4);
        expect(next % 3, `prev ${prev} roll ${n}`).not.toBe(prev % 3);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(12);
      }
    }
  });
});
