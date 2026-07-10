// Deterministic galaxy generation from the master seed.
//
// Star counts per size follow the documented classic values (data README F11).
// The color/planet roll weights below are TUNABLE defaults in the documented
// classic *structure* (weighted tables keyed by star color); exact classic
// odds were not fully published, so these are our balance set (F13).

import { rngFor, type MasterSeed, type Rng } from './rng';
import { isqrt } from './isqrt';
import { ceilDiv, roundDiv } from './imath';
import type {
  BodyType,
  Climate,
  GameStateSettings,
  Gravity,
  Minerals,
  Planet,
  Star,
  StarColor,
} from './types';
import type { RaceTraits } from './race';

export const STAR_COUNTS: Record<GameStateSettings['galaxySize'], number> = {
  small: 20,
  medium: 36,
  large: 54,
  huge: 71,
};

/** Map dimensions in centiparsecs per size. */
export const MAP_SIZE: Record<GameStateSettings['galaxySize'], { w: number; h: number }> = {
  small: { w: 2000, h: 1500 },
  medium: { w: 2700, h: 2000 },
  large: { w: 3300, h: 2500 },
  huge: { w: 3800, h: 2900 },
};

const MIN_STAR_DIST = 150; // centiparsecs
const MIN_HOME_DIST = 900;

// weight tables (average-age defaults)
const COLOR_WEIGHTS: Array<[StarColor, number]> = [
  ['blue', 8],
  ['white', 12],
  ['yellow', 20],
  ['orange', 18],
  ['red', 30],
  ['brown', 6],
  ['black_hole', 6],
];

/** planets per star by color: weights for 0..5 planets */
const PLANET_COUNT_WEIGHTS: Record<StarColor, number[]> = {
  // empty systems are deliberately rare — a visited star should usually offer
  // SOMETHING (bug: "stars with nothing are too common")
  blue: [4, 14, 21, 27, 22, 12],
  white: [4, 14, 23, 27, 20, 12],
  yellow: [2, 11, 22, 30, 23, 12],
  orange: [4, 17, 26, 27, 17, 9],
  red: [8, 25, 28, 22, 12, 5],
  brown: [30, 45, 15, 10, 0, 0],
  black_hole: [100, 0, 0, 0, 0, 0],
};

const BODY_WEIGHTS: Array<[BodyType, number]> = [
  ['planet', 62],
  ['asteroids', 18],
  ['gas_giant', 20],
];

// no size-1 worlds (bug), and the average shifts up half a class
const SIZE_WEIGHTS: number[] = [0, 22, 34, 28, 16]; // tiny(never)..huge

/** climate weights vary with orbit distance band (inner/mid/outer) */
const CLIMATE_WEIGHTS: Record<'inner' | 'mid' | 'outer', Array<[Climate, number]>> = {
  inner: [
    ['hostile', 16],
    ['energized', 14],
    ['barren', 22],
    ['desert', 22],
    ['arid', 14],
    ['tundra', 2],
    ['ocean', 3],
    ['swamp', 3],
    ['terran', 4],
    ['gaia', 0],
  ],
  mid: [
    ['hostile', 8],
    ['energized', 4],
    ['barren', 16],
    ['desert', 12],
    ['arid', 12],
    ['tundra', 12],
    ['ocean', 12],
    ['swamp', 10],
    ['terran', 13],
    ['gaia', 1],
  ],
  outer: [
    ['hostile', 10],
    ['energized', 2],
    ['barren', 34],
    ['desert', 4],
    ['arid', 6],
    ['tundra', 26],
    ['ocean', 8],
    ['swamp', 6],
    ['terran', 4],
    ['gaia', 0],
  ],
};

/** mineral weights by star color (bluer = denser worlds) */
const MINERAL_WEIGHTS: Record<StarColor, Array<[Minerals, number]>> = {
  blue: [
    ['ultra_poor', 2],
    ['poor', 8],
    ['abundant', 40],
    ['rich', 32],
    ['ultra_rich', 18],
  ],
  white: [
    ['ultra_poor', 3],
    ['poor', 12],
    ['abundant', 45],
    ['rich', 27],
    ['ultra_rich', 13],
  ],
  yellow: [
    ['ultra_poor', 5],
    ['poor', 20],
    ['abundant', 50],
    ['rich', 18],
    ['ultra_rich', 7],
  ],
  orange: [
    ['ultra_poor', 10],
    ['poor', 27],
    ['abundant', 45],
    ['rich', 14],
    ['ultra_rich', 4],
  ],
  red: [
    ['ultra_poor', 15],
    ['poor', 33],
    ['abundant', 42],
    ['rich', 8],
    ['ultra_rich', 2],
  ],
  brown: [
    ['ultra_poor', 10],
    ['poor', 25],
    ['abundant', 40],
    ['rich', 17],
    ['ultra_rich', 8],
  ],
  black_hole: [['abundant', 100]],
};

function weighted<T>(rng: Rng, entries: Array<[T, number]>): T {
  let total = 0;
  for (const [, w] of entries) total += w;
  let roll = rng.int(total);
  for (const [v, w] of entries) {
    roll -= w;
    if (roll < 0) return v;
  }
  return entries[entries.length - 1]![0];
}

/** Real star names (public astronomical catalog names), drawn in seeded-shuffle
 * order so every galaxy reads like a star chart. Procedural syllables remain
 * only as an overflow fallback. */
const REAL_STAR_NAMES = [
  'Sirius', 'Vega', 'Altair', 'Rigel', 'Deneb', 'Antares', 'Arcturus', 'Capella', 'Procyon',
  'Betelgeuse', 'Aldebaran', 'Canopus', 'Spica', 'Pollux', 'Castor', 'Regulus', 'Fomalhaut',
  'Achernar', 'Bellatrix', 'Alnilam', 'Mintaka', 'Alnitak', 'Saiph', 'Algol', 'Mira', 'Polaris',
  'Dubhe', 'Merak', 'Alioth', 'Alkaid', 'Megrez', 'Phecda', 'Rasalhague', 'Sadr', 'Albireo',
  'Tarazed', 'Sheliak', 'Sulafat', 'Alphard', 'Denebola', 'Zosma', 'Algieba', 'Mizar', 'Alcor',
  'Kochab', 'Thuban', 'Etamin', 'Rastaban', 'Alderamin', 'Enif', 'Markab', 'Scheat', 'Algenib',
  'Alpheratz', 'Mirach', 'Almach', 'Hamal', 'Sheratan', 'Menkar', 'Zaurak', 'Cursa', 'Nihal',
  'Arneb', 'Wezen', 'Adhara', 'Mirzam', 'Aludra', 'Gomeisa', 'Alhena', 'Mebsuta', 'Wasat',
  'Talitha', 'Sadalmelik', 'Sadalsuud', 'Skat', 'Diphda', 'Ankaa', 'Achird', 'Ruchbah', 'Segin',
  'Caph', 'Shedar', 'Mirfak', 'Algorab', 'Gienah', 'Kraz', 'Alchiba', 'Dschubba', 'Shaula',
  'Lesath', 'Sargas', 'Nunki', 'Ascella', 'Rukbat', 'Arkab', 'Alnair', 'Atria', 'Miaplacidus',
  'Avior', 'Suhail', 'Naos', 'Acrux', 'Mimosa', 'Gacrux', 'Hadar', 'Toliman', 'Proxima',
  'Barnard', 'Kapteyn', 'Teegarden', 'Eridani', 'Cygni', 'Ceti', 'Indi', 'Draconis', 'Lacaille',
  'Altais', 'Grumium', 'Kuma', 'Tyl', 'Izar', 'Seginus', 'Muphrid', 'Nekkar', 'Unukalhai',
  'Yed', 'Sabik', 'Cebalrai', 'Vindemiatrix', 'Zavijava', 'Porrima', 'Auva', 'Heze', 'Syrma',
] as const;

// Overflow fallback: consonant/vowel syllable pairs + suffixes (original art).
const SYL_A = ['Ka', 'Ve', 'Zo', 'My', 'Tha', 'Or', 'Ny', 'Sa', 'Del', 'Qua', 'Ri', 'Xa', 'Bel', 'Ju', 'Ho', 'Ce'];
const SYL_B = ['ri', 'la', 'no', 'dra', 'ph', 'mi', 'ta', 'ven', 'sor', 'li', 'gan', 'de', 'ru', 'na', 'ke', 'zu'];
const SYL_C = ['s', 'n', 'th', 'x', 'm', 'r', '', 'ne', 'ra', 'os', 'ia', 'us', 'ar', 'el', 'is', 'on'];

function makeNamePool(rng: Rng): string[] {
  const pool = [...REAL_STAR_NAMES];
  rng.shuffle(pool);
  return pool;
}

function starName(rng: Rng, taken: Set<string>, pool: string[]): string {
  while (pool.length > 0) {
    const name = pool.pop()!;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
  for (let i = 0; i < 100; i++) {
    const name = rng.pick(SYL_A) + rng.pick(SYL_B) + rng.pick(SYL_C);
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
  const fallback = `Star-${taken.size + 1}`;
  taken.add(fallback);
  return fallback;
}

export interface GeneratedGalaxy {
  stars: Star[];
  planets: Planet[];
  /** homeworld planet id per empire index */
  homePlanets: number[];
  nextId: number;
}

function orbitBand(orbit: number): 'inner' | 'mid' | 'outer' {
  return orbit <= 1 ? 'inner' : orbit <= 3 ? 'mid' : 'outer';
}

/** Every player must be able to reach every other by hopping colonizable
 * systems no more than this far apart (standard fuel cells = 4 parsecs). */
export const HOP_RANGE_CP = 400;
/** bridge stars are laid closer than the hop range so near-misses still link */
const BRIDGE_SPACING_CP = 340;

/** fixed-point rotations (cos, sin — scaled by 16384) for 2..8 mirror seats */
const ROTATIONS: Record<number, ReadonlyArray<readonly [number, number]>> = {
  2: [[16384, 0], [-16384, 0]],
  3: [[16384, 0], [-8192, 14189], [-8192, -14189]],
  4: [[16384, 0], [0, 16384], [-16384, 0], [0, -16384]],
  5: [[16384, 0], [5063, 15582], [-13255, 9630], [-13255, -9630], [5063, -15582]],
  6: [[16384, 0], [8192, 14189], [-8192, 14189], [-16384, 0], [-8192, -14189], [8192, -14189]],
  7: [[16384, 0], [10215, 12810], [-3646, 15973], [-14761, 7109], [-14761, -7109], [-3646, -15973], [10215, -12810]],
  8: [[16384, 0], [11585, 11585], [0, 16384], [-11585, 11585], [-16384, 0], [-11585, -11585], [0, -16384], [11585, -11585]],
};

function rotatePoint(cx: number, cy: number, dx: number, dy: number, rot: readonly [number, number]): { x: number; y: number } {
  const [c, s] = rot;
  return {
    x: cx + roundDiv(dx * c - dy * s, 16384),
    y: cy + roundDiv(dx * s + dy * c, 16384),
  };
}

/** planet specs for one star, reusable across mirror copies (no ids yet) */
type PlanetSpec = Omit<Planet, 'id' | 'starId'>;

/** Documented planet specials (planet_specials.md): gem/gold deposits pay BC
 * to an established colony, space debris converts to 50 BC on settling, and
 * rare wild artifact worlds boost science (and draw monster keepers). */
function rollSpecial(rng: Rng): string | null {
  const r = rng.int(100);
  if (r < 3) return 'gold_deposits';
  if (r < 5) return 'gem_deposits';
  if (r < 7) return 'space_debris';
  if (r < 8) return 'ancient_artifacts';
  return null;
}

function rollPlanetSpecs(rng: Rng, color: StarColor, minBodies = 0): PlanetSpec[] {
  const count = weighted(
    rng,
    PLANET_COUNT_WEIGHTS[color].map((wgt, n) => [n, wgt] as [number, number]),
  );
  const orbits = [1, 2, 3, 4, 5];
  rng.shuffle(orbits);
  const specs: PlanetSpec[] = [];
  for (let k = 0; k < count; k++) {
    const orbit = orbits[k]!;
    const body = weighted(rng, BODY_WEIGHTS);
    const sizeClass = 1 + weighted(rng, SIZE_WEIGHTS.map((wgt, i) => [i, wgt] as [number, number]));
    specs.push({
      orbit,
      body,
      sizeClass: body === 'planet' ? sizeClass : 3,
      climate: body === 'planet' ? weighted(rng, CLIMATE_WEIGHTS[orbitBand(orbit)]) : 'barren',
      minerals: weighted(rng, MINERAL_WEIGHTS[color]),
      gravity: rollGravity(rng, body === 'planet' ? sizeClass : 3),
      special: body === 'planet' ? rollSpecial(rng) : null,
      homeworldOf: null,
      terraformSteps: 0,
    });
  }
  while (specs.length < minBodies) {
    // guarantee an outpost anchor (asteroid belt) so the system can hold fuel
    const usedOrbits = new Set(specs.map((s) => s.orbit));
    const orbit = [3, 2, 4, 1, 5].find((o) => !usedOrbits.has(o)) ?? 3;
    specs.push({
      orbit,
      body: 'asteroids',
      sizeClass: 3,
      climate: 'barren',
      minerals: 'abundant',
      gravity: rollGravity(rng, 3),
      special: null,
      homeworldOf: null,
      terraformSteps: 0,
    });
  }
  return specs;
}

/** Insert bridge stars until every homeworld shares one fuel-hop component.
 * `traversable` limits which stars count as refuel hops; `addBridge` creates
 * the star(s) for a bridge point (mirror mode adds every rotated copy). */
function ensureHomeConnectivity(
  stars: Star[],
  planets: Planet[],
  homeStarIds: number[],
  traversable: (s: Star) => boolean,
  addBridge: (x: number, y: number) => void,
): void {
  const bodiesAt = (starId: number) => planets.some((p) => p.starId === starId);
  for (let guard = 0; guard < 64; guard++) {
    const nodes = stars.filter((s) => (traversable(s) && bodiesAt(s.id)) || homeStarIds.includes(s.id));
    const parent = new Map<number, number>();
    const find = (id: number): number => {
      let r = id;
      while (parent.get(r) !== r) r = parent.get(r)!;
      let cur = id;
      while (parent.get(cur) !== cur) {
        const next = parent.get(cur)!;
        parent.set(cur, r);
        cur = next;
      }
      return r;
    };
    for (const n of nodes) parent.set(n.id, n.id);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (starDistance(nodes[i]!, nodes[j]!) <= HOP_RANGE_CP) {
          parent.set(find(nodes[i]!.id), find(nodes[j]!.id));
        }
      }
    }
    const homeRoots = homeStarIds.map((id) => find(id));
    const root0 = homeRoots[0]!;
    if (homeRoots.every((r) => r === root0)) return;

    // connect home 0's component to the nearest star of a disconnected home's component
    const otherRoots = new Set(homeRoots.filter((r) => r !== root0));
    let best: { a: Star; b: Star; d: number } | null = null;
    for (const a of nodes) {
      if (find(a.id) !== root0) continue;
      for (const b of nodes) {
        if (!otherRoots.has(find(b.id))) continue;
        const d = starDistance(a, b);
        if (!best || d < best.d) best = { a, b, d };
      }
    }
    if (!best) return; // cannot happen: home stars are always nodes
    const hops = Math.max(1, ceilDiv(best.d, BRIDGE_SPACING_CP));
    // perpendicular nudge (~min star spacing) for bridge points that would
    // stack on an existing star; a ±150cp offset keeps hops within fuel range
    const ox = best.d > 0 ? roundDiv(-(best.b.y - best.a.y) * MIN_STAR_DIST, best.d) : 0;
    const oy = best.d > 0 ? roundDiv((best.b.x - best.a.x) * MIN_STAR_DIST, best.d) : 0;
    for (let j = 1; j < hops; j++) {
      const bx = best.a.x + roundDiv((best.b.x - best.a.x) * j, hops);
      const by = best.a.y + roundDiv((best.b.y - best.a.y) * j, hops);
      // an existing refuel hop close to this point already serves the chain
      // (60cp: BRIDGE_SPACING + 60 still fits inside HOP_RANGE)
      const served = stars.some(
        (s) => traversable(s) && bodiesAt(s.id) && (s.x - bx) * (s.x - bx) + (s.y - by) * (s.y - by) <= 60 * 60,
      );
      if (served) continue;
      // never generate a star inside another's minimum separation (stacked
      // discs on the map): try the point, then small perpendicular nudges
      const spot = [
        [bx, by],
        [bx + ox, by + oy],
        [bx - ox, by - oy],
      ].find(([x, y]) => !stars.some((s) => (s.x - x!) * (s.x - x!) + (s.y - y!) * (s.y - y!) < MIN_STAR_DIST * MIN_STAR_DIST));
      addBridge(spot?.[0] ?? bx, spot?.[1] ?? by);
    }
  }
}

export function generateGalaxy(
  seed: MasterSeed,
  settings: GameStateSettings,
  empireTraits: RaceTraits[],
): GeneratedGalaxy {
  if (settings.mirror && ROTATIONS[empireTraits.length]) {
    return generateMirrorGalaxy(seed, settings, empireTraits);
  }
  const rng = rngFor(seed, 'galaxy');
  const { w, h } = MAP_SIZE[settings.galaxySize];
  const starCount = STAR_COUNTS[settings.galaxySize];
  let nextId = 1;

  // --- star placement with minimum separation ---
  const stars: Star[] = [];
  const taken = new Set<string>();
  const namePool = makeNamePool(rng);
  let guard = 0;
  while (stars.length < starCount && guard++ < 20000) {
    const x = 60 + rng.int(w - 120);
    const y = 60 + rng.int(h - 120);
    if (stars.some((s) => (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y) < MIN_STAR_DIST * MIN_STAR_DIST)) {
      continue;
    }
    stars.push({
      id: nextId++,
      name: starName(rng, taken, namePool),
      x,
      y,
      color: weighted(rng, COLOR_WEIGHTS),
      wormholeTo: null,
    });
  }

  // --- planets ---
  const planets: Planet[] = [];
  for (const star of stars) {
    for (const spec of rollPlanetSpecs(rng, star.color)) {
      planets.push({ id: nextId++, starId: star.id, ...spec });
    }
  }
  planets.sort((a, b) => a.id - b.id);

  // --- homeworlds: pick well-separated stars, override one planet each ---
  const homeStars: Star[] = [];
  const nonHole = stars.filter((s) => s.color !== 'black_hole');
  let bestSpread: Star[] | null = null;
  for (let attempt = 0; attempt < 200 && !bestSpread; attempt++) {
    const shuffled = [...nonHole];
    rng.shuffle(shuffled);
    const chosen: Star[] = [];
    for (const s of shuffled) {
      if (chosen.every((c) => (c.x - s.x) ** 2 + (c.y - s.y) ** 2 >= MIN_HOME_DIST * MIN_HOME_DIST)) {
        chosen.push(s);
        if (chosen.length === empireTraits.length) break;
      }
    }
    if (chosen.length === empireTraits.length) bestSpread = chosen;
  }
  if (!bestSpread) {
    // dense fallback: greedy farthest-point pick — maximize the minimum
    // home-pair distance instead of taking the first N stars in roll order
    // (which spawned 6-8 player homes ~1.5pc apart on small maps)
    const chosen: Star[] = [];
    let seedPair: [Star, Star] | null = null;
    let seedD = -1;
    for (let i = 0; i < nonHole.length; i++) {
      for (let j = i + 1; j < nonHole.length; j++) {
        const d = (nonHole[i]!.x - nonHole[j]!.x) ** 2 + (nonHole[i]!.y - nonHole[j]!.y) ** 2;
        if (d > seedD) {
          seedD = d;
          seedPair = [nonHole[i]!, nonHole[j]!];
        }
      }
    }
    if (seedPair) chosen.push(seedPair[0], seedPair[1]);
    else if (nonHole[0]) chosen.push(nonHole[0]);
    while (chosen.length < empireTraits.length && chosen.length < nonHole.length) {
      let bestStar: Star | null = null;
      let bestMin = -1;
      for (const s of nonHole) {
        if (chosen.includes(s)) continue;
        let minD = Infinity;
        for (const c of chosen) minD = Math.min(minD, (c.x - s.x) ** 2 + (c.y - s.y) ** 2);
        if (minD > bestMin) {
          bestMin = minD;
          bestStar = s;
        }
      }
      if (!bestStar) break;
      chosen.push(bestStar);
    }
    bestSpread = chosen.slice(0, empireTraits.length);
  }
  for (const s of bestSpread) homeStars.push(s);

  // --- wormhole pairs (after home selection: home systems never get one) ---
  const wormholes = Math.min(2, Math.floor(stars.length / 12));
  const homeIds = new Set(homeStars.map((s) => s.id));
  const candidates = stars.filter((s) => s.color !== 'black_hole' && !homeIds.has(s.id));
  for (let i = 0; i < wormholes && candidates.length >= 2; i++) {
    const a = candidates.splice(rng.int(candidates.length), 1)[0]!;
    const b = candidates.splice(rng.int(candidates.length), 1)[0]!;
    a.wormholeTo = b.id;
    b.wormholeTo = a.id;
  }

  // --- connectivity guarantee: bridge stars until all homes link at hop range ---
  ensureHomeConnectivity(
    stars,
    planets,
    homeStars.map((s) => s.id),
    () => true,
    (x, y) => {
      const star: Star = {
        id: nextId++,
        name: starName(rng, taken, namePool),
        x,
        y,
        color: (() => {
          const c = weighted(rng, COLOR_WEIGHTS);
          return c === 'black_hole' ? 'red' : c;
        })(),
        wormholeTo: null,
        sym: -1,
      };
      stars.push(star);
      for (const spec of rollPlanetSpecs(rng, star.color, 1)) {
        planets.push({ id: nextId++, starId: star.id, ...spec });
      }
    },
  );

  nextId = placeHomeworlds(planets, homeStars, empireTraits, settings, nextId);
  planets.sort((a, b) => a.id - b.id);

  return { stars, planets, homePlanets: homePlanetIds(planets, empireTraits.length), nextId };
}

/** Override each home star's orbit 3 with the race homeworld and equalize the
 * rest of the system: exactly one sibling world, identical for every player
 * ('good' start = ultra-rich, 'min' start = abundant). */
function placeHomeworlds(
  planets: Planet[],
  homeStars: Star[],
  empireTraits: RaceTraits[],
  settings: GameStateSettings,
  nextIdIn: number,
): number {
  let nextId = nextIdIn;
  const sibMinerals: Minerals = (settings.homeStart ?? 'good') === 'min' ? 'abundant' : 'ultra_rich';
  for (let e = 0; e < empireTraits.length; e++) {
    const star = homeStars[e]!;
    const traits = empireTraits[e]!;
    const existingIdx = planets.findIndex((p) => p.starId === star.id && p.orbit === 3);
    const hw: Planet = {
      id: existingIdx >= 0 ? planets[existingIdx]!.id : nextId++,
      starId: star.id,
      orbit: 3,
      body: 'planet',
      sizeClass: traits.largeHomeworld ? 4 : 3,
      climate: 'terran',
      minerals: traits.richHomeworld ? 'rich' : traits.poorHomeworld ? 'poor' : 'abundant',
      gravity: traits.gravityPref, // homeworld always matches the race
      special: traits.artifactsHomeworld ? 'ancient_artifacts' : null,
      homeworldOf: e,
      terraformSteps: 0,
    };
    if (existingIdx >= 0) planets[existingIdx] = hw;
    else planets.push(hw);

    // home-system parity: drop every other rolled planet, add the one sibling
    for (let i = planets.length - 1; i >= 0; i--) {
      const p = planets[i]!;
      if (p.starId === star.id && p.id !== hw.id) planets.splice(i, 1);
    }
    planets.push({
      id: nextId++,
      starId: star.id,
      orbit: 2,
      body: 'planet',
      sizeClass: 3,
      climate: 'barren',
      minerals: sibMinerals,
      gravity: 'normal',
      special: null,
      homeworldOf: null,
      terraformSteps: 0,
    });
  }
  return nextId;
}

function homePlanetIds(planets: Planet[], empireCount: number): number[] {
  const ids: number[] = [];
  for (let e = 0; e < empireCount; e++) {
    ids.push(planets.find((p) => p.homeworldOf === e)!.id);
  }
  return ids;
}

/** Mirror galaxy: one hub star at the exact center plus N rotated copies of a
 * seeded wedge. Every player starts on the map edge with an identical
 * neighborhood (same colors, planets, distances up to 1cp rounding). */
function generateMirrorGalaxy(
  seed: MasterSeed,
  settings: GameStateSettings,
  empireTraits: RaceTraits[],
): GeneratedGalaxy {
  const rng = rngFor(seed, 'galaxy_mirror');
  const { w, h } = MAP_SIZE[settings.galaxySize];
  const starCount = STAR_COUNTS[settings.galaxySize];
  const n = empireTraits.length;
  const rots = ROTATIONS[n]!;
  const cx = w >> 1;
  const cy = h >> 1;
  const radius = Math.min(cx, cy) - 120; // homes ride the map edge
  let nextId = 1;

  const stars: Star[] = [];
  const planets: Planet[] = [];
  const taken = new Set<string>();
  const namePool = makeNamePool(rng);

  /** create one star per rotation of (dx,dy), sharing color + planet specs */
  const addGroup = (dx: number, dy: number, sym: number, color: StarColor, specs: PlanetSpec[]): Star[] => {
    const out: Star[] = [];
    for (const rot of rots) {
      const { x, y } = rotatePoint(cx, cy, dx, dy, rot);
      const star: Star = { id: nextId++, name: starName(rng, taken, namePool), x, y, color, wormholeTo: null, sym };
      stars.push(star);
      for (const spec of specs) planets.push({ id: nextId++, starId: star.id, ...spec });
      out.push(star);
    }
    return out;
  };

  // hub: a single shared star at the exact center (Orion designate)
  const hubColor: StarColor = 'yellow';
  const hub: Star = { id: nextId++, name: starName(rng, taken, namePool), x: cx, y: cy, color: hubColor, wormholeTo: null, sym: 0 };
  stars.push(hub);
  for (const spec of rollPlanetSpecs(rng, hubColor, 1)) {
    planets.push({ id: nextId++, starId: hub.id, ...spec });
  }

  // home group: one copy per player, on the edge (sym 1)
  const homeCopies = addGroup(radius, 0, 1, 'yellow', rollPlanetSpecs(rng, 'yellow', 1));

  // wedge stars: sampled offsets whose every rotation stays clear of everything
  const wedgeGroups = Math.max(2, Math.floor((starCount - 1) / n) - 1);
  let placed = 0;
  let guard = 0;
  let symCounter = 2;
  while (placed < wedgeGroups && guard++ < 30000) {
    const dx = rng.int(2 * radius + 1) - radius;
    const dy = rng.int(2 * radius + 1) - radius;
    const r2 = dx * dx + dy * dy;
    if (r2 > radius * radius || r2 < MIN_STAR_DIST * MIN_STAR_DIST) continue;
    const points = rots.map((rot) => rotatePoint(cx, cy, dx, dy, rot));
    const clear =
      points.every((p) =>
        stars.every((s) => (s.x - p.x) * (s.x - p.x) + (s.y - p.y) * (s.y - p.y) >= MIN_STAR_DIST * MIN_STAR_DIST),
      ) &&
      points.every(
        (p, i) =>
          points.filter((_, j) => j > i).every((q) => (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y) >= MIN_STAR_DIST * MIN_STAR_DIST),
      );
    if (!clear) continue;
    const color = weighted(rng, COLOR_WEIGHTS);
    addGroup(dx, dy, symCounter++, color, rollPlanetSpecs(rng, color));
    placed++;
  }

  // symmetric wormholes: one private pair inside every wedge
  const holeGroups = [...new Set(stars.filter((s) => (s.sym ?? -1) >= 2 && s.color !== 'black_hole').map((s) => s.sym!))];
  if (holeGroups.length >= 2) {
    const ga = holeGroups[rng.int(holeGroups.length)]!;
    let gb = ga;
    while (gb === ga) gb = holeGroups[rng.int(holeGroups.length)]!;
    const asPerRot = stars.filter((s) => s.sym === ga);
    const bsPerRot = stars.filter((s) => s.sym === gb);
    for (let k = 0; k < Math.min(asPerRot.length, bsPerRot.length); k++) {
      asPerRot[k]!.wormholeTo = bsPerRot[k]!.id;
      bsPerRot[k]!.wormholeTo = asPerRot[k]!.id;
    }
  }

  // connectivity: bridge symmetric copies together (hub excluded — it will be
  // guarded as the prize system, so the guaranteed path avoids it)
  ensureHomeConnectivity(
    stars,
    planets,
    homeCopies.map((s) => s.id),
    (s) => s.id !== hub.id,
    (x, y) => {
      // convert back to an offset from the hub and add every rotation of it
      let odx = x - cx;
      let ody = y - cy;
      const d2 = odx * odx + ody * ody;
      if (d2 < MIN_STAR_DIST * MIN_STAR_DIST) {
        // a chain point on/near the hub: push it out so the copies neither
        // stack on the hub nor on each other (still symmetric — every copy
        // gets the same nudged offset)
        if (d2 === 0) {
          odx = MIN_STAR_DIST;
          ody = 0;
        } else {
          const d = Math.max(1, isqrt(d2));
          odx = roundDiv(odx * MIN_STAR_DIST, d);
          ody = roundDiv(ody * MIN_STAR_DIST, d);
        }
      }
      const specs = rollPlanetSpecs(rng, 'red', 1);
      for (const rot of rots) {
        const { x: px, y: py } = rotatePoint(cx, cy, odx, ody, rot);
        // skip a copy that would stack on an existing star (tight overlaps
        // only happen near the hub where another copy already serves)
        if (stars.some((s) => (s.x - px) * (s.x - px) + (s.y - py) * (s.y - py) <= 30 * 30)) continue;
        const star: Star = { id: nextId++, name: starName(rng, taken, namePool), x: px, y: py, color: 'red', wormholeTo: null, sym: -1 };
        stars.push(star);
        for (const spec of specs) planets.push({ id: nextId++, starId: star.id, ...spec });
      }
    },
  );

  planets.sort((a, b) => a.id - b.id);
  nextId = placeHomeworlds(planets, homeCopies, empireTraits, settings, nextId);
  planets.sort((a, b) => a.id - b.id);

  return { stars, planets, homePlanets: homePlanetIds(planets, n), nextId };
}

function rollGravity(rng: Rng, sizeClass: number): Gravity {
  // bigger planets skew heavy, small skew light
  const roll = rng.int(100) + sizeClass * 10;
  if (roll < 38) return 'low';
  if (roll < 88) return 'normal';
  return 'high';
}

/** distance in centiparsecs between two stars */
export function starDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return isqrt(dx * dx + dy * dy);
}
