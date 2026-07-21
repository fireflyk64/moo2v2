// Set-piece pattern battles (0.24.0): BattleInput.patterns turns the free-
// movement sim into a choreographed rock-paper-scissors of doctrines. These
// tests pin down (a) BYTE-EXACT legacy behavior for inputs without the flag
// (hashes captured at 0.23.0 HEAD before the rework), (b) determinism of the
// pattern sim, (c) the RPS signatures (2-pocket split, line-beats-charge),
// (d) slew shots actually happening, and (e) the lumbering exception.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORDERS,
  FIELD_H,
  FIELD_W,
  FP,
  PATTERN_MELEE,
  PATTERN_POCKET_YS,
  PATTERN_SPLIT_TICK,
  SLEW_FIRE_CD_PCT,
  doctrineOf,
  fastForwardWindow,
  headingDelta,
  headingToward,
  isLumbering,
  matchupScript,
  runBattle,
  type BattleInput,
  type BattleTickFrame,
  type CombatShipInit,
  type Doctrine,
} from '@engine/index';
import { hashString } from '@engine/hash';
import { rngFor } from '@engine/rng';

const SEED = '0123456789abcdef0123456789abcdef';

function ship(shipId: number, side: 0 | 1, opts?: Partial<CombatShipInit>): CombatShipInit {
  return {
    shipId,
    side,
    hull: 'frigate',
    hullIdx: 1,
    isBase: false,
    beamAttack: 25,
    beamDefense: 25,
    speed: 6,
    armorHp: 6,
    structureHp: 8,
    shieldPool: 0,
    shieldFlat: 0,
    weapons: [{ weaponId: 'laser_cannon', classId: 0, dmgMin: 1, dmgMax: 4, mods: [], ammo: -1, cooldown: 0, count: 1 }],
    startingStructure: 8,
    startingArmor: 6,
    ...(opts ?? {}),
  };
}

function inputOf(ships: CombatShipInit[], battleId = 'pat-test'): BattleInput {
  return {
    battleId,
    seedLabel: [1, 'battle', battleId],
    attacker: 0,
    defender: 1,
    ships,
    ordersA: { ...DEFAULT_ORDERS, retreatThresholdPct: 0 },
    ordersD: { ...DEFAULT_ORDERS, retreatThresholdPct: 0 },
  };
}

function runFrames(input: BattleInput): { frames: BattleTickFrame[]; result: ReturnType<typeof runBattle> } {
  const frames: BattleTickFrame[] = [];
  const result = runBattle(structuredClone(input), rngFor(SEED, ...input.seedLabel), (f) => frames.push(structuredClone(f)));
  return { frames, result };
}

function hashBattle(input: BattleInput): string {
  const { frames, result } = runFrames(input);
  return hashString(JSON.stringify({ frames, result }));
}

// ---------- (a) legacy byte-exactness ----------

/** the exact fixtures hashed at 0.23.0 HEAD (commit before this rework) */
function legacyFixtures(): Record<string, BattleInput> {
  const brawl: BattleInput = {
    battleId: 'legacy-brawl',
    seedLabel: [3, 'battle', 'legacy-brawl'],
    attacker: 0,
    defender: 1,
    ships: [
      ship(1, 0),
      ship(2, 0, { weapons: [{ weaponId: 'nuclear_missile', classId: 1, dmgMin: 8, dmgMax: 8, mods: [], ammo: 5, cooldown: 0, count: 2 }] }),
      ship(3, 0, { hullIdx: 3, speed: 4, structureHp: 20, startingStructure: 20 }),
      ship(101, 1),
      ship(102, 1, { weapons: [{ weaponId: 'laser_cannon', classId: 0, dmgMin: 1, dmgMax: 4, mods: ['pd'], ammo: -1, cooldown: 0, count: 2 }] }),
      ship(103, 1, { shieldPool: 6, shieldFlat: 1 }),
    ],
    ordersA: { ...DEFAULT_ORDERS },
    ordersD: { ...DEFAULT_ORDERS, stance: 'hold_range' },
  };
  const formation: BattleInput = {
    battleId: 'legacy-formation',
    seedLabel: [7, 'battle', 'legacy-formation'],
    attacker: 2,
    defender: 5,
    ships: [
      ...Array.from({ length: 9 }, (_, i) =>
        ship(i + 1, 0, {
          speed: 5 + (i % 3),
          weapons: [
            { weaponId: 'fusion_beam', classId: 0, dmgMin: 2, dmgMax: 6, mods: [], ammo: -1, cooldown: 0, count: 1, arc: i % 2 ? 'F' : 'FX' },
          ],
        }),
      ),
      ...Array.from({ length: 4 }, (_, i) => ship(101 + i, 1, { hullIdx: 4, speed: 3, structureHp: 30, startingStructure: 30 })),
      ship(120, 1, {
        hull: 'star_base',
        hullIdx: 7,
        isBase: true,
        speed: 0,
        structureHp: 60,
        startingStructure: 60,
        weapons: [{ weaponId: 'laser_cannon', classId: 0, dmgMin: 2, dmgMax: 5, mods: [], ammo: -1, cooldown: 0, count: 3, arc: '360' }],
      }),
    ],
    ordersA: { ...DEFAULT_ORDERS, formation: 'envelop' },
    ordersD: { ...DEFAULT_ORDERS, stance: 'hold_range', formation: 'line', retreatThresholdPct: 10 },
    slewing: true,
  };
  const titan: BattleInput = {
    battleId: 'legacy-titan',
    seedLabel: [11, 'battle', 'legacy-titan'],
    attacker: 0,
    defender: 3,
    ships: [
      ship(1, 0, { hullIdx: 5, speed: 3, structureHp: 120, startingStructure: 120, beamAttack: 60, weapons: [{ weaponId: 'graviton_beam', classId: 0, dmgMin: 3, dmgMax: 9, mods: ['hv'], ammo: -1, cooldown: 0, count: 4 }] }),
      ship(2, 0, { speed: 9 }),
      ship(3, 0, { speed: 9 }),
      ship(101, 1, { speed: 8, weapons: [{ weaponId: 'ion_pulse_cannon', classId: 0, dmgMin: 2, dmgMax: 7, mods: [], ammo: -1, cooldown: 0, count: 1, arc: '360' }] }),
      ship(102, 1, { speed: 8 }),
      ship(103, 1, { speed: 8 }),
      ship(104, 1, { speed: 8 }),
    ],
    ordersA: { ...DEFAULT_ORDERS, priority: 'deadliest' },
    ordersD: { ...DEFAULT_ORDERS, stance: 'standoff', retreatThresholdPct: 40 },
  };
  return { brawl, formation, titan };
}

describe('legacy byte-exactness (no patterns field)', () => {
  const captured: Record<string, string> = {
    brawl: 'b34931fa0082b1dc',
    formation: '468614373b5b03b7',
    titan: '3b49389f2dff5e04',
  };

  it('inputs WITHOUT patterns reproduce the pre-0.24 sim byte-for-byte', () => {
    for (const [name, input] of Object.entries(legacyFixtures())) {
      expect(hashBattle(input), name).toBe(captured[name]);
    }
  });

  it('patterns: false is byte-identical to an absent field', () => {
    for (const input of Object.values(legacyFixtures())) {
      const withFalse = structuredClone(input);
      withFalse.patterns = false;
      expect(hashBattle(withFalse)).toBe(hashBattle(input));
    }
  });
});

// ---------- doctrine + script mapping ----------

describe('doctrines and the matchup table', () => {
  it('doctrineOf: formation wins; stances collapse to line or charge', () => {
    expect(doctrineOf({ ...DEFAULT_ORDERS, formation: 'pincer' })).toBe('pincer');
    expect(doctrineOf({ ...DEFAULT_ORDERS, stance: 'hold_range', formation: 'envelop' })).toBe('envelop');
    expect(doctrineOf({ ...DEFAULT_ORDERS, stance: 'hold_range' })).toBe('line');
    expect(doctrineOf({ ...DEFAULT_ORDERS, stance: 'standoff' })).toBe('line');
    for (const st of ['charge', 'formation', 'passthrough', 'evade_retreat'] as const) {
      expect(doctrineOf({ ...DEFAULT_ORDERS, stance: st })).toBe('charge');
    }
  });

  it('matchupScript: wheel / split / grand_wheel / maneuvers', () => {
    expect(matchupScript('charge', 'charge')).toBe('wheel');
    for (const d of ['line', 'flank', 'pincer', 'envelop'] as Doctrine[]) {
      expect(matchupScript('charge', d)).toBe('split');
      expect(matchupScript(d, 'charge')).toBe('split');
    }
    expect(matchupScript('envelop', 'envelop')).toBe('grand_wheel');
    expect(matchupScript('line', 'line')).toBe('maneuvers');
    expect(matchupScript('line', 'flank')).toBe('maneuvers');
    expect(matchupScript('pincer', 'envelop')).toBe('maneuvers');
  });

  it('fastForwardWindow duty cycle scales with combat speed', () => {
    for (const speed of [0, 4, 8, 14, 20]) {
      let open = 0;
      for (let t = 0; t < 16; t++) if (fastForwardWindow(t, 1, speed)) open++;
      expect(open).toBe(Math.min(14, Math.max(0, speed)));
    }
  });

  it('slew cooldown penalty is harsh for capitals, near-free for frigates', () => {
    expect(SLEW_FIRE_CD_PCT[4]).toBeLessThan(SLEW_FIRE_CD_PCT[3]!);
    expect(SLEW_FIRE_CD_PCT[3]).toBeLessThan(SLEW_FIRE_CD_PCT[2]!);
    expect(SLEW_FIRE_CD_PCT[2]).toBeLessThan(SLEW_FIRE_CD_PCT[1]!);
  });
});

// ---------- (b) determinism ----------

describe('pattern sim determinism', () => {
  it('same input + seed twice: identical frames and outcome', () => {
    const mk = (): BattleInput => {
      const input = inputOf([
        ...Array.from({ length: 5 }, (_, i) => ship(i + 1, 0, { speed: 7 })),
        ship(6, 0, { weapons: [{ weaponId: 'nuclear_missile', classId: 1, dmgMin: 8, dmgMax: 8, mods: [], ammo: 5, cooldown: 0, count: 2 }] }),
        ...Array.from({ length: 5 }, (_, i) => ship(101 + i, 1, { speed: 7, shieldPool: 4, shieldFlat: 1 })),
      ], 'pat-det');
      input.ordersA = { ...input.ordersA, formation: 'pincer' };
      input.ordersD = { ...input.ordersD, stance: 'hold_range' };
      input.patterns = true;
      return input;
    };
    const a = runFrames(mk());
    const b = runFrames(mk());
    expect(a.frames).toEqual(b.frames);
    expect(a.result).toEqual(b.result);
  });
});

// ---------- (c) RPS signatures ----------

/** a long-range warship: high beam attack, heavy-mount forward beams */
function longRange(shipId: number, side: 0 | 1): CombatShipInit {
  return ship(shipId, side, {
    hullIdx: 2,
    speed: 6,
    beamAttack: 70,
    beamDefense: 20,
    structureHp: 24,
    startingStructure: 24,
    armorHp: 12,
    startingArmor: 12,
    weapons: [{ weaponId: 'graviton_beam', classId: 0, dmgMin: 3, dmgMax: 8, mods: ['hv'], ammo: -1, cooldown: 0, count: 2, arc: 'F' }],
  });
}

describe('rock-paper-scissors', () => {
  it('line beats charge when both fleets are long-range gunships', () => {
    const input = inputOf([
      ...Array.from({ length: 6 }, (_, i) => longRange(i + 1, 0)),
      ...Array.from({ length: 6 }, (_, i) => longRange(101 + i, 1)),
    ], 'rps-line-charge');
    input.ordersA = { ...input.ordersA, stance: 'charge' };
    input.ordersD = { ...input.ordersD, stance: 'hold_range' }; // doctrine: line
    input.patterns = true;
    const { result } = runFrames(input);
    // the wall keeps its bows on the pockets every tick; the circling
    // chargers only get F shots in lunges and fast windows — the line wins
    expect(result.winner).toBe(1);
    expect(result.defenderDamagePct).toBeLessThan(result.attackerDamagePct);
  });

  it('charge vs a formed doctrine produces the 2-pocket split', () => {
    // unarmed on both sides: pure choreography, runs the full 400 ticks
    const disarm = { weapons: [] as CombatShipInit['weapons'], structureHp: 50, startingStructure: 50 };
    const input = inputOf([
      ...Array.from({ length: 8 }, (_, i) => ship(i + 1, 0, { ...disarm, speed: 8 })),
      ...Array.from({ length: 6 }, (_, i) => ship(101 + i, 1, { ...disarm, speed: 8 })),
    ], 'rps-split');
    input.ordersA = { ...input.ordersA, stance: 'charge' };
    input.ordersD = { ...input.ordersD, formation: 'line' };
    input.patterns = true;
    expect(matchupScript(doctrineOf(input.ordersA), doctrineOf(input.ordersD))).toBe('split');
    const { frames } = runFrames(input);
    const f = frames[220]!;
    expect(f).toBeDefined();
    const pockets = [0, 0];
    for (let id = 1; id <= 8; id++) {
      const s = f.ships.find((x) => x.id === id)!;
      const dTop = Math.abs(s.y - PATTERN_POCKET_YS[0] * FP);
      const dBot = Math.abs(s.y - PATTERN_POCKET_YS[1] * FP);
      // every charger orbits one of the two pockets
      expect(Math.min(dTop, dBot)).toBeLessThan(90 * FP);
      pockets[dTop < dBot ? 0 : 1]!++;
      // and the pockets sit near midfield, not at either deployment edge
      expect(s.x).toBeGreaterThan(180 * FP);
      expect(s.x).toBeLessThan(FIELD_W - 180 * FP);
    }
    expect(pockets[0]).toBeGreaterThan(0);
    expect(pockets[1]).toBeGreaterThan(0);
    // and the split happens AFTER phase 1: at the split tick nobody has
    // reached a pocket orbit yet (they were still rushing the wall)
    const early = frames[PATTERN_SPLIT_TICK]!;
    const clustered = Array.from({ length: 8 }, (_, i) => early.ships.find((x) => x.id === i + 1)!).filter(
      (s) => Math.min(Math.abs(s.y - PATTERN_POCKET_YS[0] * FP), Math.abs(s.y - PATTERN_POCKET_YS[1] * FP)) < 60 * FP,
    );
    expect(clustered.length).toBeLessThan(8);
  });

  it('charge vs charge: both fleets close, then circle each other at close range', () => {
    const disarm = { weapons: [] as CombatShipInit['weapons'], structureHp: 50, startingStructure: 50 };
    const input = inputOf([
      ...Array.from({ length: 4 }, (_, i) => ship(i + 1, 0, { ...disarm, speed: 8 })),
      ...Array.from({ length: 4 }, (_, i) => ship(101 + i, 1, { ...disarm, speed: 8 })),
    ], 'rps-wheel');
    input.patterns = true; // both sides default to charge
    expect(matchupScript(doctrineOf(input.ordersA), doctrineOf(input.ordersD))).toBe('wheel');
    const { frames } = runFrames(input);
    const cx = FIELD_W / 2;
    const cy = FIELD_H / 2;
    const radius = (s: { x: number; y: number }) => Math.hypot(s.x - cx, s.y - cy);
    for (const t of [240, 300, 360]) {
      for (const s of frames[t]!.ships) {
        const r = radius(s);
        expect(r).toBeGreaterThan(30 * FP); // a wheel, not a blob
        expect(r).toBeLessThan(110 * FP); // ...at close range around midfield
      }
    }
    // and it actually TURNS: everyone keeps moving tick over tick
    const a = frames[300]!.ships.find((s) => s.id === 1)!;
    const b = frames[340]!.ships.find((s) => s.id === 1)!;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(30 * FP);
  });
});

// ---------- (d) slew shots ----------

describe('slewing under patterns', () => {
  /** charge-vs-charge wheel of forward-gunned ships: tangent headings leave
   * F mounts off-axis most segments — exactly where slew shots live */
  function wheelFleet(slewing: boolean): BattleInput {
    const gunship = (id: number, side: 0 | 1) =>
      ship(id, side, {
        speed: 6,
        structureHp: 300,
        startingStructure: 300,
        armorHp: 0,
        startingArmor: 0,
        beamAttack: 60,
        weapons: [{ weaponId: 'fusion_beam', classId: 0, dmgMin: 1, dmgMax: 2, mods: [], ammo: -1, cooldown: 0, count: 1, arc: 'F' }],
      });
    const input = inputOf([
      ...Array.from({ length: 3 }, (_, i) => gunship(i + 1, 0)),
      ...Array.from({ length: 3 }, (_, i) => gunship(101 + i, 1)),
    ], slewing ? 'pat-slew-on' : 'pat-slew-off');
    input.seedLabel = [1, 'battle', 'pat-slew']; // identical stream either way
    input.patterns = true;
    if (slewing) input.slewing = true;
    return input;
  }

  /** F shots fired while the shooter's choreographed heading was off-axis
   * (outside the strict pattern F cone), its fast window was closed, AND the
   * target was beyond charging-melee range — only slewing produces these */
  function offAxisClosedWindowShots(frames: BattleTickFrame[]): number {
    let count = 0;
    for (const f of frames) {
      for (const shot of f.shots) {
        if (shot.classId !== 0 || shot.to < 0) continue;
        const from = f.ships.find((s) => s.id === shot.from)!;
        const to = f.ships.find((s) => s.id === shot.to)!;
        if (Math.hypot(to.x - from.x, to.y - from.y) <= PATTERN_MELEE) continue;
        const bearing = headingToward(to.x - from.x, to.y - from.y);
        const off = Math.abs(headingDelta(from.h, bearing)) > 4;
        if (off && !fastForwardWindow(f.tick, shot.from, 6)) count++;
      }
    }
    return count;
  }

  it('slew shots happen with the option ON and never without it', () => {
    const off = runFrames(wheelFleet(false));
    const on = runFrames(wheelFleet(true));
    expect(offAxisClosedWindowShots(off.frames)).toBe(0);
    expect(offAxisClosedWindowShots(on.frames)).toBeGreaterThan(0);
    // and both runs still see in-window forward shots (engine power fires)
    const anyShots = (fr: BattleTickFrame[]) => fr.some((f) => f.shots.some((s) => s.classId === 0));
    expect(anyShots(off.frames)).toBe(true);
    expect(anyShots(on.frames)).toBe(true);
  });
});

// ---------- (e) the lumbering exception ----------

describe('lumbering ships', () => {
  it('isLumbering: bases, dead drives, slow hulls, big forward-gunned hulls', () => {
    const fBeam = [{ weaponId: 'x', classId: 0, dmgMin: 1, dmgMax: 2, mods: [], arc: 'F' as const }];
    const turret = [{ weaponId: 'x', classId: 0, dmgMin: 1, dmgMax: 2, mods: [], arc: '360' as const }];
    expect(isLumbering({ speed: 0, hullIdx: 7, isBase: true, weapons: [] })).toBe(true);
    expect(isLumbering({ speed: 0, hullIdx: 2, isBase: false, weapons: turret })).toBe(true);
    // titan (turn 1): speed 5 lumbers outright; speed 6 only when mostly-F
    expect(isLumbering({ speed: 5, hullIdx: 5, isBase: false, weapons: turret })).toBe(true);
    expect(isLumbering({ speed: 6, hullIdx: 5, isBase: false, weapons: fBeam })).toBe(true);
    expect(isLumbering({ speed: 6, hullIdx: 5, isBase: false, weapons: turret })).toBe(false);
    expect(isLumbering({ speed: 7, hullIdx: 5, isBase: false, weapons: fBeam })).toBe(false);
    // frigate (turn 4): even speed 4 flies the patterns
    expect(isLumbering({ speed: 4, hullIdx: 1, isBase: false, weapons: fBeam })).toBe(false);
    expect(isLumbering({ speed: 2, hullIdx: 1, isBase: false, weapons: fBeam })).toBe(true);
  });

  it('fast 360 frigates stay out of a slow all-F titan front arc', () => {
    const input = inputOf([
      ...Array.from({ length: 4 }, (_, i) =>
        ship(i + 1, 0, {
          speed: 10,
          structureHp: 60,
          startingStructure: 60,
          weapons: [{ weaponId: 'laser_cannon', classId: 0, dmgMin: 1, dmgMax: 2, mods: [], ammo: -1, cooldown: 0, count: 1, arc: '360' }],
        }),
      ),
      ship(101, 1, {
        hullIdx: 5,
        speed: 3, // mobility 4: lumbering — it creeps and fires from wherever
        structureHp: 400,
        startingStructure: 400,
        armorHp: 100,
        startingArmor: 100,
        beamAttack: 80,
        weapons: [{ weaponId: 'graviton_beam', classId: 0, dmgMin: 4, dmgMax: 10, mods: [], ammo: -1, cooldown: 0, count: 3, arc: 'F' }],
      }),
    ], 'pat-lumber');
    input.patterns = true;
    const { frames } = runFrames(input);
    expect(isLumbering(input.ships[4]!)).toBe(true);
    let samples = 0;
    let behind = 0;
    let near = 0;
    for (const f of frames) {
      if (f.tick < 80) continue;
      const titan = f.ships.find((s) => s.id === 101);
      if (!titan || !titan.alive) break;
      for (let id = 1; id <= 4; id++) {
        const fr = f.ships.find((s) => s.id === id)!;
        if (!fr.alive || fr.retreated) continue;
        samples++;
        const bearing = headingToward(fr.x - titan.x, fr.y - titan.y);
        if (Math.abs(headingDelta(titan.h, bearing)) > 8) behind++; // outside its F ±90°
        if (Math.hypot(fr.x - titan.x, fr.y - titan.y) < 140 * FP) near++;
      }
    }
    expect(samples).toBeGreaterThan(100);
    expect(behind / samples).toBeGreaterThan(0.75); // they live in its baffles
    expect(near / samples).toBeGreaterThan(0.6); // ...and stay engaged, not fleeing
  });
});
