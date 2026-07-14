// Ship designer: hulls + components -> designs -> derived combat stats.
//
// Combat is REDESIGNED in this project (per prompt.md), so component space and
// cost use our documented rules (C-rules in data/README.md) built on the hull,
// weapon, and effect stats that ARE in the mechanics data:
//   C1 armor & drive auto-equip (best known), no space; armor multiplies both
//      armor and structure HP; reinforced_hull triples structure.
//   C2 computer: 5% hull space, +25 beam attack per tier.
//   C3 shield: 15% hull space; pool 5/15/25/35/50 x hull index; flat per-hit
//      reduction 1/3/5/7/10; regen 3%/tick.
//   C4 combat speed = 3 + drive tier (+4 trans-dimensional).
//   C5 miniaturization: each completed field in the weapon's subject beyond
//      its own field shrinks space/cost 10% (floor 50%).
//   C6 to-hit = clamp(50 + attack - defense + band, 5, 95); base defense from
//      the hull table's defense column, +2 per point of combat speed.

import {
  appForWeapon,
  applicationById,
  fieldById,
  FIELD_ROWS,
  FIELD_SUBJECTS,
  hullById,
  weaponById,
  CP_USAGE,
  type HullRow,
  type WeaponRow,
} from './data/index';
import { floorDiv, roundDiv } from './imath';
import { hasAdvancedGov, resolveTraits } from './race';
import type { Empire, GameState } from './types';

export const HULLS_BUILDABLE = ['frigate', 'destroyer', 'cruiser', 'battleship', 'titan', 'doomstar'] as const;
export const BASE_HULLS = ['star_base', 'battlestation', 'star_fortress'] as const;

export interface DesignWeapon {
  weapon: string;
  count: number;
  mods: string[]; // flag keys: hv pd ap co sp af nr ...
  /** firing arc: F (forward 180°, default), FX (270°), R (rear 180°), 360 */
  arc?: 'F' | 'FX' | 'R' | '360';
}

/** Arc space/cost multipliers (%): wider coverage costs mount volume; a rear
 * mount is slightly cheaper than forward. */
export const ARC_SPACE_PCT: Record<'F' | 'FX' | 'R' | '360', number> = {
  F: 100,
  FX: 120,
  R: 90,
  '360': 140,
};

export interface ShipDesign {
  id: number;
  name: string;
  hull: string;
  computer: number; // tier 0-5
  shield: number; // tier 0-5 (I III V VII X)
  specials: string[];
  weapons: DesignWeapon[];
  obsolete: boolean;
  /** engine-maintained default design of its hull class (see types.ts) */
  auto?: boolean;
}

// ---------- tech tiers available to an empire ----------

export const COMPUTER_APPS = ['electronic_computer', 'optronic_computer', 'positronic_computer', 'cybertronic_computer', 'moleculartronic_computer'];
export const SHIELD_APPS = ['class_i_shield', 'class_iii_shield', 'class_v_shield', 'class_vii_shield', 'class_x_shield'];
export const ARMOR_APPS = ['titanium_armor', 'tritanium_armor', 'zortrium_armor', 'neutronium_armor', 'adamantium_armor', 'xentronium_armor'];
export const DRIVE_APPS = ['nuclear_drive', 'fusion_drive', 'ion_drive', 'anti_matter_drive', 'hyper_drive', 'interphased_drive'];
export const ARMOR_MULT = [1, 2, 5, 6, 8, 10];
export const ARMOR_NAMES = ['titanium', 'tritanium', 'zortrium', 'neutronium', 'adamantium', 'xentronium'];

/** Designable specials: id -> space% of hull. Effects: designStats (static
 * stats) or combat.ts (in-battle behavior, keyed off CombatShipInit.specials). */
export const SPECIALS: Record<string, number> = {
  battle_pods: 0, // grants +50% space instead of using it
  reinforced_hull: 5,
  battle_scanner: 5,
  inertial_stabilizer: 5,
  shield_capacitor: 5, // shield regen 3% -> 5%/tick
  ecm_jammer: 5, // 40% missile evasion
  multi_wave_ecm_jammer: 8, // 70% missile evasion
  wide_area_jammer: 10, // 40% missile evasion for the whole fleet
  hard_shields: 5, // +3 flat reduction, immune to shield-piercing
  multi_phased_shields: 8, // +50% shield pool
  automated_repair_unit: 8, // repairs ~0.5% structure/tick in combat
  advanced_damage_control: 8, // full repair after every battle
  high_energy_focus: 8, // +50% beam damage
  hyper_x_capacitors: 10, // beams cycle twice as fast
  fast_missile_racks: 5, // missiles cycle twice as fast
  heavy_armor: 10, // armor HP x3
  augmented_engines: 8, // +5 combat speed
  inertia_nullifier: 8, // +4 combat speed (agility)
  achilles_targeting_unit: 8, // beams bypass armor (shields still apply)
  structural_analyzer: 8, // beam damage x2
  rangemaster_target_unit: 5, // range band treated one step closer
  warp_dissipater: 10, // enemy ships cannot retreat off the field
  displacement_device: 10, // 33% of incoming direct fire misses
  lightning_field: 8, // 50% of incoming missiles/torpedoes destroyed
};

export interface SpecialSystemInfo {
  id: string;
  name: string;
  description: string;
  spacePct: number;
}

function prettySpecialId(id: string): string {
  return id
    .split('_')
    .map((w) => (w[0] ?? '').toUpperCase() + w.slice(1))
    .join(' ');
}

export function specialSystemInfo(id: string): SpecialSystemInfo {
  const app = applicationById.get(id);
  const name = app?.name ?? prettySpecialId(id);
  const description = app?.effectSummary ?? `${name}.`;
  return {
    id,
    name,
    description,
    spacePct: SPECIALS[id] ?? 0,
  };
}

function bestTier(empire: Empire, apps: readonly string[], alwaysFirst = false): number {
  let tier = alwaysFirst ? 1 : 0;
  apps.forEach((app, i) => {
    if (empire.knownApps.includes(app)) tier = i + 1;
  });
  return tier;
}

export function bestComputer(empire: Empire): number {
  return bestTier(empire, COMPUTER_APPS);
}
export function bestShield(empire: Empire): number {
  return bestTier(empire, SHIELD_APPS);
}
export function bestArmor(empire: Empire): number {
  return bestTier(empire, ARMOR_APPS, true); // titanium is starting tech
}
export function bestDrive(empire: Empire): number {
  return bestTier(empire, DRIVE_APPS, true); // nuclear is starting tech
}

/** Bay technologies unlock their strike craft as mountable "weapons". */
const CRAFT_BY_BAY: Record<string, string[]> = {
  fighter_bays: ['interceptor', 'bomber'],
  heavy_fighter_bays: ['heavy_fighter'],
};

export function knownWeapons(empire: Empire): WeaponRow[] {
  const out: WeaponRow[] = [];
  for (const w of weaponById.values()) {
    // weapon rows join to applications by id, plural form, or explicit alias
    // (disruptor_cannon / proton_torpedoes / plasma_torpedoes)
    const app = appForWeapon(w.id);
    if (empire.knownApps.includes(w.id) || (app && empire.knownApps.includes(app.id))) out.push(w);
  }
  for (const [bay, crafts] of Object.entries(CRAFT_BY_BAY)) {
    if (!empire.knownApps.includes(bay)) continue;
    for (const c of crafts) {
      const w = weaponById.get(c);
      if (w && !out.includes(w)) out.push(w);
    }
  }
  // charcode order, NOT localeCompare: the user's locale must never influence
  // engine ordering (Czech collation reorders 'ch' ids; this list feeds the
  // deterministic base-arsenal picks in battles.ts)
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------- miniaturization (C5) ----------

export function miniaturizationPct(empire: Empire, weaponId: string): number {
  const app = appForWeapon(weaponId);
  if (!app) return 100;
  const field = fieldById.get(app.fieldId);
  if (!field) return 100;
  const subject = FIELD_SUBJECTS[field.id];
  let deeper = 0;
  for (const num of empire.completedFields) {
    const f = [...fieldById.values()].find((x) => x.num === num);
    if (f && FIELD_SUBJECTS[f.id] === subject && f.cost > field.cost) deeper++;
  }
  return Math.max(50, 100 - 10 * deeper);
}

// ---------- weapon fitting ----------

export interface FittedWeapon {
  row: WeaponRow;
  count: number;
  mods: string[];
  arc: 'F' | 'FX' | 'R' | '360';
  spaceEach: number;
  costEach: number;
}

const MOD_SPACE_PCT: Record<string, number> = {
  hv: 100,
  pd: -50,
  ap: 50,
  co: 50,
  nr: 25,
  sp: 50,
  af: 50,
  env: 100,
  mv: 100,
  eccm: 25,
  arm: 25,
  fst: 25,
  emg: 300,
  ovr: 50,
};

/** Advanced mods need research beyond the weapon itself: MIRV and ECCM come
 * two field levels deeper in the weapon's subject, point defense one level
 * (bug: "weapons shouldn't have mirv or eccm until 2 layers deeper"). */
const MOD_FIELD_DEPTH: Record<string, number> = { mv: 2, eccm: 2, pd: 1 };

export function modUnlocked(empire: Empire, weaponId: string, mod: string): boolean {
  const need = MOD_FIELD_DEPTH[mod] ?? 0;
  if (need === 0) return true;
  const app = appForWeapon(weaponId);
  if (!app) return true; // table-less starter weapons carry no gate
  const field = fieldById.get(app.fieldId);
  if (!field) return true;
  const subject = FIELD_SUBJECTS[field.id];
  const ladder = FIELD_ROWS.filter((f) => FIELD_SUBJECTS[f.id] === subject && !f.id.startsWith('advf_')).sort(
    (a, b) => a.cost - b.cost || a.num - b.num,
  );
  const idx = ladder.findIndex((f) => f.num === field.num);
  if (idx < 0) return true;
  const deeper = ladder.slice(idx + need);
  // top-of-tree weapons: mastering the final field of the subject qualifies
  if (deeper.length === 0) return empire.completedFields.includes(ladder[ladder.length - 1]!.num);
  return deeper.some((f) => empire.completedFields.includes(f.num));
}

export function fitWeapon(empire: Empire, dw: DesignWeapon): FittedWeapon | string {
  const row = weaponById.get(dw.weapon);
  if (!row) return `unknown weapon ${dw.weapon}`;
  for (const m of dw.mods) {
    if (!(m in MOD_SPACE_PCT)) return `unknown mod ${m}`;
    if (!row.availableMods.includes(m)) return `${dw.weapon} cannot take ${m}`;
    if (!modUnlocked(empire, dw.weapon, m)) {
      return `${m} on ${dw.weapon} needs deeper research in its field (${m === 'pd' ? 'one' : 'two'} level${m === 'pd' ? '' : 's'} beyond the weapon)`;
    }
  }
  if (!Number.isSafeInteger(dw.count) || dw.count < 1 || dw.count > 200) return 'bad weapon count';
  let arc = dw.arc ?? 'F';
  if (!(arc in ARC_SPACE_PCT)) return `unknown arc ${arc}`;
  // point-defense-class weapons (anti-missile rocket &co) track all around in
  // combat regardless of mount, so they ARE 360 — shown as such and never
  // charged the wide-arc mount premium (combat.ts: "point defense is always 360")
  if (row.classId === 5) arc = '360';
  const mini = miniaturizationPct(empire, dw.weapon);
  let spacePct = row.classId === 5 ? ARC_SPACE_PCT['F'] : ARC_SPACE_PCT[arc];
  let costPct = spacePct;
  for (const m of dw.mods) {
    spacePct += MOD_SPACE_PCT[m]!;
    costPct += MOD_SPACE_PCT[m]!;
  }
  // missiles have listed size 0 in the source table; give them a real footprint
  const baseSpace = row.space > 0 ? row.space : 5;
  const baseCost = row.cost > 0 ? row.cost : 5;
  return {
    row,
    count: dw.count,
    mods: dw.mods,
    arc,
    spaceEach: Math.max(1, roundDiv(baseSpace * spacePct * mini, 100 * 100)),
    costEach: Math.max(1, roundDiv(baseCost * costPct * mini, 100 * 100)),
  };
}

// ---------- design validation + stats ----------

export interface DesignStats {
  hull: HullRow;
  spaceUsed: number;
  spaceTotal: number;
  cost: number;
  cpUsage: number;
  beamAttack: number;
  beamDefense: number;
  combatSpeed: number;
  armorHp: number;
  structureHp: number;
  shieldPool: number;
  shieldFlat: number;
  weapons: FittedWeapon[];
}

/** Hull availability (C7): frigate/destroyer always; cruiser needs capsule
 * construction (field 21); battleship astro construction (field 19); titan and
 * doomstar need their construction applications. */
export function availableHulls(empire: Empire): string[] {
  const out = ['frigate', 'destroyer'];
  if (empire.completedFields.includes(21)) out.push('cruiser');
  if (empire.completedFields.includes(19)) out.push('battleship');
  if (empire.knownApps.includes('titan_construction')) out.push('titan');
  if (empire.knownApps.includes('doom_star_construction')) out.push('doomstar');
  return out;
}

export function designStats(state: GameState, empire: Empire, design: Omit<ShipDesign, 'id' | 'obsolete'>): DesignStats | string {
  const hull = hullById.get(design.hull);
  if (!hull) return `unknown hull ${design.hull}`;
  const hullIdx = HULLS_BUILDABLE.indexOf(design.hull as never) + 1 || BASE_HULLS.indexOf(design.hull as never) + 4;
  const traits = resolveTraits(empire.picks);
  const isBaseHull = (BASE_HULLS as readonly string[]).includes(design.hull);
  if (!isBaseHull && !availableHulls(empire).includes(design.hull)) {
    return `${design.hull} hull not yet available`;
  }

  let spaceTotal = hull.space;
  if (design.specials.includes('battle_pods')) spaceTotal = roundDiv(spaceTotal * 150, 100);
  if (empire.knownApps.includes('megafluxers')) spaceTotal = roundDiv(spaceTotal * 125, 100);

  let spaceUsed = 0;
  let cost = hull.cost;

  // computer/shield arrive as raw network JSON: a fractional value corrupts
  // canonical hashing (soft-locks the game) and a negative one indexes the
  // shield tables to undefined -> NaN damage math
  if (!Number.isSafeInteger(design.computer) || design.computer < 0 || design.computer > 5) return 'bad computer tier';
  if (!Number.isSafeInteger(design.shield) || design.shield < 0 || design.shield > 5) return 'bad shield tier';

  if (design.computer > 0) {
    if (design.computer > bestComputer(empire)) return 'computer tier not researched';
    spaceUsed += Math.max(1, floorDiv(hull.space * 5, 100));
    cost += design.computer * Math.max(2, floorDiv(hull.cost * 5, 100));
  }
  if (design.shield > 0) {
    if (design.shield > bestShield(empire)) return 'shield tier not researched';
    spaceUsed += Math.max(1, floorDiv(hull.space * 15, 100));
    cost += design.shield * Math.max(2, floorDiv(hull.cost * 8, 100));
  }
  for (const sp of design.specials) {
    if (!(sp in SPECIALS)) return `unsupported special ${sp}`;
    if (!empire.knownApps.includes(sp)) return `${sp} not researched`;
    spaceUsed += floorDiv(hull.space * SPECIALS[sp]!, 100);
    cost += Math.max(2, floorDiv(hull.cost * 5, 100));
  }

  const weapons: FittedWeapon[] = [];
  for (const dw of design.weapons) {
    const fitted = fitWeapon(empire, dw);
    if (typeof fitted === 'string') return fitted;
    if (fitted.row.classId === 3 || fitted.row.classId === 5) {
      // bombs OK; monster-only specials (tech 0) are not player-designable
      if (fitted.row.techId === 0) return `${dw.weapon} is not designable`;
    }
    // classId 5 specials without a combat implementation must not silently
    // charge space for a gun that never fires (damage-dealers fire like
    // beams; anti-missile rockets intercept)
    if (fitted.row.classId === 5 && fitted.row.tacticalDamage.max <= 0 && fitted.row.id !== 'anti_missile_rocket') {
      return `${dw.weapon} is not implemented yet`;
    }
    weapons.push(fitted);
    spaceUsed += fitted.spaceEach * fitted.count;
    cost += fitted.costEach * fitted.count;
  }

  if (spaceUsed > spaceTotal) return `over space: ${spaceUsed}/${spaceTotal}`;

  // feudal shipyards build warships at 2/3 cost (racepicks.md); confederation
  // (the advanced feudal government) drops that to 1/3
  if (traits.government === 'feudal') {
    cost = Math.max(1, roundDiv(cost * (hasAdvancedGov(empire) ? 1 : 2), 3));
  }

  const armorTier = bestArmor(empire);
  const driveTier = bestDrive(empire);
  const armorMult = ARMOR_MULT[armorTier - 1] ?? 1;
  let combatSpeed = hull.driveHp === 0 ? 0 : 3 + driveTier + (traits.transDimensional ? 4 : 0);
  if (combatSpeed > 0 && design.specials.includes('augmented_engines')) combatSpeed += 5;
  if (combatSpeed > 0 && design.specials.includes('inertia_nullifier')) combatSpeed += 4;
  const structMult = design.specials.includes('reinforced_hull') ? 3 : 1;
  const armorSpecialMult = design.specials.includes('heavy_armor') ? 3 : 1;

  const beamAttack =
    design.computer * 25 + (design.specials.includes('battle_scanner') ? 50 : 0) + traits.shipAttackPct;
  // half the hull's defense column keeps to-hit in a playable 20-60% window
  const beamDefense =
    floorDiv(hull.strategic.defBonus, 2) +
    combatSpeed * 2 +
    (design.specials.includes('inertial_stabilizer') ? 25 : 0) +
    traits.shipDefensePct;

  const SHIELD_POOL = [0, 5, 15, 25, 35, 50];
  const SHIELD_FLAT = [0, 1, 3, 5, 7, 10];
  let shieldPool = SHIELD_POOL[design.shield]! * Math.max(1, hullIdx);
  if (design.specials.includes('multi_phased_shields')) shieldPool = roundDiv(shieldPool * 150, 100);
  let shieldFlat = SHIELD_FLAT[design.shield]!;
  if (design.specials.includes('hard_shields')) shieldFlat += 3;

  return {
    hull,
    spaceUsed,
    spaceTotal,
    cost,
    cpUsage: CP_USAGE[design.hull] ?? 0,
    beamAttack,
    beamDefense,
    combatSpeed,
    armorHp: hull.armorHp * armorMult * armorSpecialMult,
    structureHp: hull.structureHp * armorMult * structMult,
    shieldPool,
    shieldFlat,
    weapons,
  };
}

/** Deterministic best-known fit for a hull: best computer and shield tier
 * plus the best beam/missile mix the space takes (armor and drive already
 * auto-equip, C1).
 *
 * Space-aware: the best-damage weapon is only worth mounting in numbers that
 * FIT the hull — 6 death rays on a star base (1610/400 space) made
 * designStats error out and the whole platform silently vanish from every
 * defense battle the moment the Guardian's prize was claimed. Counts shrink
 * until the design fits; a weapon that cannot fit even once falls through to
 * the next-best. An empire with no researched weapons (pre-warp) still
 * mounts the starter-kit laser (scouts and the Patrol Frigate already get it
 * knowledge-free). */
function autoFitDesign(state: GameState, empire: Empire, hullId: string, name: string): Omit<ShipDesign, 'id' | 'obsolete'> {
  const beams = knownWeapons(empire)
    .filter((w) => w.classId === 0 && w.techId !== 0)
    .sort((a, b) => b.tacticalDamage.max - a.tacticalDamage.max);
  const missiles = knownWeapons(empire)
    .filter((w) => w.classId === 1)
    .sort((a, b) => b.tacticalDamage.max - a.tacticalDamage.max);
  const hull = hullById.get(hullId)!;
  const base = {
    name,
    hull: hullId,
    computer: bestComputer(empire),
    shield: bestShield(empire),
    specials: [] as string[],
  };
  const fits = (weapons: DesignWeapon[]): boolean =>
    typeof designStats(state, empire, { ...base, weapons }) !== 'string';
  const weapons: DesignWeapon[] = [];
  /** mount as many of the best-fitting candidate as the remaining space takes
   * (want 0 = this hull class carries none of the category, e.g. frigates
   * and destroyers have no missile racks) */
  const mount = (candidates: WeaponRow[], want: number): void => {
    if (want <= 0) return;
    for (const row of candidates) {
      for (let count = Math.max(1, want); count >= 1; count--) {
        const attempt = [...weapons, { weapon: row.id, count, mods: [] }];
        if (fits(attempt)) {
          weapons.push({ weapon: row.id, count, mods: [] });
          return;
        }
      }
    }
  };
  mount(beams, hull.strategic.beam * 2);
  mount(missiles, hull.strategic.missile * 2);
  if (weapons.length === 0) {
    // empty arsenal (pre-warp): the knowledge-free starter laser instead of
    // an unarmed hull that cannot participate in battles
    const laser = weaponById.get('laser_cannon');
    if (laser) mount([laser], hull.strategic.beam * 2);
  }
  return { ...base, weapons };
}

/** Deterministic auto-design for defensive bases (star_base etc.). */
export function baseDesign(state: GameState, empire: Empire, baseHull: string): Omit<ShipDesign, 'id' | 'obsolete'> {
  return autoFitDesign(state, empire, baseHull, baseHull);
}

/** Display names for the engine-maintained default design of each hull class
 * (the frigate keeps its classic starter name). */
export const DEFAULT_DESIGN_NAMES: Record<string, string> = {
  frigate: 'Patrol Frigate',
  destroyer: 'Destroyer',
  cruiser: 'Cruiser',
  battleship: 'Battleship',
  titan: 'Titan',
  doomstar: 'Doom Star',
};

/** The engine-maintained default design for a mobile hull class: the best
 * known computer, shield and beam/missile mix. Recomputed by the pipeline
 * whenever research (or espionage/trade) improves the fit. */
export function defaultDesign(state: GameState, empire: Empire, hullId: string): Omit<ShipDesign, 'id' | 'obsolete'> {
  return autoFitDesign(state, empire, hullId, DEFAULT_DESIGN_NAMES[hullId] ?? hullId);
}

/** Canonical fingerprint of what a design is FITTED with (id/name/model are
 * ignored) — the refresh step replaces an auto design only when this changes. */
export function designLoadoutKey(d: Pick<ShipDesign, 'hull' | 'computer' | 'shield' | 'specials' | 'weapons'>): string {
  return JSON.stringify([
    d.hull,
    d.computer,
    d.shield,
    [...d.specials].sort(),
    d.weapons.map((w) => [w.weapon, w.count, [...w.mods].sort(), w.arc ?? 'F']),
  ]);
}
