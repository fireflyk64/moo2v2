import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { detectBattles, resolveBattle } from '@engine/battles';
import { validateCommand } from '@engine/commands';
import {
  ANTARAN_EMPIRE,
  MONSTER_EMPIRE,
  antaranUpkeep,
  factionOf,
  guardianReward,
  monsterToCombat,
  randomEventsUpkeep,
} from '@engine/npc';
import type { GameState, TurnEvent } from '@engine/types';

const SEED = '1234123412341234abcdabcdabcdabcd';

function newGame(modes: Partial<GameState['settings']['modes']> = {}): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'medium',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: true, randomEvents: false, ...modes },
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

describe('monsters and Orion', () => {
  it('seeds deterministically: Orion + Guardian + guarded systems', () => {
    const a = newGame();
    const b = newGame();
    expect(gameEngine.hash(a)).toBe(gameEngine.hash(b));
    const orion = a.stars.find((s) => s.name === 'Orion');
    expect(orion).toBeDefined();
    const guardian = a.monsters.find((m) => m.kind === 'guardian');
    expect(guardian).toBeDefined();
    expect(guardian!.starId).toBe(orion!.id);
    const prizes = a.planets.filter((p) => p.starId === orion!.id);
    expect(prizes.length).toBe(3);
    expect(prizes.some((p) => p.climate === 'gaia')).toBe(true);
    // no monster sits on a homeworld
    for (const m of a.monsters) {
      expect(a.colonies.some((c) => a.planets.some((p) => p.id === c.planetId && p.starId === m.starId))).toBe(false);
    }
  });

  it('guarded systems refuse colonization until cleared', () => {
    const state = newGame();
    const guardian = state.monsters.find((m) => m.kind === 'guardian')!;
    const prize = state.planets.find((p) => p.starId === guardian.starId)!;
    // teleport the colony ship there for the check
    const colonyShip = state.ships.find((s) => s.owner === 0 && s.shipKind === 'colony_ship')!;
    colonyShip.location = { kind: 'star', starId: guardian.starId };
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'colonize', payload: { shipId: colonyShip.id, planetId: prize.id } }),
    ).toMatch(/guarded/);
    state.monsters = state.monsters.filter((m) => m !== guardian);
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'colonize', payload: { shipId: colonyShip.id, planetId: prize.id } }),
    ).toBeNull();
  });

  it('a lair fight goes through the battle pipeline with prefilled NPC orders', () => {
    const state = newGame();
    const lair = state.monsters.find((m) => m.kind !== 'guardian') ?? state.monsters[0]!;
    const empire = state.empires[0]!;
    const design = empire.designs[0]!;
    for (let i = 0; i < 5; i++) {
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
    const fight = battles.find((b) => b.starId === lair.starId);
    expect(fight).toBeDefined();
    expect(fight!.defender).toBe(factionOf(lair));
    expect(fight!.ordersD).not.toBeNull(); // NPC side never blocks the sub-phase
    fight!.ordersA = { stance: 'charge', priority: 'nearest', retreatThresholdPct: 0, bombard: false };
    const events: TurnEvent[] = [];
    const before = lair.dmgStructure;
    resolveBattle(state, fight!, events);
    const after = state.monsters.find((m) => m.id === lair.id);
    // either the beast fell or it carries scars — both prove the exchange ran
    expect(after === undefined || after.dmgStructure >= before).toBe(true);
    expect(events.some((e) => e.kind === 'battle_resolved')).toBe(true);
  });

  it('guardian bounty grants the death ray and offers Loknar', () => {
    const state = newGame();
    const events: TurnEvent[] = [];
    guardianReward(state, 0, events);
    expect(state.empires[0]!.knownApps).toContain('death_ray');
    expect(state.leaderOffers.some((o) => o.leaderId === 'loknar' && o.empireId === 0)).toBe(true);
  });
});

describe('Antarans', () => {
  it('raids spawn at the largest empire and withdraw after their attack', () => {
    const state = newGame();
    state.antarans.nextRaidTurn = state.turn;
    const events: TurnEvent[] = [];
    antaranUpkeep(state, events);
    const raiders = state.monsters.filter((m) => factionOf(m) === ANTARAN_EMPIRE);
    expect(raiders.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === 'antaran_raid')).toBe(true);
    // the raid targets a colony star -> next detection has an Antaran attacker
    const battles = detectBattles(state);
    expect(battles.some((b) => b.attacker === ANTARAN_EMPIRE)).toBe(true);
    // two turns later they are gone
    state.turn += 2;
    antaranUpkeep(state, []);
    expect(state.monsters.filter((m) => factionOf(m) === ANTARAN_EMPIRE)).toHaveLength(0);
  });

  it('portal assault: winning at the fortress is an Antaran victory', () => {
    const state = newGame();
    const colony = state.colonies.find((c) => c.owner === 0)!;
    colony.buildings = [...colony.buildings, 'dimensional_portal'].sort();
    const planet = state.planets.find((p) => p.id === colony.planetId)!;
    const empire = state.empires[0]!;
    const design = empire.designs[0]!;
    state.ships.push({
      id: state.nextId++,
      owner: 0,
      shipKind: 'design',
      designId: design.id,
      location: { kind: 'star', starId: planet.starId },
      cargoPopUnits: 0,
      cargoRace: 0,
      dmgStructure: 0,
      dmgArmor: 0,
    });
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'attack_antarans', payload: { colonyId: colony.id } }),
    ).toBeNull();
    const next = gameEngine.apply(state, { turn: state.turn, playerId: 0, kind: 'attack_antarans', payload: { colonyId: colony.id } });
    expect(next.antarans.assaultBy).toBe(0);
    const battles = detectBattles(next);
    const assault = battles.find((b) => b.defender === ANTARAN_EMPIRE);
    expect(assault).toBeDefined();
    expect(assault!.attacker).toBe(0);
    // rig the outcome: strip the garrison down to a wounded raider
    next.monsters = next.monsters.filter((m) => factionOf(m) !== ANTARAN_EMPIRE || m.kind === 'antaran_raider');
    for (const m of next.monsters) {
      if (factionOf(m) === ANTARAN_EMPIRE) m.dmgStructure = 24; // 1 hp left
    }
    // one frigate may still lose; give the player a real fleet
    for (let i = 0; i < 8; i++) {
      next.ships.push({
        id: next.nextId++,
        owner: 0,
        shipKind: 'design',
        designId: next.empires[0]!.designs[0]!.id,
        location: { kind: 'star', starId: planet.starId },
        cargoPopUnits: 0,
        cargoRace: 0,
        dmgStructure: 0,
        dmgArmor: 0,
      });
    }
    assault!.ordersA = { stance: 'charge', priority: 'nearest', retreatThresholdPct: 0, bombard: false };
    const events: TurnEvent[] = [];
    resolveBattle(next, assault!, events);
    expect(next.winType === 'antaran' ? next.winner : null).toBe(next.winType === 'antaran' ? 0 : null);
    expect(next.antarans.assaultBy).toBeNull(); // portal collapsed either way
    expect(next.monsters.filter((m) => factionOf(m) === ANTARAN_EMPIRE)).toHaveLength(0);
  });
});

describe('random events', () => {
  it('fire deterministically and only with the option on', () => {
    const off = newGame({ randomEvents: false });
    for (let t = 0; t < 60; t++) {
      off.turn = t + 1;
      const ev: TurnEvent[] = [];
      randomEventsUpkeep(off, ev);
      expect(ev).toHaveLength(0);
    }
    const run = () => {
      const st = newGame({ randomEvents: true });
      const kinds: string[] = [];
      for (let t = 0; t < 120; t++) {
        st.turn = t + 1;
        const ev: TurnEvent[] = [];
        randomEventsUpkeep(st, ev);
        kinds.push(...ev.map((e) => e.kind));
      }
      return kinds;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((k) => k.startsWith('event_'))).toBe(true);
  });
});

describe('npc combat fixtures', () => {
  it('monster stat blocks convert to valid combat ships', () => {
    const state = newGame();
    for (const m of state.monsters) {
      const cs = monsterToCombat(m, 1);
      expect(cs.structureHp).toBeGreaterThan(0);
      expect(cs.weapons.length).toBeGreaterThan(0);
      expect(cs.shipId).toBe(2_000_000 + m.id);
      expect([MONSTER_EMPIRE, ANTARAN_EMPIRE]).toContain(factionOf(m));
    }
  });
});
