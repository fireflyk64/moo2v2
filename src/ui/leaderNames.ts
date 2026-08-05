// Stylized leader names, derived per-game from the master seed.
//
// The sim tracks leaders by id and never reads these strings, so names are
// display-only: every peer derives the identical roster from the shared seed
// (rngFor stream 'leader-names') and nothing changes on the wire or in saves.
//
// Flavor: the surveyors, magnates, and track bosses of the 1860s
// transcontinental railroad — Strobridge, Montague, Judah — bent one notch
// spaceward, the way Lando is a spacey Lance. Each name keeps its leader's
// rank ("Lord Admiral", "Commissioner") because rank encodes colony-vs-ship
// kind in the source table.

import { rngFor, type MasterSeed, type Rng } from '@engine/rng';
import { LEADERS } from '@engine/data/leaders';

const FIRST = [
  'Leland', 'Collis', 'Theodore', 'Samuel', 'James', 'Harvey', 'Grenville',
  'Thomas', 'Sidney', 'Oakes', 'Oliver', 'Silas', 'Watson', 'Charles', 'Mark',
  'Lewis', 'Peter', 'Alexander', 'David', 'Amos', 'Edwin', 'Brigham', 'Jesse',
  'Hiram', 'Asa', 'Ezra', 'Milton', 'Truman', 'Josiah', 'Cornelius', 'Horace',
  'Nathaniel', 'Eli', 'Anna', 'Clara', 'Ellen', 'Minerva', 'Phoebe', 'Louisa',
  'Abigail',
] as const;

const LAST = [
  'Stanford', 'Huntington', 'Hopkins', 'Crocker', 'Judah', 'Montague',
  'Strobridge', 'Clement', 'Dodge', 'Durant', 'Casement', 'Dillon', 'Ames',
  'Seymour', 'Hewes', 'Russell', 'Hart', 'Shilling', 'Reed', 'Farnam',
  'Bushnell', 'Whitney', 'Sargent', 'Colton', 'Towne', 'Marsh', 'Sherman',
  'Toponce', 'Coyle', 'Bates', 'Sickels', 'Graham', 'Ferguson', 'Tracy',
  'Rawlins', 'Ogden', 'Laramie', 'Corinne', 'Promontory', 'Truckee',
] as const;

/** Ending rewrites, longest match wins. Tuned by ear: Leland→Lelando,
 * Stanford→Stanvor, Crocker→Crockar, Montague→Montago, Judah→Judara. */
const END_RULES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/land$/i, ['lando', 'lund', 'laan']],
  [/ford$/i, ['vor', 'for', 'faro']],
  [/ing$/i, ['ix', 'ingo', 'ion']],
  [/dge$/i, ['dax', 'dgar', 'dio']],
  [/ton$/i, ['tar', 'thon', 'tor']],
  [/son$/i, ['zon', 'saan', 'sen']],
  [/man$/i, ['mar', 'maan', 'mond']],
  [/us$/i, ['os', 'ax', 'ion']],
  [/er$/i, ['ar', 'aro', 'ex']],
  [/es$/i, ['ez', 'eus', 'esh']],
  [/ah$/i, ['ara', 'axa', 'aar']],
  [/e$/i, ['o', 'a', 'eus']],
  [/a$/i, ['ara', 'ah', 'axa']],
  [/y$/i, ['yr', 'ys', 'ia']],
  [/o$/i, ['os', 'oon', 'ox']],
] as const;

const DEFAULT_SUFFIX = ['o', 'is', 'ar', 'ax', 'us', 'on', 'a'] as const;

const VOWEL_SHIFT: Record<string, readonly string[]> = {
  a: ['o', 'aa'],
  e: ['a', 'ei'],
  i: ['y', 'ai'],
  o: ['u', 'oa'],
  u: ['oo', 'au'],
};

const CONSONANT_SHIFT: ReadonlyArray<readonly [string, string]> = [
  ['c', 'k'], // Crocker → Krocker
  ['w', 'v'], // Watson → Vatson
  ['s', 'z'],
] as const;

function applySuffix(base: string, rng: Rng): string {
  for (const [re, outs] of END_RULES) {
    if (re.test(base)) return base.replace(re, rng.pick(outs));
  }
  return base + rng.pick(DEFAULT_SUFFIX);
}

function applyVowelShift(base: string, rng: Rng): string {
  const isVowel = (c: string | undefined) => !!c && 'aeiou'.includes(c.toLowerCase());
  const spots: number[] = [];
  for (let i = 1; i < base.length; i++) {
    // only isolated vowels: shifting inside a cluster breeds "Loauisa" mush
    if (isVowel(base[i]) && !isVowel(base[i - 1]) && !isVowel(base[i + 1])) spots.push(i);
  }
  if (spots.length === 0) return base;
  const i = spots[rng.int(spots.length)]!;
  const repl = rng.pick(VOWEL_SHIFT[base[i]!.toLowerCase()]!);
  return base.slice(0, i) + repl + base.slice(i + 1);
}

function applyConsonantShift(base: string, rng: Rng): string {
  const options = CONSONANT_SHIFT.filter(([from]) => base.toLowerCase().includes(from));
  if (options.length === 0) return base;
  const [from, to] = rng.pick(options);
  const at = base.toLowerCase().indexOf(from);
  return base.slice(0, at) + to + base.slice(at + 1);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Bend one 1869 name a notch spaceward. Always returns something ≠ base.
 * One primary morph, occasionally a light second — the name should stay
 * recognizable (Lando, not Lxq'ndo). */
export function spacify(base: string, rng: Rng): string {
  let out = base;
  const roll = rng.int(100);
  if (roll < 60) out = applySuffix(out, rng);
  else if (roll < 85) out = applyVowelShift(out, rng);
  else out = applyConsonantShift(out, rng);
  if (rng.chancePct(20)) {
    out = roll < 60 ? applyVowelShift(out, rng) : applySuffix(out, rng);
  }
  if (out === base) out = applySuffix(out, rng);
  if (out === base) out += rng.pick(DEFAULT_SUFFIX);
  return capitalize(out);
}

/** "Lord Admiral Loknar" → "Lord Admiral" (rank is every token but the last). */
function rankOf(fullName: string): string {
  const parts = fullName.split(' ');
  return parts.slice(0, -1).join(' ');
}

export interface StyledLeaderName {
  /** e.g. "Lord Admiral Jaymes Strobridax" */
  full: string;
  /** e.g. "Jaymes Strobridax" — no rank, for tight UI spots */
  person: string;
}

/**
 * Derive the whole roster at once (fixed LEADERS order) so uniqueness can be
 * enforced and every peer agrees. Memoized on the seed.
 */
export function styledLeaderRoster(seed: MasterSeed): Map<string, StyledLeaderName> {
  const cached = rosterCache.get(seed);
  if (cached) return cached;

  const rng = rngFor(seed, 'leader-names');
  const used = new Set<string>();
  const roster = new Map<string, StyledLeaderName>();

  for (const row of LEADERS) {
    let person = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      const first = spacify(rng.pick(FIRST), rng);
      const last = spacify(rng.pick(LAST), rng);
      const middle = rng.chancePct(18) ? spacify(rng.pick(FIRST), rng) + ' ' : '';
      person = `${first} ${middle}${last}`;
      if (!used.has(person)) break;
    }
    used.add(person);
    const rank = rankOf(row.name);
    roster.set(row.id, { person, full: rank ? `${rank} ${person}` : person });
  }

  rosterCache.clear(); // one live game at a time; don't grow across regames
  rosterCache.set(seed, roster);
  return roster;
}

const rosterCache = new Map<MasterSeed, Map<string, StyledLeaderName>>();

/** Display name for a leader id; falls back to the base table name. */
export function leaderDisplayName(seed: MasterSeed | null | undefined, leaderId: string, fallback: string): string {
  if (!seed) return fallback;
  try {
    return styledLeaderRoster(seed).get(leaderId)?.full ?? fallback;
  } catch {
    return fallback; // invalid seed (dev harnesses) — keep the table name
  }
}
