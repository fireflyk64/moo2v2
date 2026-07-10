// The combat bug batch: mauler auto-hit, MIRV warheads, retreat via any edge,
// overkill spread, strike craft (fighter bays / assault shuttles).

import { describe, expect, it } from 'vitest';
import { runBattle, designDps, FP, type BattleInput, type BattleTickFrame, type CombatShipInit } from '@engine/combat';
import { rngFor } from '@engine/rng';

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
  const result = runBattle(input, rngFor(SEED, 'combat-fixes'), (f) => frames.push(structuredClone(f)));
  return { frames, result };
}

describe('mauler device never misses', () => {
  it('every mauler volley lands even against a max-evasion target', () => {
    const mauler = {
      weaponId: 'mauler_device',
      classId: 0,
      dmgMin: 20,
      dmgMax: 20,
      mods: ['hit'],
      ammo: -1,
      cooldown: 0,
      count: 1,
      arc: '360' as const,
    };
    const { frames } = battle([
      ship({ shipId: 1, side: 0, beamAttack: 0, weapons: [mauler] }),
      ship({ shipId: 2, side: 1, beamDefense: 180, structureHp: 4000, startingStructure: 4000 }),
    ]);
    const shots = frames.flatMap((f) => f.shots).filter((s) => s.weaponId === 'mauler_device');
    expect(shots.length).toBeGreaterThan(3);
    expect(shots.every((s) => s.hit)).toBe(true);
  });
});

describe('MIRV', () => {
  it('quadruples missile DPS in the designer readout', () => {
    const missile = { weaponId: 'nuclear_missile', classId: 1, dmgMin: 8, dmgMax: 8, mods: [] as string[], ammo: 5, cooldown: 0, count: 2, arc: 'F' as const };
    const plain = designDps([missile], 0);
    const mirv = designDps([{ ...missile, mods: ['mv'] }], 0);
    expect(mirv).toBe(plain * 4);
  });

  it('launches four warheads per missile in the sim', () => {
    const missile = { weaponId: 'nuclear_missile', classId: 1, dmgMin: 8, dmgMax: 8, mods: ['mv'], ammo: 1, cooldown: 0, count: 1, arc: 'F' as const };
    const { frames } = battle([
      ship({ shipId: 1, side: 0, weapons: [missile] }),
      ship({ shipId: 2, side: 1, structureHp: 4000, startingStructure: 4000 }),
    ]);
    const maxInFlight = Math.max(...frames.map((f) => f.projectiles.filter((p) => p.classId === 1).length));
    expect(maxInFlight).toBe(4); // one missile, four independent warheads
  });
});

describe('retreat leaves through the NEAREST edge', () => {
  it('a ship hugging the top edge exits upward instead of crossing the whole field', () => {
    // defender sits near the top; with evade_retreat from the start it should
    // leave in very few ticks (top edge is ~40u away; its own right edge ~300u)
    const { frames, result } = battle(
      [
        ship({ shipId: 1, side: 0, speed: 0, weapons: [] }),
        ship({ shipId: 2, side: 1, speed: 8 }),
      ],
      'charge',
      'evade_retreat',
    );
    const out = result.outcomes.find((o) => o.shipId === 2)!;
    expect(out.retreated).toBe(true);
    expect(out.destroyed).toBe(false);
    // find when it left: must be quick (nearest edge, not a corner crawl)
    const leftAt = frames.findIndex((f) => f.ships.find((s) => s.id === 2)?.retreated);
    expect(leftAt).toBeGreaterThanOrEqual(0);
    expect(leftAt).toBeLessThan(60);
  });
});

describe('overkill spreads across targets', () => {
  it('an overwhelming broadside kills several weak ships in the same pass quickly', () => {
    const guns = { weaponId: 'laser_cannon', classId: 0, dmgMin: 40, dmgMax: 40, mods: [] as string[], ammo: -1, cooldown: 0, count: 8, arc: '360' as const };
    const { frames } = battle([
      ship({ shipId: 1, side: 0, beamAttack: 200, weapons: [guns] }),
      ship({ shipId: 2, side: 1, structureHp: 10, startingStructure: 10, armorHp: 0, startingArmor: 0, speed: 0 }),
      ship({ shipId: 3, side: 1, structureHp: 10, startingStructure: 10, armorHp: 0, startingArmor: 0, speed: 0 }),
      ship({ shipId: 4, side: 1, structureHp: 10, startingStructure: 10, armorHp: 0, startingArmor: 0, speed: 0 }),
    ]);
    // with the spread, all three victims die on the same tick the guns get in
    // range: no wasted volleys hammering one corpse per turn
    const deathTicks = new Map<number, number>();
    for (const f of frames) for (const d of f.deaths) deathTicks.set(d, f.tick);
    expect(deathTicks.size).toBe(3);
    const ticks = [...deathTicks.values()];
    expect(Math.max(...ticks) - Math.min(...ticks)).toBeLessThanOrEqual(1);
  });
});

describe('strike craft (fighter bays / assault shuttles)', () => {
  it('fighters launch, fly as classId-4 craft, and hurt the target', () => {
    const bays = { weaponId: 'heavy_fighter', classId: 4, dmgMin: 8, dmgMax: 32, mods: [] as string[], ammo: 4, cooldown: 0, count: 2, arc: '360' as const };
    const { frames } = battle([
      ship({ shipId: 1, side: 0, weapons: [bays] }),
      ship({ shipId: 2, side: 1, structureHp: 300, startingStructure: 300, speed: 0 }),
    ]);
    expect(frames.some((f) => f.projectiles.some((p) => p.classId === 4))).toBe(true);
    const last = frames[frames.length - 1]!;
    const target = last.ships.find((s) => s.id === 2)!;
    expect(target.structPct).toBeLessThan(100);
  });

  it('assault shuttles board: they force a system knockout on the victim', () => {
    const shuttles = { weaponId: 'assault_shuttle', classId: 4, dmgMin: 0, dmgMax: 0, mods: [] as string[], ammo: 6, cooldown: 0, count: 4, arc: '360' as const };
    const { frames } = battle([
      ship({ shipId: 1, side: 0, weapons: [shuttles] }),
      ship({ shipId: 2, side: 1, structureHp: 500, startingStructure: 500, shieldPool: 50, speed: 6, beamAttack: 30 }),
    ]);
    // some frame shows the victim with a knocked-out system (d/c/s flag)
    const crippled = frames.some((f) => (f.ships.find((s) => s.id === 2)?.sys ?? '') !== '');
    expect(crippled).toBe(true);
  });
});
