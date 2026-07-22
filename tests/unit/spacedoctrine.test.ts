// Doctrine tactics (0.26.0): BattleInput.tactics replaces the 0.24 set-piece
// scripts with enemy-RELATIVE, table-driven choreography (spaceTactics.ts).
// These tests pin down (a) byte-exact 0.24/0.25 behavior for inputs without
// the flag, (b) determinism, (c) that each doctrine fights in its OWN range
// band, (d) the mechanics that make position and drives pay — rear-arc hits,
// strike-craft endurance, the fighting withdrawal, the envelop pin — and
// (e) a compact Monte Carlo gate showing no doctrine dominates.
//
// The full analysis harness is tests/balance/space-tactics-sim.test.ts:
//   MOO2_SPACE=1 npx vitest run tests/balance/space-tactics-sim.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORDERS,
  DOCTRINES,
  DOCTRINE_PROFILE,
  FIELD_H,
  FIELD_W,
  FP,
  EVASION_PER_MP,
  JUKE_MAX_OFF,
  JUKE_MP_PER_STEP,
  REAR_ARC_DMG_PCT,
  STANDOFF_SLACK,
  STRIKE_CRAFT_TICKS,
  assignTacticalGroups,
  pickDoctrine,
  runBattle,
  tacticalDoctrineOf,
  validateCommand,
  type BattleInput,
  type BattleTickFrame,
  type CombatShipInit,
  type Doctrine,
  type GameState,
} from '@engine/index';
import { hashString } from '@engine/hash';
import { rngFor } from '@engine/rng';
import { DOCTRINES as SIM_DOCTRINES, matchupSweep, meanEdge, ordersFor } from '../balance/lib/spacesim';

const SEED = '0123456789abcdef0123456789abcdef';

function ship(shipId: number, side: 0 | 1, opts?: Partial<CombatShipInit>): CombatShipInit {
  return {
    shipId,
    side,
    hull: 'frigate',
    hullIdx: 1,
    isBase: false,
    beamAttack: 30,
    beamDefense: 25,
    speed: 8,
    armorHp: 10,
    structureHp: 20,
    shieldPool: 0,
    shieldFlat: 0,
    weapons: [{ weaponId: 'laser_cannon', classId: 0, dmgMin: 2, dmgMax: 5, mods: [], ammo: -1, cooldown: 0, count: 1 }],
    startingStructure: 20,
    startingArmor: 10,
    ...(opts ?? {}),
  };
}

function inputOf(ships: CombatShipInit[], battleId: string): BattleInput {
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

function withDoctrines(input: BattleInput, a: Doctrine, d: Doctrine): BattleInput {
  const out = structuredClone(input);
  out.ordersA = { ...out.ordersA, stance: 'charge', formation: a };
  out.ordersD = { ...out.ordersD, stance: 'charge', formation: d };
  out.tactics = true;
  return out;
}

function runFrames(input: BattleInput): { frames: BattleTickFrame[]; result: ReturnType<typeof runBattle> } {
  const frames: BattleTickFrame[] = [];
  const result = runBattle(structuredClone(input), rngFor(SEED, ...input.seedLabel), (f) => frames.push(structuredClone(f)));
  return { frames, result };
}

/** mean distance between the two live fleet centroids, in field units */
function meanSeparation(frames: BattleTickFrame[], sides: Map<number, 0 | 1>, from = 40): number {
  let sum = 0;
  let n = 0;
  for (const f of frames) {
    if (f.tick < from) continue;
    let n0 = 0;
    let n1 = 0;
    let x0 = 0;
    let y0 = 0;
    let x1 = 0;
    let y1 = 0;
    for (const s of f.ships) {
      if (!s.alive || s.retreated) continue;
      if (sides.get(s.id) === 0) { n0++; x0 += s.x; y0 += s.y; } else { n1++; x1 += s.x; y1 += s.y; }
    }
    if (!n0 || !n1) continue;
    sum += Math.hypot(x0 / n0 - x1 / n1, y0 / n0 - y1 / n1) / FP;
    n++;
  }
  return n ? sum / n : 0;
}

// ---------- (a) byte-exactness for inputs without the flag ----------

/** the exact fixtures hashed at 0.25.0 HEAD (the commit before this rework) */
function patternFixtures(): Record<string, BattleInput> {
  const brawl = inputOf(
    [
      ship(1, 0),
      ship(2, 0, { weapons: [{ weaponId: 'nuclear_missile', classId: 1, dmgMin: 8, dmgMax: 8, mods: [], ammo: 5, cooldown: 0, count: 2 }] }),
      ship(3, 0, { hullIdx: 3, speed: 4, structureHp: 40, startingStructure: 40 }),
      ship(101, 1),
      ship(102, 1, { weapons: [{ weaponId: 'laser_cannon', classId: 0, dmgMin: 1, dmgMax: 4, mods: ['pd'], ammo: -1, cooldown: 0, count: 2 }] }),
      ship(103, 1, { shieldPool: 6, shieldFlat: 1 }),
    ],
    'doc-brawl',
  );
  brawl.patterns = true;
  const formed = inputOf(
    [
      ...Array.from({ length: 7 }, (_, i) => ship(i + 1, 0, { speed: 5 + (i % 3), hullIdx: 2 })),
      ...Array.from({ length: 4 }, (_, i) => ship(101 + i, 1, { hullIdx: 4, speed: 3, structureHp: 60, startingStructure: 60 })),
    ],
    'doc-formed',
  );
  formed.ordersA = { ...formed.ordersA, formation: 'envelop' };
  formed.ordersD = { ...formed.ordersD, stance: 'hold_range', formation: 'line' };
  formed.patterns = true;
  formed.slewing = true;
  const carrier = inputOf(
    [
      ...Array.from({ length: 3 }, (_, i) =>
        ship(i + 1, 0, {
          hullIdx: 4,
          speed: 6,
          structureHp: 90,
          startingStructure: 90,
          weapons: [{ weaponId: 'interceptor_bay', classId: 4, dmgMin: 4, dmgMax: 8, mods: [], ammo: 6, cooldown: 0, count: 2, arc: '360' }],
        }),
      ),
      ...Array.from({ length: 4 }, (_, i) => ship(101 + i, 1, { speed: 9 })),
    ],
    'doc-carrier',
  );
  carrier.ordersD = { ...carrier.ordersD, stance: 'standoff' };
  carrier.patterns = true;
  return { brawl, formed, carrier };
}

describe('0.24/0.25 pattern byte-exactness (no tactics field)', () => {
  const captured: Record<string, string> = {
    brawl: '42896c402999c2d5',
    formed: 'a50bcd202877b5c9',
    carrier: 'cc457c8e216efe21',
  };

  it('inputs WITHOUT tactics reproduce the pre-0.26 pattern sim byte-for-byte', () => {
    for (const [name, input] of Object.entries(patternFixtures())) {
      const { frames, result } = runFrames(input);
      expect(hashString(JSON.stringify({ frames, result })), name).toBe(captured[name]);
    }
  });

  it('tactics: false is byte-identical to an absent field', () => {
    for (const input of Object.values(patternFixtures())) {
      const off = structuredClone(input);
      off.tactics = false;
      const a = runFrames(off);
      const b = runFrames(input);
      expect(a.frames).toEqual(b.frames);
      expect(a.result).toEqual(b.result);
    }
  });
});

// ---------- doctrine plumbing ----------

describe('doctrine selection and groups', () => {
  it('tacticalDoctrineOf: an ordered formation IS the doctrine; standoff no longer folds into line', () => {
    for (const d of DOCTRINES) {
      expect(tacticalDoctrineOf({ ...DEFAULT_ORDERS, formation: d })).toBe(d);
    }
    expect(tacticalDoctrineOf({ ...DEFAULT_ORDERS, stance: 'standoff' })).toBe('standoff');
    expect(tacticalDoctrineOf({ ...DEFAULT_ORDERS, stance: 'hold_range' })).toBe('line');
    expect(tacticalDoctrineOf({ ...DEFAULT_ORDERS, stance: 'formation' })).toBe('line');
    for (const st of ['charge', 'passthrough', 'evade_retreat'] as const) {
      expect(tacticalDoctrineOf({ ...DEFAULT_ORDERS, stance: st })).toBe('charge');
    }
    // an explicit formation still wins over the stance
    expect(tacticalDoctrineOf({ ...DEFAULT_ORDERS, stance: 'standoff', formation: 'charge' })).toBe('charge');
  });

  it('battle_orders accepts every doctrine as a formation', () => {
    const state = { turn: 1, empires: [], ships: [], battles: [] } as unknown as GameState;
    for (const d of DOCTRINES) {
      // no such battle: the formation itself must not be what is rejected
      const err = validateCommand(state, {
        type: 'battle_orders',
        playerId: 0,
        turn: 1,
        payload: { battleId: 'nope', orders: { ...DEFAULT_ORDERS, formation: d } },
      } as never);
      expect(String(err ?? ''), d).not.toContain('formation');
    }
  });

  it('assignTacticalGroups: only the wing doctrines split, and never take the whole fleet', () => {
    const roster = Array.from({ length: 9 }, (_, i) => ({ shipId: i + 1, hullIdx: 1 + (i % 4), speed: 12 - i }));
    for (const d of DOCTRINES) {
      const groups = assignTacticalGroups(roster, d, 1);
      expect(groups.size).toBe(roster.length);
      const wings = [...groups.values()].filter((g) => g.g !== 0).length;
      const wanted = Math.floor((roster.length * DOCTRINE_PROFILE[d].strikePct) / 100);
      expect(wings, d).toBe(wanted);
      expect(wings, d).toBeLessThan(roster.length);
      // stable regardless of input order
      expect(assignTacticalGroups([...roster].reverse(), d, 1)).toEqual(groups);
    }
    // flank sends its wing to ONE side; pincer alternates both
    const flank = assignTacticalGroups(roster, 'flank', 1);
    expect(new Set([...flank.values()].filter((g) => g.g !== 0).map((g) => g.g))).toEqual(new Set([1]));
    const pincer = assignTacticalGroups(roster, 'pincer', 1);
    expect(new Set([...pincer.values()].filter((g) => g.g !== 0).map((g) => g.g))).toEqual(new Set([1, 2]));
  });

  it('the profile table puts the doctrines in genuinely different range bands', () => {
    const P = DOCTRINE_PROFILE;
    // short (<=96u), medium (<=224u), long (<=448u) — the bands combat.ts scores
    expect(P.charge.standU).toBeLessThanOrEqual(96);
    expect(P.envelop.standU).toBeLessThanOrEqual(96);
    expect(P.line.standU).toBeGreaterThan(96);
    expect(P.line.standU).toBeLessThanOrEqual(224);
    expect(P.flank.standU).toBeLessThanOrEqual(224);
    expect(P.standoff.standU).toBeGreaterThan(224);
    expect(P.standoff.standU).toBeLessThanOrEqual(448);
    // only a standoff gives ground, and it pays speed for the privilege
    for (const d of DOCTRINES) expect(P[d].giveGround, d).toBe(d === 'standoff');
    // the abeam withdrawal course is itself the price of running (combat.ts
    // charges a quarter of the way for it); runPct is the fine-tune on top
    expect(P.standoff.runPct).toBeGreaterThan(0);
    expect(P.standoff.runPct).toBeLessThanOrEqual(100);
    expect(STANDOFF_SLACK).toBeGreaterThan(0);
  });
});

// ---------- (b) determinism ----------

describe('tactics determinism', () => {
  it('same input + seed twice: identical frames and outcome', () => {
    const base = inputOf(
      [
        ...Array.from({ length: 6 }, (_, i) => ship(i + 1, 0, { speed: 7 + (i % 3) })),
        ...Array.from({ length: 6 }, (_, i) => ship(101 + i, 1, { speed: 8, shieldPool: 4, shieldFlat: 1 })),
      ],
      'doc-det',
    );
    const input = withDoctrines(base, 'pincer', 'standoff');
    const a = runFrames(input);
    const b = runFrames(input);
    expect(a.frames).toEqual(b.frames);
    expect(a.result).toEqual(b.result);
  });
});

// ---------- (c) doctrines fight where the table says ----------

describe('each doctrine fights in its own band', () => {
  const mk = () =>
    inputOf(
      [
        ...Array.from({ length: 6 }, (_, i) => ship(i + 1, 0, { speed: 8, structureHp: 400, startingStructure: 400, weapons: [] })),
        ...Array.from({ length: 6 }, (_, i) => ship(101 + i, 1, { speed: 8, structureHp: 400, startingStructure: 400, weapons: [] })),
      ],
      'doc-band',
    );

  it('separation follows standU: charge closes, line holds the middle, standoff keeps the long band', () => {
    const sides = new Map<number, 0 | 1>(mk().ships.map((s) => [s.shipId, s.side]));
    const sepOf = (a: Doctrine, d: Doctrine) => meanSeparation(runFrames(withDoctrines(mk(), a, d)).frames, sides);
    // unarmed hulls of equal speed: pure choreography, no attrition. Note the
    // standoff pair is measured against a LINE that is not chasing it — a
    // standoff being run down by a faster fleet loses its band, by design
    // (see the drive-race test below).
    const charge = sepOf('charge', 'charge');
    const line = sepOf('line', 'line');
    const standoff = sepOf('standoff', 'standoff');
    expect(charge).toBeLessThan(line);
    expect(line).toBeLessThan(standoff);
    expect(charge).toBeLessThan(DOCTRINE_PROFILE.line.standU);
    expect(standoff).toBeGreaterThan(DOCTRINE_PROFILE.line.standU);
  });

  it('a standoff HOLDS the range against slower ships and loses it to faster ones', () => {
    const race = (kiterSpeed: number, chaserSpeed: number) => {
      const input = inputOf(
        [
          ...Array.from({ length: 5 }, (_, i) =>
            ship(i + 1, 0, { speed: kiterSpeed, structureHp: 400, startingStructure: 400, weapons: [] }),
          ),
          ...Array.from({ length: 5 }, (_, i) =>
            ship(101 + i, 1, { speed: chaserSpeed, structureHp: 400, startingStructure: 400, weapons: [] }),
          ),
        ],
        `doc-race-${kiterSpeed}-${chaserSpeed}`,
      );
      const sides = new Map<number, 0 | 1>(input.ships.map((s) => [s.shipId, s.side]));
      return meanSeparation(runFrames(withDoctrines(input, 'standoff', 'charge')).frames, sides, 120);
    };
    const fast = race(12, 6);
    const even = race(8, 8);
    const slow = race(5, 11);
    expect(fast).toBeGreaterThan(even);
    expect(even).toBeGreaterThan(slow);
    // a fleet that cannot outrun its pursuer ends the fight at knife range
    expect(slow).toBeLessThan(140);
  });

  it('there is nowhere to run from an envelop: the pin holds the runner', () => {
    const mkRace = (foe: Doctrine) => {
      const input = inputOf(
        [
          ...Array.from({ length: 5 }, (_, i) => ship(i + 1, 0, { speed: 13, structureHp: 400, startingStructure: 400, weapons: [] })),
          ...Array.from({ length: 5 }, (_, i) => ship(101 + i, 1, { speed: 7, structureHp: 400, startingStructure: 400, weapons: [] })),
        ],
        `doc-pin-${foe}`,
      );
      const sides = new Map<number, 0 | 1>(input.ships.map((s) => [s.shipId, s.side]));
      return meanSeparation(runFrames(withDoctrines(input, 'standoff', foe)).frames, sides, 100);
    };
    // the same faster kiter holds its band against a wall that will not chase
    // it past its own, and cannot hold it at all against a closing net
    expect(mkRace('envelop')).toBeLessThan(mkRace('line'));
  });
});

// ---------- (d) the mechanics that make position and drives pay ----------

describe('rear-arc hits', () => {
  /** a turret ring closing on slow capitals: collect SHORT-band hits and split
   * them by whether the shooter sat astern of the victim's beam. Damage is a
   * fixed number and the short band does not scale it, so the two buckets
   * differ by exactly the table multiplier. */
  function buckets(tactics: boolean): { bow: number[]; astern: number[] } {
    const base = 10;
    const input: BattleInput = {
      battleId: `rear-${tactics}`,
      seedLabel: [5, 'battle', 'rear'],
      attacker: 0,
      defender: 1,
      ships: [
        ...Array.from({ length: 9 }, (_, i) =>
          ship(i + 1, 0, {
            speed: 12,
            beamAttack: 300, // never misses: we are measuring damage, not luck
            weapons: [
              { weaponId: 'laser_cannon', classId: 0, dmgMin: base, dmgMax: base, mods: [], ammo: -1, cooldown: 0, count: 1, arc: '360' },
            ],
          }),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          ship(101 + i, 1, {
            hullIdx: 5,
            speed: 4,
            structureHp: 4000,
            startingStructure: 4000,
            armorHp: 0,
            startingArmor: 0,
            beamAttack: 300,
            weapons: [
              { weaponId: 'graviton_beam', classId: 0, dmgMin: base, dmgMax: base, mods: [], ammo: -1, cooldown: 0, count: 1, arc: 'F' },
            ],
          }),
        ),
      ],
      ordersA: { ...DEFAULT_ORDERS, retreatThresholdPct: 0, formation: 'envelop' },
      ordersD: { ...DEFAULT_ORDERS, retreatThresholdPct: 0, formation: 'line' },
      patterns: true,
      ...(tactics ? { tactics: true } : {}),
    };
    const { frames } = runFrames(input);
    const out = { bow: [] as number[], astern: [] as number[] };
    for (const f of frames) {
      const pos = new Map(f.ships.map((s) => [s.id, s]));
      for (const sh of f.shots) {
        if (!sh.hit || sh.to < 0 || sh.from > 100) continue;
        const from = pos.get(sh.from);
        const to = pos.get(sh.to);
        if (!from || !to) continue;
        if (Math.hypot(to.x - from.x, to.y - from.y) / FP > 96) continue; // short band only
        const bear = Math.atan2(from.y - to.y, from.x - to.x);
        const off = Math.abs(((bear - (to.h * Math.PI) / 16 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
        // the engine judges this on 32 quantised headings; skip the shots
        // sitting within one step of the beam rather than disagree by a hair
        const step = Math.PI / 16;
        if (Math.abs(off - Math.PI / 2) < step) continue;
        (off > Math.PI / 2 ? out.astern : out.bow).push(sh.dmg);
      }
    }
    return out;
  }

  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);

  it('direct fire from astern of the beam does REAR_ARC_DMG_PCT of its damage', () => {
    expect(REAR_ARC_DMG_PCT).toBeGreaterThan(100);
    const on = buckets(true);
    expect(on.bow.length).toBeGreaterThan(5);
    expect(on.astern.length).toBeGreaterThan(5);
    expect(Math.round((100 * mean(on.astern)) / mean(on.bow))).toBe(REAR_ARC_DMG_PCT);
  });

  it('...and never on the pattern engine, where every arc is worth the same', () => {
    const off = buckets(false);
    expect(off.bow.length + off.astern.length).toBeGreaterThan(5);
    if (off.astern.length > 0 && off.bow.length > 0) {
      expect(mean(off.astern)).toBe(mean(off.bow));
    }
  });
});

describe('strike-craft endurance', () => {
  /** carriers on one side, unarmed targets on the other; count sorties landed */
  function sorties(doc: Doctrine): number {
    const input = inputOf(
      [
        ...Array.from({ length: 3 }, (_, i) =>
          ship(i + 1, 0, {
            hullIdx: 4,
            speed: 8,
            structureHp: 300,
            startingStructure: 300,
            weapons: [{ weaponId: 'interceptor_bay', classId: 4, dmgMin: 6, dmgMax: 6, mods: [], ammo: 20, cooldown: 0, count: 2, arc: '360' }],
          }),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          ship(101 + i, 1, { speed: 8, structureHp: 3000, startingStructure: 3000, armorHp: 0, startingArmor: 0, weapons: [] }),
        ),
      ],
      `doc-sortie-${doc}`,
    );
    const { frames } = runFrames(withDoctrines(input, doc, 'line'));
    let landed = 0;
    for (const f of frames) for (const s of f.shots) if (s.classId === 4 && s.hit) landed++;
    return landed;
  }

  it('sorties land from a charge and never from a standoff — carriers are a short-range weapon', () => {
    expect(STRIKE_CRAFT_TICKS).toBeGreaterThan(0);
    const close = sorties('charge');
    const far = sorties('standoff');
    expect(close).toBeGreaterThan(10);
    expect(far * 3).toBeLessThan(close);
  });
});

describe('jukes and motion evasion', () => {
  /** a running standoff of forward-gunned hulls: the abeam withdrawal course
   * is exactly what puts their F mounts off-axis, so every shot they land
   * beyond knife range was bought with a juke. hullIdx sets the turn rate,
   * which is what the juke price is divided by. */
  function runningShots(hullIdx: number): number {
    const input = inputOf(
      [
        ...Array.from({ length: 6 }, (_, i) =>
          ship(i + 1, 0, {
            hullIdx,
            speed: 12,
            structureHp: 1200,
            startingStructure: 1200,
            beamAttack: 200,
            weapons: [{ weaponId: 'laser_cannon', classId: 0, dmgMin: 1, dmgMax: 1, mods: [], ammo: -1, cooldown: 0, count: 1, arc: 'F' }],
          }),
        ),
        ...Array.from({ length: 6 }, (_, i) =>
          ship(101 + i, 1, { speed: 6, structureHp: 1200, startingStructure: 1200, weapons: [] }),
        ),
      ],
      `juke-run-${hullIdx}`,
    );
    const { frames } = runFrames(withDoctrines(input, 'standoff', 'charge'));
    let n = 0;
    for (const f of frames) {
      if (f.tick < 60) continue;
      const pos = new Map(f.ships.map((q) => [q.id, q]));
      for (const sh of f.shots) {
        if (sh.from > 100 || sh.to < 0) continue;
        const a = pos.get(sh.from);
        const b = pos.get(sh.to);
        if (!a || !b) continue;
        if (Math.hypot(b.x - a.x, b.y - a.y) / FP <= 48) continue; // melee arcs are free
        const bear = Math.atan2(b.y - a.y, b.x - a.x);
        const d = Math.abs(((bear - (a.h * Math.PI) / 16 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
        if (d > Math.PI / 4 + 0.2) n++; // outside the strict pattern F cone: a juke bought this
      }
    }
    return n;
  }

  it('a nimble hull jukes its forward guns onto a target while running; a capital cannot', () => {
    expect(JUKE_MP_PER_STEP).toBeGreaterThan(0);
    expect(JUKE_MAX_OFF).toBeGreaterThan(4);
    const frigate = runningShots(1); // turn rate 4
    const titan = runningShots(5); // turn rate 1: the same juke costs four times as much
    expect(frigate).toBeGreaterThan(50);
    // the capital still gets the shots it can afford on the ticks it is not
    // straining to hold station — it just buys far fewer of them
    expect(titan).toBeLessThan(frigate * 0.8);
  });

  it('motion evasion is paid for in movement: a doctrine that stands still earns none', () => {
    expect(EVASION_PER_MP).toBeGreaterThan(0);
    // measure how far the row doctrine's ships actually travel per tick
    const travelled = (doctrine: Doctrine) => {
      const input = inputOf(
        [
          ...Array.from({ length: 6 }, (_, i) => ship(i + 1, 0, { speed: 9, structureHp: 900, startingStructure: 900 })),
          ...Array.from({ length: 6 }, (_, i) => ship(101 + i, 1, { speed: 9, structureHp: 900, startingStructure: 900 })),
        ],
        `evade-${doctrine}`,
      );
      const { frames } = runFrames(withDoctrines(input, doctrine, 'line'));
      let sum = 0;
      let n = 0;
      for (let i = 1; i < frames.length; i++) {
        if (frames[i]!.tick < 120) continue;
        for (const s of frames[i]!.ships) {
          if (s.id > 100 || !s.alive || s.retreated) continue;
          const p = frames[i - 1]!.ships.find((q) => q.id === s.id);
          if (!p) continue;
          sum += Math.hypot(s.x - p.x, s.y - p.y) / FP;
          n++;
        }
      }
      return n ? sum / n : 0;
    };
    // a formed wall is nearly motionless; a charge weaves across its
    // victim's stern and never stops. The gap is what the evasion term
    // trades against the wall's free juke allowance.
    const wall = travelled('line');
    const dogfight = travelled('charge');
    expect(wall).toBeLessThan(1.0);
    expect(dogfight).toBeGreaterThan(wall * 1.5);
    expect(DOCTRINE_PROFILE.line.holdsStation).toBe(true);
    expect(DOCTRINE_PROFILE.charge.holdsStation).toBe(false);
    expect(DOCTRINE_PROFILE.charge.spin16).toBeGreaterThan(0);
  });
});

// ---------- (e) no doctrine dominates ----------

describe('doctrine balance', () => {
  it('over a compact sweep no single doctrine is the right answer everywhere', { timeout: 300_000 }, () => {
    // Six matchups between fleets that want different things; every doctrine
    // pair, both deployment orientations. The gate is deliberately about
    // SHAPE, not magnitude — a tuning pass should move the numbers without
    // flaking the test (see the selfplay re-baseline lesson).
    const pairs: Array<[string, string]> = [
      ['slow_missile', 'beam_skirmisher'],
      ['fast_carrier', 'heavy_line'],
      ['turret_cruiser', 'shield_wall'],
      ['beam_skirmisher', 'heavy_line'],
      ['pd_escort', 'torpedo_raider'],
      ['fx_destroyer', 'boarding_assault'],
    ];
    const bestOf: string[] = [];
    const worstOf: string[] = [];
    for (const [x, y] of pairs) {
      const cells = matchupSweep(x, y, 1, { retreatPct: 0, tactics: true });
      const means = SIM_DOCTRINES.map((da) => {
        let sum = 0;
        for (const db of SIM_DOCTRINES) sum += meanEdge(cells.get(da)!.get(db)!);
        return sum / SIM_DOCTRINES.length;
      });
      bestOf.push(SIM_DOCTRINES[means.indexOf(Math.max(...means))]!);
      worstOf.push(SIM_DOCTRINES[means.indexOf(Math.min(...means))]!);
    }
    // no doctrine is a free win in every matchup, and none is a universal trap
    expect(new Set(bestOf).size, `best per matchup: ${bestOf.join(', ')}`).toBeGreaterThan(1);
    expect(new Set(worstOf).size, `worst per matchup: ${worstOf.join(', ')}`).toBeGreaterThan(1);
    for (const d of SIM_DOCTRINES) {
      expect(bestOf.filter((b) => b === d).length, `${d} wins every matchup`).toBeLessThan(pairs.length);
    }
  });

  it('the doctrine CHOICE moves the result: leverage inside a fixed matchup is large', { timeout: 300_000 }, () => {
    const cells = matchupSweep('slow_missile', 'beam_skirmisher', 1, { retreatPct: 0, tactics: true });
    const means = SIM_DOCTRINES.map((da) => {
      let s = 0;
      for (const db of SIM_DOCTRINES) s += meanEdge(cells.get(da)!.get(db)!);
      return s / SIM_DOCTRINES.length;
    });
    expect(Math.max(...means) - Math.min(...means)).toBeGreaterThan(5);
  });

  it('ordersFor maps every sim doctrine onto orders the engine reads back', () => {
    for (const d of SIM_DOCTRINES) {
      expect(tacticalDoctrineOf(ordersFor(d, 0, true))).toBe(d);
    }
  });
});

describe('pickDoctrine (what the bots reason with)', () => {
  const fleet = (o: Partial<Parameters<typeof pickDoctrine>[0]>) => ({
    hulls: 8,
    guidedPct: 0,
    strikePct: 0,
    speed: 7,
    hullIdx: 3,
    ...o,
  });
  const open = { defending: false, ownBases: false, enemyBases: false };

  it('fights under its own orbital guns as a line', () => {
    expect(pickDoctrine(fleet({ speed: 12, hullIdx: 1 }), { ...open, ownBases: true })).toBe('line');
  });

  it('closes when it is carrying weapons that only work close', () => {
    // strike craft and boarding shuttles have ~170u of legs
    expect(pickDoctrine(fleet({ strikePct: 40, speed: 4, hullIdx: 5 }), open)).toBe('charge');
    expect(pickDoctrine(fleet({ strikePct: 40, speed: 9, hullIdx: 4 }), open)).toBe('envelop');
  });

  it('holds the range when it is throwing warheads and can keep it', () => {
    expect(pickDoctrine(fleet({ guidedPct: 70, speed: 6 }), open)).toBe('standoff');
    // ...but a fleet that cannot make way cannot hold anything
    expect(pickDoctrine(fleet({ guidedPct: 70, speed: 3, hullIdx: 5 }), open)).not.toBe('standoff');
  });

  it('closes a net on orbital defenses, which cannot answer the helm', () => {
    expect(pickDoctrine(fleet({ speed: 8 }), { ...open, enemyBases: true })).toBe('envelop');
  });

  it('sends fast light hulls for the flanks', () => {
    expect(pickDoctrine(fleet({ speed: 10, hullIdx: 2, hulls: 7 }), open)).toBe('flank');
    expect(pickDoctrine(fleet({ speed: 10, hullIdx: 2, hulls: 14 }), open)).toBe('pincer');
  });

  it('always returns a doctrine the engine understands', () => {
    for (const guidedPct of [0, 50, 100]) {
      for (const strikePct of [0, 30]) {
        for (const speed of [2, 5, 9, 13]) {
          for (const hullIdx of [1, 3, 5]) {
            for (const hulls of [0, 1, 6, 12]) {
              for (const defending of [false, true]) {
                const d = pickDoctrine(fleet({ guidedPct, strikePct, speed, hullIdx, hulls }), { ...open, defending });
                expect(DOCTRINES).toContain(d);
              }
            }
          }
        }
      }
    }
  });
});

// the field constants the geometry is written against
describe('field', () => {
  it('is the documented 768x576', () => {
    expect(FIELD_W / FP).toBe(768);
    expect(FIELD_H / FP).toBe(576);
  });
});
