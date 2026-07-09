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
import type { Rng } from './rng';
import { traitsOf } from './economy';
import type { Empire, GameState, TurnEvent } from './types';

/** Tier-1 ("basic") fields grant every application at once, like the classic
 * starting techs (lasers etc.) — no target choice needed. */
export function fieldGrantsAll(field: FieldRow): boolean {
  return field.tier === 1 && !field.id.startsWith('advf_');
}

export function fieldCost(empire: Empire, field: FieldRow): number {
  if (field.id.startsWith('advf_')) {
    const level = empire.research.hyperLevels[field.id] ?? 0;
    return field.cost + 10000 * level;
  }
  return field.cost;
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
    if (fieldGrantsAll(field) || (traits.creative && !state.settings.modes.creativeVariant)) {
      for (const a of unknown) {
        grantApp(empire, a.id);
        granted.push(a.id);
      }
    } else if (traits.uncreative) {
      if (unknown.length) {
        const a = unknown[rng.int(unknown.length)]!;
        grantApp(empire, a.id);
        granted.push(a.id);
      }
    } else {
      const target =
        empire.research.targetApp && unknown.some((a) => a.id === empire.research.targetApp)
          ? empire.research.targetApp
          : (unknown[0]?.id ?? null);
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
  const cost = fieldCost(empire, field);
  if (r.accumRP >= cost) {
    r.accumRP -= cost;
    r.fieldNum = null;
    r.targetApp = null;
    completeField(state, empire, field, rng, events);
  }
}
