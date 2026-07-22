import { describe, expect, it } from 'vitest';
import { DEFAULT_ORDERS, runBattle, type BattleInput, type CombatShipInit, type Stance } from '@engine/index';
import { rngFor } from '@engine/rng';

// Opt-in balance harness: MOO2_BALANCE=1 npm run test:balance
// Target envelope: equal-tech equal-cost fleets take 20-40% average fleet
// damage per pass (tune COMBAT_PACE / band tables when this drifts).
const enabled = process.env['MOO2_BALANCE'] === '1';

const SEED = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';

interface Archetype {
  name: string;
  ship: (id: number, side: 0 | 1) => CombatShipInit;
  count: number;
}

function mkShip(
  id: number,
  side: 0 | 1,
  o: { hull: string; hullIdx: number; atk: number; def: number; speed: number; armor: number; struct: number; pool: number; flat: number; weapons: CombatShipInit['weapons'] },
): CombatShipInit {
  return {
    shipId: id,
    side,
    hull: o.hull,
    hullIdx: o.hullIdx,
    isBase: false,
    beamAttack: o.atk,
    beamDefense: o.def,
    speed: o.speed,
    armorHp: o.armor,
    structureHp: o.struct,
    shieldPool: o.pool,
    shieldFlat: o.flat,
    weapons: o.weapons,
    startingStructure: o.struct,
    startingArmor: o.armor,
  };
}

// tier 1: laser frigates; tier 2: fusion destroyers; tier 3: graviton cruisers
const ARCHETYPES: Archetype[] = [
  {
    name: 'laser-frigates',
    count: 6,
    ship: (id, side) =>
      mkShip(id, side, {
        hull: 'frigate',
        hullIdx: 1,
        atk: 25,
        def: 33,
        speed: 4,
        armor: 4,
        struct: 4,
        pool: 5,
        flat: 1,
        weapons: [{ weaponId: 'laser_cannon', classId: 0, dmgMin: 1, dmgMax: 4, mods: [], ammo: -1, cooldown: 0, count: 2 }],
      }),
  },
  {
    name: 'fusion-destroyers',
    count: 4,
    ship: (id, side) =>
      mkShip(id, side, {
        hull: 'destroyer',
        hullIdx: 2,
        atk: 50,
        def: 28,
        speed: 5,
        armor: 20,
        struct: 20,
        pool: 30,
        flat: 3,
        weapons: [
          { weaponId: 'fusion_beam', classId: 0, dmgMin: 2, dmgMax: 6, mods: [], ammo: -1, cooldown: 0, count: 3 },
          { weaponId: 'nuclear_missile', classId: 1, dmgMin: 8, dmgMax: 8, mods: [], ammo: 5, cooldown: 0, count: 2 },
        ],
      }),
  },
  {
    name: 'graviton-cruisers',
    count: 3,
    ship: (id, side) =>
      mkShip(id, side, {
        hull: 'cruiser',
        hullIdx: 3,
        atk: 75,
        def: 25,
        speed: 6,
        armor: 150,
        struct: 150,
        pool: 75,
        flat: 5,
        weapons: [
          { weaponId: 'graviton_beam', classId: 0, dmgMin: 3, dmgMax: 15, mods: [], ammo: -1, cooldown: 0, count: 4 },
          { weaponId: 'merculite_missiles', classId: 1, dmgMin: 14, dmgMax: 14, mods: [], ammo: 5, cooldown: 0, count: 2 },
        ],
      }),
  },
];

const STANCE_PAIRS: Array<[Stance, Stance]> = [
  ['charge', 'charge'],
  ['charge', 'hold_range'],
  ['hold_range', 'standoff'],
];

function mirrorBattle(arch: Archetype, stances: [Stance, Stance], seedIdx: number, tactics = false): BattleInput {
  const ships: CombatShipInit[] = [];
  for (let i = 0; i < arch.count; i++) ships.push(arch.ship(i + 1, 0));
  for (let i = 0; i < arch.count; i++) ships.push(arch.ship(100 + i, 1));
  return {
    battleId: `bal-${arch.name}-${stances.join('-')}-${seedIdx}`,
    seedLabel: [seedIdx, 'battle', `bal-${arch.name}-${stances.join('.')}`],
    attacker: 0,
    defender: 1,
    ships,
    ordersA: { ...DEFAULT_ORDERS, stance: stances[0] },
    ordersD: { ...DEFAULT_ORDERS, stance: stances[1] },
    ...(tactics ? { patterns: true, tactics: true } : {}),
  };
}

describe.skipIf(!enabled)('combat balance envelope (opt-in)', () => {
  it('equal-tech mirror matches average 20-40% fleet damage per pass', () => {
    const rows: string[] = ['archetype,stanceA,stanceD,seed,aDmg,dDmg,ticks'];
    let sum = 0;
    let n = 0;
    for (const arch of ARCHETYPES) {
      for (const stances of STANCE_PAIRS) {
        for (let s = 0; s < 12; s++) {
          const input = mirrorBattle(arch, stances, s);
          const r = runBattle(input, rngFor(SEED, ...input.seedLabel));
          rows.push(`${arch.name},${stances[0]},${stances[1]},${s},${r.attackerDamagePct},${r.defenderDamagePct},${r.ticks}`);
          sum += r.attackerDamagePct + r.defenderDamagePct;
          n += 2;
        }
      }
    }
    const avg = sum / n;
    console.log(rows.join('\n'));
    console.log(`AVERAGE fleet damage per pass: ${avg.toFixed(1)}%  (target 20-40)`);
    expect(avg).toBeGreaterThanOrEqual(20);
    expect(avg).toBeLessThanOrEqual(40);
  }, 30_000); // hundreds of full battles: give the envelope real headroom

  // ...and the same envelope on the engine live games actually fight (0.26
  // doctrine tactics). The stance pairs map onto charge/line/standoff, so
  // this is three of the six doctrines against each other at equal tech.
  it('the doctrine engine lands in the same 20-40% envelope', () => {
    const rows: string[] = ['archetype,docA,docD,seed,aDmg,dDmg,ticks'];
    let sum = 0;
    let n = 0;
    for (const arch of ARCHETYPES) {
      for (const stances of STANCE_PAIRS) {
        for (let s = 0; s < 12; s++) {
          const input = mirrorBattle(arch, stances, s, true);
          const r = runBattle(input, rngFor(SEED, ...input.seedLabel));
          rows.push(`${arch.name},${stances[0]},${stances[1]},${s},${r.attackerDamagePct},${r.defenderDamagePct},${r.ticks}`);
          sum += r.attackerDamagePct + r.defenderDamagePct;
          n += 2;
        }
      }
    }
    const avg = sum / n;
    console.log(rows.join('\n'));
    console.log(`AVERAGE fleet damage per pass (tactics): ${avg.toFixed(1)}%  (target 20-40)`);
    expect(avg).toBeGreaterThanOrEqual(20);
    expect(avg).toBeLessThanOrEqual(40);
  }, 60_000);

  it('a full tech tier of advantage wins decisively', () => {
    let wins = 0;
    let games = 0;
    for (let s = 0; s < 10; s++) {
      const strong = ARCHETYPES[1]!; // destroyers vs frigates, equal-ish totals
      const weak = ARCHETYPES[0]!;
      const ships: CombatShipInit[] = [];
      for (let i = 0; i < strong.count; i++) ships.push(strong.ship(i + 1, 0));
      for (let i = 0; i < weak.count; i++) ships.push(weak.ship(100 + i, 1));
      const input: BattleInput = {
        battleId: `tier-${s}`,
        seedLabel: [s, 'battle', 'tier'],
        attacker: 0,
        defender: 1,
        ships,
        ordersA: { ...DEFAULT_ORDERS },
        ordersD: { ...DEFAULT_ORDERS },
      };
      const r = runBattle(input, rngFor(SEED, ...input.seedLabel));
      games++;
      if (r.winner === 0 || r.defenderDamagePct > r.attackerDamagePct + 20) wins++;
    }
    expect(wins / games).toBeGreaterThanOrEqual(0.8);
  });
});
