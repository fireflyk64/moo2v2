// Ground invasion resolution + participants-only replay events (improvements:
// "make sure planet takeovers and transports work well" + animated invasion
// summary visible only to the involved players).

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { setRelation } from '@engine/battles';
import { resolveInvasions } from '@engine/ground';
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

/** land a big invasion force on player 1's homeworld */
function stageInvasion(state: GameState, troops: number) {
  setRelation(state, 0, 1, 'war');
  const target = state.colonies.find((c) => c.owner === 1 && !c.outpost)!;
  const star = state.planets.find((p) => p.id === target.planetId)!.starId;
  // remove the defender's warships (armed scouts count too) so the landing is unopposed
  state.ships = state.ships.filter((s) => !(s.owner === 1 && (s.shipKind === 'design' || s.shipKind === 'scout')));
  state.ships.push({
    id: state.nextId++,
    owner: 0,
    shipKind: 'transport',
    designId: null,
    location: { kind: 'star', starId: star },
    cargoPopUnits: troops,
    cargoRace: 0,
    dmgStructure: 0,
    dmgArmor: 0,
  });
  return { target, star };
}

describe('ground invasions', () => {
  it('an overwhelming force captures the colony and emits a replay to BOTH participants only', () => {
    const state = newGame();
    const { target } = stageInvasion(state, 40);
    const events: TurnEvent[] = [];
    resolveInvasions(state, events);

    const after = state.colonies.find((c) => c.id === target.id)!;
    expect(after.owner).toBe(0); // captured

    const ground = events.filter((e) => e.kind === 'ground_battle');
    // exactly one replay per participant (attacker 0, defender 1), no -1
    expect(ground.map((e) => e.visibleTo).sort()).toEqual([0, 1]);
    const p = ground[0]!.payload as { captured: boolean; rounds: unknown[]; startTroops: number };
    expect(p.captured).toBe(true);
    expect(p.startTroops).toBe(40);
    expect(p.rounds.length).toBeGreaterThan(1); // there is something to animate
  });

  it('a token force is repelled', () => {
    const state = newGame();
    const { target } = stageInvasion(state, 1);
    const events: TurnEvent[] = [];
    resolveInvasions(state, events);
    expect(state.colonies.find((c) => c.id === target.id)!.owner).toBe(1); // held
    const p = events.find((e) => e.kind === 'ground_battle')!.payload as { captured: boolean };
    expect(p.captured).toBe(false);
  });
});
