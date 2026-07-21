// Space-combat tactics (0.23.0): fleet FORMATIONS (line/flank/pincer/envelop
// battle order — deterministic per-ship roles, wings that actually swing wide)
// and the SLEWING game option (spend movement to rotate beyond the hull turn
// rate and bring F-arc guns onto off-axis targets). Absent fields must stay
// byte-exact legacy.
import { describe, expect, it } from 'vitest';
import {
  assignFormationRoles,
  DEFAULT_ORDERS,
  FIELD_H,
  FIELD_W,
  FP,
  LINE_WALL_X,
  gameEngine,
  headingDelta,
  runBattle,
  validateCommand,
  type BattleInput,
  type BattleTickFrame,
  type CombatShipInit,
  type GameState,
} from '@engine/index';
import { buildBattleInput } from '@engine/battles';
import { rngFor } from '@engine/rng';
import { DEFAULT_SETTINGS } from '@protocol/messages';

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

function inputOf(ships: CombatShipInit[], battleId = 'tac-test'): BattleInput {
  return {
    battleId,
    seedLabel: [1, 'battle', battleId],
    attacker: 0,
    defender: 1,
    ships,
    ordersA: { ...DEFAULT_ORDERS, retreatThresholdPct: 0 },
    ordersD: { ...DEFAULT_ORDERS, stance: 'hold_range', retreatThresholdPct: 0 },
  };
}

function runFrames(input: BattleInput): { frames: BattleTickFrame[]; result: ReturnType<typeof runBattle> } {
  const frames: BattleTickFrame[] = [];
  const result = runBattle(input, rngFor(SEED, ...input.seedLabel), (f) => frames.push(structuredClone(f)));
  return { frames, result };
}

const trackOf = (frames: BattleTickFrame[], id: number) =>
  frames.map((f) => f.ships.find((s) => s.id === id)!);

describe('formation role assignment', () => {
  const roster = [
    { shipId: 1, hullIdx: 5, speed: 2, isBase: false }, // titan
    { shipId: 2, hullIdx: 4, speed: 3, isBase: false },
    { shipId: 3, hullIdx: 3, speed: 4, isBase: false },
    { shipId: 4, hullIdx: 2, speed: 6, isBase: false },
    { shipId: 5, hullIdx: 1, speed: 8, isBase: false },
    { shipId: 6, hullIdx: 1, speed: 8, isBase: false },
    { shipId: 7, hullIdx: 1, speed: 8, isBase: false },
    { shipId: 8, hullIdx: 9, speed: 0, isBase: true }, // base: never a role
    { shipId: 9, hullIdx: 2, speed: 0, isBase: false }, // immobile: never a role
  ];

  it('is deterministic and stable-ordered', () => {
    for (const f of ['line', 'flank', 'pincer', 'envelop'] as const) {
      expect(assignFormationRoles(roster, f, 'wingA')).toEqual(assignFormationRoles(roster, f, 'wingA'));
      // shuffled roster input: same roles (ordering is by keys, not position)
      expect(assignFormationRoles([...roster].reverse(), f, 'wingA')).toEqual(assignFormationRoles(roster, f, 'wingA'));
    }
  });

  it('assigns the documented roles per formation', () => {
    // line: heaviest ceil(7/2)=4 mobile hulls wall up; the rest skirmish (no role)
    expect(assignFormationRoles(roster, 'line', 'wingA')).toEqual(
      new Map([[1, 'hold'], [2, 'hold'], [3, 'hold'], [4, 'hold']]),
    );
    // flank: fastest floor(7/3)=2 swing to the chosen wing, the rest hold
    expect(assignFormationRoles(roster, 'flank', 'wingB')).toEqual(
      new Map([[5, 'wingB'], [6, 'wingB'], [7, 'hold'], [4, 'hold'], [3, 'hold'], [2, 'hold'], [1, 'hold']]),
    );
    // pincer: the same fast wing alternates sides
    expect(assignFormationRoles(roster, 'pincer', 'wingA')).toEqual(
      new Map([[5, 'wingA'], [6, 'wingB'], [7, 'hold'], [4, 'hold'], [3, 'hold'], [2, 'hold'], [1, 'hold']]),
    );
    // envelop: two fast wings + slow center
    expect(assignFormationRoles(roster, 'envelop', 'wingA')).toEqual(
      new Map([[5, 'wingA'], [6, 'wingA'], [7, 'wingB'], [4, 'wingB'], [3, 'center'], [2, 'center'], [1, 'center']]),
    );
    // bases and immobile ships never appear
    for (const f of ['line', 'flank', 'pincer', 'envelop'] as const) {
      const roles = assignFormationRoles(roster, f, 'wingA');
      expect(roles.has(8)).toBe(false);
      expect(roles.has(9)).toBe(false);
    }
  });
});

describe('formation movement', () => {
  it('envelop wings actually swing wide (positions diverge from massed)', () => {
    const mk = () => [
      ...Array.from({ length: 9 }, (_, i) => ship(i + 1, 0)),
      ...Array.from({ length: 3 }, (_, i) => ship(101 + i, 1, { speed: 4 })),
    ];
    const massed = runFrames(inputOf(mk()));
    const enveloped = (() => {
      const input = inputOf(mk());
      input.ordersA = { ...input.ordersA, formation: 'envelop' };
      return runFrames(input);
    })();
    // ship 3 is in wingA (fastest-by-id among equal frigates): it must climb
    // toward the top waypoint (48u from the edge) — far above anything the
    // massed baseline does from its 172.8u deployment lane
    const wingTrack = trackOf(enveloped.frames, 3);
    const massTrack = trackOf(massed.frames, 3);
    const minY = (t: Array<{ y: number }>) => Math.min(...t.map((s) => s.y));
    expect(minY(wingTrack)).toBeLessThan(90 * FP);
    expect(minY(massTrack) - minY(wingTrack)).toBeGreaterThan(40 * FP);
    // wingB mirror: ship 6 dives toward the bottom edge
    const maxY = Math.max(...trackOf(enveloped.frames, 6).map((s) => s.y));
    expect(maxY).toBeGreaterThan(FIELD_H - 90 * FP);
    // the two runs genuinely diverge tick by tick
    expect(enveloped.frames.some((f, i) => {
      const a = f.ships.find((s) => s.id === 3)!;
      const b = massed.frames[i]?.ships.find((s) => s.id === 3);
      return b !== undefined && (a.x !== b.x || a.y !== b.y);
    })).toBe(true);
    // formation runs are themselves deterministic
    const again = (() => {
      const input = inputOf(mk());
      input.ordersA = { ...input.ordersA, formation: 'envelop' };
      return runFrames(input);
    })();
    expect(again.frames).toEqual(enveloped.frames);
    expect(again.result.outcomes).toEqual(enveloped.result.outcomes);
  });

  it('line formation: heavies wall up near their edge while light ships skirmish', () => {
    const mk = () => [
      // 4 heavies (battleship-class) + 4 light frigates
      ...Array.from({ length: 4 }, (_, i) => ship(i + 1, 0, { hullIdx: 4, speed: 3, structureHp: 40, startingStructure: 40 })),
      ...Array.from({ length: 4 }, (_, i) => ship(11 + i, 0, { speed: 8 })),
      ...Array.from({ length: 2 }, (_, i) => ship(101 + i, 1, { weapons: [], structureHp: 100, startingStructure: 100 })),
    ];
    const input = inputOf(mk());
    input.ordersA = { ...input.ordersA, formation: 'line' };
    const { frames } = runFrames(input);
    for (const id of [1, 2, 3, 4]) {
      const maxX = Math.max(...trackOf(frames, id).map((s) => s.x));
      // the wall stands at LINE_WALL_X; one advance step of slack
      expect(maxX).toBeLessThanOrEqual(LINE_WALL_X + 3 * FP);
    }
    // the light half charges far past the wall
    const skirmishMax = Math.max(...[11, 12, 13, 14].flatMap((id) => trackOf(frames, id).map((s) => s.x)));
    expect(skirmishMax).toBeGreaterThan(400 * FP);
  });

  it('formation: null behaves byte-identically to an absent field', () => {
    const base = runFrames(inputOf([ship(1, 0), ship(2, 0), ship(101, 1)]));
    const withNull = (() => {
      const input = inputOf([ship(1, 0), ship(2, 0), ship(101, 1)]);
      input.ordersA = { ...input.ordersA, formation: null };
      input.ordersD = { ...input.ordersD, formation: null };
      return runFrames(input);
    })();
    expect(withNull.frames).toEqual(base.frames);
    expect(withNull.result).toEqual(base.result);
  });
});

describe('slewing', () => {
  /** a lone titan defender holding its ground; a fast raider punches past it
   * and parks dead astern (plus two slow decoys that keep the passthrough
   * group from withdrawing early) */
  function slewScenario(slewing: boolean, titanStance: 'hold_range' | 'charge') {
    const raiderOpts: Partial<CombatShipInit> = { weapons: [], structureHp: 400, startingStructure: 400, armorHp: 0, startingArmor: 0, shieldPool: 0 };
    const ships = [
      ship(1, 0, { ...raiderOpts, speed: 2 }), // decoy lane 144u
      ship(2, 0, { ...raiderOpts, speed: 12 }), // the raider, lane 288u = titan's lane
      ship(3, 0, { ...raiderOpts, speed: 2 }), // decoy lane 432u
      ship(101, 1, {
        hullIdx: 5, // titan: turn rate 1
        speed: 4,
        structureHp: 200,
        startingStructure: 200,
        armorHp: 0,
        startingArmor: 0,
        beamAttack: 100,
        weapons: [{ weaponId: 'laser_cannon', classId: 0, dmgMin: 5, dmgMax: 10, mods: [], ammo: -1, cooldown: 0, count: 1 }],
      }),
    ];
    const input = inputOf(ships, 'slew-test');
    input.ordersA = { ...input.ordersA, stance: 'passthrough' };
    input.ordersD = { ...input.ordersD, stance: titanStance };
    if (slewing) input.slewing = true;
    return runFrames(input);
  }

  it('OFF is byte-identical whether the flag is absent or false', () => {
    const absent = runFrames(inputOf([ship(1, 0), ship(2, 0), ship(101, 1)]));
    const withFalse = (() => {
      const input = inputOf([ship(1, 0), ship(2, 0), ship(101, 1)]);
      input.slewing = false;
      return runFrames(input);
    })();
    expect(withFalse.frames).toEqual(absent.frames);
    expect(withFalse.result).toEqual(absent.result);
  });

  it('ON brings F-arc guns onto an off-axis target sooner, at a movement cost', () => {
    const off = slewScenario(false, 'hold_range');
    const on = slewScenario(true, 'hold_range');
    const titanId = 101;
    const raiderId = 2;
    const passTickOf = (frames: BattleTickFrame[]) =>
      frames.findIndex((f) => {
        const t = f.ships.find((s) => s.id === titanId)!;
        const r = f.ships.find((s) => s.id === raiderId)!;
        return r.x > t.x + 20 * FP;
      });
    const passOff = passTickOf(off.frames);
    const passOn = passTickOf(on.frames);
    expect(passOff).toBeGreaterThan(0);
    expect(passOn).toBeGreaterThan(0);
    const firstHit = (frames: BattleTickFrame[], from: number) => {
      const pass = passTickOf(frames);
      for (const f of frames) {
        if (f.tick <= pass) continue;
        if (f.shots.some((s) => s.from === titanId && s.to === from && s.hit)) return f.tick;
      }
      return Infinity;
    };
    const hitOn = firstHit(on.frames, raiderId);
    const hitOff = firstHit(off.frames, raiderId);
    expect(hitOn).toBeLessThan(hitOff); // guns bear sooner with slewing
    expect(hitOn).not.toBe(Infinity);
    // the titan visibly slews: > 1 heading step in a single tick (legacy titan
    // turn rate is exactly 1/tick, so OFF can never do this)
    const slewTicks = (frames: BattleTickFrame[]) => {
      const t = trackOf(frames, titanId);
      const ticks: number[] = [];
      for (let i = 1; i < t.length; i++) {
        if (Math.abs(headingDelta(t[i - 1]!.h, t[i]!.h)) > 1) ticks.push(i);
      }
      return ticks;
    };
    expect(slewTicks(on.frames).length).toBeGreaterThan(0);
    expect(slewTicks(off.frames).length).toBe(0);
  });

  it('slewing spends movement: a charging titan barely moves while it slews', () => {
    const on = slewScenario(true, 'charge');
    const titanId = 101;
    const track = trackOf(on.frames, titanId);
    let sawSlew = false;
    for (let i = 1; i < track.length; i++) {
      if (Math.abs(headingDelta(track[i - 1]!.h, track[i]!.h)) > 1) {
        sawSlew = true;
        const dx = Math.abs(track[i]!.x - track[i - 1]!.x);
        const dy = Math.abs(track[i]!.y - track[i - 1]!.y);
        // titan speed is 4u/tick; a slewing tick must not run at full burn
        expect(dx + dy).toBeLessThan(4 * FP);
      }
    }
    expect(sawSlew).toBe(true);
  });
});

// ---------- settings + orders plumbing ----------

function startTwoEmpireGame(extraSettings: Record<string, unknown> = {}): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands: true,
      ...extraSettings,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'korrath' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'skyshear' }) },
    ],
    dataVersion: 'test',
  });
}

/** war + fleets at the defender's home star, advanced into battle_orders */
function intoBattlePhase(state: GameState): GameState {
  let s = state;
  const run = (playerId: number, kind: string, payload: unknown) => {
    s = gameEngine.apply(s, { turn: s.turn, playerId, kind, payload });
  };
  run(0, 'declare_war', { target: 1 });
  const defenderHome = s.colonies.find((c) => c.owner === 1)!;
  const starId = s.planets.find((p) => p.id === defenderHome.planetId)!.starId;
  run(0, 'debug_spawn_ships', { starId, designId: s.empires[0]!.designs[0]!.id, count: 3 });
  run(1, 'debug_spawn_ships', { starId, designId: s.empires[1]!.designs[0]!.id, count: 3 });
  run(-1, 'advance_turn', {});
  gameEngine.takeEvents();
  return s;
}

describe('slewing setting + battle-orders formation plumbing', () => {
  it('lobby default is OFF', () => {
    expect(DEFAULT_SETTINGS.slewing).toBe(false);
  });

  it('BattleInput carries slewing only when the game setting is ON', () => {
    const off = intoBattlePhase(startTwoEmpireGame());
    expect(off.phase).toBe('battle_orders');
    const inputOff = buildBattleInput(off, off.pendingBattles[0]!).input;
    expect('slewing' in inputOff).toBe(false); // absent key: legacy replays stay byte-exact
    const on = intoBattlePhase(startTwoEmpireGame({ slewing: true }));
    const inputOn = buildBattleInput(on, on.pendingBattles[0]!).input;
    expect(inputOn.slewing).toBe(true);
  });

  it('validates the formation field and normalizes null to absent', () => {
    const state = intoBattlePhase(startTwoEmpireGame());
    const battle = state.pendingBattles[0]!;
    const orders = (extra: Record<string, unknown>) => ({
      battleId: battle.id,
      orders: { stance: 'charge', priority: 'nearest', retreatThresholdPct: 25, bombard: false, ...extra },
    });
    const val = (playerId: number, payload: unknown) =>
      validateCommand(state, { turn: state.turn, playerId, kind: 'battle_orders', payload });
    expect(val(0, orders({}))).toBeNull(); // absent = legal legacy
    expect(val(0, orders({ formation: null }))).toBeNull();
    for (const f of ['line', 'flank', 'pincer', 'envelop']) expect(val(0, orders({ formation: f }))).toBeNull();
    expect(val(0, orders({ formation: 'diamond' }))).toBe('bad formation');
    expect(val(0, orders({ formation: 42 }))).toBe('bad formation');
    // invadeTactic: attacker-only, must be a real ground tactic
    expect(val(0, orders({ invadeTactic: 'flank' }))).toBeNull();
    expect(val(0, orders({ invadeTactic: 'tunnel_rush' }))).toBe('bad invade tactic');
    expect(val(1, orders({ invadeTactic: 'flank' }))).toBe('invade tactic is an attacker order');
    // apply: null formation is normalized to ABSENT; a real one is kept
    let s = gameEngine.apply(state, { turn: state.turn, playerId: 0, kind: 'battle_orders', payload: orders({ formation: null }) });
    expect('formation' in (s.pendingBattles[0]!.ordersA as Record<string, unknown>)).toBe(false);
    s = gameEngine.apply(state, { turn: state.turn, playerId: 0, kind: 'battle_orders', payload: orders({ formation: 'envelop', invadeTactic: 'flank' }) });
    const applied = s.pendingBattles[0]!.ordersA as Record<string, unknown>;
    expect(applied.formation).toBe('envelop');
    expect(applied.invadeTactic).toBe('flank');
  });

  it('a full battle with formations resolves deterministically end to end', () => {
    const play = (): GameState => {
      let s = intoBattlePhase(startTwoEmpireGame());
      const battle = s.pendingBattles[0]!;
      const run = (playerId: number, kind: string, payload: unknown) => {
        s = gameEngine.apply(s, { turn: s.turn, playerId, kind, payload });
      };
      run(0, 'battle_orders', {
        battleId: battle.id,
        orders: { stance: 'charge', priority: 'nearest', retreatThresholdPct: 25, bombard: false, formation: 'flank' },
      });
      run(1, 'battle_orders', {
        battleId: battle.id,
        orders: { stance: 'charge', priority: 'nearest', retreatThresholdPct: 25, bombard: false, formation: 'line' },
      });
      run(-1, 'resolve_combat', {});
      gameEngine.takeEvents();
      return s;
    };
    const a = play();
    const b = play();
    expect(a.phase).toBe('planning');
    expect(gameEngine.hash(a)).toBe(gameEngine.hash(b));
  });
});
