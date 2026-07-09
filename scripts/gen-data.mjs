#!/usr/bin/env node
// Generates src/engine/data/generated.ts from the mechanics/ markdown tables.
// Extracts numeric/structural parameter data (ids, costs, stats). Run:
//   node scripts/gen-data.mjs        # regenerate
//   node scripts/gen-data.mjs --check # verify committed output is up to date
//
// Documented data fix-ups (see src/engine/data/README.md) are applied here so
// regeneration is reproducible.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const mech = (p) => readFileSync(join(root, 'mechanics', p), 'utf8');
const OUT = join(root, 'src/engine/data/generated.ts');

// ---------- markdown table parsing ----------

/** Parse all pipe tables in a markdown text: [{header: string[], rows: string[][]}] */
function parseTables(text) {
  const lines = text.split('\n');
  const tables = [];
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('|') && t.endsWith('|')) {
      const cells = t
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
      if (!cur) {
        cur = { header: cells, rows: [] };
        tables.push(cur);
      } else {
        cur.rows.push(cells);
      }
    } else {
      cur = null;
    }
  }
  return tables;
}

function findTable(tables, firstHeaderCells) {
  const found = tables.find((t) =>
    firstHeaderCells.every((h, i) => (t.header[i] ?? '').toLowerCase() === h.toLowerCase()),
  );
  if (!found) throw new Error(`table not found: ${firstHeaderCells.join(' | ')}`);
  return found;
}

const num = (s) => {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new Error(`expected integer, got ${JSON.stringify(s)}`);
  return n;
};

const snake = (s) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

// ---------- load sources ----------

const gm = mech('game_mechanics.md');
const gmTables = parseTables(gm);

// ---------- picks (§02) ----------

const picksTable = findTable(gmTables, ['Pick id', 'Cost']);
const picks = picksTable.rows.map(([id, cost, value, meaning]) => ({
  id,
  cost: num(cost),
  value: value === 'n/a' ? null : num(value),
  meaning,
}));

// ---------- buildables (§04) ----------

const buildTable = findTable(gmTables, ['id', 'tech_id', 'cost', 'maintenance', 'group']);
const buildables = buildTable.rows.map(([id, techId, cost, maintenance, group]) => ({
  id,
  techId: num(techId),
  cost: num(cost),
  maintenance: num(maintenance),
  group,
}));

// ---------- tech fields (§05) ----------

const fieldTable = findTable(gmTables, ['id', 'row', 'previous', 'next', 'cost', 'tier']);
const fields = fieldTable.rows.map(([id, row, previous, next, cost, tier]) => ({
  id,
  num: num(row),
  previous: num(previous),
  next: num(next),
  cost: num(cost),
  tier: num(tier),
}));

// Derive subject for each field by walking the next-chains from the known roots.
const SUBJECT_ROOTS = [
  ['construction', 'engineering'],
  ['power', 'nuclear_fission'],
  ['chemistry', 'chemistry'],
  ['sociology', 'military_tactics'],
  ['computers', 'electronics'],
  ['ecology', 'astro_ecology'],
  ['physics', 'physics'],
  ['force_fields', 'advanced_magnetism'],
];
const byNum = new Map(fields.map((f) => [f.num, f]));
const subjectOf = new Map();
for (const [subject, rootId] of SUBJECT_ROOTS) {
  let f = fields.find((x) => x.id === rootId);
  if (!f) throw new Error(`missing root field ${rootId}`);
  while (f) {
    if (subjectOf.has(f.id)) throw new Error(`field ${f.id} reached twice`);
    subjectOf.set(f.id, subject);
    f = f.next === 0 || f.next === f.num ? null : byNum.get(f.next);
  }
}
for (const f of fields) {
  if (!subjectOf.has(f.id)) {
    if (f.id === 'xenon_technology') subjectOf.set(f.id, 'special'); // Orion/Antaran items
    else throw new Error(`field ${f.id} not reachable from any subject root`);
  }
}

// ---------- techs (§05) ----------

const techTable = findTable(gmTables, ['id', 'tech_id', 'field_id', 'ai_group', 'strategic']);
let techs = techTable.rows.map(([id, techId, fieldNum, aiGroup, strategic]) => ({
  id,
  techId: num(techId),
  fieldNum: num(fieldNum),
  aiGroup: num(aiGroup),
  strategic: num(strategic) === 1,
}));

// FIX(data): the source table assigns tech_id 24 to BOTH battle_scanner and
// battleoids. battle_scanner keeps 24; battleoids gets synthetic id 224.
techs = techs.map((t) => (t.id === 'battleoids' ? { ...t, techId: 224 } : t));
// FIX(data): tech_id 10 is assigned to BOTH android_scientists (part of the
// consecutive 9/10/11 android trio) and anti_matter_bomb; the bomb moves to 225.
techs = techs.map((t) => (t.id === 'anti_matter_bomb' ? { ...t, techId: 225 } : t));
// FIX(data): rows with tech_id 0 (spacetime_surfing + monster weapons) are
// placeholders in the source; keep 0 and treat as "no public number".

// ---------- hulls (§06) ----------

const hullTable = findTable(gmTables, ['hull', 'cost', 'size', 'marines']);
const hulls = hullTable.rows.map((r) => ({
  id: r[0],
  cost: num(r[1]),
  space: num(r[2]),
  marines: num(r[3]),
  armorHp: num(r[4]),
  structureHp: num(r[5]),
  computerHp: num(r[6]),
  driveHp: num(r[7]),
  shieldHp: num(r[8]),
  strategic: {
    beam: num(r[9]),
    missile: num(r[10]),
    special: num(r[11]),
    bomb: num(r[12]),
    defBonus: num(r[13]),
    hits: num(r[14]),
  },
}));

// ---------- weapons + mods (§06) ----------

const weaponTable = findTable(gmTables, ['id', 'tech_id', 'class_id', 'ammo']);
const parseDamage = (s) => {
  const m = /^(-?\d+)-(-?\d+)$/.exec(s);
  if (!m) throw new Error(`bad damage ${s}`);
  return { min: num(m[1]), max: num(m[2]) };
};
const parseFlags = (s) => (s === 'none' ? [] : s.split(',').map((x) => x.trim()));
const weapons = weaponTable.rows.map((r) => ({
  id: r[0],
  techId: num(r[1]),
  classId: num(r[2]),
  ammo: num(r[3]),
  space: num(r[4]),
  cost: num(r[5]),
  naturalMods: parseFlags(r[6]),
  tacticalDamage: parseDamage(r[7]),
  strategicDamage: parseDamage(r[8]),
  availableMods: parseFlags(r[9]),
}));

const modTable = findTable(gmTables, ['mod', 'mod_id']);
const weaponMods = modTable.rows.map((r) => ({
  id: r[0],
  modId: num(r[1]),
  miniaturizationLevel: num(r[2]),
  spacePercent: num(r[3]),
  costPercent: num(r[4]),
  damageMultiplier: num(r[5]),
}));

const flagTable = findTable(gmTables, ['Flag', 'Suggested key']);
const modFlagKeys = Object.fromEntries(flagTable.rows.map(([flag, key]) => [flag, key]));

// ---------- misc constants (§01/§02/§04) ----------

const cpSourcesTable = findTable(gmTables, ['Source', 'Command points']);
const cpUsageTable = findTable(gmTables, ['Hull', 'CP usage']);
const scanTable = findTable(gmTables, ['Source', 'Scan bonus']);
const stealthTable = findTable(gmTables, ['Source', 'Stealth bonus']);
const kv = (t) => Object.fromEntries(t.rows.map(([k, v]) => [snake(k), num(v)]));

const budgetTable = findTable(gmTables, ['Parameter', 'Classic value']);
const budget = kv(budgetTable);

const landerTable = findTable(gmTables, ['Buildable', 'Cost']);
const miscCostTable = findTable(gmTables, ['Item', 'Cost']);

// ---------- starting fields (§05) ----------

const startTable = findTable(gmTables, ['Start mode', 'Known field ids']);
const startingFields = Object.fromEntries(
  startTable.rows.map(([mode, ids]) => [snake(mode), ids.split(',').map((s) => num(s.trim()))]),
);

// ---------- applications (tech/technology_effects.md) ----------

const fx = mech('tech/technology_effects.md');
const fxTables = parseTables(fx);
const fxTable = findTable(fxTables, ['Field', 'Tier (cost)', 'Item', 'Effect']);

// Field display name -> field id (strip "(General)/(Avg)/(Adv)" markers and costs).
const FIELD_ALIASES = {
  multi_dimensiomal_physics: 'multi_dimensional_physics', // typo in source md
  advanced_government: 'advanced_governments',
};
// Application display name -> canonical id (tech-table/buildable id where snake() differs).
const APP_ALIASES = {
  merculite_missile: 'merculite_missiles',
  phasor: 'phasors',
  pulson_missile: 'pulson_missiles',
  plasma_torpedo: 'plasma_torpedoes',
  proton_torpedo: 'proton_torpedoes',
  research_laboratory: 'research_lab',
  anti_missile_rockets: 'anti_missile_rocket',
  automated_factories: 'automated_factory',
  robo_mining_plant: 'robominers',
  battle_station: 'battlestation',
  assault_shuttles: 'assault_shuttle',
  heavy_fighters: 'heavy_fighter_bays',
  warp_dissipator: 'warp_dissipater',
  warp_field_interdicter: 'warp_interdictor',
  subspace_teleporter: 'sub_space_teleporter',
  inertial_nullifier: 'inertia_nullifier',
  alien_control_center: 'alien_management_center',
  planetary_supercomputer: 'supercomputer',
  core_waste_dumps: 'core_waste_dump', // matches buildable id
  planetary_stock_exchange: 'stock_exchange', // matches tech row 173 + buildable id
  habitat_transformation: 'gaia_transformation', // terran->gaia project; tech row 211
};

const fieldById = new Map(fields.map((f) => [f.id, f]));
const techById = new Map(techs.map((t) => [t.id, t]));
const warnings = [];

// Fields whose docs heading carries the "(General)" tag grant EVERY application
// to any race on completion (the five tier-1 subject roots + Cold Fusion).
const generalFieldIds = new Set();

const applications = fxTable.rows.map(([subjectName, tierCell, itemCell, effect]) => {
  // tierCell e.g. "Advanced Ecology (Adv) (400 RP / 480 total)" or "Chemistry (General) (Avg) (50 RP)"
  const base = tierCell
    .replace(/\((?:General|Avg|Adv)\)/g, '')
    .replace(/\([^)]*RP[^)]*\)/g, '')
    .trim();
  const rpMatch = /\((\d[\d.]*)\s*RP/.exec(tierCell);
  const fieldRp = rpMatch ? Number(rpMatch[1].replace(/\./g, '')) : null;
  let fieldId = snake(base);
  if (FIELD_ALIASES[fieldId]) fieldId = FIELD_ALIASES[fieldId];
  const field = fieldById.get(fieldId);
  if (/\(General\)/.test(tierCell)) generalFieldIds.add(field ? field.id : fieldId);
  if (!field) warnings.push(`application field not found: "${base}" -> ${fieldId} (from ${tierCell})`);
  else if (fieldRp !== null && field.cost !== fieldRp)
    warnings.push(`field RP mismatch for ${fieldId}: table ${field.cost} vs effects ${fieldRp}`);

  const name = itemCell.replace(/\*\*/g, '').trim();
  let appId = snake(name);
  if (APP_ALIASES[appId]) appId = APP_ALIASES[appId];
  const tech = techById.get(appId);
  // Numeric public ids conflict across the source tables (e.g. 43 and 72 are each
  // claimed twice), so string ids are the canonical join key everywhere; techId is
  // reference metadata only. Fall back to the weapon table's number when the tech
  // table lacks the row (e.g. pulsar = 148).
  const weapon = weapons.find((w) => w.id === appId || w.id + 's' === appId);
  return {
    id: appId,
    name,
    subject: snake(subjectName),
    fieldId: field ? field.id : fieldId,
    techId: tech ? tech.techId : weapon && weapon.techId !== 0 ? weapon.techId : null,
    effectSummaryLen: effect.length, // prose lives in mechanics docs; engine keeps structure only
  };
});

// Cross-check: where an application also has a tech-table row, compare field
// placement (application rows are authoritative; disagreements are documented).
for (const a of applications) {
  const t = techById.get(a.id);
  if (t) {
    const f = byNum.get(t.fieldNum);
    if (f && f.id !== a.fieldId) {
      warnings.push(`field placement differs for ${a.id}: effects=${a.fieldId} tech_table=${f.id}`);
    }
  }
}

// Cross-check: tech-table entries whose field has applications listed but that
// never matched an application row (informational).
const appIds = new Set(applications.map((a) => a.id));
for (const t of techs) {
  if (!appIds.has(t.id)) warnings.push(`tech-table id has no matching application row: ${t.id}`);
}
if (process.argv.includes('--diff')) {
  console.log('--- applications with NO tech-table row:');
  for (const a of applications) {
    if (!techById.has(a.id)) console.log(`   ${a.id}  [${a.fieldId}]`);
  }
}

// attach the grant-all flag parsed from the effects-table headings
for (const f of fields) f.general = generalFieldIds.has(f.id);

// dedupe warnings
const uniqueWarnings = [...new Set(warnings)];

// ---------- emit ----------

const emit = (name, type, value) =>
  `export const ${name}: ${type} = ${JSON.stringify(value, null, 2)} as const;\n`;

const out = `// AUTO-GENERATED by scripts/gen-data.mjs from mechanics/*.md — DO NOT EDIT.
// Regenerate: node scripts/gen-data.mjs   Verify: node scripts/gen-data.mjs --check
// Data fix-ups applied during generation are documented in src/engine/data/README.md.

export interface PickRow { id: string; cost: number; value: number | null; meaning: string }
export interface BuildableRow { id: string; techId: number; cost: number; maintenance: number; group: string }
export interface FieldRow { id: string; num: number; previous: number; next: number; cost: number; tier: number; general: boolean }
export interface TechRow { id: string; techId: number; fieldNum: number; aiGroup: number; strategic: boolean }
export interface HullRow {
  id: string; cost: number; space: number; marines: number;
  armorHp: number; structureHp: number; computerHp: number; driveHp: number; shieldHp: number;
  strategic: { beam: number; missile: number; special: number; bomb: number; defBonus: number; hits: number };
}
export interface WeaponRow {
  id: string; techId: number; classId: number; ammo: number; space: number; cost: number;
  naturalMods: string[]; tacticalDamage: { min: number; max: number };
  strategicDamage: { min: number; max: number }; availableMods: string[];
}
export interface WeaponModRow {
  id: string; modId: number; miniaturizationLevel: number;
  spacePercent: number; costPercent: number; damageMultiplier: number;
}
export interface ApplicationRow {
  id: string; name: string; subject: string; fieldId: string; techId: number | null;
  effectSummaryLen: number;
}

${emit('PICK_ROWS', 'readonly PickRow[]', picks)}
${emit('BUILDABLE_ROWS', 'readonly BuildableRow[]', buildables)}
${emit('FIELD_ROWS', 'readonly FieldRow[]', fields)}
${emit('FIELD_SUBJECTS', 'Readonly<Record<string, string>>', Object.fromEntries(subjectOf))}
${emit('TECH_ROWS', 'readonly TechRow[]', techs)}
${emit('HULL_ROWS', 'readonly HullRow[]', hulls)}
${emit('WEAPON_ROWS', 'readonly WeaponRow[]', weapons)}
${emit('WEAPON_MOD_ROWS', 'readonly WeaponModRow[]', weaponMods)}
${emit('MOD_FLAG_KEYS', 'Readonly<Record<string, string>>', modFlagKeys)}
${emit('APPLICATION_ROWS', 'readonly ApplicationRow[]', applications)}
${emit('STARTING_FIELD_NUMS', 'Readonly<Record<string, readonly number[]>>', startingFields)}
${emit('PICK_BUDGET', 'Readonly<Record<string, number>>', budget)}
${emit('CP_SOURCES', 'Readonly<Record<string, number>>', kv(cpSourcesTable))}
${emit('CP_USAGE', 'Readonly<Record<string, number>>', kv(cpUsageTable))}
${emit('SCAN_BONUSES', 'Readonly<Record<string, number>>', kv(scanTable))}
${emit('STEALTH_BONUSES', 'Readonly<Record<string, number>>', kv(stealthTable))}
${emit('LANDER_COSTS', 'Readonly<Record<string, number>>', kv(landerTable))}
${emit('MISC_COSTS', 'Readonly<Record<string, number>>', kv(miscCostTable))}
`;

if (process.argv.includes('--check')) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== out) {
    console.error('generated.ts is out of date; run: node scripts/gen-data.mjs');
    process.exit(1);
  }
  console.log('generated.ts is up to date.');
} else {
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}`);
  console.log(
    `picks=${picks.length} buildables=${buildables.length} fields=${fields.length} techs=${techs.length} hulls=${hulls.length} weapons=${weapons.length} mods=${weaponMods.length} applications=${applications.length}`,
  );
}
if (uniqueWarnings.length) {
  console.log(`\n${uniqueWarnings.length} warnings:`);
  for (const w of uniqueWarnings) console.log('  - ' + w);
}
