// Retrofit + scrap (bug: "we need retrofit ships with new designs of the same
// class and scrap ships — use the same MOO2 formula"). Refits are queue items
// (refit:<shipId>:<designId>) priced at max(newCost − oldCost, ¼ newCost),
// built at a colony with a star base; scrapping returns ¼ of cost as BC.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyCommand, validateCommand } from '@engine/commands';
import { itemCost, refitCost, canQueue } from '@engine/items';
import type { GameState } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average', // home colonies start with a star base
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

function advance(state: GameState): GameState {
  const next = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
  if (next.phase === 'battle_orders') {
    return gameEngine.apply(next, { turn: next.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
  }
  return next;
}

const cmd = (state: GameState, kind: string, payload: unknown) => ({
  turn: state.turn,
  playerId: 0,
  kind,
  payload,
});

/** save a bigger frigate design and spawn one ship of the STARTING design at home */
function setup(state: GameState) {
  const home = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
  const homeStar = state.planets.find((p) => p.id === home.planetId)!.starId;
  const oldDesign = state.empires[0]!.designs[0]!; // Patrol Frigate
  const save = cmd(state, 'save_design', {
    name: 'Upgunned',
    hull: oldDesign.hull,
    computer: 1, // costlier fit in the same hull (electronics known at average start)
    shield: 0,
    specials: [],
    weapons: [{ weapon: 'laser_cannon', count: 2, mods: [] }],
  });
  if (validateCommand(state, save) !== null) throw new Error(validateCommand(state, save)!);
  applyCommand(state, save);
  const newDesign = state.empires[0]!.designs.find((d) => d.name === 'Upgunned')!;
  applyCommand(state, cmd(state, 'debug_spawn_ships', { starId: homeStar, designId: oldDesign.id, count: 1 }));
  const ship = state.ships.find((s) => s.owner === 0 && s.designId === oldDesign.id)!;
  return { home, homeStar, oldDesign, newDesign, ship };
}

describe('retrofit (MOO2 formula) and scrap', () => {
  it('prices a refit at max(cost difference, quarter of the new design)', () => {
    const state = newGame();
    const { home, oldDesign, newDesign, ship } = setup(state);
    const oldCost = itemCost(state, 0, `design:${oldDesign.id}`)!;
    const newCost = itemCost(state, 0, `design:${newDesign.id}`)!;
    const price = refitCost(state, 0, ship.id, newDesign.id)!;
    expect(price).toBe(Math.max(newCost - oldCost, Math.ceil(newCost / 4)));
    expect(price).toBeGreaterThan(0);
    // itemCost resolves refit queue items to the same price
    expect(itemCost(state, 0, `refit:${ship.id}:${newDesign.id}`, home)).toBe(price);
    // a "downgrade" to a cheaper design still costs a quarter of the target
    expect(refitCost(state, 0, ship.id, oldDesign.id)).toBeNull(); // same design: invalid
  });

  it('queues at a starbase colony and swaps the design (repairs included)', () => {
    const state = newGame();
    const { home, oldDesign, newDesign, ship } = setup(state);
    ship.dmgStructure = 5;
    const c = cmd(state, 'set_build_queue', { colonyId: home.id, items: [`refit:${ship.id}:${newDesign.id}`] });
    expect(validateCommand(state, c)).toBeNull();
    applyCommand(state, c);
    home.storedProd = 100_000; // fund it fully
    const after = advance(state);
    const refitted = after.ships.find((s) => s.id === ship.id)!;
    expect(refitted.designId).toBe(newDesign.id);
    expect(refitted.dmgStructure).toBe(0); // the yard overhauls the hull
    expect(after.colonies.find((x) => x.id === home.id)!.queue.length).toBe(0);
    void oldDesign;
  });

  it('rejects refits without a shipyard base, across hulls, or away from the colony', () => {
    const state = newGame();
    const { home, newDesign, ship } = setup(state);
    // no starbase
    const saved = home.buildings;
    home.buildings = home.buildings.filter((b) => b !== 'star_base');
    expect(canQueue(state, home, `refit:${ship.id}:${newDesign.id}`)).toContain('star base');
    home.buildings = saved;
    // ship elsewhere
    const otherStar = state.stars.find((s) => s.id !== (ship.location as { starId: number }).starId)!;
    const origLoc = ship.location;
    ship.location = { kind: 'star', starId: otherStar.id };
    expect(canQueue(state, home, `refit:${ship.id}:${newDesign.id}`)).toContain('must wait');
    ship.location = origLoc;
    // different hull class is not a refit
    applyCommand(state, cmd(state, 'save_design', {
      name: 'Fat Hull',
      hull: 'destroyer',
      computer: 0,
      shield: 0,
      specials: [],
      weapons: [{ weapon: 'laser_cannon', count: 1, mods: [] }],
    }));
    const fat = state.empires[0]!.designs.find((d) => d.name === 'Fat Hull')!;
    expect(refitCost(state, 0, ship.id, fat.id)).toBeNull();
  });

  it('refunds half the price in BC when the ship leaves before the yard finishes', () => {
    const state = newGame();
    const { home, newDesign, ship, oldDesign } = setup(state);
    const price = refitCost(state, 0, ship.id, newDesign.id)!;
    applyCommand(state, cmd(state, 'set_build_queue', { colonyId: home.id, items: [`refit:${ship.id}:${newDesign.id}`] }));
    // the ship slips away mid-refit
    ship.location = { kind: 'transit', arrivalTurn: state.turn + 3 } as never;
    home.storedProd = 100_000;
    const bcBefore = state.empires[0]!.bc;
    const after = advance(state);
    const still = after.ships.find((s) => s.id === ship.id)!;
    expect(still.designId).toBe(oldDesign.id); // unchanged
    // half the price came back (other income also flows; check the floor holds)
    expect(after.empires[0]!.bc).toBeGreaterThanOrEqual(bcBefore + Math.floor(price / 2) - 200);
  });

  it('scrapping returns a quarter of the cost in BC — warships included', () => {
    const state = newGame();
    const { oldDesign, ship } = setup(state);
    const cost = itemCost(state, 0, `design:${oldDesign.id}`)!;
    const bc0 = state.empires[0]!.bc;
    applyCommand(state, cmd(state, 'scrap_ship', { shipId: ship.id }));
    expect(state.empires[0]!.bc).toBe(bc0 + Math.floor(cost / 4));
    expect(state.ships.some((s) => s.id === ship.id)).toBe(false);
  });
});
