// Ground combat tactics + planetary terrain (bugs.md round 6).
//
// Every planet has ONE deterministic terrain map (seeded by planet id +
// climate) that never changes — players learn what desert worlds look like
// and plan accordingly. Terrain is coarse: a 12x8 grid of zone characters,
// generated as grown patches so it reads like a real theater map. The colony
// sits at the RIGHT edge (defender side, matching the space battle layout);
// attackers land on the LEFT.
//
// Tactics are an RPS layer: the attacker picks one with the invade order,
// the defender keeps a standing doctrine per colony (set_ground_tactic).
// A matchup matrix plus terrain-fit modifiers scale the two sides' per-round
// strengths in ground.ts. BOTH sides absent (old logs, old saves) = exact
// legacy math — multipliers 1.

export const ATTACK_TACTICS = [
  'charge',
  'flank',
  'surround',
  'pincer',
  'infiltrate',
  'hammer_and_anvil',
  'pinning',
  'bounding_overwatch',
] as const;
export type AttackTactic = (typeof ATTACK_TACTICS)[number];

export const DEFENSE_TACTICS = ['defense_in_depth', 'fortress', 'long_line', 'charge'] as const;
export type DefenseTactic = (typeof DEFENSE_TACTICS)[number];

export const TERRAIN_W = 12;
export const TERRAIN_H = 8;

/** zone kinds, one char each so a whole map is 8 short strings */
export const TERRAIN_INFO: Record<string, { id: string; name: string; color: string; defBonus: number }> = {
  p: { id: 'plain', name: 'plains', color: '#7a8a58', defBonus: 0 },
  f: { id: 'forest', name: 'forest', color: '#3f6a3a', defBonus: 0.1 },
  h: { id: 'hills', name: 'hills', color: '#8a7a52', defBonus: 0.15 },
  m: { id: 'marsh', name: 'marsh', color: '#4a6a5c', defBonus: 0.1 },
  d: { id: 'dunes', name: 'dunes', color: '#c0a060', defBonus: 0 },
  r: { id: 'ridge', name: 'ridge', color: '#8a8078', defBonus: 0.3 },
  c: { id: 'craters', name: 'craters', color: '#6a6258', defBonus: 0.2 },
  i: { id: 'ice', name: 'ice field', color: '#a8c0d0', defBonus: 0.05 },
  u: { id: 'urban', name: 'urban', color: '#9a9aa8', defBonus: 0.25 },
  l: { id: 'lava', name: 'lava flats', color: '#7a4038', defBonus: 0.15 },
};

/** climate -> weighted zone palette. Rocky worlds (desert/barren/hostile/
 * tundra/energized) carry the ridge/crater cover that favors defenders. */
const CLIMATE_ZONES: Record<string, Array<[string, number]>> = {
  gaia: [['p', 40], ['f', 30], ['h', 20], ['m', 10]],
  terran: [['p', 45], ['f', 25], ['h', 20], ['m', 10]],
  ocean: [['p', 40], ['m', 35], ['h', 15], ['f', 10]],
  swamp: [['m', 45], ['f', 30], ['p', 20], ['h', 5]],
  arid: [['p', 30], ['d', 35], ['h', 20], ['r', 15]],
  desert: [['d', 40], ['r', 25], ['c', 15], ['p', 20]],
  tundra: [['i', 35], ['h', 25], ['r', 20], ['p', 20]],
  barren: [['c', 35], ['r', 30], ['d', 20], ['p', 15]],
  hostile: [['l', 25], ['c', 30], ['r', 30], ['d', 15]],
  energized: [['c', 30], ['r', 30], ['p', 25], ['h', 15]],
};

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The planet's one true terrain map: TERRAIN_H strings of TERRAIN_W chars.
 * Patch-grown so zones cluster like a real map; urban blocks hug the colony
 * anchor at the right edge. Pure function of (planetId, climate). */
export function generateTerrain(planetId: number, climate: string): string[] {
  const rnd = mulberry32((planetId | 0) * 2654435761 + 17);
  const zones = CLIMATE_ZONES[climate] ?? CLIMATE_ZONES['barren']!;
  const total = zones.reduce((s, [, w]) => s + w, 0);
  const pick = (): string => {
    let roll = rnd() * total;
    for (const [k, w] of zones) {
      roll -= w;
      if (roll <= 0) return k;
    }
    return zones[0]![0];
  };
  const grid: string[][] = [];
  const base = pick();
  for (let y = 0; y < TERRAIN_H; y++) grid.push(new Array<string>(TERRAIN_W).fill(base));
  // grow 7-10 coherent patches
  const patches = 7 + Math.floor(rnd() * 4);
  for (let n = 0; n < patches; n++) {
    const kind = pick();
    let x = Math.floor(rnd() * TERRAIN_W);
    let y = Math.floor(rnd() * TERRAIN_H);
    const len = 4 + Math.floor(rnd() * 9);
    for (let s = 0; s < len; s++) {
      grid[y]![x] = kind;
      if (rnd() < 0.5 && x + 1 < TERRAIN_W) grid[y]![x + 1] = kind;
      x = Math.min(TERRAIN_W - 1, Math.max(0, x + Math.floor(rnd() * 3) - 1));
      y = Math.min(TERRAIN_H - 1, Math.max(0, y + Math.floor(rnd() * 3) - 1));
    }
  }
  // the colony's urban blocks: 2-3 cells at the right-edge center
  const cy = Math.floor(TERRAIN_H / 2) - 1 + Math.floor(rnd() * 2);
  grid[cy]![TERRAIN_W - 1] = 'u';
  grid[cy + 1 < TERRAIN_H ? cy + 1 : cy - 1]![TERRAIN_W - 1] = 'u';
  if (rnd() < 0.6) grid[cy]![TERRAIN_W - 2] = 'u';
  return grid.map((row) => row.join(''));
}

/** fraction of the map covered by each zone char */
export function terrainFractions(rows: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  let n = 0;
  for (const row of rows) {
    for (const ch of row) {
      out[ch] = (out[ch] ?? 0) + 1;
      n++;
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k]! / Math.max(1, n);
  return out;
}

/** RPS matchup: attacker strength multiplier per (attack, defense) pair.
 * <1 favors the defender. Retuned in round 8 so every row averages ~1.0
 * (no dominant attack) and every doctrine has real counters: charges break
 * thin lines but die on fortresses; infiltrators unpick fortresses but get
 * caught in the open by a counter-charge; overwatch fire shreds that same
 * counter-charge; the methodical tactics (anvil/pinning/overwatch) grind
 * down elastic defenses that want to trade ground. */
const MATCHUP: Record<AttackTactic, Record<DefenseTactic, number>> = {
  charge: { defense_in_depth: 0.85, fortress: 0.75, long_line: 1.25, charge: 1.1 },
  flank: { defense_in_depth: 0.95, fortress: 1.1, long_line: 0.85, charge: 1.1 },
  surround: { defense_in_depth: 0.9, fortress: 1.15, long_line: 0.8, charge: 1.15 },
  pincer: { defense_in_depth: 0.95, fortress: 1.05, long_line: 0.9, charge: 1.1 },
  infiltrate: { defense_in_depth: 1.1, fortress: 1.25, long_line: 0.95, charge: 0.75 },
  hammer_and_anvil: { defense_in_depth: 1.1, fortress: 0.9, long_line: 1.1, charge: 0.9 },
  pinning: { defense_in_depth: 1.1, fortress: 0.9, long_line: 1.05, charge: 0.85 },
  bounding_overwatch: { defense_in_depth: 1.1, fortress: 0.95, long_line: 0.85, charge: 1.2 },
};

/** Strength multipliers for one ground battle. Both tactics absent = exact
 * legacy (1/1). Terrain shapes both sides: defenders always mine the map's
 * cover (doctrine-weighted); attacker tactics fit or fight the ground. */
export function groundModifiers(
  atk: AttackTactic | undefined,
  def: DefenseTactic | undefined,
  terrain: string[] | null,
): { atkMult: number; defMult: number } {
  if (!atk && !def) return { atkMult: 1, defMult: 1 };
  const frac = terrain ? terrainFractions(terrain) : {};
  const f = (chars: string) => chars.split('').reduce((s, ch) => s + (frac[ch] ?? 0), 0);
  const open = f('pdi');
  const rough = f('rchl'); // lava flats are broken ground too
  const cover = f('fmu');

  // terrain fit (round 8: coefficients doubled so the SURFACE flips the best
  // pick): shock and wings want open ground, methodical fire-and-move wants
  // broken rock, infiltrators want foliage/streets — and marsh eats wings
  let atkMult = atk && def ? MATCHUP[atk][def] : 1;
  if (atk) {
    if (atk === 'charge') atkMult += 0.35 * open - 0.4 * rough;
    if (atk === 'flank') atkMult += 0.25 * open - 0.15 * rough - 0.3 * f('m');
    if (atk === 'pincer') atkMult += 0.1 * open - 0.1 * cover;
    if (atk === 'surround') atkMult += 0.15 * open - 0.25 * cover;
    if (atk === 'infiltrate') atkMult += 0.35 * cover - 0.25 * open;
    if (atk === 'hammer_and_anvil') atkMult += 0.15 * open - 0.1 * rough;
    if (atk === 'pinning') atkMult += 0.2 * rough - 0.1 * cover;
    if (atk === 'bounding_overwatch') atkMult += 0.3 * rough - 0.2 * open;
  }

  // defender terrain bonus: coverage-weighted, doctrine-emphasized
  let terrBonus = 0;
  for (const [ch, share] of Object.entries(frac)) {
    let b = (TERRAIN_INFO[ch]?.defBonus ?? 0) * share;
    if (def === 'fortress' && (ch === 'u' || ch === 'r')) b *= 2;
    if (def === 'defense_in_depth' && (ch === 'h' || ch === 'f')) b *= 1.5;
    terrBonus += b;
  }
  let defMult = 1 + terrBonus;
  if (def === 'fortress') defMult *= 1.08;
  if (def === 'defense_in_depth') defMult *= 1.05;
  if (def === 'long_line') defMult *= 0.9 + 0.45 * open; // a line needs fields of fire
  if (def === 'charge') defMult *= 0.9 + 0.35 * open; // a counter-attack needs room to run

  return { atkMult: Math.max(0.4, atkMult), defMult: Math.max(0.4, defMult) };
}

/** Per-doctrine effectiveness of the two defender classes (round 8):
 * "civilians man walls; soldiers maneuver." Behind fortress works militia
 * fight like soldiers; a counter-charge is a trained-troop move that
 * militia rout out of. No doctrine set = exact legacy 1/1. Marines die
 * first, so a maneuver doctrine collapses as its trained core is spent. */
export function groundCompFactors(def: DefenseTactic | undefined): { marine: number; militia: number } {
  switch (def) {
    case 'fortress':
      return { marine: 1, militia: 1 };
    case 'long_line':
      return { marine: 1, militia: 0.95 };
    case 'defense_in_depth':
      return { marine: 1.3, militia: 0.7 };
    case 'charge':
      return { marine: 1.6, militia: 0.5 };
    default:
      return { marine: 1, militia: 1 };
  }
}

export const isAttackTactic = (x: unknown): x is AttackTactic =>
  typeof x === 'string' && (ATTACK_TACTICS as readonly string[]).includes(x);
export const isDefenseTactic = (x: unknown): x is DefenseTactic =>
  typeof x === 'string' && (DEFENSE_TACTICS as readonly string[]).includes(x);

export interface GroundResolution {
  troops: number;
  defMarines: number;
  militia: number;
  civilianLosses: number;
  /** per-round unit counts, thinned to ~60 entries for long sieges */
  rounds: Array<{ t: number; m: number }>;
}

/** The one true ground-battle loop, shared by landInvasion and the battle
 * lab. P(attacker kills) = atkPower/(atkPower+defPower) each round; marines
 * die before militia; militia losses cost civilians 1:1 down to a floor of
 * one pop unit. `comp` (round 8) weights the two defender classes per the
 * doctrine (groundCompFactors); absent or 1/1 = byte-exact legacy rounds. */
export function fightGroundRounds(
  troops0: number,
  defMarines0: number,
  militia0: number,
  atkStr: number,
  defStr: number,
  pop: number,
  rng: { int(maxExclusive: number): number },
  comp?: { marine: number; militia: number },
): GroundResolution {
  let troops = troops0;
  let defMarines = defMarines0;
  let militia = militia0;
  let civilianLosses = 0;
  const marineF = comp?.marine ?? 1;
  const militiaF = comp?.militia ?? 1;
  const roundsLog: Array<{ t: number; m: number }> = [{ t: troops, m: defMarines + militia }];
  while (troops > 0 && defMarines + militia > 0) {
    const atkPower = troops * atkStr;
    const defPower = Math.max(1, Math.round((defMarines * marineF + militia * militiaF) * defStr));
    if (rng.int(atkPower + defPower) < atkPower) {
      if (defMarines > 0) {
        defMarines--;
      } else {
        militia--;
        if (pop - civilianLosses > 1) civilianLosses++;
      }
    } else {
      troops--;
    }
    roundsLog.push({ t: troops, m: defMarines + militia });
  }
  // long sieges get thinned so the replay payload stays small
  const rounds =
    roundsLog.length <= 60
      ? roundsLog
      : roundsLog.filter((_, i) => i % Math.ceil(roundsLog.length / 60) === 0 || i === roundsLog.length - 1);
  return { troops, defMarines, militia, civilianLosses, rounds };
}
