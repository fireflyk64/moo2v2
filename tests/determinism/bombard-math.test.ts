// MOO2 strategic-bombardment math: every weapon attacks the planet with its
// strategic damage — bombs/missiles full (one run per ammo, MIRV x4),
// beams/torpedoes half, strike craft never, specials only the stellar
// converter — and planetary shields block their strength from each run.
import { describe, expect, it } from 'vitest';
import { fleetBombardDamage, planetShieldBlock } from '@engine/battles';
import type { Colony, GameState } from '@engine/types';

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
