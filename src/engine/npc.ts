// Non-player forces + random events (M1/A1/E1 documented decisions):
//
// M1  Monsters guard star systems (rolled at game start, ~12% of non-home
//     systems with planets; the classic stat blocks in mechanics/monsters.md
//     are rescaled to our combat units). The Guardian holds Orion — the star
//     farthest from every homeworld, re-rolled to prime worlds. Killing the
//     Guardian grants the death ray application and a free offer for Loknar.
// M2  Monster battles use the normal battle pipeline with NPC empire id -2
//     (Antarans -3); the NPC side's orders are pre-filled so only the human
//     side is awaited in the battle-orders sub-phase.
// A1  Antarans (option): every 25-40 turns they raid the colony of the
//     currently largest empire; the raid party scales with the turn number.
//     If they win the pass they raze half the colony and vanish; either way
//     the party leaves after its attack. dimensional_portal + attack_antarans
//     sends your fleet at their home fortress: win = Antaran victory.
// E1  Random events (option): 4%/turn one event strikes a random empire;
//     lucky races are never the victim of the bad ones.

import { rngFor } from './rng';
import { NEXT_TERRAFORM } from './terraform';
import { grantApp } from './research';
import { colonyPopUnits, traitsOf } from './economy';
import type { CombatShipInit, CombatWeapon } from './combat';
import type { GameState, MonsterUnit, Planet, TurnEvent } from './types';

export const MONSTER_EMPIRE = -2;
export const ANTARAN_EMPIRE = -3;

export type MonsterKind = MonsterUnit['kind'];

interface MonsterSpec {
  structure: number;
  armor: number;
  beamAttack: number;
  beamDefense: number;
  speed: number;
  shieldPool: number;
  shieldFlat: number;
  specials: string[];
  weapons: CombatWeapon[];
}

const beam = (id: string, min: number, max: number, count: number, mods: string[] = []): CombatWeapon => ({
  weaponId: id,
  classId: 0,
  dmgMin: min,
  dmgMax: max,
  mods,
  ammo: -1,
  cooldown: 0,
  count,
});
const missile = (id: string, dmg: number, count: number, ammo = 10): CombatWeapon => ({
  weaponId: id,
  classId: 1,
  dmgMin: dmg,
  dmgMax: dmg,
  mods: [],
  ammo,
  cooldown: 0,
  count,
});

/** Classic stat blocks rescaled to our combat units (M1). */
export const MONSTER_SPECS: Record<MonsterKind, MonsterSpec> = {
  amoeba: {
    structure: 150, armor: 0, beamAttack: 50, beamDefense: 35, speed: 7,
    shieldPool: 0, shieldFlat: 0, specials: [],
    weapons: [beam('caustic_slime', 6, 12, 2)],
  },
  hydra: {
    structure: 250, armor: 0, beamAttack: 50, beamDefense: 30, speed: 6,
    shieldPool: 0, shieldFlat: 0, specials: ['energy_absorber'],
    weapons: [beam('plasma_breath', 5, 10, 5, ['hv'])],
  },
  eel: {
    structure: 180, armor: 0, beamAttack: 100, beamDefense: 60, speed: 20,
    shieldPool: 0, shieldFlat: 0, specials: ['lightning_field'],
    weapons: [beam('plasma_flux', 8, 14, 2)],
  },
  crystal: {
    structure: 400, armor: 0, beamAttack: 90, beamDefense: 45, speed: 10,
    shieldPool: 0, shieldFlat: 0, specials: ['lightning_field'],
    weapons: [beam('crystal_ray', 10, 20, 1, ['hv']), missile('death_spore', 6, 5)],
  },
  dragon: {
    structure: 500, armor: 0, beamAttack: 100, beamDefense: 70, speed: 16,
    shieldPool: 0, shieldFlat: 0, specials: [],
    weapons: [beam('dragon_breath', 15, 30, 1, ['hv']), beam('phasor_eye', 2, 4, 8, ['pd'])],
  },
  guardian: {
    structure: 800, armor: 0, beamAttack: 110, beamDefense: 70, speed: 10,
    shieldPool: 120, shieldFlat: 10,
    specials: ['hard_shields', 'automated_repair_unit', 'multi_wave_ecm_jammer', 'lightning_field'],
    weapons: [beam('death_ray', 25, 50, 2, ['hv']), beam('particle_beam', 4, 12, 6, ['pd', 'sp']), missile('plasma_torpedo', 15, 2, 20)],
  },
  antaran_raider: {
    structure: 25, armor: 25, beamAttack: 90, beamDefense: 80, speed: 18,
    shieldPool: 0, shieldFlat: 0, specials: ['damper_field'],
    weapons: [beam('particle_beam', 4, 12, 2, ['sp'])],
  },
  antaran_marauder: {
    structure: 60, armor: 60, beamAttack: 90, beamDefense: 75, speed: 16,
    shieldPool: 0, shieldFlat: 0, specials: ['damper_field'],
    weapons: [beam('particle_beam', 4, 12, 3, ['sp']), beam('particle_beam_hv', 4, 12, 1, ['sp', 'hv'])],
  },
  antaran_intruder: {
    structure: 150, armor: 150, beamAttack: 90, beamDefense: 70, speed: 14,
    shieldPool: 0, shieldFlat: 0, specials: ['damper_field'],
    weapons: [beam('particle_beam', 4, 12, 4, ['sp']), beam('particle_beam_hv', 4, 12, 2, ['sp', 'hv'])],
  },
  antaran_fortress: {
    structure: 900, armor: 900, beamAttack: 110, beamDefense: 40, speed: 0,
    shieldPool: 0, shieldFlat: 6,
    specials: ['damper_field', 'hard_shields', 'lightning_field'],
    weapons: [beam('death_ray', 25, 50, 3, ['hv']), beam('particle_beam', 4, 12, 8, ['sp']), beam('particle_beam_pd', 4, 12, 10, ['pd', 'sp'])],
  },
};

const GUARDABLE: MonsterKind[] = ['amoeba', 'hydra', 'eel', 'crystal', 'dragon'];

export function monsterToCombat(m: MonsterUnit, side: 0 | 1): CombatShipInit {
  const spec = MONSTER_SPECS[m.kind];
  return {
    shipId: 2_000_000 + m.id,
    side,
    hull: m.kind,
    hullIdx: m.kind === 'guardian' || m.kind === 'antaran_fortress' ? 9 : 6,
    isBase: spec.speed === 0,
    beamAttack: spec.beamAttack,
    beamDefense: spec.beamDefense,
    speed: spec.speed,
    armorHp: spec.armor,
    structureHp: spec.structure,
    shieldPool: spec.shieldPool,
    shieldFlat: spec.shieldFlat,
    weapons: spec.weapons.map((w) => ({ ...w, mods: [...w.mods], arc: '360' as const })), // beasts strike all around
    startingStructure: Math.max(1, spec.structure - m.dmgStructure),
    startingArmor: spec.armor,
    specials: [...spec.specials],
  };
}

export function monstersAt(state: GameState, starId: number, faction: number): MonsterUnit[] {
  return state.monsters.filter((m) => m.starId === starId && factionOf(m) === faction);
}

export function factionOf(m: MonsterUnit): number {
  return m.kind.startsWith('antaran_') ? ANTARAN_EMPIRE : MONSTER_EMPIRE;
}

export function hostileMonsterAt(state: GameState, starId: number): boolean {
  return state.monsters.some((m) => m.starId === starId);
}

/** A system worth taking (ultra-rich, gaia/terran, or a special like
 * artifacts) attracts a keeper far more often than an ordinary one. */
function systemPrizeworthy(state: GameState, starId: number): boolean {
  return state.planets.some(
    (p) =>
      p.starId === starId &&
      p.body === 'planet' &&
      (p.minerals === 'ultra_rich' || p.climate === 'gaia' || p.climate === 'terran' || p.special !== null),
  );
}

/** Game-start placement: guarded systems + the Guardian's prize system (M1). */
export function seedMonsters(state: GameState): void {
  if (state.settings.mirror) return seedMonstersMirror(state);
  const rng = rngFor(state.seed, 0, 'monsters');
  const homeStars = new Set<number>();
  for (const c of state.colonies) {
    const p = state.planets.find((x) => x.id === c.planetId);
    if (p) homeStars.add(p.starId);
  }
  // Orion: the star farthest from every homeworld (never a connectivity bridge)
  let orion: { starId: number; score: number } | null = null;
  for (const star of state.stars) {
    if (homeStars.has(star.id) || star.color === 'black_hole' || star.sym === -1) continue;
    let nearest = Infinity;
    for (const hs of homeStars) {
      const h = state.stars.find((s) => s.id === hs)!;
      const d = (star.x - h.x) * (star.x - h.x) + (star.y - h.y) * (star.y - h.y);
      nearest = Math.min(nearest, d);
    }
    if (!orion || nearest > orion.score) orion = { starId: star.id, score: nearest };
  }
  if (orion) {
    placeOrion(state, state.stars.find((s) => s.id === orion!.starId)!);
  }
  // guarded systems (bridges exempt — they carry the guaranteed path between
  // players): prize systems (ultra-rich / gaia / terran / specials) draw a
  // keeper 55% of the time, ordinary systems 8%
  for (const star of state.stars) {
    if (homeStars.has(star.id) || star.id === orion?.starId || star.sym === -1) continue;
    if (!state.planets.some((p) => p.starId === star.id && p.body === 'planet')) continue;
    const pct = systemPrizeworthy(state, star.id) ? 55 : 8;
    if (rng.chancePct(pct)) {
      const kind = GUARDABLE[rng.int(GUARDABLE.length)]!;
      state.monsters.push({ id: state.nextId++, kind, starId: star.id, dmgStructure: 0 });
    }
  }
  state.monsters.sort((a, b) => a.id - b.id);
}

/** Turn a star into Orion: prize worlds + the Guardian. */
function placeOrion(state: GameState, star: GameState['stars'][number]): void {
  star.name = 'Orion';
  // re-roll its planets into prizes
  state.planets = state.planets.filter((p) => p.starId !== star.id);
  const prizes: Array<Pick<Planet, 'sizeClass' | 'climate' | 'minerals'>> = [
    { sizeClass: 5, climate: 'gaia', minerals: 'abundant' },
    { sizeClass: 4, climate: 'terran', minerals: 'ultra_rich' },
    { sizeClass: 3, climate: 'arid', minerals: 'rich' },
  ];
  prizes.forEach((prize, i) => {
    state.planets.push({
      id: state.nextId++,
      starId: star.id,
      orbit: i + 1,
      body: 'planet',
      sizeClass: prize.sizeClass,
      climate: prize.climate,
      minerals: prize.minerals,
      gravity: 'normal',
      special: i === 0 ? 'ancient_artifacts' : null,
      homeworldOf: null,
      terraformSteps: 0,
    });
  });
  state.planets.sort((a, b) => a.id - b.id);
  state.monsters.push({ id: state.nextId++, kind: 'guardian', starId: star.id, dmgStructure: 0 });
}

/** Mirror-galaxy placement: Orion sits on the shared hub (equidistant from
 * every home) and guarded systems are decided per symmetry group so every
 * player faces the identical set of keepers. */
function seedMonstersMirror(state: GameState): void {
  const rng = rngFor(state.seed, 0, 'monsters');
  const hub = state.stars.find((s) => s.sym === 0);
  if (hub) {
    placeOrion(state, hub);
  }
  const groups = new Map<number, typeof state.stars>();
  for (const star of state.stars) {
    if (star.sym === undefined || star.sym < 2) continue; // hub, homes, bridges exempt
    groups.set(star.sym, [...(groups.get(star.sym) ?? []), star]);
  }
  for (const sym of [...groups.keys()].sort((a, b) => a - b)) {
    const members = groups.get(sym)!;
    if (!state.planets.some((p) => p.starId === members[0]!.id && p.body === 'planet')) continue;
    // symmetric wedges: the value check on any member matches every member
    const pct = systemPrizeworthy(state, members[0]!.id) ? 55 : 8;
    if (rng.chancePct(pct)) {
      const kind = GUARDABLE[rng.int(GUARDABLE.length)]!;
      for (const star of members.sort((a, b) => a.id - b.id)) {
        state.monsters.push({ id: state.nextId++, kind, starId: star.id, dmgStructure: 0 });
      }
    }
  }
  state.monsters.sort((a, b) => a.id - b.id);
}

// ---------- Antaran raids (A1) ----------

export const ANTARAN_FIRST_RAID = 25;

export function antaranUpkeep(state: GameState, events: TurnEvent[]): void {
  if (!state.settings.modes.antarans) return;
  // raiders withdraw after their attack turn resolves (battles run before S11)
  const before = state.monsters.length;
  state.monsters = state.monsters.filter((m) => {
    if (factionOf(m) !== ANTARAN_EMPIRE) return true;
    if (m.raidTurn === undefined) return true; // assault garrison: battles.ts cleans up
    return state.turn < m.raidTurn;
  });
  if (state.monsters.length !== before) {
    events.push({ visibleTo: -1, kind: 'antarans_withdraw', payload: {} });
  }
  if (state.turn < state.antarans.nextRaidTurn) return;
  // target: largest empire's most populous colony
  const alive = state.empires.filter((e) => !e.eliminated);
  if (!alive.length) return;
  const rng = rngFor(state.seed, state.turn, 'antarans');
  const pops = alive
    .map((e) => ({ e, pop: state.colonies.filter((c) => c.owner === e.id).reduce((s, c) => s + colonyPopUnits(c), 0) }))
    .sort((a, b) => b.pop - a.pop || a.e.id - b.e.id);
  const target = pops[0]!.e;
  const colonies = state.colonies.filter((c) => c.owner === target.id && !c.outpost).sort((a, b) => colonyPopUnits(b) - colonyPopUnits(a) || a.id - b.id);
  const colony = colonies[0];
  if (!colony) return;
  const planet = state.planets.find((p) => p.id === colony.planetId)!;
  // party scales with game length
  const tier = Math.min(4, 1 + Math.floor((state.turn - ANTARAN_FIRST_RAID) / 30));
  const party: MonsterKind[] = ['antaran_raider'];
  if (tier >= 2) party.push('antaran_raider');
  if (tier >= 3) party.push('antaran_marauder');
  if (tier >= 4) party.push('antaran_marauder', 'antaran_intruder');
  for (const kind of party) {
    state.monsters.push({ id: state.nextId++, kind, starId: planet.starId, dmgStructure: 0, raidStar: planet.starId, raidTurn: state.turn + 1 });
  }
  state.monsters.sort((a, b) => a.id - b.id);
  state.antarans.nextRaidTurn = state.turn + 25 + rng.int(16);
  events.push({ visibleTo: -1, kind: 'antaran_raid', payload: { starId: planet.starId, empireId: target.id, ships: party.length } });
}

/** After the Antarans win a raid battle they raze half the colony (A1). */
export function antaranRaze(state: GameState, colonyId: number, events: TurnEvent[]): void {
  const colony = state.colonies.find((c) => c.id === colonyId);
  if (!colony) return;
  const rng = rngFor(state.seed, state.turn, 'antaran_raze', colonyId);
  for (const g of colony.groups) {
    g.popK = Math.max(1000, g.popK - Math.floor(g.popK / 2));
  }
  const keep: string[] = [];
  for (const b of colony.buildings) {
    if (rng.chancePct(50)) keep.push(b);
  }
  colony.buildings = keep.sort();
  for (const g of colony.groups) {
    const units = Math.floor(g.popK / 1000);
    while (g.farmers + g.workers + g.scientists > units) {
      if (g.scientists > 0) g.scientists--;
      else if (g.workers > 0) g.workers--;
      else g.farmers--;
    }
  }
  events.push({ visibleTo: -1, kind: 'colony_razed', payload: { colonyId } });
}

// ---------- random events (E1) ----------

export function randomEventsUpkeep(state: GameState, events: TurnEvent[]): void {
  if (!state.settings.modes.randomEvents) return;
  const rng = rngFor(state.seed, state.turn, 'events');
  if (!rng.chancePct(4)) return;
  const alive = state.empires.filter((e) => !e.eliminated);
  if (!alive.length) return;
  const kind = rng.int(8);
  const bad = kind >= 4;
  const pool = bad ? alive.filter((e) => !traitsOf(e).lucky) : alive;
  if (!pool.length) return;
  const empire = pool[rng.int(pool.length)]!;
  const colonies = state.colonies.filter((c) => c.owner === empire.id && !c.outpost);
  const colony = colonies.length ? colonies[rng.int(colonies.length)] : undefined;

  switch (kind) {
    case 0: {
      const bc = 100 + rng.int(201);
      empire.bc += bc;
      events.push({ visibleTo: -1, kind: 'event_donation', payload: { empireId: empire.id, bc } });
      break;
    }
    case 1: {
      if (colony) {
        const g = colony.groups[0];
        if (g) {
          g.popK += 1000;
          events.push({ visibleTo: -1, kind: 'event_boom', payload: { empireId: empire.id, colonyId: colony.id } });
        }
      }
      break;
    }
    case 2: {
      if (colony) {
        const planet = state.planets.find((p) => p.id === colony.planetId)!;
        const order = ['ultra_poor', 'poor', 'abundant', 'rich', 'ultra_rich'] as const;
        const i = order.indexOf(planet.minerals);
        if (i < order.length - 1) {
          planet.minerals = order[i + 1]!;
          events.push({ visibleTo: -1, kind: 'event_minerals', payload: { empireId: empire.id, colonyId: colony.id, minerals: planet.minerals } });
        }
      }
      break;
    }
    case 3: {
      if (colony) {
        const planet = state.planets.find((p) => p.id === colony.planetId)!;
        const next = NEXT_TERRAFORM[planet.climate];
        if (next) {
          planet.climate = next;
          events.push({ visibleTo: -1, kind: 'event_climate', payload: { empireId: empire.id, colonyId: colony.id, climate: next } });
        }
      }
      break;
    }
    case 4: {
      const loss = Math.floor(empire.bc / 5);
      empire.bc -= loss;
      events.push({ visibleTo: -1, kind: 'event_depression', payload: { empireId: empire.id, bc: loss } });
      break;
    }
    case 5: {
      if (empire.freighters > 0) {
        empire.freighters = Math.max(0, empire.freighters - 5);
        events.push({ visibleTo: -1, kind: 'event_pirates', payload: { empireId: empire.id } });
      }
      break;
    }
    case 6: {
      if (colony && colony.buildings.length) {
        const destructible = colony.buildings.filter((b) => b !== 'marine_barracks');
        if (destructible.length) {
          const b = destructible[rng.int(destructible.length)]!;
          colony.buildings = colony.buildings.filter((x) => x !== b);
          events.push({ visibleTo: -1, kind: 'event_meteor', payload: { empireId: empire.id, colonyId: colony.id, building: b } });
        }
      }
      break;
    }
    case 7: {
      if (colony) {
        const g = colony.groups[0];
        if (g && g.popK > 1000) {
          g.popK -= 1000;
          const units = Math.floor(g.popK / 1000);
          while (g.farmers + g.workers + g.scientists > units) {
            if (g.scientists > 0) g.scientists--;
            else if (g.workers > 0) g.workers--;
            else g.farmers--;
          }
          events.push({ visibleTo: -1, kind: 'event_plague', payload: { empireId: empire.id, colonyId: colony.id } });
        }
      }
      break;
    }
  }
}

/** Guardian bounty: the death ray application + a free-agent offer for the
 * Last Orion (M1). */
export function guardianReward(state: GameState, victorId: number, events: TurnEvent[]): void {
  const empire = state.empires.find((e) => e.id === victorId);
  if (!empire) return;
  grantApp(empire, 'death_ray');
  if (!state.empires.some((e) => e.leaders.some((l) => l.leaderId === 'loknar'))) {
    state.leaderOffers.push({ empireId: victorId, leaderId: 'loknar', priceBc: 100, expiresTurn: state.turn + 10 });
  }
  events.push({ visibleTo: -1, kind: 'guardian_defeated', payload: { empireId: victorId } });
}
