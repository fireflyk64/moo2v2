// Global UI state: which screen is visible plus the active game handle.
// Screens re-render off `app.version`, bumped on every session event; all game
// data is read through session getters (engine state is never proxied).

import type { ActiveGame } from './net';

export const app = $state({
  screen: 'home' as 'home' | 'lobby' | 'game',
  error: '',
  connecting: false,
  version: 0,
  chat: [] as Array<{ id: number; from: number; text: string }>,
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
    }
  });
}

export function leaveGame(): void {
  activeGame?.transport.close();
  activeGame = null;
  app.screen = 'home';
  app.chat = [];
  app.version++;
}
