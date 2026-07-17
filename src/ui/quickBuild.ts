// Map-view quick building: hotkeys queue ships/buildings at the best-suited
// colony of the selected star, and the queued items are "pinned" — the slider
// autopilot leaves a pinned colony's queue alone until every pinned item
// finishes or is cancelled, at which point autobuild takes the yard back.
// Everything here issues the same ordinary logged commands a human would
// (set_build_queue); pins themselves are client-side bookkeeping only.

import { selectors, availableHulls } from '@engine/index';
import { canQueue, itemCost, itemLabel } from '@engine/items';
import type { Colony, GameState } from '@engine/types';
import type { GameSession } from '@protocol/session';

/** hotkey → what to queue. Hull keys resolve to the empire's newest design of
 * that hull (the auto design tracks the latest researched components). */
export const BUILD_HOTKEYS: Record<string, { hull?: string; item?: string; label: string }> = {
  c: { item: 'colony_ship', label: 'colony ship' },
  o: { item: 'outpost_ship', label: 'outpost ship' },
  s: { hull: 'frigate', label: 'scout (frigate)' },
  f: { hull: 'frigate', label: 'frigate' },
  d: { hull: 'destroyer', label: 'destroyer' },
  r: { hull: 'cruiser', label: 'cruiser' },
  b: { hull: 'battleship', label: 'battleship' },
  t: { hull: 'titan', label: 'titan' },
  h: { item: 'housing', label: 'housing' },
  a: { item: 'automated_factory', label: 'factory' },
  l: { item: 'research_lab', label: 'research lab' },
  k: { item: 'supercomputer', label: 'supercomputer' },
};

/** Resolve a build hotkey to a concrete queue item for this empire.
 * Hull keys prefer the auto design (kept at the latest tech by the engine's
 * per-turn refresh); a hand-made non-obsolete design of the hull works too. */
export function resolveHotkeyItem(
  state: GameState,
  empireId: number,
  key: string,
): { item: string; note?: string } | { error: string } {
  const spec = BUILD_HOTKEYS[key];
  if (!spec) return { error: `no build bound to "${key}"` };
  if (spec.item) return { item: spec.item };
  const empire = state.empires.find((e) => e.id === empireId);
  if (!empire) return { error: 'no empire' };
  if (!availableHulls(empire).includes(spec.hull!)) {
    return { error: `${spec.hull} hulls are not researched yet` };
  }
  const candidates = empire.designs.filter((d) => d.hull === spec.hull && !d.obsolete);
  const design = candidates.find((d) => d.auto) ?? candidates[candidates.length - 1];
  if (!design) return { error: `no ${spec.hull} design — create one in the Designer` };
  const note = key === 's' ? 'scouts are start-only ships — queued the frigate instead' : undefined;
  return { item: `design:${design.id}`, note };
}

/** The best-suited colony at a star for an item: among the player's colonies
 * in that system that can queue it, the strongest yard (production actually
 * reaching the queue) wins — the same yardstick the governor and bots use. */
export function bestColonyFor(
  state: GameState,
  empireId: number,
  starId: number,
  item: string,
): { colony: Colony; row: selectors.ColonyRow } | { error: string } {
  const here = state.colonies.filter((c) => {
    if (c.owner !== empireId || c.outpost) return false;
    const p = state.planets.find((x) => x.id === c.planetId);
    return p?.starId === starId;
  });
  if (!here.length) return { error: 'you have no colony at this star' };
  let firstReason: string | null = null;
  let best: { colony: Colony; row: selectors.ColonyRow } | null = null;
  for (const colony of here) {
    const reason = canQueue(state, colony, item);
    if (reason !== null) {
      firstReason ??= reason;
      continue;
    }
    if (colony.queue.length >= 12) {
      firstReason ??= 'build queue is full (12)';
      continue;
    }
    const row = selectors.colonyRow(state, colony);
    if (!best || row.output.prodToQueue > best.row.output.prodToQueue) best = { colony, row };
  }
  if (!best) return { error: firstReason ?? 'no colony here can build that' };
  return best;
}

// ---- pins: which queue entries are the player's explicit orders ----
// pins[colonyId] = item ids in build order. The queue is kept as
// [pinned items…, everything else…]; reconcile() trims pins as they complete.

export type Pins = Record<number, string[]>;

/** queue minus one occurrence of each pinned item, preserving order — the
 * "everything else" tail that autopilot/manual edits own */
export function unpinnedTail(queue: string[], pinned: string[]): string[] {
  const budget = new Map<string, number>();
  for (const it of pinned) budget.set(it, (budget.get(it) ?? 0) + 1);
  const tail: string[] = [];
  for (const it of queue) {
    const n = budget.get(it) ?? 0;
    if (n > 0) budget.set(it, n - 1);
    else tail.push(it);
  }
  return tail;
}

/** Queue `item` at the colony as a pinned (player-ordered) build: it lands
 * right after the existing pinned items and ahead of any autopilot filler. */
export function pinBuild(
  session: GameSession<GameState>,
  pins: Pins,
  colony: Colony,
  item: string,
): { error?: string } {
  const pinned = pins[colony.id] ?? [];
  const queue = colony.queue.map((q) => q.item);
  const items = [...pinned, item, ...unpinnedTail(queue, pinned)].slice(0, 12);
  const res = session.submit('set_build_queue', { colonyId: colony.id, items });
  if (res.error) return { error: res.error };
  pins[colony.id] = [...pinned, item];
  return {};
}

/** Cancel one pinned build (by pin index). The item leaves the queue; when it
 * was the last pin the colony returns to autobuild on the next governor pass. */
export function cancelPin(session: GameSession<GameState>, pins: Pins, colony: Colony, pinIndex: number): { error?: string } {
  const pinned = pins[colony.id] ?? [];
  if (pinIndex < 0 || pinIndex >= pinned.length) return {};
  const remaining = pinned.filter((_, i) => i !== pinIndex);
  const tail = unpinnedTail(
    colony.queue.map((q) => q.item),
    pinned,
  );
  const res = session.submit('set_build_queue', { colonyId: colony.id, items: [...remaining, ...tail] });
  if (res.error) return { error: res.error };
  if (remaining.length) pins[colony.id] = remaining;
  else delete pins[colony.id];
  return {};
}

/** Drop pins whose item no longer sits in the queue (completed, or removed by
 * a manual spreadsheet edit) and pins on colonies that are gone or captured.
 * The engine refreshes auto designs as research lands and migrates queue
 * entries design:old → design:new — a pin on the old id follows the same
 * migration so the player's ship keeps its status bar (and its yard).
 * Returns true when anything changed. */
export function reconcilePins(state: GameState, empireId: number, pins: Pins): boolean {
  const empire = state.empires.find((e) => e.id === empireId);
  let changed = false;
  for (const key of Object.keys(pins)) {
    const colonyId = Number(key);
    const colony = state.colonies.find((c) => c.id === colonyId);
    if (!colony || colony.owner !== empireId) {
      delete pins[colonyId];
      changed = true;
      continue;
    }
    const counts = new Map<string, number>();
    for (const q of colony.queue) counts.set(q.item, (counts.get(q.item) ?? 0) + 1);
    const kept: string[] = [];
    for (let it of pins[colonyId] ?? []) {
      if ((counts.get(it) ?? 0) === 0 && it.startsWith('design:') && empire) {
        // follow the auto-refresh: same hull, current auto design
        const old = empire.designs.find((d) => `design:${d.id}` === it);
        const successor = old && empire.designs.find((d) => d.auto && !d.obsolete && d.hull === old.hull);
        if (successor && (counts.get(`design:${successor.id}`) ?? 0) > 0) {
          it = `design:${successor.id}`;
          changed = true;
        }
      }
      const n = counts.get(it) ?? 0;
      if (n > 0) {
        counts.set(it, n - 1);
        kept.push(it);
      } else {
        changed = true;
      }
    }
    if (kept.length) pins[colonyId] = kept;
    else delete pins[colonyId];
  }
  return changed;
}

/** Auto-explore: every idle scout flies to the nearest unexplored star in
 * fuel range (ordinary move_ships — cancel/re-route like any manual order).
 * One pass per turn; returns how many scouts were dispatched. */
export function autoExploreScouts(session: GameSession<GameState>): number {
  const state = session.getPlanned();
  if (!state) return 0;
  const me = session.playerId;
  const unexplored = new Set(
    selectors
      .galaxyView(state, me)
      .filter((v) => !v.explored)
      .map((v) => v.star.id),
  );
  if (!unexplored.size) return 0;
  let sent = 0;
  for (const ship of state.ships) {
    if (ship.owner !== me || ship.shipKind !== 'scout' || ship.location.kind !== 'star') continue;
    // moveOptions come back distance-sorted: the first reachable unexplored
    // star not already claimed by an earlier scout this pass is the target
    const target = selectors
      .moveOptions(state, me, ship.location.starId)
      .find((o) => o.reachable && unexplored.has(o.starId));
    if (!target) continue;
    const res = session.submit('move_ships', { shipIds: [ship.id], destStarId: target.starId });
    if (!res.error) {
      unexplored.delete(target.starId);
      sent++;
    }
  }
  return sent;
}

export interface PinStatus {
  colonyId: number;
  pinIndex: number;
  colonyName: string;
  starId: number;
  starName: string;
  item: string;
  label: string;
  /** 0..100 of the ACTIVE item's cost (only the queue head accrues) */
  pct: number;
  /** estimated turns until THIS item completes (null = never at current output) */
  turns: number | null;
  /** 0 = building now */
  queuePos: number;
}

/** Per-turn status of every pinned build (drives the map-view progress bars). */
export function pinnedStatus(state: GameState, empireId: number, pins: Pins): PinStatus[] {
  const out: PinStatus[] = [];
  for (const key of Object.keys(pins)) {
    const colonyId = Number(key);
    const colony = state.colonies.find((c) => c.id === colonyId);
    if (!colony || colony.owner !== empireId) continue;
    const row = selectors.colonyRow(state, colony);
    const planet = state.planets.find((p) => p.id === colony.planetId);
    const star = state.stars.find((s) => s.id === planet?.starId);
    const queue = colony.queue.map((q) => q.item);
    // walk the queue once, matching pins in order to queue positions
    const pinned = pins[colonyId] ?? [];
    const positions: number[] = [];
    let from = 0;
    for (const it of pinned) {
      const idx = queue.indexOf(it, from);
      if (idx === -1) continue; // reconcile() will trim it next pass
      positions.push(idx);
      from = idx + 1;
    }
    const prod = row.output.prodToQueue;
    pinned.forEach((it, i) => {
      const pos = positions[i];
      if (pos === undefined) return;
      // production ahead of this item: everything before it in the queue,
      // minus what is already stored toward the head
      let ahead = -colony.storedProd;
      for (let j = 0; j < pos; j++) ahead += itemCost(state, empireId, queue[j]!, colony) ?? 0;
      const cost = itemCost(state, empireId, it, colony) ?? 0;
      const remaining = Math.max(0, ahead + cost);
      out.push({
        colonyId,
        pinIndex: i,
        colonyName: colony.name,
        starId: star?.id ?? -1,
        starName: star?.name ?? '?',
        item: it,
        label: itemLabel(state, empireId, it),
        pct: pos === 0 && cost > 0 ? Math.min(100, Math.floor((colony.storedProd * 100) / cost)) : 0,
        turns: prod > 0 ? Math.max(1, Math.ceil(remaining / prod)) : null,
        queuePos: pos,
      });
    });
  }
  return out.sort((a, b) => a.colonyId - b.colonyId || a.pinIndex - b.pinIndex);
}
