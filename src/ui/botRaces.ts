// Bot race archetypes: budget-scaled pick builds so bots exploit richer
// pick-point games (12/14/16) instead of leaving points on the table.
//
// Every archetype takes Repulsive: bots barely use diplomacy, so its -6 is
// nearly free budget — the classic min-max the stock presets refuse to do.
// From a fixed base (government + signature traits) the remaining budget is
// spent down a per-archetype priority list; tiered picks upgrade in place
// (industry2 -> industry3) via the exclusivity groups, and every list is
// ordered so all of 10/12/14/16 points are spent exactly (unit-tested).

import { PICK_EXCLUSIVE_GROUPS, validatePicks } from '@engine/data/index';

export interface BotRaceDef {
  id: string;
  name: string;
  blurb: string;
  /** always taken (must include exactly one government) */
  base: readonly string[];
  /** spent in order while the budget allows; same-group picks upgrade */
  wants: readonly string[];
}

export const BOT_RACES: readonly BotRaceDef[] = [
  {
    id: 'forgers',
    name: 'Subterran Forgers',
    blurb: 'repulsive miners — subterranean, unified, heavy industry',
    base: ['unification', 'repulsive', 'subterranean'],
    wants: ['industry2', 'industry3', 'science2', 'rich_hw', 'large_hw', 'growth2'],
  },
  {
    id: 'scholars',
    name: 'Subterran Scholars',
    blurb: 'repulsive researchers — subterranean warrens full of labs',
    base: ['dictatorship', 'repulsive', 'subterranean'],
    wants: ['science2', 'science3', 'industry2', 'industry3', 'growth2', 'rich_hw', 'large_hw'],
  },
  {
    id: 'lithovores',
    name: 'Lithovore Hollows',
    blurb: 'rock-eaters — no farms ever, deep subterranean cities',
    base: ['dictatorship', 'repulsive', 'lithovore'],
    wants: ['subterranean', 'industry2', 'industry3', 'rich_hw', 'large_hw', 'science2'],
  },
  {
    id: 'cyborgs',
    name: 'Cybernetic Union',
    blurb: 'machine hybrids — cybernetic industry under one directive',
    base: ['unification', 'repulsive', 'cybernetic'],
    wants: ['industry2', 'industry3', 'science2', 'rich_hw', 'large_hw', 'growth2'],
  },
  {
    id: 'creatives',
    name: 'Creative Recluses',
    blurb: 'shunned geniuses — creative research, every tech learned',
    // industry2 before subterranean/science3: round 9 showed the 10-pick
    // creative finishing dead last (19c/0 warships/626pts at t600) — all
    // brains and no hands. Industry at every budget fixes the opening.
    base: ['dictatorship', 'repulsive', 'creative'],
    wants: ['science2', 'industry2', 'subterranean', 'science3', 'rich_hw', 'large_hw', 'growth2'],
  },
];

export const botRaceById: ReadonlyMap<string, BotRaceDef> = new Map(BOT_RACES.map((r) => [r.id, r]));

/** add a pick, evicting any same-exclusivity-group pick (tier upgrades) */
function withPick(picks: readonly string[], id: string): string[] {
  const group = Object.values(PICK_EXCLUSIVE_GROUPS).find((g) => g.includes(id));
  const out = group ? picks.filter((p) => !group.includes(p)) : [...picks];
  out.push(id);
  return out;
}

/** The archetype's pick list for a budget, or null for unknown archetypes
 * (callers fall back to treating the id as a stock preset). */
export function botRacePicks(archetypeId: string, budget: number): string[] | null {
  const def = botRaceById.get(archetypeId);
  if (!def) return null;
  let picks = [...def.base];
  for (const want of def.wants) {
    const trial = withPick(picks, want);
    if (validatePicks(trial, budget).ok) picks = trial;
  }
  return picks.sort();
}
