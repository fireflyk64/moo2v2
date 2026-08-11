// The user-reported brokenness (save 0a3b3533, turn 92): battles vs monsters
// could never be WATCHED. A fleet massing MONSTER_CLEAR_WEIGHT hull points
// auto-clears an ordinary lair instantly — the orders dialog asks for a
// stance, then no battle appears, because the instant-clear path returns
// before any battle_replay event is pushed. fightOut: true on the attacker's
// battle orders now runs the real sim (and emits the replay); absent keeps
// the lossless instant clear byte-for-byte for old logs, timeouts and bots.
import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { detectBattles, resolveBattle, MONSTER_CLEAR_WEIGHT } from '@engine/battles';
import { validateCommand, applyCommand } from '@engine/commands';
import type { GameState, TurnEvent } from '@engine/types';
import type { BattleOrders } from '@engine/combat';

const SEED = '1234123412341234abcdabcdabcdabcd';

function newGame(): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'medium',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: true, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands: true,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

/** An ordinary (non-guardian) lair with `count` player-0 frigates parked on
 * it (weight 1 each), and the detected pending battle. */
function lairFight(state: GameState, count: number) {
  let lair = state.monsters.find((m) => m.kind !== 'guardian');
  if (!lair) {
    const star = state.stars.find(
      (s) =>
        !state.monsters.some((m) => m.starId === s.id) &&
        !state.colonies.some((c) => state.planets.some((p) => p.id === c.planetId && p.starId === s.id)),
    )!;
    lair = { id: state.nextId++, kind: 'dragon', starId: star.id, dmgStructure: 0 };
    state.monsters.push(lair);
  }
  const empire = state.empires[0]!;
  const design = empire.designs.find((d) => d.hull === 'frigate')!;
  for (let i = 0; i < count; i++) {
    state.ships.push({
      id: state.nextId++,
      owner: 0,
      shipKind: 'design',
      designId: design.id,
      location: { kind: 'star', starId: lair.starId },
      cargoPopUnits: 0,
      cargoRace: 0,
      dmgStructure: 0,
      dmgArmor: 0,
    });
  }
  const battles = detectBattles(state);
  const fight = battles.find((b) => b.starId === lair!.starId)!;
  return { lair, fight };
}

const CHARGE: BattleOrders = { stance: 'charge', priority: 'nearest', retreatThresholdPct: 0, bombard: false };

describe('watching monster battles (fightOut)', () => {
  it('BROKENNESS: an overwhelming fleet ordered to charge got no battle_replay (legacy orders)', () => {
    const state = newGame();
    const { fight } = lairFight(state, MONSTER_CLEAR_WEIGHT);
    fight.ordersA = { ...CHARGE };
    const events: TurnEvent[] = [];
    const { summary } = resolveBattle(state, fight, events);
    // legacy behavior, deliberately preserved: instant lossless clear, no show
    expect(summary.autoCleared).toBe(true);
    expect(events.some((e) => e.kind === 'battle_replay')).toBe(false);
  });

  it('FIX: fightOut orders run the real sim and the attacker gets a watchable replay', () => {
    const state = newGame();
    const { lair, fight } = lairFight(state, MONSTER_CLEAR_WEIGHT);
    fight.ordersA = { ...CHARGE, fightOut: true };
    const events: TurnEvent[] = [];
    const { summary, result } = resolveBattle(state, fight, events);
    expect(summary.autoCleared).toBeUndefined();
    expect(result.ticks).toBeGreaterThan(0);
    const replay = events.find((e) => e.kind === 'battle_replay');
    expect(replay).toBeDefined();
    expect(replay!.visibleTo).toBe(0); // the attacker can watch it
    // the fight was real: the lair died or carries scars
    const after = state.monsters.find((m) => m.id === lair.id);
    expect(after === undefined || after.dmgStructure > 0 || after.dmgArmor !== undefined).toBe(true);
  });

  it('the battle_orders command carries fightOut through validation and apply (attacker only)', () => {
    const state = newGame();
    const { fight } = lairFight(state, MONSTER_CLEAR_WEIGHT);
    state.phase = 'battle_orders';
    state.pendingBattles = [fight];
    const cmd = {
      turn: state.turn,
      playerId: 0,
      kind: 'battle_orders',
      payload: { battleId: fight.id, orders: { ...CHARGE, fightOut: true } },
    };
    expect(validateCommand(state, cmd)).toBeNull();
    applyCommand(state, cmd);
    expect((state.pendingBattles[0]!.ordersA as BattleOrders).fightOut).toBe(true);
    // a non-boolean is rejected, not silently coerced
    const bad = { ...cmd, payload: { battleId: fight.id, orders: { ...CHARGE, fightOut: 1 as unknown as boolean } } };
    expect(validateCommand(state, bad)).toBe('bad fightOut flag');
  });

  it('absent fightOut keeps the instant clear (bots/timeouts/old logs unchanged)', () => {
    const state = newGame();
    const { lair, fight } = lairFight(state, MONSTER_CLEAR_WEIGHT);
    state.phase = 'battle_orders';
    state.pendingBattles = [fight];
    const cmd = {
      turn: state.turn,
      playerId: 0,
      kind: 'battle_orders',
      payload: { battleId: fight.id, orders: { ...CHARGE } },
    };
    expect(validateCommand(state, cmd)).toBeNull();
    applyCommand(state, cmd);
    const events: TurnEvent[] = [];
    const { summary } = resolveBattle(state, state.pendingBattles[0]!, events);
    expect(summary.autoCleared).toBe(true);
    expect(state.monsters.some((m) => m.id === lair.id)).toBe(false);
    expect(events.some((e) => e.kind === 'battle_replay')).toBe(false);
  });
});
