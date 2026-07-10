// Foundations laid for fast-start + the 2026-07 bugs.md batch:
//   - per-empire dynamic entity ids (speculative replay safety)
//   - settler runs on the second-best drive
//   - freighter in-use upkeep (0.5 BC per freighter, idle free)
//   - Unification skips morale tech in research choices
//   - point-defense weapons mount as 360° at standard space

import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/adapter';
import { allocId, allocWorldId, ID_BLOCK, shortEntityId } from '@engine/ids';
import { settlerDriveSpeed, driveSpeed } from '@engine/movement';
import { advanceTurn } from '@engine/pipeline';
import { appPickableBy, applyResearch } from '@engine/research';
import { rngFor } from '@engine/rng';
import { validateCommand } from '@engine/commands';
import { fitWeapon } from '@engine/shipdesign';
import { fieldByNum } from '@engine/data/index';
import type { GameState, TurnEvent } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(raceJson0?: string, raceJson1?: string): GameState {
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
      { id: 0, name: 'A', raceJson: raceJson0 ?? JSON.stringify({ presetId: 'solari' }) },
      { id: 1, name: 'B', raceJson: raceJson1 ?? JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

describe('per-empire entity ids', () => {
  it("an empire's ids never depend on other empires' allocations", () => {
    const base = newGame();
    const alone = structuredClone(base);
    const crowded = structuredClone(base);
    const idAlone = allocId(alone, 0);
    // in the crowded world, empire 1 and the world allocate first
    allocId(crowded, 1);
    allocId(crowded, 1);
    allocWorldId(crowded);
    const idCrowded = allocId(crowded, 0);
    expect(idCrowded).toBe(idAlone);
  });

  it('blocks never collide: init < world < empires, all safe integers', () => {
    const s = newGame();
    const w = allocWorldId(s);
    const e0 = allocId(s, 0);
    const e1 = allocId(s, 1);
    expect(s.nextId).toBeLessThan(ID_BLOCK);
    expect(w).toBeGreaterThanOrEqual(ID_BLOCK);
    expect(w).toBeLessThan(2 * ID_BLOCK);
    expect(e0).toBeGreaterThanOrEqual(2 * ID_BLOCK);
    expect(e0).toBeLessThan(3 * ID_BLOCK);
    expect(e1).toBeGreaterThanOrEqual(3 * ID_BLOCK);
    expect(Number.isSafeInteger(e1)).toBe(true);
    expect(shortEntityId(e0)).toBe(1);
    expect(shortEntityId(42)).toBe(42);
  });
});

describe('settler drive speed (second-best drive)', () => {
  it('uses nuclear until TWO drives are known, then the second best', () => {
    const s = newGame();
    const e = s.empires[0]!;
    e.knownApps = e.knownApps.filter((a) => !a.includes('drive'));
    expect(settlerDriveSpeed(e)).toBe(2); // nuclear only
    e.knownApps.push('fusion_drive');
    expect(driveSpeed(e)).toBe(3);
    expect(settlerDriveSpeed(e)).toBe(2); // best goes to the warfleet
    e.knownApps.push('ion_drive');
    expect(driveSpeed(e)).toBe(4);
    expect(settlerDriveSpeed(e)).toBe(3); // fusion hand-me-downs
    e.knownApps.push('interphased_drive');
    expect(settlerDriveSpeed(e)).toBe(4); // ion is now second best
  });

  it('racial trans-dimensional bonus still applies (it is the crew, not the engine)', () => {
    const s = newGame(JSON.stringify({ picks: ['trans_dimensional', 'dictatorship'] }));
    const e = s.empires[0]!;
    expect(settlerDriveSpeed(e)).toBe(driveSpeed(e)); // single drive: same base
    expect(settlerDriveSpeed(e)).toBe(4); // nuclear 2 + trans-dimensional 2
  });
});

describe('freighter in-use upkeep', () => {
  function withDeficitColony(s: GameState): void {
    const home = s.colonies.find((c) => c.owner === 0)!;
    const homeStar = s.planets.find((p) => p.id === home.planetId)!.starId;
    const sibling = s.planets.find((p) => p.starId === homeStar && p.id !== home.planetId && p.body === 'planet')!;
    s.colonies.push({
      id: allocId(s, 0),
      planetId: sibling.id,
      owner: 0,
      name: 'Deficit',
      groups: [{ race: 0, popK: 2000, farmers: 0, workers: 2, scientists: 0, unrest: false }],
      buildings: [],
      queue: [],
      storedProd: 0,
      stickyInvested: {},
      boughtThisTurn: false,
      foodLackPrev: 0,
      prodLackPrev: 0,
      housingPPPrev: 0,
      outpost: false,
    });
    s.colonies.sort((a, b) => a.id - b.id);
  }

  it('charges 0.5 BC per freighter hauling food or colonists; idle hulls are free', () => {
    const s = newGame();
    withDeficitColony(s);
    const e = s.empires[0]!;
    e.freighters = 10;
    // one colonist unit in transit ties up 5 freighters for the whole trip
    s.popTransits = [
      {
        id: allocId(s, 0),
        empireId: 0,
        race: 0,
        fromColonyId: s.colonies.find((c) => c.owner === 0)!.id,
        toColonyId: s.colonies.find((c) => c.owner === 0)!.id,
        units: 1,
        departedTurn: 1,
        arrivalTurn: 5,
      },
    ];
    const { events } = advanceTurn(s);
    const upkeep = events.find((ev) => ev.kind === 'freighter_upkeep' && ev.visibleTo === 0);
    expect(upkeep).toBeDefined();
    // 2 food hauled (workers-only colony eats 2) + 5 colonist freighters = 7
    // in use -> ceil(7/2) = 4 BC
    expect(upkeep!.payload).toEqual({ inUse: 7, bc: 4 });
  });

  it('no charge when nothing is hauled', () => {
    const s = newGame();
    s.empires[0]!.freighters = 10; // idle fleet
    const { events } = advanceTurn(s);
    expect(events.find((ev) => ev.kind === 'freighter_upkeep' && ev.visibleTo === 0)).toBeUndefined();
  });
});

describe('Unification skips morale tech', () => {
  const HIVEX = JSON.stringify({ presetId: 'hivex' }); // uncreative + unification

  it('appPickableBy marks the three morale buildings dead for unification only', () => {
    const s = newGame(HIVEX);
    expect(appPickableBy(s.empires[0]!, 'pleasure_dome')).toBe(false);
    expect(appPickableBy(s.empires[0]!, 'holo_simulator')).toBe(false);
    expect(appPickableBy(s.empires[0]!, 'virtual_reality_network')).toBe(false);
    expect(appPickableBy(s.empires[0]!, 'astro_university')).toBe(true);
    expect(appPickableBy(s.empires[1]!, 'pleasure_dome')).toBe(true); // solari: fine
  });

  it("an uncreative unification empire's random grant never rolls a morale app", () => {
    // field 73 holds alien_management_center + astro_university + holo_simulator
    const field = fieldByNum.get(73)!;
    for (let salt = 0; salt < 8; salt++) {
      const s = newGame(HIVEX);
      s.turn = 1 + salt; // vary the roll stream
      const e = s.empires[0]!;
      if (field.previous !== 0 && !e.completedFields.includes(field.previous)) {
        e.completedFields.push(field.previous);
        e.completedFields.sort((a, b) => a - b);
      }
      e.research.fieldNum = 73;
      const events: TurnEvent[] = [];
      applyResearch(s, e, 1_000_000, rngFor(SEED, s.turn, 'research', 0), events);
      const done = events.find((ev) => ev.kind === 'research_complete');
      expect(done).toBeDefined();
      const granted = (done!.payload as { granted: string[] }).granted;
      expect(granted).toHaveLength(1);
      expect(granted[0]).not.toBe('holo_simulator');
    }
  });

  it('a target-choosing unification race cannot pick a morale app while alternatives exist', () => {
    const s = newGame(JSON.stringify({ picks: ['unification'] })); // not uncreative
    const e = s.empires[0]!;
    const field = fieldByNum.get(73)!;
    if (field.previous !== 0 && !e.completedFields.includes(field.previous)) {
      e.completedFields.push(field.previous);
      e.completedFields.sort((a, b) => a - b);
    }
    const err = validateCommand(s, {
      seq: -1,
      turn: 1,
      playerId: 0,
      kind: 'set_research',
      payload: { fieldNum: 73, targetApp: 'holo_simulator' },
    } as never);
    expect(err).toMatch(/Unification/);
    const ok = validateCommand(s, {
      seq: -1,
      turn: 1,
      playerId: 0,
      kind: 'set_research',
      payload: { fieldNum: 73, targetApp: 'astro_university' },
    } as never);
    expect(ok).toBeNull();
  });
});

describe('point defense mounts as 360°', () => {
  it('anti-missile rocket: any requested arc fits as 360 at standard-mount space', () => {
    const s = newGame();
    const e = s.empires[0]!;
    const f = fitWeapon(e, { weapon: 'anti_missile_rocket', count: 1, mods: [], arc: 'F' });
    const t = fitWeapon(e, { weapon: 'anti_missile_rocket', count: 1, mods: [], arc: '360' });
    expect(typeof f).not.toBe('string');
    expect(typeof t).not.toBe('string');
    if (typeof f === 'string' || typeof t === 'string') return;
    expect(f.arc).toBe('360');
    expect(f.spaceEach).toBe(t.spaceEach); // no wide-arc premium either way
    expect(f.costEach).toBe(t.costEach);
    // control: a beam weapon still pays for the turret
    const beamF = fitWeapon(e, { weapon: 'laser_cannon', count: 1, mods: [], arc: 'F' });
    const beam360 = fitWeapon(e, { weapon: 'laser_cannon', count: 1, mods: [], arc: '360' });
    if (typeof beamF === 'string' || typeof beam360 === 'string') throw new Error('laser must fit');
    expect(beam360.spaceEach).toBeGreaterThan(beamF.spaceEach);
  });
});
