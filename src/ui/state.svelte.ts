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

export const app = $state({
  screen: 'home' as 'home' | 'lobby' | 'game',
  error: '',
  connecting: false,
  version: 0,
  chat: [] as Array<{ id: number; from: number; text: string }>,
  replays: [] as ReplayEntry[],
  /** replay currently open in the battle viewer */
  viewing: null as ReplayEntry | null,
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
  app.version++;
  active.session.subscribe((ev) => {
    app.version++;
    if (ev.type === 'started') app.screen = 'game';
    else if (ev.type === 'version-reject') {
      app.error = ev.reason;
      app.screen = 'home';
    } else if (ev.type === 'chat') {
      app.chat.push({ id: ev.id, from: ev.from, text: ev.text });
      if (app.chat.length > 100) app.chat.shift();
    } else if (ev.type === 'turn-advanced') {
      for (const e of active.session.lastTurnEvents) {
        if (e.kind === 'battle_replay') {
          const p = e.payload as { battleId: string; seed: string; input: unknown; summary: Record<string, unknown> };
          if (!app.replays.some((r) => r.battleId === p.battleId)) {
            app.replays.push({ ...p, turn: ev.turn - 1, watched: false });
            if (app.replays.length > 20) app.replays.shift();
          }
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
  activeGame?.transport.close();
  activeGame = null;
  app.screen = 'home';
  app.chat = [];
  app.version++;
}
