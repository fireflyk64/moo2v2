// Client-side research queue helpers. The engine researches ONE field at a
// time and refuses any field whose predecessor is unresearched, so a deep
// tech queued on its own could never start: the entry parked in the queue
// forever while the labs sat idle (and its presence suppressed the idle
// warning). Queueing a field therefore queues its whole unresearched
// prerequisite ladder ahead of it.
import { fieldByNum } from '@engine/data/index';

export interface ResearchQueueEntry {
  fieldNum: number;
  fieldId: string;
  targetApp: string | null;
}

/** Rewrite the queue so every entry is eventually startable: unknown fields
 * drop (save drift), completed entries drop, duplicates collapse, and each
 * entry's unresearched prerequisites are inserted ahead of it in ladder
 * order. Pure — the drain calls it every pass, which also heals queues saved
 * before chain expansion existed. */
export function normalizeResearchQueue(
  queue: readonly ResearchQueueEntry[],
  completedFields: readonly number[],
  currentFieldNum: number | null,
): ResearchQueueEntry[] {
  const done = new Set(completedFields);
  // queued or in progress: counts as satisfied for everything laddered on it
  const covered = new Set<number>();
  if (currentFieldNum !== null) covered.add(currentFieldNum);
  const out: ResearchQueueEntry[] = [];
  for (const entry of queue) {
    const row = fieldByNum.get(entry.fieldNum);
    if (!row) continue;
    if (covered.has(entry.fieldNum) || done.has(entry.fieldNum)) continue;
    const chain: ResearchQueueEntry[] = [];
    for (let prev = row.previous, guard = 0; prev !== 0 && guard < 1000; guard++) {
      if (done.has(prev) || covered.has(prev)) break;
      const prevRow = fieldByNum.get(prev);
      if (!prevRow) break;
      chain.unshift({ fieldNum: prevRow.num, fieldId: prevRow.id, targetApp: null });
      prev = prevRow.previous;
    }
    for (const link of chain) {
      out.push(link);
      covered.add(link.fieldNum);
    }
    out.push(entry);
    covered.add(entry.fieldNum);
  }
  return out;
}
