// Campaign timelapse: the event-sourced log IS the whole game's history —
// replay(log) == state, so replaying it and sampling one frame per turn gives
// an unfogged map of every border shift and battle. Consent-gated by the
// engine's timelapse_vote ballot (types.ts) because it reveals everything.

import { createGameEngine } from '@engine/adapter';
import { MAP_SIZE } from '@engine/galaxy';
import type { GameState } from '@engine/types';
import type { ActiveGame } from './net';

export interface TimelapseFrame {
  turn: number;
  /** starId → owners with a colony/outpost there this turn */
  owners: Array<[number, number[]]>;
  /** battles resolved during the turn that produced this frame */
  battles: Array<{ starId: number; winner: number | null }>;
  stats: Array<{ empire: number; colonies: number; pop: number; warships: number; apps: number }>;
}

export interface TimelapseData {
  w: number;
  h: number;
  stars: Array<{ id: number; x: number; y: number; color: string; name: string }>;
  empires: Array<{ id: number; name: string }>;
  frames: TimelapseFrame[];
}

interface LogCmd {
  turn: number;
  playerId: number;
  kind: string;
  payload: unknown;
}

function captureFrame(state: GameState, battles: TimelapseFrame['battles']): TimelapseFrame {
  const byStar = new Map<number, Set<number>>();
  for (const c of state.colonies) {
    const p = state.planets.find((x) => x.id === c.planetId);
    if (!p) continue;
    byStar.set(p.starId, (byStar.get(p.starId) ?? new Set()).add(c.owner));
  }
  return {
    turn: state.turn,
    owners: [...byStar.entries()]
      .map(([starId, owners]) => [starId, [...owners].sort((a, b) => a - b)] as [number, number[]])
      .sort((a, b) => a[0] - b[0]),
    battles,
    stats: state.empires.map((e) => ({
      empire: e.id,
      colonies: state.colonies.filter((c) => c.owner === e.id && !c.outpost).length,
      pop: state.colonies
        .filter((c) => c.owner === e.id)
        .reduce((n, c) => n + c.groups.reduce((m, g) => m + Math.floor(g.popK / 1000), 0), 0),
      warships: state.ships.filter((s) => s.owner === e.id && s.shipKind === 'design').length,
      apps: e.knownApps.length,
    })),
  };
}

/** Replay a full command log into per-turn frames. Pure of any session state
 * (fresh engine instance) — also unit-testable straight off a headless log. */
export async function framesFromLog(
  log: LogCmd[],
  onProgress?: (pct: number) => void,
): Promise<TimelapseData> {
  const first = log[0];
  if (!first || first.kind !== 'game_start') throw new Error('history does not begin with game_start');
  const engine = createGameEngine();
  let state = engine.init(first.payload as never) as GameState;
  engine.takeEvents();
  const dims = MAP_SIZE[state.settings.galaxySize];
  const frames: TimelapseFrame[] = [];
  let pendingBattles: TimelapseFrame['battles'] = [];
  frames.push(captureFrame(state, []));
  for (let i = 1; i < log.length; i++) {
    const cmd = log[i]!;
    const prevTurn = state.turn;
    state = engine.apply(state, {
      turn: cmd.turn,
      playerId: cmd.playerId,
      kind: cmd.kind,
      payload: cmd.payload,
    } as never) as GameState;
    for (const ev of engine.takeEvents() as Array<{ kind: string; payload: Record<string, unknown> }>) {
      if (ev.kind === 'battle_resolved') {
        pendingBattles.push({ starId: Number(ev.payload['starId']), winner: (ev.payload['winner'] as number | null) ?? null });
      }
    }
    if (state.turn > prevTurn) {
      frames.push(captureFrame(state, pendingBattles));
      pendingBattles = [];
    }
    if (i % 25 === 0) {
      onProgress?.(Math.floor((i * 100) / log.length));
      // keep the UI thread breathing during long replays
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(100);
  return {
    w: dims.w,
    h: dims.h,
    stars: state.stars.map((s) => ({ id: s.id, x: s.x, y: s.y, color: s.color, name: s.name })),
    empires: state.empires.map((e) => ({ id: e.id, name: e.name })),
    frames,
  };
}

/** Browser entry: pull the stored game record (any seat persists it) and
 * replay it. Throws with a friendly message when there is no history. */
export async function generateTimelapse(
  active: ActiveGame,
  onProgress?: (pct: number) => void,
): Promise<TimelapseData> {
  if (!active.store || !active.session.gameId) {
    throw new Error('the timelapse needs the stored game record — persistence is unavailable in this tab');
  }
  await active.session.flush();
  const envelope = await active.store.exportGame(active.session.gameId, { history: true });
  if (envelope.history === false || envelope.commands.length === 0) {
    throw new Error('this game has no stored turn-by-turn history (loaded from a no-history save)');
  }
  const log: LogCmd[] = envelope.commands.map((c) => ({
    turn: c.turn,
    playerId: c.playerId,
    kind: c.kind,
    payload: JSON.parse(c.payload) as unknown,
  }));
  return framesFromLog(log, onProgress);
}
