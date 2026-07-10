// Hand-off from a live game to the Battle Lab: "test the ship types I have
// built or encountered". Set by the Empires tab (all designs) or the Designer
// (the work-in-progress design), consumed once by BattleLab.

import { ARMOR_MULT, HULLS_BUILDABLE, type BattleInput } from '@engine/index';
import { hullById, weaponById } from '@engine/data/index';

export interface LabSeedGroup {
  label: string;
  hull: string;
  computer: number;
  shield: number;
  /** armor tier 1..6 (inferred from observed hull points for enemies) */
  armor?: number;
  specials: string[];
  weapons: Array<{ weapon: string; count: number; mods: string[]; arc: 'F' | 'FX' | 'R' | '360' }>;
  count: number;
}

let pending: { a: LabSeedGroup[]; d: LabSeedGroup[] } | null = null;

export function setLabSeed(a: LabSeedGroup[], d: LabSeedGroup[]): void {
  pending = { a, d };
}

export function takeLabSeed(): { a: LabSeedGroup[]; d: LabSeedGroup[] } | null {
  const out = pending;
  pending = null;
  return out;
}

const SHIELD_FLAT_TIERS = [0, 1, 3, 5, 7, 10];

/** Enemy ship types seen across the battles we hold replays for, deduped,
 * with approximated computer/shield tiers (they are not directly observable). */
export function enemySeedsFromReplays(
  replays: Array<{ input: unknown }>,
  selfId: number,
): LabSeedGroup[] {
  const seen = new Map<string, LabSeedGroup>();
  for (const r of replays) {
    const input = r.input as BattleInput;
    const mySide = input.attacker === selfId ? 0 : input.defender === selfId ? 1 : -1;
    for (const s of input.ships) {
      if (s.side === mySide || s.isBase) continue;
      if (!(HULLS_BUILDABLE as readonly string[]).includes(s.hull)) continue; // monsters stay wild
      const weapons = s.weapons
        .filter((w) => w.classId <= 2 && weaponById.has(w.weaponId))
        .map((w) => ({
          weapon: w.weaponId,
          count: w.count,
          mods: [...w.mods],
          arc: (w.arc ?? 'F') as LabSeedGroup['weapons'][number]['arc'],
        }));
      const key = JSON.stringify([s.hull, weapons, s.specials ?? []]);
      const existing = seen.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      // read the armor class off the observed hull points (heavy_armor ×3)
      const hullRow = hullById.get(s.hull);
      const heavy = (s.specials ?? []).includes('heavy_armor') ? 3 : 1;
      const observedMult = hullRow && hullRow.armorHp > 0 ? s.armorHp / (hullRow.armorHp * heavy) : 1;
      let armor = 1;
      for (let t = 0; t < ARMOR_MULT.length; t++) {
        if (Math.abs(ARMOR_MULT[t]! - observedMult) < Math.abs(ARMOR_MULT[armor - 1]! - observedMult)) armor = t + 1;
      }
      seen.set(key, {
        label: `encountered ${s.hull}`,
        hull: s.hull,
        computer: Math.max(0, Math.min(6, Math.round(s.beamAttack / 25))),
        shield: Math.max(0, SHIELD_FLAT_TIERS.findIndex((f) => f >= s.shieldFlat)),
        armor,
        specials: [...(s.specials ?? [])],
        weapons,
        count: 1,
      });
    }
  }
  return [...seen.values()];
}
