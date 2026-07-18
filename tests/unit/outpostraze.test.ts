// bug report 2026-07-18: "a fleet cannot destroy a built outpost". Destroying
// an outpost required winning WITH >=20 bomb-class damage — a fleet without
// bomb hardpoints (the normal case) could never remove one. Now ANY victorious
// fleet with the bombard order levels one outpost dome, preferring the one on
// a colonizable (body=planet) world; at a mixed star the populated colony is
// always the bombardment target, never an outpost.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyCommand } from '@engine/commands';
import { detectBattles, resolveBattle } from '@engine/battles';
import type { Colony, GameState, Ship, TurnEvent } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
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

function addScouts(state: GameState, owner: number, starId: number, n: number): void {
  for (let i = 0; i < n; i++) {
    state.ships.push({
      id: state.nextId++,
      owner,
      shipKind: 'scout',
      designId: null,
      location: { kind: 'star', starId },
      cargoPopUnits: 0,
      cargoRace: owner,
      dmgStructure: 0,
      dmgArmor: 0,
    } as Ship);
  }
}

function addOutpost(state: GameState, owner: number, planetId: number): Colony {
  const outpost: Colony = {
    id: state.nextId++,
    planetId,
    owner,
    name: 'Test Outpost',
    groups: [],
    buildings: [],
    queue: [],
    storedProd: 0,
    stickyInvested: {},
    boughtThisTurn: false,
    foodLackPrev: 0,
    prodLackPrev: 0,
    housingPPPrev: 0,
    outpost: true,
  } as Colony;
  state.colonies.push(outpost);
  return outpost;
}

/** a star with no colonies, no monsters, and both a colonizable planet and a
 * non-planet body (asteroids / gas giant) */
function emptyMixedStar(state: GameState) {
  return state.stars.find((s) => {
    const planets = state.planets.filter((p) => p.starId === s.id);
    if (state.monsters.some((m) => m.starId === s.id)) return false;
    if (state.colonies.some((c) => planets.some((p) => p.id === c.planetId))) return false;
    return planets.some((p) => p.body === 'planet') && planets.some((p) => p.body !== 'planet');
  })!;
}

const attackOrders = { stance: 'charge', priority: 'nearest', retreatThresholdPct: 0, bombard: true } as const;

describe('a fleet can destroy a built outpost', () => {
  it('a bomb-less victorious fleet with the bombard order razes an outpost, favoring the colonizable world', () => {
    const state = newGame();
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'declare_war', payload: { target: 1 } });
    const star = emptyMixedStar(state);
    const planets = state.planets.filter((p) => p.starId === star.id);
    // the non-colonizable dome is pushed FIRST so survival of the preference
    // logic (not state order) is what the assertion proves
    const onRock = addOutpost(state, 1, planets.find((p) => p.body !== 'planet')!.id);
    const onWorld = addOutpost(state, 1, planets.find((p) => p.body === 'planet')!.id);
    addScouts(state, 0, star.id, 2); // scouts carry a laser, not bombs

    const battle = detectBattles(state).find((b) => b.starId === star.id)!;
    expect(battle).toBeDefined();
    expect(battle.attacker).toBe(0);
    expect(battle.defender).toBe(1);
    expect(battle.ordersD).not.toBeNull(); // defenseless: pre-filled, never prompted
    battle.ordersA = { ...attackOrders };

    const events: TurnEvent[] = [];
    const { result } = resolveBattle(state, battle, events);
    expect(result.winner).toBe(0);
    // the dome on the colonizable planet fell; the rock outpost still stands
    expect(state.colonies.some((c) => c.id === onWorld.id)).toBe(false);
    expect(state.colonies.some((c) => c.id === onRock.id)).toBe(true);
    const bomb = events.find((e) => e.kind === 'bombardment');
    expect(bomb?.payload['outpostDestroyed']).toBe(true);
    expect(bomb?.payload['colonyId']).toBe(onWorld.id);
  });

  it('without the bombard order the outpost survives the lost battle', () => {
    const state = newGame();
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'declare_war', payload: { target: 1 } });
    const star = emptyMixedStar(state);
    const outpost = addOutpost(state, 1, state.planets.find((p) => p.starId === star.id && p.body === 'planet')!.id);
    addScouts(state, 0, star.id, 2);
    const battle = detectBattles(state).find((b) => b.starId === star.id)!;
    battle.ordersA = { ...attackOrders, bombard: false };
    const events: TurnEvent[] = [];
    const { result } = resolveBattle(state, battle, events);
    expect(result.winner).toBe(0);
    expect(state.colonies.some((c) => c.id === outpost.id)).toBe(true);
  });

  it('at a mixed star the populated colony takes the bombardment, not the outpost', () => {
    const state = newGame();
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'declare_war', payload: { target: 1 } });
    const home = state.colonies.find((c) => c.owner === 1 && !c.outpost)!;
    const homeStarId = state.planets.find((p) => p.id === home.planetId)!.starId;
    // strip the orbit so the attacker wins outright
    home.buildings = home.buildings.filter(
      (b) => !['star_base', 'battle_station', 'star_fortress', 'missile_base', 'ground_batteries'].includes(b),
    );
    state.ships = state.ships.filter(
      (s) => !(s.owner === 1 && s.location.kind === 'star' && s.location.starId === homeStarId),
    );
    const open = state.planets.find(
      (p) => p.starId === homeStarId && !state.colonies.some((c) => c.planetId === p.id),
    );
    if (!open) return; // this seed always has a free orbit at the home star; guard anyway
    const outpost = addOutpost(state, 1, open.id);
    addScouts(state, 0, homeStarId, 2);
    const battle = detectBattles(state).find((b) => b.starId === homeStarId)!;
    battle.ordersA = { ...attackOrders };
    const events: TurnEvent[] = [];
    const { result } = resolveBattle(state, battle, events);
    expect(result.winner).toBe(0);
    // the outpost is untouched; the barrage report targets the real colony
    expect(state.colonies.some((c) => c.id === outpost.id)).toBe(true);
    const bomb = events.find((e) => e.kind === 'bombardment');
    expect(bomb?.payload['colonyId']).toBe(home.id);
    expect(bomb?.payload['outpostDestroyed']).toBeUndefined();
  });
});
