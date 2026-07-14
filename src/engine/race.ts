// Resolved race traits: turns a pick list into the flags/magnitudes the
// simulation consumes. Pure lookup over the picks data.

import { pickById, type Government, GOVERNMENTS } from './data/index';
import type { Gravity } from './types';

export interface RaceTraits {
  government: Government;
  growthPct: number; // -50 | 0 | 50 | 100
  farmingHalf: number; // food coeff delta per farmer in HALF units (-1 = -0.5 food)
  industry: number;
  science: number;
  bcHalves: number; // money pick in half-BC units (-1, 0, 1, 2)
  shipDefensePct: number;
  shipAttackPct: number;
  groundPct: number;
  spyingPct: number;
  gravityPref: Gravity;
  aquatic: boolean;
  subterranean: boolean;
  largeHomeworld: boolean;
  richHomeworld: boolean;
  poorHomeworld: boolean;
  artifactsHomeworld: boolean;
  cybernetic: boolean;
  lithovore: boolean;
  repulsive: boolean;
  charismatic: boolean;
  uncreative: boolean;
  creative: boolean;
  tolerant: boolean;
  fantasticTraders: boolean;
  telepathic: boolean;
  lucky: boolean;
  omniscient: boolean;
  stealthyShips: boolean;
  transDimensional: boolean;
  warlord: boolean;
}

function pickValue(picks: ReadonlySet<string>, base: string): number {
  for (const tier of [1, 2, 3]) {
    const id = `${base}${tier}`;
    if (picks.has(id)) return pickById.get(id)?.value ?? 0;
  }
  return 0;
}

export function resolveTraits(pickIds: readonly string[]): RaceTraits {
  const picks = new Set(pickIds);
  const government = (GOVERNMENTS.find((g) => picks.has(g)) ?? 'dictatorship') as Government;
  // farming/money picks store half-units in the data table (value 2 = +1)
  return {
    government,
    growthPct: pickValue(picks, 'growth'),
    farmingHalf: pickValue(picks, 'farming'),
    industry: pickValue(picks, 'industry'),
    science: pickValue(picks, 'science'),
    bcHalves: pickValue(picks, 'money'),
    shipDefensePct: pickValue(picks, 'defense'),
    shipAttackPct: pickValue(picks, 'attack'),
    groundPct: pickValue(picks, 'ground'),
    spyingPct: pickValue(picks, 'spying'),
    gravityPref: picks.has('lowg_world') ? 'low' : picks.has('highg_world') ? 'high' : 'normal',
    aquatic: picks.has('aquatic'),
    subterranean: picks.has('subterranean'),
    largeHomeworld: picks.has('large_hw'),
    richHomeworld: picks.has('rich_hw'),
    poorHomeworld: picks.has('poor_hw'),
    artifactsHomeworld: picks.has('arti_world'),
    cybernetic: picks.has('cybernetic'),
    lithovore: picks.has('lithovore'),
    repulsive: picks.has('repulsive'),
    charismatic: picks.has('charismatic'),
    uncreative: picks.has('uncreative'),
    creative: picks.has('creative'),
    tolerant: picks.has('tolerant'),
    fantasticTraders: picks.has('fantastic_traders'),
    telepathic: picks.has('telepathic'),
    lucky: picks.has('lucky'),
    omniscient: picks.has('omniscient'),
    stealthyShips: picks.has('stealthy_ships'),
    transDimensional: picks.has('trans_dimensional'),
    warlord: picks.has('warlord'),
  };
}

/** Advanced-government application per base government (sociology field 6).
 * Researching the app matching YOUR government upgrades it; a mismatched app
 * (e.g. a democracy stealing imperium) has no effect. */
export const ADVANCED_GOV_APP: Record<Government, string> = {
  feudal: 'confederation',
  dictatorship: 'imperium',
  democracy: 'federation',
  unification: 'galactic_unification',
};

/** Does this empire run the advanced form of its government? */
export function hasAdvancedGov(empire: { government: Government; knownApps: readonly string[] }): boolean {
  return empire.knownApps.includes(ADVANCED_GOV_APP[empire.government]);
}

/** Gravity mismatch steps for a race on a planet: 0, 1, or 2. Mismatch is
 * symmetric — a low-G world hampers a normal-G race just as a heavy world
 * does — except heavy-G races operate fine down to normal (racepicks doc). */
export function gravitySteps(pref: Gravity, planet: Gravity): number {
  const order: Record<Gravity, number> = { low: 0, normal: 1, high: 2 };
  if (pref === 'high') return planet === 'low' ? 2 : 0;
  return Math.abs(order[planet] - order[pref]);
}
