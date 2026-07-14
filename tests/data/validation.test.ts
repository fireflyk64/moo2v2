import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  APPLICATION_ROWS,
  BUILDABLE_ROWS,
  CP_SOURCES,
  CP_USAGE,
  DATA_VERSION,
  FIELD_ROWS,
  FIELD_SUBJECTS,
  HULL_ROWS,
  PICK_ROWS,
  RACE_PRESETS,
  SUBJECTS,
  TECH_ROWS,
  WEAPON_MOD_ROWS,
  WEAPON_ROWS,
  applicationById,
  applicationsOfField,
  buildableById,
  fieldById,
  fieldByNum,
  hullById,
  pickById,
  startingFieldNums,
  techById,
  validatePicks,
  weaponById,
} from '@engine/data/index';

describe('generated data is current', () => {
  it('matches a fresh run of scripts/gen-data.mjs', () => {
    execFileSync('node', ['scripts/gen-data.mjs', '--check'], { cwd: process.cwd() });
  });
});

describe('table counts (vs mechanics docs)', () => {
  it('has the documented row counts', () => {
    expect(PICK_ROWS.length).toBe(54);
    expect(FIELD_ROWS.length).toBe(82);
    expect(TECH_ROWS.length).toBe(173);
    expect(HULL_ROWS.length).toBe(9);
    expect(WEAPON_ROWS.length).toBe(45);
    expect(WEAPON_MOD_ROWS.length).toBe(14);
    expect(APPLICATION_ROWS.length).toBe(191);
    expect(BUILDABLE_ROWS.length).toBe(70);
  });
});

describe('spot-check golden values from mechanics docs', () => {
  it('picks', () => {
    expect(pickById.get('creative')!.cost).toBe(8);
    expect(pickById.get('uncreative')!.cost).toBe(-4);
    expect(pickById.get('lithovore')!.cost).toBe(10);
    expect(pickById.get('repulsive')!.cost).toBe(-6);
    expect(pickById.get('growth3')!.value).toBe(100);
    expect(pickById.get('money2')!.cost).toBe(5); // canonical §02 value (racepicks.md has a typo)
    expect(pickById.get('defense2')!.cost).toBe(3);
  });

  it('fields', () => {
    expect(fieldById.get('interphased_fission')!.cost).toBe(10000);
    expect(fieldById.get('chemistry')!.cost).toBe(50);
    expect(fieldById.get('advf_ecology')!.cost).toBe(25000);
    expect(fieldById.get('xenon_technology')!.tier).toBe(22);
  });

  it('hulls', () => {
    const cruiser = hullById.get('cruiser')!;
    expect(cruiser.cost).toBe(250);
    expect(cruiser.space).toBe(120);
    expect(hullById.get('doomstar')!.space).toBe(1200);
    expect(hullById.get('star_fortress')!.strategic.hits).toBe(500);
  });

  it('weapons', () => {
    const laser = weaponById.get('laser_cannon')!;
    expect(laser.tacticalDamage).toEqual({ min: 1, max: 4 });
    expect(laser.ammo).toBe(-1);
    expect(weaponById.get('stellar_converter')!.tacticalDamage.min).toBe(400);
    expect(weaponById.get('nuclear_missile')!.ammo).toBe(5);
  });

  it('buildables', () => {
    expect(buildableById.get('automated_factory')!.cost).toBe(60);
    expect(buildableById.get('star_fortress')!.cost).toBe(2500);
    expect(buildableById.get('core_waste_dump')!.maintenance).toBe(8);
    expect(buildableById.get('housing')!.cost).toBe(0);
  });

  it('command points', () => {
    expect(CP_SOURCES['colony']).toBe(1);
    expect(CP_SOURCES['star_fortress']).toBe(6);
    expect(CP_USAGE['doomstar']).toBe(12);
  });
});

describe('referential integrity', () => {
  it('field linked-list: previous/next resolve; every field has a subject', () => {
    for (const f of FIELD_ROWS) {
      if (f.previous !== 0) expect(fieldByNum.get(f.previous), `prev of ${f.id}`).toBeDefined();
      if (f.next !== 0) expect(fieldByNum.get(f.next), `next of ${f.id}`).toBeDefined();
      expect(FIELD_SUBJECTS[f.id], `subject of ${f.id}`).toBeDefined();
    }
  });

  it('subject chains cover all fields exactly once', () => {
    const counts = new Map<string, number>();
    for (const f of FIELD_ROWS) {
      const s = FIELD_SUBJECTS[f.id]!;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(FIELD_ROWS.length);
    for (const s of SUBJECTS) expect(counts.get(s) ?? 0).toBeGreaterThan(0);
    expect(counts.get('special')).toBe(1); // xenon_technology
  });

  it('applications reference existing fields; researchable fields have 1-4 applications', () => {
    for (const a of APPLICATION_ROWS) {
      expect(fieldById.has(a.fieldId), `field of application ${a.id}: ${a.fieldId}`).toBe(true);
    }
    for (const f of FIELD_ROWS) {
      if (FIELD_SUBJECTS[f.id] === 'special') continue;
      if (f.id.startsWith('advf_')) continue; // hyper-advanced: synthetic apps later
      const apps = applicationsOfField(f.id);
      expect(apps.length, `applications in ${f.id}`).toBeGreaterThanOrEqual(1);
      expect(apps.length, `applications in ${f.id}`).toBeLessThanOrEqual(4);
    }
  });

  it('techIds are unique where present (post fix-up)', () => {
    const seen = new Map<number, string>();
    for (const t of TECH_ROWS) {
      if (t.techId === 0) continue;
      expect(seen.has(t.techId), `techId ${t.techId} reused by ${t.id} and ${seen.get(t.techId)}`).toBe(false);
      seen.set(t.techId, t.id);
    }
    expect(techById.get('battleoids')!.techId).toBe(224); // documented fix-up
    expect(techById.get('battle_scanner')!.techId).toBe(24);
    expect(techById.get('anti_matter_bomb')!.techId).toBe(225); // documented fix-up
    expect(techById.get('android_scientists')!.techId).toBe(10);
  });

  it('starting fields resolve', () => {
    for (const mode of ['pre_warp', 'average'] as const) {
      for (const num of startingFieldNums(mode)) {
        expect(fieldByNum.get(num), `starting field ${num}`).toBeDefined();
      }
    }
    expect(startingFieldNums('pre_warp').length).toBe(5);
    expect(startingFieldNums('average').length).toBe(8);
  });

  it('weapon mod flags in weapon rows resolve to mod ids', () => {
    const validFlags = new Set(['hv', 'pd', 'ap', 'co', 'nr', 'sp', 'af', 'env', 'mv', 'eccm', 'arm', 'fst', 'emg', 'ovr']);
    for (const w of WEAPON_ROWS) {
      for (const f of w.availableMods) {
        expect(validFlags.has(f), `weapon ${w.id} mod flag ${f}`).toBe(true);
      }
    }
  });
});

describe('race presets', () => {
  it('all 13 presets validate under the pick rules', () => {
    expect(RACE_PRESETS.length).toBe(13);
    for (const preset of RACE_PRESETS) {
      const res = validatePicks(preset.picks);
      expect(res.errors, `${preset.id}: ${res.errors.join('; ')}`).toEqual([]);
    }
  });

  it('pick validation rejects bad sets', () => {
    expect(validatePicks(['creative', 'uncreative', 'dictatorship']).ok).toBe(false);
    expect(validatePicks(['creative']).ok).toBe(false); // no government
    expect(validatePicks(['creative', 'lithovore', 'tolerant', 'dictatorship']).ok).toBe(false); // 28 > 10
    expect(validatePicks(['creative', 'dictatorship', 'repulsive', 'poor_hw']).ok).toBe(true); // 8-7=1
  });
});

describe('DATA_VERSION', () => {
  it('is a stable 16-hex fingerprint', () => {
    expect(DATA_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });
});
