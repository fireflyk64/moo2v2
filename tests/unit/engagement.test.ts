// Battle engagement choice (0.22.0): the attacker picks WHICH colony to
// assault (only that colony's defenses fight, it takes the bombardment) or a
// deep-space fleet action (no colony defenses at all); the defender may hold
// at a colony when the attacker stays out. Absent field = byte-exact legacy.
import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { BASE_COMBAT_ID, MONSTER_COMBAT_ID } from '@engine/ids';
import { bombard, buildBattleInput, setRelation } from '@engine/battles';
import { validateCommand } from '@engine/commands';
import type { Colony, GameState, PendingBattle, Planet } from '@engine/types';

const SEED = '1234123412341234abcdabcdabcdabcd';

const ORDERS = { stance: 'charge', priority: 'nearest', retreatThresholdPct: 25, bombard: false };

interface Scene {
  state: GameState;
  starId: number;
  colonyA: Colony; // defender's first (home) colony — the legacy pick
  colonyB: Colony; // defender's second colony at the same star
  emptyPlanet: Planet; // a planet at the star with no colony on it
  battle: PendingBattle;
}

/** Two defender colonies (both with a star base) at one star, attacker
 * warships in orbit, war declared. */
function scene(): Scene {
  const state = gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'medium',
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
  const colonyA = state.colonies.find((c) => c.owner === 1)!;
  const homePlanet = state.planets.find((p) => p.id === colonyA.planetId)!;
  const starId = homePlanet.starId;
  if (!colonyA.buildings.includes('star_base')) colonyA.buildings.push('star_base');
  // second colony on another world of the same system (fabricated planet so
  // the fixture never depends on the generated system layout)
  const planetB: Planet = {
    id: state.nextId++,
    starId,
    orbit: 4,
    body: 'planet',
    sizeClass: 3,
    climate: 'terran',
    minerals: 'abundant',
    gravity: 'normal',
    special: null,
    homeworldOf: null,
    terraformSteps: 0,
  };
  state.planets.push(planetB);
  const colonyB: Colony = { ...structuredClone(colonyA), id: state.nextId++, planetId: planetB.id };
  state.colonies.push(colonyB);
  const emptyPlanet: Planet = { ...planetB, id: state.nextId++, orbit: 5 };
  state.planets.push(emptyPlanet);
  // attacker warships at the defender's star
  const empire0 = state.empires.find((e) => e.id === 0)!;
  const design = empire0.designs.find((d) => d.hull === 'frigate')!;
  for (let i = 0; i < 2; i++) {
    state.ships.push({
      id: state.nextId++,
      owner: 0,
      shipKind: 'design',
      designId: design.id,
      location: { kind: 'star', starId },
      cargoPopUnits: 0,
      cargoRace: 0,
      dmgStructure: 0,
      dmgArmor: 0,
    });
  }
  setRelation(state, 0, 1, 'war');
  const battle: PendingBattle = { id: `b${state.turn}-${starId}-0v1`, starId, attacker: 0, defender: 1, ordersA: null, ordersD: null };
  return { state, starId, colonyA, colonyB, emptyPlanet, battle };
}

const baseIds = (input: { ships: Array<{ shipId: number }> }) =>
  input.ships.map((s) => s.shipId).filter((id) => id >= BASE_COMBAT_ID && id < MONSTER_COMBAT_ID);

describe('battle engagement', () => {
  it('legacy orders (no field) keep today\'s exact pick: the first colony\'s base fights', () => {
    const { state, colonyA, colonyB, battle } = scene();
    battle.ordersA = { ...ORDERS };
    battle.ordersD = { ...ORDERS };
    const built = buildBattleInput(state, battle);
    expect(built.engagedColonyId).toBeUndefined();
    expect(built.baseColonyId).toBe(colonyA.id);
    expect(baseIds(built.input)).toEqual([BASE_COMBAT_ID + colonyA.id]);
    expect(baseIds(built.input)).not.toContain(BASE_COMBAT_ID + colonyB.id);
    expect(built.input.planetId).toBe(colonyA.planetId);
  });

  it('assaulting colony B fields only B\'s defenses (and B takes the barrage)', () => {
    const { state, colonyA, colonyB, battle } = scene();
    battle.ordersA = { ...ORDERS, engagePlanetId: colonyB.planetId };
    battle.ordersD = { ...ORDERS };
    const built = buildBattleInput(state, battle);
    expect(built.engagedColonyId).toBe(colonyB.id);
    expect(built.baseColonyId).toBe(colonyB.id);
    expect(baseIds(built.input)).toEqual([BASE_COMBAT_ID + colonyB.id]);
    expect(baseIds(built.input)).not.toContain(BASE_COMBAT_ID + colonyA.id);
    expect(built.input.planetId).toBe(colonyB.planetId);
    // the engaged colony takes the bombardment, not the legacy first pick
    const report = bombard(state, battle, [], colonyB.id) as { colonyId: number };
    expect(report.colonyId).toBe(colonyB.id);
    const legacy = bombard(state, battle, []) as { colonyId: number };
    expect(legacy.colonyId).toBe(colonyA.id);
  });

  it('deep space fields NO colony defenses', () => {
    const { state, battle } = scene();
    battle.ordersA = { ...ORDERS, engagePlanetId: null };
    battle.ordersD = { ...ORDERS }; // defender default = meet the fleet
    const built = buildBattleInput(state, battle);
    expect(built.engagedColonyId).toBeNull();
    expect(built.baseColonyId).toBeNull();
    expect(baseIds(built.input)).toEqual([]);
    expect(built.input.planetId).toBeNull();
  });

  it('attacker in deep space + defender holding = the fight happens under the held colony\'s guns', () => {
    const { state, colonyB, battle } = scene();
    battle.ordersA = { ...ORDERS, engagePlanetId: null };
    battle.ordersD = { ...ORDERS, engagePlanetId: colonyB.planetId };
    const built = buildBattleInput(state, battle);
    expect(built.engagedColonyId).toBe(colonyB.id);
    expect(baseIds(built.input)).toEqual([BASE_COMBAT_ID + colonyB.id]);
    expect(built.input.planetId).toBe(colonyB.planetId);
  });

  it('the attacker\'s assault overrides the defender\'s hold preference (auto-defend)', () => {
    const { state, colonyA, colonyB, battle } = scene();
    battle.ordersA = { ...ORDERS, engagePlanetId: colonyA.planetId };
    battle.ordersD = { ...ORDERS, engagePlanetId: colonyB.planetId };
    const built = buildBattleInput(state, battle);
    expect(built.engagedColonyId).toBe(colonyA.id);
    expect(baseIds(built.input)).toEqual([BASE_COMBAT_ID + colonyA.id]);
  });

  it('validates the engagement field strictly', () => {
    const { state, colonyB, emptyPlanet, battle } = scene();
    state.phase = 'battle_orders';
    state.pendingBattles = [battle];
    const cmd = (playerId: number, engagePlanetId: unknown) =>
      validateCommand(state, {
        turn: state.turn,
        playerId,
        kind: 'battle_orders',
        payload: { battleId: battle.id, orders: { ...ORDERS, engagePlanetId } },
      });
    // attacker: enemy colony planet or null are valid
    expect(cmd(0, colonyB.planetId)).toBeNull();
    expect(cmd(0, null)).toBeNull();
    expect(cmd(0, undefined)).toBeNull(); // absent = legacy
    // attacker: colony-less planet, off-star planet, junk are rejected
    expect(cmd(0, emptyPlanet.id)).toMatch(/not an enemy colony/);
    const offStar = state.planets.find((p) => p.starId !== battle.starId)!;
    expect(cmd(0, offStar.id)).toMatch(/not at the battle star/);
    expect(cmd(0, 1.5)).toMatch(/bad engage planet/);
    // defender: holds only at an OWN colony
    expect(cmd(1, colonyB.planetId)).toBeNull();
    expect(cmd(1, emptyPlanet.id)).toMatch(/not your colony/);
    expect(cmd(1, null)).toBeNull();
  });
});
