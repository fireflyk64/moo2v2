// Global UI state: which screen is visible plus the active game handle.
// Screens re-render off `app.version`, bumped on every session event; all game
// data is read through session getters (engine state is never proxied).

import type { ActiveGame } from './net';

export interface ReplayEntry {
  battleId: string;
  seed: string;
  input: unknown;
  summary: Record<string, unknown>;
  turn: number;
  watched: boolean;
}

export interface ReportEntry {
  turn: number;
  kind: string;
  payload: Record<string, unknown>;
}

export const app = $state({
  screen: 'home' as 'home' | 'lobby' | 'game',
  error: '',
  connecting: false,
  version: 0,
  chat: [] as Array<{ id: number; from: number; to: number; text: string }>,
  replays: [] as ReplayEntry[],
  /** replay currently open in the battle viewer */
  viewing: null as ReplayEntry | null,
  /** turn-event feed visible to this player (newest last) */
  reports: [] as ReportEntry[],
  /** host peer connectivity (clients only; host is always true) */
  hostConnected: true,
  /** the ?room=&name= URL auto-join already ran (don't rejoin after leaving) */
  autoJoined: false,
});

// Not reactive on purpose: session/transport are external objects.
let activeGame: ActiveGame | null = null;

export function getActive(): ActiveGame | null {
  return activeGame;
}

export function bindActive(active: ActiveGame): void {
  activeGame = active;
  app.error = '';
  app.screen = active.session.isStarted() ? 'game' : 'lobby';
  app.hostConnected = true;
  app.version++;
  if (!active.host) {
    active.transport.onEvent((ev) => {
      if (ev.type === 'player-left' && ev.playerId === 0) app.hostConnected = false;
      else if ((ev.type === 'player-rejoined' || ev.type === 'player-joined') && ev.playerId === 0) app.hostConnected = true;
      app.version++;
    });
  }
  active.session.subscribe((ev) => {
    app.version++;
    if (ev.type === 'started') app.screen = 'game';
    else if (ev.type === 'version-reject') {
      app.error = ev.reason;
      app.screen = 'home';
    } else if (ev.type === 'chat') {
      app.chat.push({ id: ev.id, from: ev.from, to: ev.to, text: ev.text });
      if (app.chat.length > 100) app.chat.shift();
    } else if (ev.type === 'turn-advanced') {
      const me = active.session.playerId;
      for (const e of active.session.lastTurnEvents) {
        if (e.kind === 'battle_replay') {
          if (e.visibleTo !== -1 && e.visibleTo !== me) continue; // participants only
          const p = e.payload as { battleId: string; seed: string; input: unknown; summary: Record<string, unknown> };
          if (!app.replays.some((r) => r.battleId === p.battleId)) {
            app.replays.push({ ...p, turn: ev.turn - 1, watched: false });
            if (app.replays.length > 20) app.replays.shift();
          }
          continue;
        }
        if (e.visibleTo === -1 || e.visibleTo === me) {
          app.reports.push({ turn: ev.turn - 1, kind: e.kind, payload: e.payload as Record<string, unknown> });
          if (app.reports.length > 300) app.reports.shift();
        }
      }
    }
  });
  if (import.meta.env.DEV) {
    // dev/e2e hook: drive the session from the console or page.evaluate
    (window as unknown as Record<string, unknown>)['__moo2'] = { session: active.session };
  }
}

export function leaveGame(): void {
  const g = activeGame;
  activeGame = null;
  app.screen = 'home';
  app.chat = [];
  app.version++;
  if (!g) return;
  g.solo?.close();
  for (const b of g.bots) b.close();
  void (async () => {
    // play-by-mail: final upload + lock release must finish BEFORE the store
    // (its data source) is torn down
    await g.pbm?.stop().catch(() => undefined);
    g.transport.close();
    // release the room database (OPFS access handle) so another tab can take it
    await g.store?.destroy().catch(() => undefined);
  })();
}
