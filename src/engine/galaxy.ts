// Deterministic galaxy generation from the master seed.
//
// Star counts per size follow the documented classic values (data README F11).
// The color/planet roll weights below are TUNABLE defaults in the documented
// classic *structure* (weighted tables keyed by star color); exact classic
// odds were not fully published, so these are our balance set (F13).

import { rngFor, type MasterSeed, type Rng } from './rng';
import { isqrt } from './isqrt';
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
  blue: [10, 15, 20, 25, 20, 10],
  white: [10, 15, 22, 25, 18, 10],
  yellow: [5, 12, 22, 28, 22, 11],
  orange: [10, 18, 25, 25, 15, 7],
  red: [20, 25, 25, 18, 9, 3],
  brown: [55, 30, 10, 5, 0, 0],
  black_hole: [100, 0, 0, 0, 0, 0],
};

const BODY_WEIGHTS: Array<[BodyType, number]> = [
  ['planet', 62],
  ['asteroids', 18],
  ['gas_giant', 20],
];

const SIZE_WEIGHTS: number[] = [15, 25, 30, 20, 10]; // tiny..huge

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

export function generateGalaxy(
  seed: MasterSeed,
  settings: GameStateSettings,
  empireTraits: RaceTraits[],
): GeneratedGalaxy {
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

  // --- wormhole pairs (up to galaxySize/4 like the classic cap, we use 2) ---
  const wormholes = Math.min(2, Math.floor(stars.length / 12));
  const candidates = stars.filter((s) => s.color !== 'black_hole');
  for (let i = 0; i < wormholes && candidates.length >= 2; i++) {
    const a = candidates.splice(rng.int(candidates.length), 1)[0]!;
    const b = candidates.splice(rng.int(candidates.length), 1)[0]!;
    a.wormholeTo = b.id;
    b.wormholeTo = a.id;
  }

  // --- planets ---
  const planets: Planet[] = [];
  for (const star of stars) {
    const count = weighted(
      rng,
      PLANET_COUNT_WEIGHTS[star.color].map((wgt, n) => [n, wgt] as [number, number]),
    );
    const orbits = [1, 2, 3, 4, 5];
    rng.shuffle(orbits);
    for (let k = 0; k < count; k++) {
      const orbit = orbits[k]!;
      const body = weighted(rng, BODY_WEIGHTS);
      const sizeClass = 1 + weighted(rng, SIZE_WEIGHTS.map((wgt, i) => [i, wgt] as [number, number]));
      planets.push({
        id: nextId++,
        starId: star.id,
        orbit,
        body,
        sizeClass: body === 'planet' ? sizeClass : 3,
        climate: body === 'planet' ? weighted(rng, CLIMATE_WEIGHTS[orbitBand(orbit)]) : 'barren',
        minerals: weighted(rng, MINERAL_WEIGHTS[star.color]),
        gravity: rollGravity(rng, body === 'planet' ? sizeClass : 3),
        special: null,
        homeworldOf: null,
        terraformSteps: 0,
      });
    }
  }
  planets.sort((a, b) => a.id - b.id);

  // --- homeworlds: pick well-separated stars, override one planet each ---
  const homePlanets: number[] = [];
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
    // dense fallback: just take the most mutually distant stars greedily
    bestSpread = nonHole.slice(0, empireTraits.length);
  }
  for (let e = 0; e < empireTraits.length; e++) {
    const star = bestSpread[e]!;
    homeStars.push(star);
    const traits = empireTraits[e]!;
    // replace/insert the homeworld at orbit 3
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
    homePlanets.push(hw.id);

    // every home system starts with at least one other settleable world — a
    // modest poor planet — so colony bases have somewhere to go (min-start rule)
    const sibling = planets.find((p) => p.starId === star.id && p.id !== hw.id && p.body === 'planet');
    if (!sibling) {
      const usedOrbits = new Set(planets.filter((p) => p.starId === star.id).map((p) => p.orbit));
      const orbit = [2, 4, 1, 5].find((o) => !usedOrbits.has(o)) ?? 2;
      const existingAt = planets.findIndex((p) => p.starId === star.id && p.orbit === orbit);
      const extra: Planet = {
        id: existingAt >= 0 ? planets[existingAt]!.id : nextId++,
        starId: star.id,
        orbit,
        body: 'planet',
        sizeClass: 2,
        climate: weighted(rng, CLIMATE_WEIGHTS[orbitBand(orbit)]),
        minerals: 'poor',
        gravity: rollGravity(rng, 2),
        special: null,
        homeworldOf: null,
        terraformSteps: 0,
      };
      if (existingAt >= 0) planets[existingAt] = extra;
      else planets.push(extra);
    }
  }
  planets.sort((a, b) => a.id - b.id);

  return { stars, planets, homePlanets, nextId };
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
