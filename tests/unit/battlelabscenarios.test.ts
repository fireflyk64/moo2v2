// Battle Lab scenarios (0.26): every curated matchup must (a) build under the
// max-tech lab empire with no design error, (b) fit its mounts in the hull,
// (c) be deterministic, and (d) actually be a FIGHT — not the laser-vs-shield
// stalemate the scenarios exist to replace. This mirrors BattleLab.svelte's
// group -> CombatShipInit path so the data and the sandbox never drift.
import { describe, expect, it } from 'vitest';
import {
  ARMOR_MULT,
  DEFAULT_ORDERS,
  HULLS_BUILDABLE,
  designStats,
  runBattle,
  type BattleInput,
  type CombatShipInit,
  type Empire,
  type GameState,
} from '@engine/index';
import { APPLICATION_ROWS, FIELD_ROWS } from '@engine/data/index';
import { rngFor } from '@engine/rng';
import { LAB_SCENARIOS, type ScenarioGroup, type ScenarioSide } from '@ui/screens/battleLabScenarios';

// the lab's "researched everything" empire
function labEmpire(id: number): Empire {
  return {
    id,
    name: id === 0 ? 'Blue Lab' : 'Red Lab',
    raceName: 'laboratory',
    picks: [],
    government: 'dictatorship',
    bc: 0,
    freighters: 0,
    research: { fieldNum: null, targetApp: null, accumRP: 0, extraQueue: [], extraAccumRP: 0, hyperLevels: {} },
    knownApps: APPLICATION_ROWS.map((a) => a.id).sort(),
    completedFields: FIELD_ROWS.map((f) => f.num).sort((a, b) => a - b),
    exploredStars: [],
    designs: [],
    spies: { count: 0, target: null, mode: 'steal' },
    leaders: [],
    eliminated: false,
  } as unknown as Empire;
}
const stubState = { settings: { modes: {} } } as unknown as GameState;
const empires = [labEmpire(0), labEmpire(1)];

function toCombat(side: 0 | 1, gr: ScenarioGroup, gi: number, n: number): CombatShipInit {
  const stats = designStats(stubState, empires[side]!, {
    name: 'lab',
    hull: gr.hull,
    computer: gr.computer ?? 3,
    shield: gr.shield ?? 3,
    specials: gr.specials ?? [],
    weapons: gr.weapons.map((x) => ({ weapon: x.weapon, count: x.count, mods: x.mods ?? [], arc: x.arc ?? 'F' })),
  });
  if (typeof stats === 'string') throw new Error(`${gr.hull}: ${stats}`);
  // fits in the hull
  expect(stats.spaceUsed, `${gr.hull} over capacity (${stats.spaceUsed}/${stats.spaceTotal})`).toBeLessThanOrEqual(
    stats.spaceTotal,
  );
  const armorTier = Math.max(1, Math.min(6, gr.armor ?? 3));
  const armorMult = ARMOR_MULT[armorTier - 1]!;
  const bestArmorMult = ARMOR_MULT[5]!;
  const armorHp = Math.max(1, Math.round((stats.armorHp * armorMult) / bestArmorMult));
  const structureHp = Math.max(1, Math.round((stats.structureHp * armorMult) / bestArmorMult));
  return {
    shipId: (side + 1) * 1000 + gi * 100 + n,
    side,
    hull: gr.hull,
    hullIdx: (HULLS_BUILDABLE as readonly string[]).indexOf(gr.hull) + 1,
    isBase: false,
    beamAttack: stats.beamAttack,
    beamDefense: stats.beamDefense,
    speed: gr.speed ?? stats.combatSpeed,
    armorHp,
    structureHp,
    shieldPool: stats.shieldPool,
    shieldFlat: stats.shieldFlat,
    weapons: stats.weapons.map((wp) => ({
      weaponId: wp.row.id,
      classId: wp.row.classId,
      dmgMin: wp.row.classId === 4 ? wp.row.strategicDamage.min : wp.row.tacticalDamage.min,
      dmgMax: wp.row.classId === 4 ? wp.row.strategicDamage.max : wp.row.tacticalDamage.max,
      mods: [...new Set([...wp.mods, ...wp.row.naturalMods])],
      ammo: wp.row.ammo,
      cooldown: 0,
      count: wp.count,
      arc: wp.arc,
    })),
    startingStructure: structureHp,
    startingArmor: armorHp,
    specials: gr.specials ?? [],
  };
}

function buildSide(side: 0 | 1, s: ScenarioSide): CombatShipInit[] {
  const ships: CombatShipInit[] = [];
  s.groups.forEach((gr, gi) => {
    for (let n = 0; n < Math.min(gr.count, 20); n++) ships.push(toCombat(side, gr, gi, n));
  });
  return ships;
}

function inputFor(scenarioId: string): BattleInput {
  const sc = LAB_SCENARIOS.find((x) => x.id === scenarioId)!;
  const ships = [...buildSide(0, sc.a), ...buildSide(1, sc.d)].sort((a, b) => a.shipId - b.shipId);
  return {
    battleId: `lab-${sc.seed}`,
    seedLabel: [0, 'battle', `lab-${sc.seed}`],
    attacker: 0,
    defender: 1,
    ships,
    ordersA: { ...DEFAULT_ORDERS, ...sc.a.orders },
    ordersD: { ...DEFAULT_ORDERS, ...sc.d.orders },
    patterns: true,
    tactics: true,
  };
}

const SEED = 'aabbccddeeff00112233445566778899';

describe('Battle Lab scenarios', () => {
  it('there are several, each with a name, blurb, seed and both sides armed', () => {
    expect(LAB_SCENARIOS.length).toBeGreaterThanOrEqual(5);
    const ids = new Set(LAB_SCENARIOS.map((s) => s.id));
    expect(ids.size).toBe(LAB_SCENARIOS.length); // unique ids
    for (const sc of LAB_SCENARIOS) {
      expect(sc.name.length).toBeGreaterThan(0);
      expect(sc.blurb.length).toBeGreaterThan(20);
      expect(sc.a.groups.length).toBeGreaterThan(0);
      expect(sc.d.groups.length).toBeGreaterThan(0);
    }
  });

  it('every ship in every scenario builds under a max-tech empire and fits its hull', () => {
    for (const sc of LAB_SCENARIOS) {
      expect(() => buildSide(0, sc.a), `${sc.id} side A`).not.toThrow();
      expect(() => buildSide(1, sc.d), `${sc.id} side D`).not.toThrow();
    }
  });

  it('each scenario is a real fight, not a stalemate, and is deterministic', () => {
    for (const sc of LAB_SCENARIOS) {
      const input = inputFor(sc.id);
      const a = runBattle(structuredClone(input), rngFor(SEED, ...input.seedLabel));
      const b = runBattle(structuredClone(input), rngFor(SEED, ...input.seedLabel));
      expect(a, `${sc.id} determinism`).toEqual(b);
      // SOMETHING happens: real damage on at least one side (the whole point —
      // the old laser-vs-shield-V default ended 0/0)
      const dmg = Math.max(a.attackerDamagePct, a.defenderDamagePct);
      expect(dmg, `${sc.id} did nothing (${a.attackerDamagePct}/${a.defenderDamagePct})`).toBeGreaterThan(15);
    }
  });

  it('the default scenario (first) is decisive enough to teach', () => {
    const input = inputFor(LAB_SCENARIOS[0]!.id);
    const r = runBattle(structuredClone(input), rngFor(SEED, ...input.seedLabel));
    // a clear result, not a mutual near-miss: the loser takes real losses
    const spread = Math.abs(r.attackerDamagePct - r.defenderDamagePct);
    expect(r.attackerDamagePct + r.defenderDamagePct).toBeGreaterThan(60);
    expect(spread).toBeGreaterThan(0);
  });
});
