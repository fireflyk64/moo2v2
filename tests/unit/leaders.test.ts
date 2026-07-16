import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import {
  LEADERS,
  leaderById,
  leaderPoints,
  hireCostOf,
  salaryOf,
  leaderColonyModifiers,
  leaderEmpireBonuses,
  leaderCombatBonuses,
  leadersUpkeep,
  countKind,
} from '@engine/leaders';
import { levelForXp, skillMagnitude, MAX_LEADERS_PER_KIND } from '@engine/data/leaders';
import { colonyOutput } from '@engine/economy';
import { validateCommand, applyCommand } from '@engine/commands';
import { driveSpeed } from '@engine/movement';
import type { Colony, GameState, TurnEvent } from '@engine/types';

const SEED = '0123456789abcdef0123456789abcdef';

function newGame(): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: true, randomEvents: false },
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

describe('leader data', () => {
  it('transcribes the full pool with valid classification', () => {
    expect(LEADERS.length).toBe(46);
    const ids = new Set(LEADERS.map((l) => l.id));
    expect(ids.size).toBe(46);
    const ships = LEADERS.filter((l) => l.kind === 'ship');
    const colonies = LEADERS.filter((l) => l.kind === 'colony');
    expect(ships.length + colonies.length).toBe(46);
    // spot checks against mechanics/leaders.md
    expect(leaderById.get('loknar')!.kind).toBe('ship');
    expect(leaderById.get('loknar')!.skills).toHaveLength(5);
    expect(leaderById.get('loknar')!.skills.every((s) => s.enhanced)).toBe(true);
    expect(leaderById.get('draxx')!.kind).toBe('colony');
    expect(leaderById.get('kimbuzzi')!.skills).toEqual([{ skill: 'farming_leader', enhanced: false }]);
  });

  it('levels and magnitudes follow L1/L4', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(29)).toBe(1);
    expect(levelForXp(30)).toBe(2);
    expect(levelForXp(300)).toBe(5);
    expect(skillMagnitude({ skill: 'farming_leader', enhanced: false }, 2)).toBe(6);
    expect(skillMagnitude({ skill: 'farming_leader', enhanced: true }, 2)).toBe(12);
  });

  it('prices follow L3 with famous/charismatic discounts', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    const charismatic = empire.picks.includes('charismatic');
    empire.picks = empire.picks.filter((p) => p !== 'charismatic'); // isolate the famous discount
    const kimbuzzi = leaderById.get('kimbuzzi')!;
    expect(leaderPoints(kimbuzzi)).toBe(1);
    expect(hireCostOf(kimbuzzi, empire)).toBe(75);
    expect(salaryOf(kimbuzzi)).toBe(1);
    // famous leader on staff discounts future hires
    empire.leaders.push({ leaderId: 'garron', level: 2, xp: 40, colonyId: null }); // famous (basic) lvl2 = 20%
    expect(hireCostOf(kimbuzzi, empire)).toBe(60);
    // charismatic races stack another 25%
    if (charismatic) {
      empire.picks = [...empire.picks, 'charismatic'].sort();
      expect(hireCostOf(kimbuzzi, empire)).toBe(41); // 75 × (100-45)%
    }
  });
});

describe('leader effects', () => {
  it('assigned colony leader boosts colony output', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    const colony = state.colonies.find((c) => c.owner === 0)!;
    const before = colonyOutput(state, colony);
    // science leader: research has no pollution term to mask the gain
    empire.leaders.push({ leaderId: 'emo', level: 5, xp: 300, colonyId: colony.id }); // +15% sci
    const mods = leaderColonyModifiers(state, empire, colony.id);
    expect(mods).toEqual([{ target: 'sci_pct', amount: 15, scope: 'colony' }]);
    const after = colonyOutput(state, colony);
    expect(after.research).toBeGreaterThan(before.research);
    // unassigned leaders contribute nothing
    empire.leaders[0]!.colonyId = null;
    expect(colonyOutput(state, colony).research).toBe(before.research);
  });

  it('colony leaders administer the whole star system, not just their seat', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    const home = state.colonies.find((c) => c.owner === 0)!;
    const homePlanet = state.planets.find((p) => p.id === home.planetId)!;
    const otherStar = state.stars.find((s) => s.id !== homePlanet.starId)!;
    // plant a copy of the homeworld colony around a given star
    const plant = (starId: number): Colony => {
      const planetId = state.nextId++;
      state.planets.push({ ...homePlanet, id: planetId, starId, orbit: 5, homeworldOf: null, special: null });
      const colony: Colony = structuredClone(home);
      colony.id = state.nextId++;
      colony.planetId = planetId;
      colony.name = `Test ${colony.id}`;
      state.colonies.push(colony);
      return colony;
    };
    const sibling = plant(homePlanet.starId); // same system as the leader's seat
    const faraway = plant(otherStar.id); // another system entirely
    const siblingBefore = colonyOutput(state, sibling).research;
    const farawayBefore = colonyOutput(state, faraway).research;
    // science leader seated at the homeworld (+15% sci at level 5)
    empire.leaders.push({ leaderId: 'emo', level: 5, xp: 300, colonyId: home.id });
    const boost = [{ target: 'sci_pct', amount: 15, scope: 'colony' }];
    expect(leaderColonyModifiers(state, empire, home.id)).toEqual(boost); // own seat
    expect(leaderColonyModifiers(state, empire, sibling.id)).toEqual(boost); // sibling in system
    expect(leaderColonyModifiers(state, empire, faraway.id)).toEqual([]); // other system: nothing
    expect(colonyOutput(state, sibling).research).toBeGreaterThan(siblingBefore);
    expect(colonyOutput(state, faraway).research).toBe(farawayBefore);
    // a seat lost to the enemy stops administering the system
    home.owner = 1;
    expect(leaderColonyModifiers(state, empire, sibling.id)).toEqual([]);
  });

  it('empire and combat bonuses accumulate by kind', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    empire.leaders.push({ leaderId: 'ruola', level: 3, xp: 90, colonyId: null }); // weaponry lvl3 = +15 attack
    empire.leaders.push({ leaderId: 'hawk', level: 2, xp: 40, colonyId: null }); // helmsman+navigator lvl2
    const cb = leaderCombatBonuses(empire);
    expect(cb.beamAttack).toBe(15);
    expect(cb.beamDefense).toBe(10);
    const eb = leaderEmpireBonuses(empire);
    expect(eb.navigatorSpeed).toBe(1); // basic navigator lvl2 -> +1 pc/turn
    expect(driveSpeed(empire)).toBeGreaterThanOrEqual(3);
  });
});

describe('leader lifecycle', () => {
  it('hire command validates offers, slots, and funds', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    empire.bc = 1000;
    const cmd = { turn: state.turn, playerId: 0, kind: 'hire_leader', payload: { leaderId: 'emo' } };
    expect(validateCommand(state, cmd)).toMatch(/no offer/);
    state.leaderOffers.push({ empireId: 0, leaderId: 'emo', priceBc: 75, expiresTurn: state.turn + 5 });
    expect(validateCommand(state, cmd)).toBeNull();
    applyCommand(state, cmd);
    expect(empire.bc).toBe(925);
    expect(empire.leaders).toHaveLength(1);
    expect(state.leaderOffers).toHaveLength(0);
    // assign to a colony
    const colony = state.colonies.find((c) => c.owner === 0)!;
    const assign = { turn: state.turn, playerId: 0, kind: 'assign_leader', payload: { leaderId: 'emo', colonyId: colony.id } };
    expect(validateCommand(state, assign)).toBeNull();
    applyCommand(state, assign);
    expect(empire.leaders[0]!.colonyId).toBe(colony.id);
    // a second leader cannot govern the same colony
    state.leaderOffers.push({ empireId: 0, leaderId: 'galis', priceBc: 75, expiresTurn: state.turn + 5 });
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'hire_leader', payload: { leaderId: 'galis' } });
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'assign_leader', payload: { leaderId: 'galis', colonyId: colony.id } }),
    ).toMatch(/already governs/);
    // ship officers refuse colony assignment
    state.leaderOffers.push({ empireId: 0, leaderId: 'ruola', priceBc: 75, expiresTurn: state.turn + 5 });
    applyCommand(state, { turn: state.turn, playerId: 0, kind: 'hire_leader', payload: { leaderId: 'ruola' } });
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'assign_leader', payload: { leaderId: 'ruola', colonyId: colony.id } }),
    ).toMatch(/fleet-wide/);
    expect(countKind(empire, 'colony')).toBe(2);
    expect(countKind(empire, 'ship')).toBe(1);
  });

  it('slot cap rejects a fifth colony leader', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    empire.bc = 10000;
    for (const id of ['emo', 'galis', 'crassis', 'kimbuzzi']) {
      state.leaderOffers.push({ empireId: 0, leaderId: id, priceBc: 10, expiresTurn: state.turn + 5 });
      applyCommand(state, { turn: state.turn, playerId: 0, kind: 'hire_leader', payload: { leaderId: id } });
    }
    expect(countKind(empire, 'colony')).toBe(MAX_LEADERS_PER_KIND);
    state.leaderOffers.push({ empireId: 0, leaderId: 'houri', priceBc: 10, expiresTurn: state.turn + 5 });
    expect(
      validateCommand(state, { turn: state.turn, playerId: 0, kind: 'hire_leader', payload: { leaderId: 'houri' } }),
    ).toMatch(/no free colony/);
  });

  it('upkeep pays salaries, awards XP, levels up, and fires the broke', () => {
    const state = newGame();
    const empire = state.empires[0]!;
    empire.bc = 100;
    empire.leaders.push({ leaderId: 'emo', level: 1, xp: 28, colonyId: null }); // 1 BC salary, about to level
    const events: TurnEvent[] = [];
    leadersUpkeep(state, events);
    expect(empire.bc).toBe(99);
    expect(empire.leaders[0]!.xp).toBeGreaterThanOrEqual(29);
    // drain the treasury: leader quits rather than sink the empire
    empire.bc = 0;
    const events2: TurnEvent[] = [];
    leadersUpkeep(state, events2);
    expect(empire.leaders).toHaveLength(0);
    expect(events2.some((e) => e.kind === 'leader_quit')).toBe(true);
    expect(empire.bc).toBe(0);
  });

  it('offers are deterministic and replay-stable', () => {
    const run = () => {
      let state = newGame();
      const log: string[] = [];
      for (let i = 0; i < 40; i++) {
        state = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
        gameEngine.takeEvents();
        log.push(state.leaderOffers.map((o) => `${o.empireId}:${o.leaderId}@${o.expiresTurn}`).join(','));
      }
      return { hash: gameEngine.hash(state), log: log.join('|') };
    };
    const a = run();
    const b = run();
    expect(a.hash).toBe(b.hash);
    expect(a.log).toBe(b.log);
  });
});
