// MOO2 strategic-bombardment math: every weapon attacks the planet with its
// strategic damage — bombs/missiles full (one run per ammo, MIRV x4),
// beams/torpedoes half, strike craft never, specials only the stellar
// converter — and planetary shields block their strength from each run.
import { describe, expect, it } from 'vitest';
import {
  HULL_WEIGHT,
  MEDIUM_FLEET_WEIGHT,
  STRONG_FLEET_WEIGHT,
  bombard,
  fleetBombardDamage,
  fleetHullWeight,
  planetShieldBlock,
} from '@engine/battles';
import type { Colony, GameState, PendingBattle } from '@engine/types';

function stateWith(weapons: Array<{ weapon: string; count: number; mods: string[] }>): GameState {
  return {
    empires: [{ id: 0, designs: [{ id: 1, weapons }] }],
    ships: [{ owner: 0, designId: 1, location: { kind: 'star', starId: 8 } }],
  } as unknown as GameState;
}

const colonyWith = (buildings: string[]) => ({ buildings }) as unknown as Colony;

describe('fleetBombardDamage', () => {
  it('halves beam damage against planets', () => {
    // laser avg 2.5 -> floor to 1 vs planet (half-point integer math); 8 lasers = 8
    expect(fleetBombardDamage(stateWith([{ weapon: 'laser_cannon', count: 8, mods: [] }]), 0, 8, 0)).toBe(8);
  });
  it('gives bombs one full-strength run per point of ammo', () => {
    // nuclear bomb avg 7.5 x 10 ammo = 75 per mount
    expect(fleetBombardDamage(stateWith([{ weapon: 'nuclear_bomb', count: 1, mods: [] }]), 0, 8, 0)).toBe(75);
  });
  it('gives missiles full damage across their ammo, x4 when MIRVed', () => {
    // nuclear missile avg 8 x 5 ammo = 40; MIRV x4 = 160
    expect(fleetBombardDamage(stateWith([{ weapon: 'nuclear_missile', count: 1, mods: [] }]), 0, 8, 0)).toBe(40);
    expect(fleetBombardDamage(stateWith([{ weapon: 'nuclear_missile', count: 1, mods: ['mv'] }]), 0, 8, 0)).toBe(160);
  });
  it('halves torpedoes and runs their ammo', () => {
    // anti-matter torpedo avg 25 -> 12.5 vs planet, x2 ammo = 25
    expect(fleetBombardDamage(stateWith([{ weapon: 'anti_matter_torpedo', count: 1, mods: [] }]), 0, 8, 0)).toBe(25);
  });
  it('excludes strike craft and non-converter specials', () => {
    expect(fleetBombardDamage(stateWith([{ weapon: 'bomber', count: 4, mods: [] }]), 0, 8, 0)).toBe(0);
    expect(fleetBombardDamage(stateWith([{ weapon: 'black_hole_generator', count: 1, mods: [] }]), 0, 8, 0)).toBe(0);
    expect(fleetBombardDamage(stateWith([{ weapon: 'stellar_converter', count: 1, mods: [] }]), 0, 8, 0)).toBe(250);
  });
  it('applies heavy-mount damage before halving', () => {
    // phasor avg 12.5, hv x1.5 rounds to 19 -> 9.5 vs planet; x4 mounts = 38
    expect(fleetBombardDamage(stateWith([{ weapon: 'phasor', count: 4, mods: ['hv'] }]), 0, 8, 0)).toBe(38);
  });
  it('blocks each individual run with the planetary shield', () => {
    // shield 5 zeroes lasers (1.25/run) no matter how many are mounted
    expect(fleetBombardDamage(stateWith([{ weapon: 'laser_cannon', count: 30, mods: [] }]), 0, 8, 5)).toBe(0);
    // nuclear bomb runs land 7.5 - 5 = 2.5 each: 10 runs = 25
    expect(fleetBombardDamage(stateWith([{ weapon: 'nuclear_bomb', count: 1, mods: [] }]), 0, 8, 5)).toBe(25);
    // barrier shield (20) stops nuclear bombs entirely
    expect(fleetBombardDamage(stateWith([{ weapon: 'nuclear_bomb', count: 1, mods: [] }]), 0, 8, 20)).toBe(0);
  });
  it('lets piercing mods through the planetary shield', () => {
    expect(fleetBombardDamage(stateWith([{ weapon: 'laser_cannon', count: 8, mods: ['sp'] }]), 0, 8, 20)).toBe(8);
    expect(fleetBombardDamage(stateWith([{ weapon: 'laser_cannon', count: 8, mods: ['ap'] }]), 0, 8, 20)).toBe(8);
  });
});

describe('planetShieldBlock', () => {
  it('reads the best planetary shield on the colony', () => {
    expect(planetShieldBlock(colonyWith([]))).toBe(0);
    expect(planetShieldBlock(colonyWith(['stellar_safety_shield']))).toBe(5);
    expect(planetShieldBlock(colonyWith(['stellar_safety_shield', 'planetary_flux_shield']))).toBe(10);
    expect(planetShieldBlock(colonyWith(['planetary_barrier_shield']))).toBe(20);
  });
});

// ---- per-turn bombardment caps by fleet hull weight ----

const SEED = '1234123412341234abcdabcdabcdabcd';
const FAT_BUILDINGS = ['automated_factory', 'hydroponic_farm', 'soil_enrichment', 'holo_simulator', 'marine_barracks'];

/** Fabricated raid: `hulls` bombard a 20-unit colony with 4 destructible
 * buildings (+ the untouchable marine_barracks). */
function raid(
  hulls: Array<{ hull: string; weapons: Array<{ weapon: string; count: number; mods: string[] }> }>,
  battleId = 'bT',
): { state: GameState; battle: PendingBattle; colony: { buildings: string[]; groups: Array<{ popK: number }> } } {
  const colony = {
    id: 60,
    owner: 1,
    planetId: 50,
    outpost: false,
    buildings: [...FAT_BUILDINGS],
    groups: [{ race: 0, popK: 20000, farmers: 0, workers: 0, scientists: 0 }],
  };
  const state = {
    seed: SEED,
    turn: 5,
    empires: [{ id: 0, designs: hulls.map((h, i) => ({ id: i + 1, hull: h.hull, weapons: h.weapons })) }],
    ships: hulls.map((h, i) => ({ id: 100 + i, owner: 0, shipKind: 'design', designId: i + 1, location: { kind: 'star', starId: 8 } })),
    planets: [{ id: 50, starId: 8 }],
    colonies: [colony],
  } as unknown as GameState;
  const battle = { id: battleId, starId: 8, attacker: 0, defender: 1, ordersA: null, ordersD: null } as PendingBattle;
  return { state, battle, colony };
}

const bombs = { weapon: 'nuclear_bomb', count: 8, mods: [] }; // 600 dmg per ship = 30 hits

describe('fleet hull weight', () => {
  it('weighs designed warships on the 1/2/4/6/12/24 ladder, civilians and scouts at 0', () => {
    expect(HULL_WEIGHT['frigate']).toBe(1);
    expect(HULL_WEIGHT['destroyer']).toBe(2);
    expect(HULL_WEIGHT['cruiser']).toBe(4);
    expect(HULL_WEIGHT['battleship']).toBe(6);
    expect(HULL_WEIGHT['titan']).toBe(12);
    expect(HULL_WEIGHT['doomstar']).toBe(24);
    const state = {
      empires: [{ id: 0, designs: [{ id: 1, hull: 'frigate' }, { id: 2, hull: 'battleship' }] }],
      ships: [
        { id: 1, owner: 0, shipKind: 'design', designId: 1, location: { kind: 'star', starId: 8 } },
        { id: 2, owner: 0, shipKind: 'design', designId: 2, location: { kind: 'star', starId: 8 } },
        { id: 3, owner: 0, shipKind: 'scout', designId: null, location: { kind: 'star', starId: 8 } },
        { id: 4, owner: 0, shipKind: 'colony_ship', designId: null, location: { kind: 'star', starId: 8 } },
        { id: 5, owner: 0, shipKind: 'design', designId: 2, location: { kind: 'star', starId: 9 } }, // elsewhere
      ],
    } as unknown as GameState;
    expect(fleetHullWeight(state, 0, 8)).toBe(7);
  });
});

describe('bombardment caps by fleet strength', () => {
  it('a strong fleet (weight >= 12) takes at most 3 pop + 1 building per turn', () => {
    const { state, battle, colony } = raid([
      { hull: 'titan', weapons: [bombs] },
      { hull: 'titan', weapons: [bombs] },
    ]);
    const report = bombard(state, battle, []) as { popKilled: number; buildingsDestroyed: string[] };
    expect(report.popKilled).toBe(3);
    expect(report.buildingsDestroyed).toHaveLength(1);
    expect(colony.groups[0]!.popK).toBe(17000);
    expect(colony.buildings).toContain('marine_barracks'); // barracks never bombed
  });

  it('a medium fleet (6-11) takes at most 2 pop + 1 building', () => {
    const { state, battle } = raid([{ hull: 'battleship', weapons: [bombs] }]); // weight 6
    const report = bombard(state, battle, []) as { popKilled: number; buildingsDestroyed: string[] };
    expect(report.popKilled).toBe(2);
    expect(report.buildingsDestroyed).toHaveLength(1);
  });

  it('a small fleet (< 6) takes at most 1 pop and a building only ~25% of the time', () => {
    let buildingsHit = 0;
    for (let i = 0; i < 200; i++) {
      const { state, battle } = raid([{ hull: 'frigate', weapons: [bombs] }], `b${i}`); // weight 1
      const report = bombard(state, battle, []) as { popKilled: number; buildingsDestroyed: string[] };
      expect(report.popKilled).toBe(1);
      expect(report.buildingsDestroyed.length).toBeLessThanOrEqual(1);
      buildingsHit += report.buildingsDestroyed.length;
    }
    // the 25% gate: mean 50/200, generous +-3.3 sigma band, and never zero
    expect(buildingsHit).toBeGreaterThanOrEqual(30);
    expect(buildingsHit).toBeLessThanOrEqual(70);
  });

  it('never raises damage: a barrage under the cap lands exactly as before', () => {
    // medium fleet, 30 laser damage = 1 hit total (cap 2+1 untouched)
    const one = raid([{ hull: 'battleship', weapons: [{ weapon: 'laser_cannon', count: 30, mods: [] }] }]);
    const r1 = bombard(one.state, one.battle, []) as { popKilled: number; buildingsDestroyed: string[] };
    expect(r1.popKilled + r1.buildingsDestroyed.length).toBe(1);
    // strong fleet, one bomb rack: 75 damage = 3 hits, all land (caps allow 3+1)
    const three = raid([
      { hull: 'battleship', weapons: [{ weapon: 'nuclear_bomb', count: 1, mods: [] }] },
      { hull: 'battleship', weapons: [] },
    ]);
    const r3 = bombard(three.state, three.battle, []) as { popKilled: number; buildingsDestroyed: string[] };
    expect(r3.popKilled + r3.buildingsDestroyed.length).toBe(3);
    expect(r3.popKilled).toBeLessThanOrEqual(3);
    expect(r3.buildingsDestroyed.length).toBeLessThanOrEqual(1);
    // under 20 damage nothing happens for any tier
    const nil = raid([{ hull: 'titan', weapons: [{ weapon: 'laser_cannon', count: 8, mods: [] }] }]);
    const r0 = bombard(nil.state, nil.battle, []) as { popKilled: number; buildingsDestroyed: string[] };
    expect(r0.popKilled + r0.buildingsDestroyed.length).toBe(0);
  });

  it('tier constants match the agreed ladder', () => {
    expect(MEDIUM_FLEET_WEIGHT).toBe(6);
    expect(STRONG_FLEET_WEIGHT).toBe(12);
  });
});
