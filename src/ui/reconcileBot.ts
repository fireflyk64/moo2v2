// The reconciliation fleet brain. In reconciliation the economy is a script;
// FLEET PLAY is the whole game — so instead of contorting the onion, the
// bots get a dedicated doctrine built around one hard lesson: a starbase
// devastates piecemeal arrivals. Ships mass into a small number of strike
// groups, price INSTALLATIONS into every target (4 frigate-equivalents per
// defensive structure), strike only when the assembled group clearly wins,
// and send small groups at soft targets while the big fleet hunts the big
// baddies. Outpost ships extend fuel range toward unreachable goals and lay
// redundancy links toward the front when everything is already in reach.
//
// Tactics (task: A/B these):
//  - consolidated: one fleet, everything masses, one target at a time
//  - split: 2-3 balanced groups, each with its own winnable target
//  - hybrid: a main fleet (~60%) for the hardest winnable prize + raiders
//    for soft targets; more groups as the navy grows

import { HULL_WEIGHT, selectors, shipMarines, starDistance } from '@engine/index';
import { marinesOf } from '@engine/economy';
import type { GameState, Ship } from '@engine/types';
import type { GameSession } from '@protocol/session';

export type ReconcileTactic = 'consolidated' | 'split' | 'hybrid';

export interface ReconcileBotMemory {
  /** committed target star per group index (null = massing) */
  targets: Array<{ starId: number; since: number } | null>;
}

export const freshReconcileMemory = (): ReconcileBotMemory => ({ targets: [] });

const ORBITAL_DEFENSES = ['star_base', 'battle_station', 'star_fortress', 'missile_base', 'ground_batteries'];
/** frigate-equivalents a defensive structure is worth when pricing a strike */
const BASE_WEIGHT = 4;
/** the assembled group must outweigh the priced garrison by this much */
const WIN_RATIO_NUM = 5; // 1.25x as integers
const WIN_RATIO_DEN = 4;
/** commitment window before a stuck target is dropped */
const TARGET_LAPSE = 20;

export interface ReconcileBotCtx {
  session: GameSession<GameState>;
  state: GameState;
  me: number;
  tactic: ReconcileTactic;
  memory: ReconcileBotMemory;
}

interface TargetInfo {
  starId: number;
  /** enemy ship weight + BASE_WEIGHT per defensive structure */
  defWeight: number;
  /** pop value (+core bonus) */
  value: number;
  core: boolean;
}

export function reconcileBotTurn(ctx: ReconcileBotCtx): void {
  const { session, state, me, memory } = ctx;
  const empire = state.empires.find((e) => e.id === me);
  if (!empire || empire.eliminated) return;

  const starById = new Map(state.stars.map((s) => [s.id, s]));
  const starOfPlanet = new Map(state.planets.map((p) => [p.id, p.starId]));
  const weightOf = (s: Ship): number => {
    if (s.shipKind !== 'design') return 0;
    const d = empire.designs.find((x) => x.id === s.designId);
    return Math.max(1, d ? (HULL_WEIGHT[d.hull] ?? 1) : 1);
  };

  const myColonyStars = new Set<number>();
  for (const c of state.colonies) {
    if (c.owner !== me) continue;
    const sid = starOfPlanet.get(c.planetId);
    if (sid !== undefined) myColonyStars.add(sid);
  }

  // ---- the map: who has what where ----
  const rivals = state.empires.filter((e) => e.id !== me && !e.eliminated);
  const atWarWith = new Set(
    state.relations.filter((r) => r.status === 'war' && (r.a === me || r.b === me)).map((r) => (r.a === me ? r.b : r.a)),
  );
  const enemyWeightAt = new Map<number, number>(); // war rivals only
  const rivalWeightTotal = new Map<number, number>();
  for (const s of state.ships) {
    if (s.shipKind !== 'design' || s.owner === me) continue;
    const w = (() => {
      const owner = state.empires.find((e) => e.id === s.owner);
      const d = owner?.designs.find((x) => x.id === s.designId);
      return Math.max(1, d ? (HULL_WEIGHT[d.hull] ?? 1) : 1);
    })();
    rivalWeightTotal.set(s.owner, (rivalWeightTotal.get(s.owner) ?? 0) + w);
    if (atWarWith.has(s.owner) && s.location.kind === 'star') {
      enemyWeightAt.set(s.location.starId, (enemyWeightAt.get(s.location.starId) ?? 0) + w);
    }
  }

  const warships = state.ships.filter((s) => s.owner === me && s.shipKind === 'design' && s.location.kind === 'star');
  const myWeight = warships.reduce((n, s) => n + weightOf(s), 0);

  // ---- war: the goal is the goal — declare at rough fleet parity or better
  // (the per-group winnability gates below do the real safety work; a bot
  // that only fights from clear superiority never fights a mirror), always
  // against a rival squatting on a victory star, one declaration per turn ----
  const coreIds = new Set(state.coreWorlds ?? []);
  const notAtWar = rivals.filter((r) => !atWarWith.has(r.id));
  if (notAtWar.length && warships.length > 0) {
    const target = notAtWar
      .filter((r) => {
        const theirs = rivalWeightTotal.get(r.id) ?? 0;
        const holdsCore = coreIds.size > 0 && state.colonies.some((c) => c.owner === r.id && coreIds.has(c.planetId));
        return myWeight * 10 >= theirs * 9 || holdsCore;
      })
      .sort((a, b) => (rivalWeightTotal.get(a.id) ?? 0) - (rivalWeightTotal.get(b.id) ?? 0) || a.id - b.id)[0];
    if (target) {
      session.submit('declare_war', { target: target.id });
      atWarWith.add(target.id);
    }
  }

  // ---- candidate targets: war rivals' colony stars, priced with their guns ----
  const targets = new Map<number, TargetInfo>();
  for (const c of state.colonies) {
    if (!atWarWith.has(c.owner)) continue;
    const sid = starOfPlanet.get(c.planetId);
    if (sid === undefined) continue;
    const t = targets.get(sid) ?? { starId: sid, defWeight: enemyWeightAt.get(sid) ?? 0, value: 0, core: false };
    t.defWeight += c.buildings.filter((b) => ORBITAL_DEFENSES.includes(b)).length * BASE_WEIGHT;
    t.value += c.groups.reduce((n, g) => n + Math.floor(g.popK / 1000), 0) + (c.outpost ? 1 : 0);
    if (coreIds.has(c.planetId)) {
      t.core = true;
      t.value += 50;
    }
    targets.set(sid, t);
  }

  // ---- home fire: enemies over my worlds outrank everything ----
  const threats = [...enemyWeightAt.entries()]
    .filter(([sid]) => myColonyStars.has(sid))
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);

  // ---- groups by tactic ("more fleets later": counts scale with the navy) ----
  const groupCount = groupCountFor(ctx.tactic, myWeight);
  const groups = assignGroups(warships, weightOf, groupCount, ctx.tactic);
  while (memory.targets.length < groups.length) memory.targets.push(null);
  memory.targets.length = groups.length;

  const winnable = (groupWeight: number, t: TargetInfo) => groupWeight * WIN_RATIO_DEN >= t.defWeight * WIN_RATIO_NUM + WIN_RATIO_DEN;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!;
    const groupWeight = group.reduce((n, s) => n + weightOf(s), 0);
    if (!group.length) {
      memory.targets[gi] = null;
      continue;
    }

    // commitment bookkeeping: drop won, lapsed or no-longer-winnable targets
    const committed = memory.targets[gi];
    if (committed) {
      const t = targets.get(committed.starId);
      const lapsed = state.turn - committed.since > TARGET_LAPSE;
      if (!t || lapsed || !winnable(groupWeight, t)) memory.targets[gi] = null;
    }

    // defense first: the heaviest group answers the biggest home fire it can beat
    if (gi === 0 && threats.length) {
      const answerable = threats.find(([, w]) => groupWeight * WIN_RATIO_DEN >= w * WIN_RATIO_NUM);
      if (answerable) {
        memory.targets[gi] = { starId: answerable[0], since: state.turn };
        moveGroup(ctx, group, weightOf, answerable[0], answerable[1]);
        continue;
      }
    }

    if (memory.targets[gi] === null) {
      const pool = [...targets.values()].filter((t) => winnable(groupWeight, t));
      // reachability first (a commitment the fleet cannot fly to just parks
      // it at home — the unreachable ones are the outpost chain's job); then
      // main group (0) hunts the biggest winnable baddie; raiders take the
      // softest — small fleets favor soft targets by doctrine
      const musterStar = heaviestStackStar(group);
      const reach = musterStar === null ? new Set<number>() : new Set(selectors.moveOptions(state, me, musterStar).filter((o) => o.reachable).map((o) => o.starId));
      pool.sort((a, b) => {
        const ra = reach.has(a.starId) ? 0 : 1;
        const rb = reach.has(b.starId) ? 0 : 1;
        if (ra !== rb) return ra - rb;
        if (a.core !== b.core) return a.core ? -1 : 1;
        if (gi === 0) return b.value - a.value || a.defWeight - b.defWeight || a.starId - b.starId;
        return a.defWeight - b.defWeight || b.value - a.value || a.starId - b.starId;
      });
      const pick = pool[0];
      if (pick) memory.targets[gi] = { starId: pick.starId, since: state.turn };
    }

    const target = memory.targets[gi];
    if (target) {
      moveGroup(ctx, group, weightOf, target.starId, targets.get(target.starId)?.defWeight ?? 0);
    } else if (gi > 0 && memory.targets[0]) {
      // no winnable soft target: the raider reinforces the main effort
      moveGroup(ctx, group, weightOf, memory.targets[0]!.starId, targets.get(memory.targets[0]!.starId)?.defWeight ?? 0, true);
    } else {
      // nothing winnable anywhere: mass at the group's heaviest stack and grow
      massGroup(ctx, group);
    }
  }

  runTransports(ctx, starOfPlanet, enemyWeightAt);
  runOutposts(ctx, starById, starOfPlanet, targets, myColonyStars);
}

function groupCountFor(tactic: ReconcileTactic, myWeight: number): number {
  if (tactic === 'consolidated') return 1;
  if (tactic === 'split') return myWeight >= 24 ? 3 : 2;
  // hybrid: main fleet always; raiders as the navy grows
  return 1 + (myWeight >= 18 ? 1 : 0) + (myWeight >= 36 ? 1 : 0);
}

/** deterministic weight-balanced grouping; hybrid loads ~60% into group 0 */
function assignGroups(warships: Ship[], weightOf: (s: Ship) => number, count: number, tactic: ReconcileTactic): Ship[][] {
  const groups: Ship[][] = Array.from({ length: count }, () => []);
  if (count === 1) {
    groups[0] = [...warships];
    return groups;
  }
  const sorted = [...warships].sort((a, b) => weightOf(b) - weightOf(a) || a.id - b.id);
  const weights = new Array(count).fill(0) as number[];
  const total = sorted.reduce((n, s) => n + weightOf(s), 0);
  const lightest = (from: number): number => {
    let best = from;
    for (let i = from + 1; i < count; i++) if (weights[i]! < weights[best]!) best = i;
    return best;
  };
  for (const s of sorted) {
    // hybrid: the main fleet takes ~60% of the tonnage, raiders share the rest
    const gi = tactic === 'hybrid' ? (weights[0]! * 5 < total * 3 ? 0 : lightest(1)) : lightest(0);
    groups[gi]!.push(s);
    weights[gi]! += weightOf(s);
  }
  return groups;
}

/** onion-proven muster-then-strike, per group: stacks pull to the heaviest
 * concentration and only a stack that carries the WHOLE assembled group (and
 * clearly outweighs the garrison) jumps the target. */
function moveGroup(
  ctx: ReconcileBotCtx,
  group: Ship[],
  weightOf: (s: Ship) => number,
  targetStar: number,
  defWeight: number,
  reinforce = false,
): void {
  const { session, state, me } = ctx;
  const stacks = new Map<number, { ids: number[]; w: number }>();
  let totalW = 0;
  for (const s of group) {
    const from = (s.location as { starId: number }).starId;
    const st = stacks.get(from) ?? stacks.set(from, { ids: [], w: 0 }).get(from)!;
    st.ids.push(s.id);
    st.w += weightOf(s);
    totalW += weightOf(s);
  }
  const atTargetW = stacks.get(targetStar)?.w ?? 0;
  stacks.delete(targetStar);
  // caution around installations: jump only with ~the whole group assembled
  // AND a clear win over the priced garrison (reinforcing an ongoing fight
  // relaxes the bar — the battle is already joined)
  const assembled = Math.max(1, Math.ceil(totalW * 0.85));
  let muster = targetStar;
  let musterW = atTargetW;
  for (const [star, st] of stacks) {
    if (st.w > musterW) {
      musterW = st.w;
      muster = star;
    }
  }
  const starById = new Map(state.stars.map((s) => [s.id, s]));
  for (const [from, st] of stacks) {
    const winsAlone = st.w * WIN_RATIO_DEN >= defWeight * WIN_RATIO_NUM + WIN_RATIO_DEN;
    const jump = reinforce || atTargetW > 0 ? winsAlone || atTargetW > 0 : st.w >= assembled && winsAlone;
    const dest = jump ? targetStar : muster;
    if (dest === from) continue;
    const options = selectors.moveOptions(state, me, from).filter((o) => o.reachable);
    if (options.some((o) => o.starId === dest)) {
      for (let i = 0; i < st.ids.length; i += 20) {
        session.submit('move_ships', { shipIds: st.ids.slice(i, i + 20), destStarId: dest });
      }
      continue;
    }
    // out of reach: STAGE FORWARD — creep to the reachable star nearest the
    // destination so the moment the outpost chain bridges, the jump is short
    const destObj = starById.get(dest);
    const fromObj = starById.get(from);
    if (!destObj || !fromObj) continue;
    const step = options
      .filter((o) => o.starId !== from)
      .sort((a, b) => starDistance(starById.get(a.starId)!, destObj) - starDistance(starById.get(b.starId)!, destObj) || a.starId - b.starId)[0];
    if (step && starDistance(starById.get(step.starId)!, destObj) < starDistance(fromObj, destObj)) {
      for (let i = 0; i < st.ids.length; i += 20) {
        session.submit('move_ships', { shipIds: st.ids.slice(i, i + 20), destStarId: step.starId });
      }
    }
  }
}

/** the star carrying the group's heaviest stack (null for an empty group) */
function heaviestStackStar(group: Ship[]): number | null {
  const w = new Map<number, number>();
  for (const s of group) {
    const from = (s.location as { starId: number }).starId;
    w.set(from, (w.get(from) ?? 0) + 1);
  }
  return [...w.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
}

function massGroup(ctx: ReconcileBotCtx, group: Ship[]): void {
  const { session, state, me } = ctx;
  const stacks = new Map<number, { ids: number[]; w: number }>();
  for (const s of group) {
    const from = (s.location as { starId: number }).starId;
    const st = stacks.get(from) ?? stacks.set(from, { ids: [], w: 0 }).get(from)!;
    st.ids.push(s.id);
    st.w += 1;
  }
  const muster = [...stacks.entries()].sort((a, b) => b[1].w - a[1].w || a[0] - b[0])[0]?.[0];
  if (muster === undefined) return;
  for (const [from, st] of stacks) {
    if (from === muster) continue;
    const ok = selectors.moveOptions(state, me, from).some((o) => o.reachable && o.starId === muster);
    if (ok) {
      for (let i = 0; i < st.ids.length; i += 20) {
        session.submit('move_ships', { shipIds: st.ids.slice(i, i + 20), destStarId: muster });
      }
    }
  }
}

/** loaded marine transports ride to cleared enemy skies in one wave */
function runTransports(ctx: ReconcileBotCtx, starOfPlanet: Map<number, number>, enemyWeightAt: Map<number, number>): void {
  const { session, state, me } = ctx;
  const atWarWith = new Set(
    state.relations.filter((r) => r.status === 'war' && (r.a === me || r.b === me)).map((r) => (r.a === me ? r.b : r.a)),
  );
  const myWarAt = new Set<number>();
  for (const s of state.ships) {
    if (s.owner === me && s.shipKind === 'design' && s.location.kind === 'star') myWarAt.add(s.location.starId);
  }
  const cleared = state.colonies
    .filter((c) => atWarWith.has(c.owner) && !c.outpost)
    .map((c) => {
      const sid = starOfPlanet.get(c.planetId);
      const pop = c.groups.reduce((n, g) => n + Math.floor(g.popK / 1000), 0);
      return { starId: sid, militia: marinesOf(c) + Math.ceil(pop / 2) };
    })
    .filter((t): t is { starId: number; militia: number } => t.starId !== undefined && myWarAt.has(t.starId) && (enemyWeightAt.get(t.starId) ?? 0) === 0)
    .sort((a, b) => a.militia - b.militia || a.starId - b.starId)[0];
  if (!cleared) return;
  const loaded = state.ships.filter((s) => s.owner === me && s.shipKind === 'transport' && shipMarines(s) > 0 && s.location.kind === 'star');
  const wave = loaded.reduce((n, t) => n + shipMarines(t), 0);
  if (wave <= cleared.militia + 2) return;
  for (const t of loaded) {
    if (t.location.kind === 'star' && t.location.starId === cleared.starId) continue;
    const from = (t.location as { starId: number }).starId;
    const ok = selectors.moveOptions(state, me, from).some((o) => o.reachable && o.starId === cleared.starId);
    if (ok) session.submit('move_ships', { shipIds: [t.id], destStarId: cleared.starId });
  }
}

/** outpost ships extend the fuel network toward unreachable goals — and when
 * everything is in reach, lay a redundancy link toward the front so one lost
 * colony cannot sever the lane */
function runOutposts(
  ctx: ReconcileBotCtx,
  starById: Map<number, GameState['stars'][number]>,
  starOfPlanet: Map<number, number>,
  targets: Map<number, TargetInfo>,
  myColonyStars: Set<number>,
): void {
  const { session, state, me } = ctx;
  for (const row of selectors.fleetRows(state, me)) {
    if (row.kind !== 'outpost_ship') continue;
    // settle wherever we already are (outside our own systems)
    if (row.canOutpostHere.length && row.atStarId !== null && !myColonyStars.has(row.atStarId)) {
      session.submit('build_outpost', { shipId: row.ship.id, planetId: row.canOutpostHere[0] });
      continue;
    }
    if (row.atStarId === null) continue;
    const options = selectors.moveOptions(state, me, row.atStarId);
    const reachable = new Set(options.filter((o) => o.reachable).map((o) => o.starId));
    // goals we cannot reach yet: enemy target stars outside the bubble
    const here = starById.get(row.atStarId)!;
    const byDistance = (ids: number[]): number | undefined =>
      ids.sort((a, b) => starDistance(starById.get(a)!, here) - starDistance(starById.get(b)!, here) || a - b)[0];
    const unreachableGoals = [...targets.keys()].filter((sid) => !reachable.has(sid) && sid !== row.atStarId);
    const goalId = unreachableGoals.length ? byDistance(unreachableGoals) : byDistance([...targets.keys()]);
    const goalStar = goalId !== undefined ? starById.get(goalId) : undefined;
    const candidates = options
      .filter(
        (o) =>
          o.reachable &&
          !myColonyStars.has(o.starId) &&
          state.planets.some((p) => p.starId === o.starId && !state.colonies.some((c) => c.planetId === p.id)) &&
          !state.monsters.some((m) => m.starId === o.starId),
      )
      .sort((a, b) => {
        if (!goalStar) return a.starId - b.starId;
        const sa = starById.get(a.starId)!;
        const sb = starById.get(b.starId)!;
        return starDistance(sa, goalStar) - starDistance(sb, goalStar) || a.starId - b.starId;
      });
    // two ships in service diversify: even ids push the lane, odd ids take
    // the runner-up spot — a parallel link so one lost dome cannot sever it
    const dest = candidates[row.ship.id % 2] ?? candidates[0];
    if (dest && dest.starId !== row.atStarId) {
      session.submit('move_ships', { shipIds: [row.ship.id], destStarId: dest.starId });
    }
  }
}
