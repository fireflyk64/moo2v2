// Research model: one active field at a time chosen from the next field of any
// subject; target application pre-selected (changeable until completion) so
// turn resolution never prompts. Creative rules:
//   vanilla creative        -> all applications of the field
//   uncreative              -> seeded-random application
//   creative-variant mode   -> creative races take the target only; remaining
//     applications become individually purchasable (each at the full field
//     cost, at most one completes per turn).
// Switching fields keeps accumulated RP (documented simplification).

import {
  APPLICATION_ROWS,
  applicationsOfField,
  fieldById,
  fieldByNum,
  FIELD_ROWS,
  FIELD_SUBJECTS,
  type FieldRow,
} from './data/index';
import { rngFor, type Rng } from './rng';
import { floorDiv } from './imath';
import { traitsOf } from './economy';
import type { Empire, GameState, TurnEvent } from './types';

/** "(General)" fields grant every application at once — the five tier-1
 * subject roots plus Cold Fusion (colony ship / outpost ship / transport /
 * freighters), exactly as the mechanics docs mark them. No target choice. */
export function fieldGrantsAll(field: FieldRow): boolean {
  return field.general;
}

/** Seeded per-game difficulty: every field's real cost is its base cost times a
 * multiplier in [100%, 200%], fixed by the game seed — identical for every
 * player (nobody gets "lucky" on a category), different between games.
 * Tier-1 basics stay at list price so the opening is predictable. */
export function fieldCostMultiplierPct(state: GameState, field: FieldRow): number {
  if (fieldGrantsAll(field) || field.id.startsWith('advf_')) return 100;
  return 100 + rngFor(state.seed, 'field_cost', field.num).int(101);
}

export function fieldCost(state: GameState, empire: Empire, field: FieldRow): number {
  const scaled = floorDiv(field.cost * fieldCostMultiplierPct(state, field), 100);
  if (field.id.startsWith('advf_')) {
    const level = empire.research.hyperLevels[field.id] ?? 0;
    return scaled + 10000 * level;
  }
  return scaled;
}

/** The next researchable field per subject (previous completed, not yet done). */
export function availableFields(empire: Empire): FieldRow[] {
  const done = new Set(empire.completedFields);
  const out: FieldRow[] = [];
  for (const f of FIELD_ROWS) {
    if (FIELD_SUBJECTS[f.id] === 'special') continue;
    if (done.has(f.num) && !f.id.startsWith('advf_')) continue;
    const prevOk = f.previous === 0 || done.has(f.previous);
    if (prevOk) out.push(f);
  }
  out.sort((a, b) => a.num - b.num);
  return out;
}

/** Buildings whose ONLY effect is colony morale (data/effectsMap.ts). A
 * Unification government is immune to morale swings (economy.ts), so these
 * applications are dead picks for it: they are dropped from its research
 * choices (target pick, uncreative roll, default grant). Creative grant-all
 * still includes them — no choice is being made there. */
const MORALE_ONLY_APPS = ['holo_simulator', 'pleasure_dome', 'virtual_reality_network'];

/** False when this application would be a dead research pick for the empire. */
export function appPickableBy(empire: Empire, appId: string): boolean {
  return !(empire.government === 'unification' && MORALE_ONLY_APPS.includes(appId));
}

export function grantApp(empire: Empire, appId: string): boolean {
  if (empire.knownApps.includes(appId)) return false;
  empire.knownApps.push(appId);
  empire.knownApps.sort();
  return true;
}

function completeField(
  state: GameState,
  empire: Empire,
  field: FieldRow,
  rng: Rng,
  events: TurnEvent[],
): void {
  const traits = traitsOf(empire);
  const apps = applicationsOfField(field.id);
  const granted: string[] = [];

  if (field.id.startsWith('advf_')) {
    empire.research.hyperLevels[field.id] = (empire.research.hyperLevels[field.id] ?? 0) + 1;
    const synthetic = `hyper_advanced_${FIELD_SUBJECTS[field.id] ?? 'unknown'}`;
    grantApp(empire, synthetic);
    granted.push(synthetic);
  } else {
    const unknown = apps.filter((a) => !empire.knownApps.includes(a.id));
    // choice paths skip dead picks (morale tech under Unification); when a
    // field somehow offers ONLY dead picks, fall back so it still grants
    const pickableList = unknown.filter((a) => appPickableBy(empire, a.id));
    const pickable = pickableList.length ? pickableList : unknown;
    if (fieldGrantsAll(field) || (traits.creative && !state.settings.modes.creativeVariant)) {
      for (const a of unknown) {
        grantApp(empire, a.id);
        granted.push(a.id);
      }
    } else if (traits.uncreative) {
      if (pickable.length) {
        const a = pickable[rng.int(pickable.length)]!;
        grantApp(empire, a.id);
        granted.push(a.id);
      }
    } else {
      const target =
        empire.research.targetApp && pickable.some((a) => a.id === empire.research.targetApp)
          ? empire.research.targetApp
          : (pickable[0]?.id ?? null);
      if (target) {
        grantApp(empire, target);
        granted.push(target);
      }
    }
    if (!empire.completedFields.includes(field.num)) {
      empire.completedFields.push(field.num);
      empire.completedFields.sort((a, b) => a - b);
    }
  }

  events.push({
    visibleTo: empire.id,
    kind: 'research_complete',
    payload: { field: field.id, granted },
  });
}

/** Apply an empire's research points for the turn (mutates empire in place). */
export function applyResearch(
  state: GameState,
  empire: Empire,
  rp: number,
  rng: Rng,
  events: TurnEvent[],
): void {
  const r = empire.research;

  // creative-variant purchases take priority; at most one completes per turn
  if (r.extraQueue.length > 0) {
    r.extraAccumRP += rp;
    const head = r.extraQueue[0]!;
    const app = APPLICATION_ROWS.find((a) => a.id === head);
    const field = app ? fieldById.get(app.fieldId) : undefined;
    const cost = field ? field.cost : 0;
    if (field && r.extraAccumRP >= cost) {
      r.extraQueue.shift();
      r.extraAccumRP -= cost;
      grantApp(empire, head);
      events.push({ visibleTo: empire.id, kind: 'research_complete', payload: { field: field.id, granted: [head], extra: true } });
    }
    return;
  }

  if (r.fieldNum === null) {
    r.accumRP += rp; // banked until a field is chosen
    return;
  }
  const field = fieldByNum.get(r.fieldNum);
  if (!field) return;
  r.accumRP += rp;
  const cost = fieldCost(state, empire, field);
  if (r.accumRP >= cost) {
    r.accumRP -= cost;
    r.fieldNum = null;
    r.targetApp = null;
    completeField(state, empire, field, rng, events);
  }
}
