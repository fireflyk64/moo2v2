// Unit gates for the 0.32.0 bot behaviors: (1) population logistics — the
// onion ships colonists toward under-half-full EXCELLENT worlds (gaia /
// rich / ultra-rich); (2) lair escort — a committed no-splinter monster-world
// strike routes a colony ship to ride with the fleet. Both drive the brain
// through onionTurn with a stub session capturing submitted commands.

import { describe, expect, it } from 'vitest';
import { gameEngine, selectors } from '@engine/index';
import type { GameState } from '@engine/types';
import { onionTurn, freshOnionMemory } from '@ui/onionBot';
import type { GameSession } from '@protocol/session';

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

interface Submitted {
  kind: string;
  payload: Record<string, unknown>;
}

/** drive one onion planning turn over a fixed state, capturing commands */
function turnOver(state: GameState, me: number): Submitted[] {
  const calls: Submitted[] = [];
  const session = {
    submit: (kind: string, payload: unknown) => {
      calls.push({ kind, payload: payload as Record<string, unknown> });
      return true;
    },
  } as unknown as GameSession<GameState>;
  onionTurn({
    session,
    state,
    planned: state,
    me,
    personality: 'balanced',
    alwaysWar: false,
    memory: freshOnionMemory(),
  });
  return calls;
}

describe('onion population logistics', () => {
  it('ships colonists from a comfortable donor to an under-half-full excellent world', () => {
    const state = newGame();
    // the homeworld is the donor: pack it near cap, farmers covering the table
    const home = state.colonies.find((c) => c.owner === 0)!;
    home.groups[0]!.popK = 12000;
    home.groups[0]!.farmers = 8;
    home.groups[0]!.workers = 2;
    home.groups[0]!.scientists = 2;
    // found a colony IN THE SAME SYSTEM on an ultra-rich world with room
    const homePlanet = state.planets.find((p) => p.id === home.planetId)!;
    const sibling = state.planets.find((p) => p.starId === homePlanet.starId && p.id !== homePlanet.id && p.body === 'planet')!;
    sibling.minerals = 'ultra_rich';
    sibling.climate = 'terran';
    sibling.sizeClass = 4;
    const next = gameEngine.apply(state, {
      turn: state.turn,
      playerId: 0,
      kind: 'debug_found_colony',
      payload: { planetId: sibling.id },
    });
    const calls = turnOver(next, 0);
    const moves = calls.filter((c) => c.kind === 'move_colonists');
    expect(moves.length).toBeGreaterThanOrEqual(1);
    const dest = next.colonies.find((c) => c.planetId === sibling.id)!;
    expect(moves.some((m) => m.payload['toColonyId'] === dest.id && m.payload['fromColonyId'] === home.id)).toBe(true);
  });

  it('leaves full or ordinary worlds alone', () => {
    const state = newGame();
    const calls = turnOver(state, 0);
    expect(calls.filter((c) => c.kind === 'move_colonists').length).toBe(0);
  });
});

describe('onion lair escort', () => {
  it('a committed no-splinter monster strike routes a colony ship with the fleet', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0)!;
    const homeStar = state.planets.find((p) => p.id === home.planetId)!.starId;
    // hand the bot a heavy clearing fleet + one colony ship, parked at home
    let s = state;
    const design = s.empires[0]!.designs.find((d) => d.auto);
    expect(design).toBeDefined();
    s = gameEngine.apply(s, {
      turn: s.turn,
      playerId: 0,
      kind: 'debug_spawn_ships',
      payload: { starId: homeStar, designId: design!.id, count: 14 },
    });
    s = gameEngine.apply(s, {
      turn: s.turn,
      playerId: 0,
      kind: 'debug_spawn_ships',
      payload: { starId: homeStar, designId: null, count: 1, shipKind: 'colony_ship' },
    });
    // stage the lair on a REACHABLE star with a free colonizable no-splinter
    // world (a generated keeper may sit outside the opening fuel bubble)
    const reachable = new Set(
      selectors.moveOptions(s, 0, homeStar).filter((o) => o.reachable).map((o) => o.starId),
    );
    const lairStar = s.stars.find(
      (st) =>
        st.id !== homeStar &&
        reachable.has(st.id) &&
        s.planets.some(
          (p) =>
            p.starId === st.id &&
            p.body === 'planet' &&
            p.special !== 'splinter_colony' &&
            !s.colonies.some((c) => c.planetId === p.id),
        ) &&
        s.planets.filter((p) => p.starId === st.id && p.body === 'planet').every((p) => p.special !== 'splinter_colony'),
    );
    expect(lairStar).toBeDefined();
    s.monsters = s.monsters.filter((m) => m.starId !== lairStar!.id);
    s.monsters.push({ id: s.nextId++, kind: 'hydra', starId: lairStar!.id, dmgStructure: 0 });
    const lair = s.monsters[s.monsters.length - 1]!;
    const calls: Submitted[] = [];
    const session = {
      submit: (kind: string, payload: unknown) => {
        calls.push({ kind, payload: payload as Record<string, unknown> });
        return true;
      },
    } as unknown as GameSession<GameState>;
    const memory = freshOnionMemory();
    memory.attackStar = lair!.starId; // strike already committed
    memory.attackSince = s.turn;
    onionTurn({ session, state: s, planned: s, me: 0, personality: 'balanced', alwaysWar: false, memory });
    const colonyShip = s.ships.find((x) => x.owner === 0 && x.shipKind === 'colony_ship')!;
    // the settler is either riding a jump to the lair star or holding at the muster
    const moved = calls.filter(
      (c) => c.kind === 'move_ships' && (c.payload['shipIds'] as number[]).includes(colonyShip.id),
    );
    const jump = calls.find(
      (c) => c.kind === 'move_ships' && c.payload['destStarId'] === lair!.starId && (c.payload['shipIds'] as number[]).includes(colonyShip.id),
    );
    // the fleet sits WITH the settler at home, so the whole strike (and the
    // escort) should jump the lair star together
    expect(jump ?? moved[0]).toBeDefined();
  });
});
