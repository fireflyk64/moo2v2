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
  applicationById,
  fieldById,
  FIELD_SUBJECTS,
  hullById,
  weaponById,
  CP_USAGE,
  type HullRow,
  type WeaponRow,
} from './data/index';
import { floorDiv, roundDiv } from './imath';
import { resolveTraits } from './race';
import type { Empire, GameState } from './types';

export const HULLS_BUILDABLE = ['frigate', 'destroyer', 'cruiser', 'battleship', 'titan', 'doomstar'] as const;
export const BASE_HULLS = ['star_base', 'battlestation', 'star_fortress'] as const;

export interface DesignWeapon {
  weapon: string;
  count: number;
  mods: string[]; // flag keys: hv pd ap co sp af nr ...
}

export interface ShipDesign {
  id: number;
  name: string;
  hull: string;
  computer: number; // tier 0-5
  shield: number; // tier 0-5 (I III V VII X)
  specials: string[];
  weapons: DesignWeapon[];
  obsolete: boolean;
}

// ---------- tech tiers available to an empire ----------

const COMPUTER_APPS = ['electronic_computer', 'optronic_computer', 'positronic_computer', 'cybertronic_computer', 'moleculartronic_computer'];
const SHIELD_APPS = ['class_i_shield', 'class_iii_shield', 'class_v_shield', 'class_vii_shield', 'class_x_shield'];
const ARMOR_APPS = ['titanium_armor', 'tritanium_armor', 'zortrium_armor', 'neutronium_armor', 'adamantium_armor', 'xentronium_armor'];
const DRIVE_APPS = ['nuclear_drive', 'fusion_drive', 'ion_drive', 'anti_matter_drive', 'hyper_drive', 'interphased_drive'];
const ARMOR_MULT = [1, 2, 5, 6, 8, 10];

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

function bestTier(empire: Empire, apps: string[], alwaysFirst = false): number {
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

export function knownWeapons(empire: Empire): WeaponRow[] {
  const out: WeaponRow[] = [];
  for (const w of weaponById.values()) {
    // weapon rows join to applications by id (aliases already normalized)
    if (empire.knownApps.includes(w.id) || empire.knownApps.includes(w.id + 's')) out.push(w);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- miniaturization (C5) ----------

export function miniaturizationPct(empire: Empire, weaponId: string): number {
  const app = applicationById.get(weaponId) ?? applicationById.get(weaponId + 's');
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

export function fitWeapon(empire: Empire, dw: DesignWeapon): FittedWeapon | string {
  const row = weaponById.get(dw.weapon);
  if (!row) return `unknown weapon ${dw.weapon}`;
  for (const m of dw.mods) {
    if (!(m in MOD_SPACE_PCT)) return `unknown mod ${m}`;
    if (!row.availableMods.includes(m)) return `${dw.weapon} cannot take ${m}`;
  }
  if (!Number.isSafeInteger(dw.count) || dw.count < 1 || dw.count > 200) return 'bad weapon count';
  const mini = miniaturizationPct(empire, dw.weapon);
  let spacePct = 100;
  let costPct = 100;
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
    weapons.push(fitted);
    spaceUsed += fitted.spaceEach * fitted.count;
    cost += fitted.costEach * fitted.count;
  }

  if (spaceUsed > spaceTotal) return `over space: ${spaceUsed}/${spaceTotal}`;

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

/** Deterministic auto-design for defensive bases (star_base etc.). */
export function baseDesign(state: GameState, empire: Empire, baseHull: string): Omit<ShipDesign, 'id' | 'obsolete'> {
  const beams = knownWeapons(empire).filter((w) => w.classId === 0 && w.techId !== 0);
  const missiles = knownWeapons(empire).filter((w) => w.classId === 1);
  const hull = hullById.get(baseHull)!;
  const best = beams.sort((a, b) => b.tacticalDamage.max - a.tacticalDamage.max)[0];
  const bestMissile = missiles.sort((a, b) => b.tacticalDamage.max - a.tacticalDamage.max)[0];
  const weapons: DesignWeapon[] = [];
  if (best) weapons.push({ weapon: best.id, count: hull.strategic.beam * 2, mods: [] });
  if (bestMissile) weapons.push({ weapon: bestMissile.id, count: hull.strategic.missile * 2, mods: [] });
  return {
    name: baseHull,
    hull: baseHull,
    computer: bestComputer(empire),
    shield: bestShield(empire),
    specials: [],
    weapons,
  };
}
