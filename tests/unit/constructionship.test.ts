// Planetary Construction Ship (optional game mode): once EVERY construction
// field is researched, colonies can build a construction ship that flies to
// an asteroid belt or gas giant and rebuilds it into a barren world
// (construct_planet consumes the ship).
import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { applyCommand, validateCommand } from '@engine/commands';
import { canQueue, constructionShipUnlocked } from '@engine/items';
import { FIELD_ROWS, FIELD_SUBJECTS } from '@engine/data/index';
import type { GameState } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(mode: boolean): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: {
        creativeVariant: false,
        pickBidding: false,
        stickyBuild: false,
        antarans: false,
        randomEvents: false,
        constructionShip: mode,
      },
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

function completeConstruction(state: GameState): void {
  const empire = state.empires[0]!;
  for (const f of FIELD_ROWS) {
    if (FIELD_SUBJECTS[f.id] !== 'construction' || f.id.startsWith('advf_')) continue;
    if (!empire.completedFields.includes(f.num)) empire.completedFields.push(f.num);
  }
  empire.completedFields.sort((a, b) => a - b);
}

function homeColony(state: GameState) {
  return state.colonies.find((c) => c.owner === 0 && !c.outpost)!;
}

describe('planetary construction ship', () => {
  it('cannot be queued with the mode off, or before construction is finished', () => {
    const off = newGame(false);
    completeConstruction(off);
    expect(canQueue(off, homeColony(off), 'construction_ship')).toContain('game option is off');

    const on = newGame(true);
    expect(constructionShipUnlocked(on, on.empires[0]!)).toBe(false);
    expect(canQueue(on, homeColony(on), 'construction_ship')).toContain('every construction field');
    completeConstruction(on);
    expect(constructionShipUnlocked(on, on.empires[0]!)).toBe(true);
    expect(canQueue(on, homeColony(on), 'construction_ship')).toBeNull();
  });

  it('construct_planet turns an asteroid belt into a barren world and consumes the ship', () => {
    const state = newGame(true);
    completeConstruction(state);
    const colony = homeColony(state);
    const home = state.planets.find((p) => p.id === colony.planetId)!;
    // plant an asteroid belt in the home system on a free orbit
    const orbitInUse = new Set(state.planets.filter((p) => p.starId === home.starId).map((p) => p.orbit));
    const orbit = [1, 2, 3, 4, 5].find((o) => !orbitInUse.has(o)) ?? 5;
    const belt = {
      id: 987654,
      starId: home.starId,
      orbit,
      body: 'asteroids',
      sizeClass: 3,
      climate: 'barren',
      minerals: 'rich',
      gravity: 'normal',
      special: null,
      homeworldOf: null,
      terraformSteps: 0,
    };
    state.planets.push(belt as unknown as (typeof state.planets)[number]);
    // spawn the ship at the home star (as the build completion would)
    const ship = {
      id: 555001,
      owner: 0,
      shipKind: 'construction_ship',
      designId: null,
      location: { kind: 'star', starId: home.starId },
      cargoPopUnits: 0,
      cargoRace: 0,
      dmgStructure: 0,
      dmgArmor: 0,
    };
    state.ships.push(ship as unknown as (typeof state.ships)[number]);

    const cmd = { turn: state.turn, playerId: 0, kind: 'construct_planet', payload: { shipId: ship.id, planetId: belt.id } };
    // rejected when the mode is off
    const off = { ...state, settings: { ...state.settings, modes: { ...state.settings.modes, constructionShip: false } } } as GameState;
    expect(validateCommand(off, cmd)).toContain('game option is off');
    // rejected against an ordinary planet
    expect(validateCommand(state, { ...cmd, payload: { shipId: ship.id, planetId: home.id } })).toContain('asteroid belts and gas giants');

    expect(validateCommand(state, cmd)).toBeNull();
    applyCommand(state, cmd);
    const converted = state.planets.find((p) => p.id === belt.id)!;
    expect(converted.body).toBe('planet');
    expect(converted.climate).toBe('barren');
    expect(converted.sizeClass).toBe(3);
    expect(converted.minerals).toBe('rich');
    expect(state.ships.some((s) => s.id === ship.id)).toBe(false); // consumed
  });

  it('gas giants become huge barren worlds', () => {
    const state = newGame(true);
    completeConstruction(state);
    const colony = homeColony(state);
    const home = state.planets.find((p) => p.id === colony.planetId)!;
    const giant = {
      id: 987655,
      starId: home.starId,
      orbit: 5,
      body: 'gas_giant',
      sizeClass: 3,
      climate: 'barren',
      minerals: 'abundant',
      gravity: 'high',
      special: null,
      homeworldOf: null,
      terraformSteps: 0,
    };
    state.planets.push(giant as unknown as (typeof state.planets)[number]);
    const ship = {
      id: 555002,
      owner: 0,
      shipKind: 'construction_ship',
      designId: null,
      location: { kind: 'star', starId: home.starId },
      cargoPopUnits: 0,
      cargoRace: 0,
      dmgStructure: 0,
      dmgArmor: 0,
    };
    state.ships.push(ship as unknown as (typeof state.ships)[number]);
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'construct_planet', payload: { shipId: ship.id, planetId: giant.id } });
    const converted = state.planets.find((p) => p.id === giant.id)!;
    expect(converted.body).toBe('planet');
    expect(converted.sizeClass).toBe(5);
    expect(converted.gravity).toBe('high'); // gravity carries over
  });
});
