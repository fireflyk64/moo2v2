// S6b discovery payouts (planet_specials.md + design brief): ancient
// artifacts pay one free technology to the FIRST empire that visits the
// system once no keeper holds it; a splinter colony joins the discoverer
// outright as a farm-only native settlement.

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { advanceTurn } from '@engine/pipeline';
import { NATIVE_RACE, type GameState } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function freshState(): GameState {
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

/** a quiet non-home planet: no colony in its system, no monster */
function quietPlanet(state: GameState) {
  const colonyStars = new Set(
    state.colonies.map((c) => state.planets.find((p) => p.id === c.planetId)!.starId),
  );
  const monsterStars = new Set(state.monsters.map((m) => m.starId));
  return state.planets.find(
    (p) => p.body === 'planet' && !colonyStars.has(p.starId) && !monsterStars.has(p.starId),
  )!;
}

/** park one of the owner's ships at the star (unit test: direct placement) */
function parkShip(state: GameState, owner: number, starId: number) {
  const ship = state.ships.find((s) => s.owner === owner)!;
  ship.location = { kind: 'star', starId };
}

describe('s6b discovery payouts', () => {
  it('artifacts pay one free tech to the first visitor, exactly once', () => {
    const state = freshState();
    const planet = quietPlanet(state);
    planet.special = 'ancient_artifacts';
    parkShip(state, 0, planet.starId);
    const before0 = state.empires[0]!.knownApps.length;
    const before1 = state.empires[1]!.knownApps.length;

    const { events } = advanceTurn(state);
    expect(state.empires[0]!.knownApps.length).toBe(before0 + 1);
    expect(state.empires[1]!.knownApps.length).toBe(before1); // research can't finish turn 1
    expect(planet.artifactsLooted).toBe(true);
    expect(planet.special).toBe('ancient_artifacts'); // the +2-research special stays
    const ev = events.find((e) => e.kind === 'artifact_tech');
    expect(ev?.visibleTo).toBe(0);
    expect(ev?.payload['planetId']).toBe(planet.id);

    // a second visit pays nothing
    const after = state.empires[0]!.knownApps.length;
    const second = advanceTurn(state);
    expect(state.empires[0]!.knownApps.length).toBe(after);
    expect(second.events.find((e) => e.kind === 'artifact_tech')).toBeUndefined();
  });

  it('a keeper blocks the payout until it is gone', () => {
    const state = freshState();
    const planet = quietPlanet(state);
    planet.special = 'ancient_artifacts';
    state.monsters.push({ id: state.nextId++, kind: 'hydra', starId: planet.starId, dmgStructure: 0 });
    parkShip(state, 0, planet.starId);
    const before = state.empires[0]!.knownApps.length;
    // note: the parked ship fights the keeper this turn; the claim question
    // is settled BEFORE encounters, so the payout must not have happened
    advanceTurn(state);
    expect(planet.artifactsLooted).not.toBe(true);
    expect(state.empires[0]!.knownApps.length).toBe(before);
  });

  it('a guarded splinter colony joins only after the keeper is defeated', () => {
    const state = freshState();
    const planet = quietPlanet(state);
    planet.special = 'splinter_colony';
    planet.climate = 'terran';
    const keeperId = state.nextId++;
    state.monsters.push({ id: keeperId, kind: 'dragon', starId: planet.starId, dmgStructure: 0 });
    parkShip(state, 0, planet.starId);

    // keeper alive: the settlement stays hidden (the parked ship battles it)
    advanceTurn(state);
    if (state.phase === 'battle_orders') {
      gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
    }
    expect(state.colonies.find((c) => c.planetId === planet.id)).toBeUndefined();
    expect(planet.special).toBe('splinter_colony');

    // keeper falls (a scout loses that fight — clear it as combat would) and
    // a fleet stands in the system: the splinter folk join on the next turn
    state.monsters = state.monsters.filter((m) => m.id !== keeperId);
    parkShip(state, 0, planet.starId);
    advanceTurn(state);
    const colony = state.colonies.find((c) => c.planetId === planet.id);
    expect(colony?.owner).toBe(0);
    expect(colony?.groups[0]?.race).toBe(NATIVE_RACE);
    expect(planet.special).toBeNull();
  });

  it('a splinter colony joins the discoverer with farm-only natives', () => {
    const state = freshState();
    const planet = quietPlanet(state);
    planet.special = 'splinter_colony';
    planet.climate = 'terran';
    planet.sizeClass = 4;
    parkShip(state, 1, planet.starId);

    const { events } = advanceTurn(state);
    const colony = state.colonies.find((c) => c.planetId === planet.id);
    expect(colony).toBeDefined();
    expect(colony!.owner).toBe(1);
    expect(colony!.groups).toHaveLength(1);
    expect(colony!.groups[0]!.race).toBe(NATIVE_RACE);
    expect(colony!.groups[0]!.farmers).toBe(3);
    expect(colony!.groups[0]!.workers).toBe(0);
    expect(planet.special).toBeNull();
    const ev = events.find((e) => e.kind === 'splinter_joined');
    expect(ev?.visibleTo).toBe(1);
    expect(ev?.payload['units']).toBe(3);
  });

  it('simultaneous arrival: the lower empire id claims (deterministic tiebreak)', () => {
    const state = freshState();
    const planet = quietPlanet(state);
    planet.special = 'splinter_colony';
    planet.climate = 'terran';
    parkShip(state, 0, planet.starId);
    parkShip(state, 1, planet.starId);
    advanceTurn(state);
    if (state.phase === 'battle_orders') {
      // both parked fleets may clash — the claim was already settled at S6b
      gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
    }
    const colony = state.colonies.find((c) => c.planetId === planet.id);
    expect(colony?.owner).toBe(0);
  });
});
