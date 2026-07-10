import { describe, expect, it } from 'vitest';
import {
  DIRS,
  headingDelta,
  headingToward,
  inArc,
  runBattle,
  turnRateOf,
  designDps,
  FP,
  type BattleInput,
  type CombatShipInit,
  type BattleTickFrame,
} from '@engine/combat';
import { ARC_SPACE_PCT, fitWeapon } from '@engine/shipdesign';
import { gameEngine } from '@engine/index';
import { rngFor } from '@engine/rng';
import type { GameState } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function ship(partial: Partial<CombatShipInit> & { shipId: number; side: 0 | 1 }): CombatShipInit {
  return {
    hull: 'cruiser',
    hullIdx: 3,
    isBase: false,
    beamAttack: 50,
    beamDefense: 0,
    speed: 6,
    armorHp: 50,
    structureHp: 100,
    shieldPool: 0,
    shieldFlat: 0,
    weapons: [],
    startingStructure: 100,
    startingArmor: 50,
    ...partial,
  };
}

const beam = (arc: 'F' | 'FX' | 'R' | '360', dmg = 6) => ({
  weaponId: 'laser_cannon',
  classId: 0,
  dmgMin: dmg,
  dmgMax: dmg,
  mods: [] as string[],
  ammo: -1,
  cooldown: 0,
  count: 2,
  arc,
});

function battle(
  ships: CombatShipInit[],
  stanceA: import('@engine/combat').Stance = 'charge',
  stanceB: import('@engine/combat').Stance = 'hold_range',
): { frames: BattleTickFrame[]; result: ReturnType<typeof runBattle> } {
  const input: BattleInput = {
    battleId: 't',
    seedLabel: ['t'],
    attacker: 0,
    defender: 1,
    ships,
    ordersA: { stance: stanceA, priority: 'nearest', retreatThresholdPct: 0, bombard: false },
    ordersD: { stance: stanceB, priority: 'nearest', retreatThresholdPct: 0, bombard: false },
  };
  const frames: BattleTickFrame[] = [];
  const result = runBattle(input, rngFor(SEED, 'combat-test'), (f) => frames.push(structuredClone(f)));
  return { frames, result };
}

describe('heading math', () => {
  it('headingToward picks the nearest of 32 compass points', () => {
    expect(headingToward(1000, 0)).toBe(0);
    expect(headingToward(0, 1000)).toBe(8);
    expect(headingToward(-1000, 0)).toBe(16);
    expect(headingToward(0, -1000)).toBe(24);
    expect(headingToward(1000, 1000)).toBe(4);
  });
  it('headingDelta finds the signed short way around', () => {
    expect(headingDelta(0, 4)).toBe(4);
    expect(headingDelta(4, 0)).toBe(-4);
    expect(headingDelta(30, 2)).toBe(4);
    expect(headingDelta(2, 30)).toBe(-4);
    expect(Math.abs(headingDelta(0, 16))).toBe(16);
  });
  it('capitals answer the helm slower than escorts', () => {
    expect(turnRateOf(1, false)).toBeGreaterThan(turnRateOf(5, false));
  });
});

describe('firing arcs', () => {
  it('arc membership: F forward, R rear, FX wide, 360 all', () => {
    // heading 0 (east); target due east = bearing 0; due west = 16
    expect(inArc('F', 0, 0)).toBe(true);
    expect(inArc('F', 16, 0)).toBe(false);
    expect(inArc('R', 16, 0)).toBe(true);
    expect(inArc('R', 0, 0)).toBe(false);
    expect(inArc('FX', 12, 0)).toBe(true);
    expect(inArc('FX', 13, 0)).toBe(false);
    expect(inArc('360', 16, 0)).toBe(true);
  });

  it('a rear-arc ship cannot hit the enemy ahead; a forward-arc ship can', () => {
    // both sides stationary far apart is useless — let attackers close in
    const rear = battle([
      ship({ shipId: 1, side: 0, weapons: [beam('R')] }),
      ship({ shipId: 2, side: 1, speed: 0, weapons: [] }),
    ]);
    const rearHits = rear.frames.flatMap((f) => f.shots).filter((s) => s.from === 1 && s.hit);
    // the charge keeps the enemy in the front half the whole way in
    expect(rearHits.length).toBe(0);

    const fwd = battle([
      ship({ shipId: 1, side: 0, weapons: [beam('F')] }),
      ship({ shipId: 2, side: 1, speed: 0, weapons: [] }),
    ]);
    const fwdHits = fwd.frames.flatMap((f) => f.shots).filter((s) => s.from === 1);
    expect(fwdHits.length).toBeGreaterThan(0);
  });
});

describe('turning limits (sprites rotate through the helm, not instantly)', () => {
  it('heading changes at most turnRate per tick', () => {
    const { frames } = battle([
      ship({ shipId: 1, side: 0, hullIdx: 6, hull: 'doomstar', weapons: [beam('F')] }),
      ship({ shipId: 2, side: 1, speed: 0, weapons: [] }),
    ]);
    let prev: number | null = null;
    for (const f of frames) {
      const h = f.ships.find((s) => s.id === 1)!.h;
      if (prev !== null) {
        expect(Math.abs(headingDelta(prev, h))).toBeLessThanOrEqual(turnRateOf(6, false));
      }
      prev = h;
    }
  });
});

describe('formations + passthrough', () => {
  it('formation ships advance in lane and hold at the line together', () => {
    const { frames } = battle(
      [
        ship({ shipId: 1, side: 0, speed: 9, weapons: [beam('F')] }),
        ship({ shipId: 2, side: 0, speed: 3, weapons: [beam('F')] }),
        ship({ shipId: 3, side: 1, speed: 0, weapons: [] }),
      ],
      'formation',
    );
    // cohesion: the fast ship never runs ahead of the slow one by more than a hair
    for (const f of frames.slice(0, 30)) {
      const a = f.ships.find((s) => s.id === 1)!;
      const b = f.ships.find((s) => s.id === 2)!;
      expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(4 * FP);
    }
  });

  it('passthrough raiders punch past the line, then withdraw together off their own edge', () => {
    const { frames, result } = battle(
      [
        ship({ shipId: 1, side: 0, speed: 10, weapons: [beam('F', 1)] }),
        ship({ shipId: 2, side: 0, speed: 10, weapons: [beam('F', 1)] }),
        ship({ shipId: 3, side: 1, speed: 0, structureHp: 5000, startingStructure: 5000, weapons: [] }),
      ],
      'passthrough',
    );
    const o1 = result.outcomes.find((o) => o.shipId === 1)!;
    const o2 = result.outcomes.find((o) => o.shipId === 2)!;
    expect(o1.retreated).toBe(true);
    expect(o2.retreated).toBe(true);
    // they really did cross the defender's position before turning home
    const maxX1 = Math.max(...frames.map((f) => f.ships.find((s) => s.id === 1)!.x));
    const defX = frames[0]!.ships.find((s) => s.id === 3)!.x;
    expect(maxX1).toBeGreaterThan(defX);
  });
});

describe('system knockouts (transient battle damage)', () => {
  it('sustained structure damage eventually knocks out systems; nothing persists but hull percentages', () => {
    const { frames, result } = battle(
      [
        ship({ shipId: 1, side: 0, beamAttack: 100, weapons: [beam('F', 9)] }),
        ship({
          shipId: 2,
          side: 1,
          speed: 8,
          armorHp: 0,
          startingArmor: 0,
          structureHp: 4000,
          startingStructure: 4000,
          shieldPool: 30,
          beamAttack: 40,
          weapons: [beam('F', 1)],
        }),
      ],
      'charge',
      'hold_range',
    );
    const sysStates = frames.map((f) => f.ships.find((s) => s.id === 2)!.sys);
    expect(sysStates.some((s) => s.length > 0)).toBe(true); // something broke mid-fight
    // outcomes carry only structure/armor — no system fields leak out
    const o = result.outcomes.find((x) => x.shipId === 2)!;
    expect(Object.keys(o).sort()).toEqual(
      ['armorLeft', 'crossed', 'destroyed', 'retreated', 'shipId', 'side', 'structureLeft', 'structureMax'].sort(),
    );
  });
});

describe('designer numbers', () => {
  it('arc mounts cost space per ARC_SPACE_PCT', () => {
    const state: GameState = gameEngine.init({
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
    const empire = state.empires[0]!;
    const f = fitWeapon(empire, { weapon: 'laser_cannon', count: 1, mods: [], arc: 'F' });
    const t = fitWeapon(empire, { weapon: 'laser_cannon', count: 1, mods: [], arc: '360' });
    const r = fitWeapon(empire, { weapon: 'laser_cannon', count: 1, mods: [], arc: 'R' });
    expect(typeof f).not.toBe('string');
    expect(typeof t).not.toBe('string');
    if (typeof f !== 'string' && typeof t !== 'string' && typeof r !== 'string') {
      expect(t.spaceEach).toBeGreaterThan(f.spaceEach);
      expect(r.spaceEach).toBeLessThanOrEqual(f.spaceEach);
      expect(ARC_SPACE_PCT['360']).toBe(140);
    }
    const bad = fitWeapon(empire, { weapon: 'laser_cannon', count: 1, mods: [], arc: 'X' as never });
    expect(bad).toContain('unknown arc');
  });

  it('designDps sums expected weapon output per second', () => {
    const dps = designDps([beam('F', 10)], 50);
    expect(dps).toBeGreaterThan(0);
    // twice the mounts, twice the output (±1 integer rounding: the readout
    // divides by the real cooldown+1 firing period)
    expect(Math.abs(designDps([{ ...beam('F', 10), count: 4 }], 50) - dps * 2)).toBeLessThanOrEqual(1);
  });
});
