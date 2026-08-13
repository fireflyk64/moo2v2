// Regression: per-empire dynamic entity ids (blocks at 20M/30M/...) collided
// with the battle sim's synthetic id fences (bases 1e6+, monsters 2e6+), so
// every block-id ship outcome was misrouted to the monster branch and
// silently dropped — destroyed ships stayed in the game forever, sieges
// re-fired every turn, and bombardment (which runs after a victory is
// applied) never touched the colony. bugs.md CRITICAL items 1-3.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { setRelation } from '@engine/battles';
import { allocId, BASE_COMBAT_ID, MONSTER_COMBAT_ID, ID_BLOCK } from '@engine/ids';
import { advanceTurn, resolveCombat } from '@engine/pipeline';
import { applyCommand } from '@engine/commands';
import { colonyPopUnits } from '@engine/economy';
import type { GameState, TurnEvent } from '@engine/types';

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
      debugCommands: false,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

/** Attacker fleet with block ids and nuclear bombs parked at the defender's
 * homeworld; the defender keeps one block-id frigate so both sides have
 * outcomes to apply. */
function stageSiege(state: GameState) {
  setRelation(state, 0, 1, 'war');
  const attacker = state.empires.find((e) => e.id === 0)!;
  const defender = state.empires.find((e) => e.id === 1)!;
  const colony = state.colonies.find((c) => c.owner === 1 && !c.outpost)!;
  const starId = state.planets.find((p) => p.id === colony.planetId)!.starId;

  // clear the field, then rebuild both sides with dynamic (block) ids
  state.ships = state.ships.filter(
    (s) => !((s.owner === 0 || s.owner === 1) && (s.shipKind === 'design' || s.shipKind === 'scout')),
  );
  if (!attacker.completedFields.includes(62)) attacker.completedFields.push(62); // battleship hull (robotics)
  const bomber = {
    id: allocId(state, 0),
    name: 'Bomber',
    hull: 'battleship',
    computer: 0,
    shield: 0,
    specials: [],
    weapons: [
      { weapon: 'fusion_beam', count: 8, mods: [] },
      { weapon: 'nuclear_bomb', count: 2, mods: [] },
    ],
    obsolete: false,
  };
  attacker.designs.push(bomber);
  const picket = {
    id: allocId(state, 1),
    name: 'Picket',
    hull: 'frigate',
    computer: 0,
    shield: 0,
    specials: [],
    weapons: [{ weapon: 'laser_cannon', count: 1, mods: [] }],
    obsolete: false,
  };
  defender.designs.push(picket);

  const shipIds: number[] = [];
  for (let i = 0; i < 3; i++) {
    const id = allocId(state, 0);
    shipIds.push(id);
    state.ships.push({
      id,
      owner: 0,
      shipKind: 'design',
      designId: bomber.id,
      location: { kind: 'star', starId },
      cargoPopUnits: 0,
      cargoRace: 0,
      dmgStructure: 0,
      dmgArmor: 0,
    });
  }
  const picketShipId = allocId(state, 1);
  state.ships.push({
    id: picketShipId,
    owner: 1,
    shipKind: 'design',
    designId: picket.id,
    location: { kind: 'star', starId },
    cargoPopUnits: 0,
    cargoRace: 1,
    dmgStructure: 0,
    dmgArmor: 0,
  });
  // a defense base so the synthetic base id path is exercised too
  if (!colony.buildings.includes('star_base')) colony.buildings.push('star_base');
  colony.buildings.sort();
  return { colony, starId, shipIds, picketShipId };
}

describe('battle outcomes with block entity ids', () => {
  it('synthetic combat ids clear every real id block', () => {
    // 16 empires is far beyond the supported player count; even that stays clear
    expect(ID_BLOCK * 18).toBeLessThan(BASE_COMBAT_ID);
    expect(BASE_COMBAT_ID + ID_BLOCK * 18).toBeLessThan(MONSTER_COMBAT_ID);
  });

  it('destroyed block-id ships are removed, the base falls, and bombardment kills pop + buildings', () => {
    const state = newGame();
    const { colony, starId, shipIds, picketShipId } = stageSiege(state);
    const popBefore = colonyPopUnits(colony);
    const buildingsBefore = [...colony.buildings];
    expect(buildingsBefore.length).toBeGreaterThan(1);

    const adv = advanceTurn(state);
    expect(state.phase).toBe('battle_orders');
    const battle = state.pendingBattles.find((b) => b.starId === starId)!;
    expect(battle.attacker).toBe(0);

    // attacker orders the bombardment (defender defaults)
    applyCommand(
      state,
      {
        turn: state.turn,
        playerId: 0,
        kind: 'battle_orders',
        payload: {
          battleId: battle.id,
          orders: { stance: 'charge', priority: 'nearest', retreatThresholdPct: 0, bombard: true },
        },
      },
      [],
    );
    const res = resolveCombat(state);
    const events: TurnEvent[] = [...adv.events, ...res.events];

    const resolved = events.find((e) => e.kind === 'battle_resolved')!.payload as {
      winner: number | null;
      destroyed: number[];
    };
    expect(resolved.winner).toBe(0);
    // the defender's block-id picket died and left the game
    expect(resolved.destroyed).toContain(picketShipId);
    expect(state.ships.some((s) => s.id === picketShipId)).toBe(false);
    // every destroyed ship (either side) actually left the game; survivors stayed
    for (const id of resolved.destroyed) {
      expect(state.ships.some((s) => s.id === id)).toBe(false);
    }
    const survivors = state.ships.filter((s) => s.owner === 0 && s.shipKind === 'design');
    expect(survivors.length).toBe(3 - resolved.destroyed.filter((id) => shipIds.includes(id)).length);
    expect(survivors.length).toBeGreaterThan(0); // the attacker won: someone lived to bombard
    // no ghost battle: the siege resolves instead of re-firing forever
    // (colony may still exist; if war continues a NEW battle can trigger, but
    // the picket must not be resurrected into it)
    const after = state.colonies.find((c) => c.id === colony.id)!;
    // star base died with the battle
    expect(after.buildings).not.toContain('star_base');
    // bombardment: population lost and output (buildings) destroyed
    const bomb = events.find((e) => e.kind === 'bombardment')!.payload as {
      popKilled: number;
      buildingsDestroyed: string[];
    };
    expect(bomb.popKilled).toBeGreaterThan(0);
    expect(colonyPopUnits(after)).toBeLessThan(popBefore);
    expect(colonyPopUnits(after)).toBe(popBefore - bomb.popKilled);
    // 6 bomb mounts * ~7.5 avg * 10 runs = enough to also level structures
    expect(bomb.buildingsDestroyed.length + bomb.popKilled).toBeGreaterThan(2);

    // ...and NOTHING comes back one turn later (the 0.9.0 symptom was exactly
    // this resurrection: outcomes were dropped, so the next boundary showed
    // the dead ships alive again and the same battle re-fired)
    const popAfterBombard = colonyPopUnits(after);
    const adv2 = advanceTurn(state);
    if (state.phase === 'battle_orders') resolveCombat(state);
    expect(state.ships.some((s) => s.id === picketShipId)).toBe(false);
    for (const id of resolved.destroyed) {
      expect(state.ships.some((s) => s.id === id)).toBe(false);
    }
    const after2 = state.colonies.find((c) => c.id === colony.id);
    if (after2) {
      // natural growth may add a fraction, but the bombed units must not respawn
      expect(colonyPopUnits(after2)).toBeLessThanOrEqual(popAfterBombard + 1);
      expect(after2.buildings).not.toContain('star_base');
    }
    void adv2;
  });
});
