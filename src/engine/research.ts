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
import { ceilDiv } from './imath';
import { traitsOf } from './economy';
import type { Empire, GameState, TurnEvent } from './types';

/** "(General)" fields grant every application at once — the five tier-1
 * subject roots plus Cold Fusion (colony ship / outpost ship / transport /
 * freighters), exactly as the mechanics docs mark them. No target choice. */
export function fieldGrantsAll(field: FieldRow): boolean {
  return field.general;
}

/** Listed research cost: what the tech tree and research screen display.
 * Hyper-advanced repeats add their level surcharge to the listed price. */
export function fieldListedCost(empire: Empire, field: FieldRow): number {
  if (field.id.startsWith('advf_')) {
    const level = empire.research.hyperLevels[field.id] ?? 0;
    return field.cost + 10000 * level;
  }
  return field.cost;
}

/** The hidden DISCOVERY LINE (improvements.md): a field actually completes
 * somewhere past its listed cost — uniformly at random in
 * (listed, 2 × listed] — fixed by the game seed, so every empire shares the
 * same line for the same field and nobody sees it. The UI shows the listed
 * cost plus "% chance to discover" odds once next turn's RP could reach the
 * line (researchOddsPct below). Hyper-advanced repeats stay at list price
 * (a predictable endgame sink). */
export function fieldCost(state: GameState, empire: Empire, field: FieldRow): number {
  const listed = fieldListedCost(empire, field);
  if (field.id.startsWith('advf_')) return listed;
  return rngFor(state.seed, 'field_cost', field.num).range(listed + 1, 2 * listed);
}

/** Integer % chance that the current research discovers by the beginning of
 * next turn: P(line ≤ accum + rp) given the line is uniform on
 * (listed, 2 × listed] and known to exceed both the listed cost and what has
 * already been spent without discovering. Ceil'd so any real chance shows as
 * at least 1%; 0 while discovery is impossible next turn. */
export function researchOddsPct(listed: number, accumRP: number, rpPerTurn: number): number {
  if (listed <= 0 || rpPerTurn <= 0) return 0;
  const lower = Math.max(accumRP, listed);
  const next = Math.min(accumRP + rpPerTurn, 2 * listed);
  if (next <= lower) return 0;
  return Math.min(100, ceilDiv((next - lower) * 100, 2 * listed - lower));
}

/** "~N turns" discovery estimate against the EXPECTED line (≈1.5 × listed —
 * the real line is hidden). Never below 1 while unfinished. */
export function researchEtaTurns(listed: number, accumRP: number, rpPerTurn: number): number | null {
  if (rpPerTurn <= 0) return null;
  const expectedX2 = 3 * listed + 1; // 2 × E[line] for line uniform on (listed, 2·listed]
  return Math.max(1, ceilDiv(Math.max(0, expectedX2 - 2 * accumRP), 2 * rpPerTurn));
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

  // creative-variant purchases take priority; at most one completes per turn.
  // Purchases complete at the LISTED price (a purchase, not a discovery — the
  // hidden line applies to field research only).
  if (r.extraQueue.length > 0) {
    // an app acquired meanwhile (stolen, traded) must not burn its price on a
    // no-op grant: drop already-known heads without consuming any RP
    while (r.extraQueue.length > 0 && empire.knownApps.includes(r.extraQueue[0]!)) {
      r.extraQueue.shift();
    }
    if (r.extraQueue.length === 0) {
      r.extraAccumRP = 0;
      r.accumRP += rp;
      return;
    }
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
    // completeField reads r.targetApp to grant the chosen application — it
    // may only be cleared AFTER (clearing first granted the field's first
    // app no matter what the player picked)
    completeField(state, empire, field, rng, events);
    r.targetApp = null;
  }
}
