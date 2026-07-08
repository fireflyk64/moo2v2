import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORDERS,
  designStats,
  gameEngine,
  runBattle,
  validateCommand,
  type BattleInput,
  type CombatShipInit,
  type GameState,
} from '@engine/index';
import { rngFor } from '@engine/rng';

const SEED = '0123456789abcdef0123456789abcdef';

function startTwoEmpireGame(debug = true): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands: debug,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'korrath' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'skyshear' }) },
    ],
    dataVersion: 'test',
  });
}

function frigateInit(shipId: number, side: 0 | 1, opts?: Partial<CombatShipInit>): CombatShipInit {
  return {
    shipId,
    side,
    hull: 'frigate',
    hullIdx: 1,
    isBase: false,
    beamAttack: 25,
    beamDefense: 50 + 8,
    speed: 4,
    armorHp: 4,
    structureHp: 4,
    shieldPool: 5,
    shieldFlat: 1,
    weapons: [
      { weaponId: 'laser_cannon', classId: 0, dmgMin: 1, dmgMax: 4, mods: [], ammo: -1, cooldown: 0, count: 2 },
    ],
    startingStructure: 4,
    startingArmor: 4,
    ...(opts ?? {}),
  };
}

function battleOf(shipsA: number, shipsD: number): BattleInput {
  const ships: CombatShipInit[] = [];
  for (let i = 0; i < shipsA; i++) ships.push(frigateInit(i + 1, 0));
  for (let i = 0; i < shipsD; i++) ships.push(frigateInit(100 + i, 1));
  return {
    battleId: 'test-battle',
    seedLabel: [1, 'battle', 'test-battle'],
    attacker: 0,
    defender: 1,
    ships,
    ordersA: { ...DEFAULT_ORDERS },
    ordersD: { ...DEFAULT_ORDERS, stance: 'hold_range' },
  };
}

describe('ship designer', () => {
  it('validates space and derives stats', () => {
    const state = startTwoEmpireGame();
    const empire = state.empires[0]!;
    const stats = designStats(state, empire, {
      name: 'Test',
      hull: 'frigate',
      computer: 1,
      shield: 1,
      specials: [],
      weapons: [{ weapon: 'laser_cannon', count: 2, mods: [] }],
    });
    expect(typeof stats).not.toBe('string');
    if (typeof stats === 'string') return;
    expect(stats.spaceUsed).toBeLessThanOrEqual(stats.spaceTotal);
    expect(stats.beamAttack).toBeGreaterThanOrEqual(25 + 50); // computer + korrath attack3(+50)
    expect(stats.cost).toBeGreaterThan(20);
    expect(stats.cpUsage).toBe(1);
  });

  it('rejects over-space and unresearched components', () => {
    const state = startTwoEmpireGame();
    const empire = state.empires[0]!;
    expect(
      designStats(state, empire, {
        name: 'Bloated',
        hull: 'frigate',
        computer: 0,
        shield: 0,
        specials: [],
        weapons: [{ weapon: 'laser_cannon', count: 50, mods: [] }],
      }),
    ).toMatch(/over space/);
    expect(
      designStats(state, empire, {
        name: 'FutureTech',
        hull: 'frigate',
        computer: 5,
        shield: 0,
        specials: [],
        weapons: [],
      }),
    ).toMatch(/not researched/);
  });
});

describe('battle sim', () => {
  it('is deterministic for identical inputs', () => {
    const input = battleOf(3, 3);
    const r1 = runBattle(input, rngFor(SEED, ...input.seedLabel));
    const r2 = runBattle(battleOf(3, 3), rngFor(SEED, ...input.seedLabel));
    expect(r1.ticks).toBe(r2.ticks);
    expect(r1.outcomes).toEqual(r2.outcomes);
    expect(r1.attackerDamagePct).toBe(r2.attackerDamagePct);
  });

  it('equal-tech equal-count pass deals partial damage, not devastation', () => {
    // several seeds; fleet damage should be meaningful but survivable on average
    let totalDmg = 0;
    let runs = 0;
    for (let s = 0; s < 8; s++) {
      const input = battleOf(4, 4);
      input.battleId = `bal-${s}`;
      input.seedLabel = [1, 'battle', input.battleId];
      const r = runBattle(input, rngFor(SEED, ...input.seedLabel));
      totalDmg += r.attackerDamagePct + r.defenderDamagePct;
      runs += 2;
      expect(r.ticks).toBeLessThanOrEqual(400);
    }
    const avg = totalDmg / runs;
    expect(avg).toBeGreaterThanOrEqual(15);
    expect(avg).toBeLessThanOrEqual(60);
  });

  it('a lopsided battle destroys the small side', () => {
    const input = battleOf(6, 1);
    const r = runBattle(input, rngFor(SEED, ...input.seedLabel));
    expect(r.winner).toBe(0);
    expect(r.outcomes.filter((o) => o.side === 1 && o.destroyed).length).toBe(1);
  });

  it('evade_retreat exits the field and survives', () => {
    const input = battleOf(2, 2);
    input.ordersD = { ...DEFAULT_ORDERS, stance: 'evade_retreat' };
    const r = runBattle(input, rngFor(SEED, ...input.seedLabel));
    const defenders = r.outcomes.filter((o) => o.side === 1);
    expect(defenders.some((o) => o.retreated)).toBe(true);
  });

  it('frames stream to the viewer callback', () => {
    const input = battleOf(2, 2);
    let frames = 0;
    let sawShot = false;
    runBattle(input, rngFor(SEED, ...input.seedLabel), (f) => {
      frames++;
      if (f.shots.length) sawShot = true;
    });
    expect(frames).toBeGreaterThan(5);
    expect(sawShot).toBe(true);
  });
});

describe('war -> encounter -> battle orders -> resolve pipeline', () => {
  it('runs the full battle sub-phase deterministically', () => {
    let state = startTwoEmpireGame();
    const apply = (playerId: number, kind: string, payload: unknown) => {
      const cmd = { turn: state.turn, playerId, kind, payload };
      const err = validateCommand(state, cmd);
      expect(err, `${kind}: ${err}`).toBeNull();
      state = gameEngine.apply(state, cmd);
    };
    const system = (kind: string) => {
      state = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind, payload: {} });
      gameEngine.takeEvents();
    };

    // war + spawn fleets at the defender homeworld star
    apply(0, 'declare_war', { target: 1 });
    const defenderHome = state.colonies.find((c) => c.owner === 1)!;
    const starId = state.planets.find((p) => p.id === defenderHome.planetId)!.starId;
    const attackerDesign = state.empires[0]!.designs[0]!.id;
    const defenderDesign = state.empires[1]!.designs[0]!.id;
    apply(0, 'debug_spawn_ships', { starId, designId: attackerDesign, count: 4 });
    apply(1, 'debug_spawn_ships', { starId, designId: defenderDesign, count: 3 });

    system('advance_turn');
    expect(state.phase).toBe('battle_orders');
    expect(state.pendingBattles.length).toBe(1);
    const battle = state.pendingBattles[0]!;
    expect(battle.attacker).toBe(0);
    expect(battle.defender).toBe(1);

    // non-battle commands are rejected during the sub-phase
    expect(validateCommand(state, { turn: state.turn, playerId: 0, kind: 'declare_war', payload: { target: 1 } })).toMatch(/battle/);

    apply(0, 'battle_orders', {
      battleId: battle.id,
      orders: { stance: 'charge', priority: 'nearest', retreatThresholdPct: 20, bombard: true },
    });
    apply(1, 'battle_orders', {
      battleId: battle.id,
      orders: { stance: 'hold_range', priority: 'biggest', retreatThresholdPct: 30, bombard: false },
    });

    const turnBefore = state.turn;
    system('resolve_combat');
    expect(state.phase).toBe('planning');
    expect(state.pendingBattles.length).toBe(0);
    expect(state.turn).toBe(turnBefore + 1);

    // ships took damage or died; totals changed
    const warships = state.ships.filter((s) => s.shipKind === 'design');
    expect(warships.length).toBeLessThanOrEqual(7);

    // replay determinism incl. the battle
    const state2 = replaySame();
    expect(gameEngine.hash(state2)).toBe(gameEngine.hash(state));

    function replaySame(): GameState {
      let s = startTwoEmpireGame();
      const run = (playerId: number, kind: string, payload: unknown) => {
        s = gameEngine.apply(s, { turn: s.turn, playerId, kind, payload });
      };
      run(0, 'declare_war', { target: 1 });
      run(0, 'debug_spawn_ships', { starId, designId: attackerDesign, count: 4 });
      run(1, 'debug_spawn_ships', { starId, designId: defenderDesign, count: 3 });
      run(-1, 'advance_turn', {});
      gameEngine.takeEvents();
      run(0, 'battle_orders', {
        battleId: battle.id,
        orders: { stance: 'charge', priority: 'nearest', retreatThresholdPct: 20, bombard: true },
      });
      run(1, 'battle_orders', {
        battleId: battle.id,
        orders: { stance: 'hold_range', priority: 'biggest', retreatThresholdPct: 30, bombard: false },
      });
      run(-1, 'resolve_combat', {});
      gameEngine.takeEvents();
      return s;
    }
  });

  it('peace handshake restores peace', () => {
    let state = startTwoEmpireGame();
    const run = (playerId: number, kind: string, payload: unknown) => {
      const err = validateCommand(state, { turn: state.turn, playerId, kind, payload });
      expect(err).toBeNull();
      state = gameEngine.apply(state, { turn: state.turn, playerId, kind, payload });
    };
    run(0, 'declare_war', { target: 1 });
    expect(state.relations[0]!.status).toBe('war');
    run(0, 'offer_peace', { target: 1 });
    run(1, 'offer_peace', { target: 0 });
    state = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
    gameEngine.takeEvents();
    expect(state.relations[0]!.status).toBe('peace');
  });
});
