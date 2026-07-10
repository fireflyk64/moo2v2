// Terraforming + planetary construction verification (bug: "ensure
// terraforming and planetary construction works correctly"): step chains per
// the mechanics docs (incl. barren → desert OR tundra), escalating costs,
// hostile/energized exclusion, gaia on terran only, and max-pop payoff —
// exercised through the real build pipeline, not just the helpers.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyCommand, validateCommand } from '@engine/commands';
import { canQueue } from '@engine/items';
import { colonyMaxPop } from '@engine/economy';
import { applyTerraformStep, canTerraform, terraformCost, NEXT_TERRAFORM } from '@engine/terraform';
import type { Climate, GameState, Planet } from '@engine/types';

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

function advance(state: GameState): GameState {
  const next = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
  if (next.phase === 'battle_orders') {
    return gameEngine.apply(next, { turn: next.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
  }
  return next;
}

const fakePlanet = (id: number, climate: Climate): Planet =>
  ({ id, starId: 0, orbit: 1, body: 'planet', climate, minerals: 'abundant', gravity: 'normal', sizeClass: 3, special: null, terraformSteps: 0 }) as Planet;

describe('terraforming steps + costs (docs: mechanics/tech/ecology.md)', () => {
  it('every documented chain ends at terran', () => {
    for (const start of ['desert', 'arid', 'tundra', 'swamp', 'ocean'] as Climate[]) {
      const p = fakePlanet(2, start);
      for (let guard = 0; guard < 5 && p.climate !== 'terran'; guard++) applyTerraformStep(p);
      expect(p.climate).toBe('terran');
    }
  });

  it('barren becomes desert or tundra (deterministic per planet), both reaching terran in 3 steps', () => {
    const even = fakePlanet(2, 'barren');
    const odd = fakePlanet(3, 'barren');
    expect(applyTerraformStep(even)).toBe('desert');
    expect(applyTerraformStep(odd)).toBe('tundra');
    for (const p of [even, odd]) {
      while (p.climate !== 'terran') applyTerraformStep(p);
      expect(p.terraformSteps).toBe(3);
    }
  });

  it('cost escalates 250 + 250 per completed step on that planet', () => {
    const p = fakePlanet(2, 'barren');
    expect(terraformCost(p)).toBe(250);
    applyTerraformStep(p);
    expect(terraformCost(p)).toBe(500);
    applyTerraformStep(p);
    expect(terraformCost(p)).toBe(750);
  });

  it('hostile and energized worlds are never terraformable; terran/gaia are done', () => {
    expect(canTerraform(fakePlanet(2, 'hostile'))).toContain('cannot be terraformed');
    expect(canTerraform(fakePlanet(2, 'energized'))).toContain('cannot be terraformed');
    expect(canTerraform(fakePlanet(2, 'terran'))).toContain('cannot be improved');
    expect(NEXT_TERRAFORM['gaia' as Climate]).toBeUndefined();
  });
});

describe('terraforming + gaia through the real build pipeline', () => {
  it('a queued terraforming project changes the climate and raises max pop', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
    const planet = state.planets.find((p) => p.id === home.planetId)!;
    planet.climate = 'desert';
    planet.terraformSteps = 0;
    const popBefore = colonyMaxPop(state, home);

    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'debug_grant_app', payload: { appId: 'terraforming' } });
    const c = { turn: state.turn, playerId: 0, kind: 'set_build_queue', payload: { colonyId: home.id, items: ['terraforming'] } };
    expect(validateCommand(state, c)).toBeNull();
    applyCommand(state, c);
    home.storedProd = 100_000;
    const after = advance(state);
    const planetAfter = after.planets.find((p) => p.id === planet.id)!;
    expect(planetAfter.climate).toBe('arid');
    expect(planetAfter.terraformSteps).toBe(1);
    const homeAfter = after.colonies.find((x) => x.id === home.id)!;
    expect(colonyMaxPop(after, homeAfter)).toBeGreaterThan(popBefore);
  });

  it('gaia transformation: terran only, and completion makes the world gaia', () => {
    const state = newGame();
    const home = state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
    const planet = state.planets.find((p) => p.id === home.planetId)!;
    planet.climate = 'desert';
    expect(canQueue(state, home, 'gaia_transformation')).toBeTruthy(); // rejected off-terran

    planet.climate = 'terran';
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'debug_grant_app', payload: { appId: 'gaia_transformation' } });
    expect(canQueue(state, home, 'gaia_transformation')).toBeNull();
    applyCommand(state, {
      turn: state.turn,
      playerId: 0,
      kind: 'set_build_queue',
      payload: { colonyId: home.id, items: ['gaia_transformation'] },
    });
    home.storedProd = 100_000;
    const after = advance(state);
    expect(after.planets.find((p) => p.id === planet.id)!.climate).toBe('gaia');
  });
});
