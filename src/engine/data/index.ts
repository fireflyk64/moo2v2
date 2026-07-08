// Curated static-data layer over generated.ts: types, lookups, exclusivity
// rules, stock-race presets, and the DATA_VERSION fingerprint.
//
// Identity rules (see README.md): string ids are canonical; APPLICATION_ROWS is
// authoritative for tech-tree structure; numeric techIds are reference only.

import { hashCanonical } from '../canonical';
import {
  APPLICATION_ROWS,
  BUILDABLE_ROWS,
  CP_SOURCES,
  CP_USAGE,
  FIELD_ROWS,
  FIELD_SUBJECTS,
  HULL_ROWS,
  LANDER_COSTS,
  MISC_COSTS,
  MOD_FLAG_KEYS,
  PICK_BUDGET,
  PICK_ROWS,
  SCAN_BONUSES,
  STARTING_FIELD_NUMS,
  STEALTH_BONUSES,
  TECH_ROWS,
  WEAPON_MOD_ROWS,
  WEAPON_ROWS,
  type ApplicationRow,
  type BuildableRow,
  type FieldRow,
  type HullRow,
  type PickRow,
  type TechRow,
  type WeaponModRow,
  type WeaponRow,
} from './generated';

export * from './generated';

// ---------- subjects ----------

export const SUBJECTS = [
  'construction',
  'power',
  'chemistry',
  'sociology',
  'computers',
  'ecology',
  'physics',
  'force_fields',
] as const;
export type Subject = (typeof SUBJECTS)[number];

// ---------- lookups ----------

function byId<T extends { id: string }>(rows: readonly T[], what: string): ReadonlyMap<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) {
    if (m.has(r.id)) throw new Error(`duplicate ${what} id: ${r.id}`);
    m.set(r.id, r);
  }
  return m;
}

export const pickById: ReadonlyMap<string, PickRow> = byId(PICK_ROWS, 'pick');
export const fieldById: ReadonlyMap<string, FieldRow> = byId(FIELD_ROWS, 'field');
export const techById: ReadonlyMap<string, TechRow> = byId(TECH_ROWS, 'tech');

/** Curated buildable projects the source tables list only as applications.
 * Terraform costs are OUR tunables (T1, data/README.md); the terraforming
 * project's cost is dynamic (rises per completed step — items.ts). */
export const CURATED_BUILDABLES: BuildableRow[] = [
  { id: 'terraforming', techId: 184, cost: 250, maintenance: 0, group: 'special' },
  { id: 'gaia_transformation', techId: 211, cost: 500, maintenance: 0, group: 'special' },
];

export const buildableById: ReadonlyMap<string, BuildableRow> = byId(
  [...BUILDABLE_ROWS, ...CURATED_BUILDABLES],
  'buildable',
);
export const hullById: ReadonlyMap<string, HullRow> = byId(HULL_ROWS, 'hull');
export const weaponById: ReadonlyMap<string, WeaponRow> = byId(WEAPON_ROWS, 'weapon');
export const weaponModById: ReadonlyMap<string, WeaponModRow> = byId(WEAPON_MOD_ROWS, 'weaponMod');

export const fieldByNum: ReadonlyMap<number, FieldRow> = new Map(
  FIELD_ROWS.map((f) => [f.num, f]),
);

/** Applications may repeat per field only via hyper-advanced synthetics; base rows are unique. */
export const applicationById: ReadonlyMap<string, ApplicationRow> = byId(
  APPLICATION_ROWS,
  'application',
);

export function applicationsOfField(fieldId: string): ApplicationRow[] {
  return APPLICATION_ROWS.filter((a) => a.fieldId === fieldId);
}

export function subjectOfField(fieldId: string): string {
  const s = FIELD_SUBJECTS[fieldId];
  if (!s) throw new Error(`no subject for field ${fieldId}`);
  return s;
}

/** Ordered researchable fields of a subject (by walking next-chain from root). */
export function fieldsOfSubject(subject: Subject): FieldRow[] {
  const out: FieldRow[] = [];
  for (const f of FIELD_ROWS) if (FIELD_SUBJECTS[f.id] === subject) out.push(f);
  out.sort((a, b) => (a.tier - b.tier) || (a.cost - b.cost) || (a.num - b.num));
  return out;
}

// ---------- picks: groups, exclusivity, budget ----------

export const GOVERNMENTS = ['feudal', 'dictatorship', 'democracy', 'unification'] as const;
export type Government = (typeof GOVERNMENTS)[number];

/** Mutually exclusive pick groups (at most one per group; government exactly one). */
export const PICK_EXCLUSIVE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  government: GOVERNMENTS,
  growth: ['growth1', 'growth2', 'growth3'],
  farming: ['farming1', 'farming2', 'farming3'],
  industry: ['industry1', 'industry2', 'industry3'],
  science: ['science1', 'science2', 'science3'],
  money: ['money1', 'money2', 'money3'],
  defense: ['defense1', 'defense2', 'defense3'],
  attack: ['attack1', 'attack2', 'attack3'],
  ground: ['ground1', 'ground2', 'ground3'],
  spying: ['spying1', 'spying2', 'spying3'],
  gravity: ['lowg_world', 'highg_world'],
  hw_minerals: ['rich_hw', 'poor_hw'],
  creativity: ['creative', 'uncreative'],
  charisma: ['charismatic', 'repulsive'],
};

export const MAX_POSITIVE_PICKS = PICK_BUDGET['maximum_positive_custom_race_picks'] ?? 10;
export const MAX_NEGATIVE_PICKS = PICK_BUDGET['maximum_negative_picks'] ?? -10;
export const ADAPTIVE_UPGRADE_PICKS = PICK_BUDGET['adaptive_upgrade_added_picks'] ?? 4;

export interface PickValidationResult {
  ok: boolean;
  errors: string[];
  cost: number;
}

/** Validate a custom race pick set per the §02 rules. */
export function validatePicks(pickIds: readonly string[]): PickValidationResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  let cost = 0;
  for (const id of pickIds) {
    const row = pickById.get(id);
    if (!row) {
      errors.push(`unknown pick: ${id}`);
      continue;
    }
    if (seen.has(id)) errors.push(`duplicate pick: ${id}`);
    seen.add(id);
    cost += row.cost;
  }
  for (const [group, members] of Object.entries(PICK_EXCLUSIVE_GROUPS)) {
    const chosen = members.filter((m) => seen.has(m));
    if (group === 'government') {
      if (chosen.length !== 1) errors.push(`exactly one government required (got ${chosen.length})`);
    } else if (chosen.length > 1) {
      errors.push(`picks are mutually exclusive: ${chosen.join(', ')}`);
    }
  }
  // Negative picks ADD budget: net cost must stay within [-10, +10] and at most
  // 10 points of disadvantages may be taken (stock presets like the telepathic
  // feudal race spend 14 gross positives against 4 refunded points, legally).
  const negatives = pickIds.reduce((s, id) => s + Math.min(0, pickById.get(id)?.cost ?? 0), 0);
  if (negatives < MAX_NEGATIVE_PICKS) {
    errors.push(`negative picks ${negatives} exceed allowance ${MAX_NEGATIVE_PICKS}`);
  }
  if (cost > MAX_POSITIVE_PICKS) errors.push(`net cost ${cost} exceeds ${MAX_POSITIVE_PICKS}`);
  return { ok: errors.length === 0, cost, errors };
}

// ---------- stock race presets ----------
//
// Presets correspond row-by-row to mechanics/races.md (same pick sets); display
// names here are original to this project, per the docs' renaming guidance.

export interface RacePreset {
  id: string;
  name: string;
  picks: readonly string[];
}

export const RACE_PRESETS: readonly RacePreset[] = [
  { id: 'skyshear', name: 'Skyshear Flock', picks: ['defense3', 'arti_world', 'dictatorship'] },
  { id: 'urgok', name: 'Urgok Clans', picks: ['attack2', 'ground2', 'highg_world', 'dictatorship'] },
  { id: 'veilkin', name: 'Veilkin Syndics', picks: ['spying3', 'stealthy_ships', 'dictatorship'] },
  { id: 'mindral', name: 'Mindral Court', picks: ['defense2', 'attack2', 'telepathic', 'omniscient', 'feudal'] },
  { id: 'lumini', name: 'Lumini Compact', picks: ['money3', 'lowg_world', 'fantastic_traders', 'lucky', 'dictatorship'] },
  { id: 'solari', name: 'Solari Republic', picks: ['charismatic', 'democracy'] },
  { id: 'hivex', name: 'Hivex Commune', picks: ['farming2', 'industry2', 'large_hw', 'uncreative', 'unification'] },
  { id: 'ferron', name: 'Ferron Assembly', picks: ['industry3', 'cybernetic', 'dictatorship'] },
  { id: 'korrath', name: 'Korrath Prides', picks: ['attack3', 'rich_hw', 'warlord', 'dictatorship'] },
  { id: 'cerebri', name: 'Cerebri Conclave', picks: ['science3', 'lowg_world', 'large_hw', 'creative', 'dictatorship'] },
  { id: 'sauren', name: 'Sauren Broods', picks: ['growth3', 'farming2', 'spying1', 'subterranean', 'large_hw', 'feudal'] },
  { id: 'lithor', name: 'Lithor Shards', picks: ['growth1', 'lithovore', 'repulsive', 'tolerant', 'dictatorship'] },
  { id: 'tidari', name: 'Tidari Currents', picks: ['aquatic', 'trans_dimensional', 'dictatorship'] },
];

export const racePresetById: ReadonlyMap<string, RacePreset> = byId(RACE_PRESETS, 'racePreset');

// ---------- starting knowledge ----------

/** Field numbers known at game start per start mode (pre_warp / average). */
export function startingFieldNums(mode: 'pre_warp' | 'average'): readonly number[] {
  const nums = STARTING_FIELD_NUMS[mode];
  if (!nums) throw new Error(`unknown start mode ${mode}`);
  return nums;
}

/** Items every empire knows regardless of research (see mechanics/unresearchable.md). */
export const ALWAYS_KNOWN_ITEMS = ['capitol', 'marine_barracks', 'spies'] as const;

// ---------- version fingerprint ----------

export const DATA_VERSION: string = hashCanonical({
  picks: PICK_ROWS,
  buildables: BUILDABLE_ROWS,
  fields: FIELD_ROWS,
  subjects: FIELD_SUBJECTS,
  techs: TECH_ROWS,
  hulls: HULL_ROWS,
  weapons: WEAPON_ROWS,
  weaponMods: WEAPON_MOD_ROWS,
  modFlags: MOD_FLAG_KEYS,
  applications: APPLICATION_ROWS,
  starting: STARTING_FIELD_NUMS,
  budget: PICK_BUDGET,
  cpSources: CP_SOURCES,
  cpUsage: CP_USAGE,
  scan: SCAN_BONUSES,
  stealth: STEALTH_BONUSES,
  landers: LANDER_COSTS,
  misc: MISC_COSTS,
  presets: RACE_PRESETS,
});
