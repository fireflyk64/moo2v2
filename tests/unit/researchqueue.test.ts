// Client research queue: queueing a deep field must queue its whole
// unresearched prerequisite ladder ahead of it. A lone deep entry can never
// start (the engine refuses fields with unresearched predecessors), so it
// used to park in the queue forever while the labs sat idle — and its
// presence suppressed the "labs idle" fast-forward stop on top.
import { describe, expect, it } from 'vitest';
import { FIELD_ROWS, FIELD_SUBJECTS, fieldByNum } from '@engine/data/index';
import { normalizeResearchQueue, type ResearchQueueEntry } from '@ui/researchQueue';

/** a root field (previous = 0) with at least two successors on its ladder */
function someLadder(): [rootNum: number, mid: number, deep: number] {
  for (const f of FIELD_ROWS) {
    if (f.previous !== 0 || FIELD_SUBJECTS[f.id] === 'special') continue;
    const mid = fieldByNum.get(f.next);
    const deep = mid ? fieldByNum.get(mid.next) : undefined;
    if (mid && deep) return [f.num, mid.num, deep.num];
  }
  throw new Error('no 3-deep ladder in field data');
}

const entry = (fieldNum: number, targetApp: string | null = null): ResearchQueueEntry => ({
  fieldNum,
  fieldId: fieldByNum.get(fieldNum)?.id ?? `unknown_${fieldNum}`,
  targetApp,
});

describe('normalizeResearchQueue', () => {
  const [root, mid, deep] = someLadder();

  it('inserts the unresearched prerequisite ladder ahead of a deep entry', () => {
    const out = normalizeResearchQueue([entry(deep, 'target_app')], [], null);
    expect(out.map((q) => q.fieldNum)).toEqual([root, mid, deep]);
    // the clicked entry keeps its target; inserted prerequisites carry none
    expect(out.map((q) => q.targetApp)).toEqual([null, null, 'target_app']);
    // inserted entries name their field so the queue chips read correctly
    expect(out[0]!.fieldId).toBe(fieldByNum.get(root)!.id);
  });

  it('starts the ladder after the last completed ancestor', () => {
    const out = normalizeResearchQueue([entry(deep)], [root], null);
    expect(out.map((q) => q.fieldNum)).toEqual([mid, deep]);
  });

  it('treats the field currently being researched as satisfied', () => {
    const out = normalizeResearchQueue([entry(deep)], [], mid);
    // root is below mid on the ladder, so mid-in-progress covers it too
    expect(out.map((q) => q.fieldNum)).toEqual([deep]);
  });

  it('collapses duplicates however the entries are ordered', () => {
    const out = normalizeResearchQueue([entry(deep), entry(mid), entry(deep)], [], null);
    expect(out.map((q) => q.fieldNum)).toEqual([root, mid, deep]);
  });

  it('drops completed entries and unknown fields (save drift)', () => {
    const out = normalizeResearchQueue(
      [entry(root), { fieldNum: 999999, fieldId: 'gone', targetApp: null }, entry(mid)],
      [root],
      null,
    );
    expect(out.map((q) => q.fieldNum)).toEqual([mid]);
  });

  it('leaves an already-startable queue unchanged', () => {
    const out = normalizeResearchQueue([entry(root, 'pick')], [], null);
    expect(out).toEqual([entry(root, 'pick')]);
  });
});
