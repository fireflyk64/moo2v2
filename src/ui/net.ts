// UI-side network/persistence glue: connect to a room, open the per-room
// database, detect resumable games, and wire up the session (+ HostCore when
// this browser is the room creator / player 0).

import { ENGINE_VERSION } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import type { EngineAdapter } from '@protocol/engineAdapter';
import type { HostCore } from '@protocol/host';
import { LobbylinkTransport } from '@protocol/lobbylinkTransport';
import { DEFAULT_SETTINGS, type LogCommand } from '@protocol/messages';
import { createHostedGame, generateSeed, joinGame } from '@protocol/setup';
import type { GameSession } from '@protocol/session';
import { isOpfsLikelyAvailable, openBrowserStore } from '@storage/browser';
import type { GameStore } from '@storage/repo';

export const DEFAULT_SERVER = 'https://pqrstuvw.xyz/lobbylink';

export interface RoomParams {
  server: string;
  code: string;
  name: string;
  playerCount: number;
}

export interface ActiveGame {
  transport: LobbylinkTransport;
  session: GameSession<GameState>;
  host: HostCore<GameState> | null;
  store: GameStore | null;
  params: RoomParams;
  startGame: () => void;
}

interface ResumeInfo {
  gameId: string;
  lastSeq: number;
  state: GameState | null;
  log: LogCommand[];
}

async function loadResume(
  store: GameStore,
  roomCode: string,
  engine: EngineAdapter<GameState>,
): Promise<ResumeInfo | null> {
  const games = await store.listGames();
  const g = games.find((x) => x.room_code === roomCode && x.status === 'active');
  if (!g) return null;
  const snap = await store.latestSnapshot(g.game_id);
  let state: GameState | null = snap ? engine.deserialize(snap.stateJson) : null;
  let lastSeq = snap?.seq ?? -1;
  const tail = await store.readCommands(g.game_id, lastSeq + 1);
  for (const c of tail) {
    state = c.kind === 'game_start' ? engine.init(c.payload as never) : state ? engine.apply(state, c) : null;
    lastSeq = c.seq;
  }
  const log = (await store.readCommands(g.game_id)).map((c) => ({
    seq: c.seq,
    turn: c.turn,
    playerId: c.playerId,
    kind: c.kind,
    payload: c.payload,
  }));
  return { gameId: g.game_id, lastSeq, state, log };
}

export async function enterRoom(params: RoomParams): Promise<ActiveGame> {
  const transport = await LobbylinkTransport.connect({
    server: params.server,
    code: params.code,
    maxPlayers: params.playerCount,
  });

  let store: GameStore | null = null;
  if (isOpfsLikelyAvailable()) {
    try {
      store = (await openBrowserStore(`moo2v2-room-${params.code}.sqlite3`)).store;
    } catch (e) {
      console.warn('[net] persistence unavailable (another tab in this room?):', e);
    }
  }

  const identity = {
    name: params.name,
    engineVersion: ENGINE_VERSION,
    dataVersion: DATA_VERSION,
    roomCode: params.code,
    lobbyServer: params.server,
  };

  const resume = store ? await loadResume(store, params.code, gameEngine as unknown as EngineAdapter<GameState>) : null;

  if (transport.selfId === 0) {
    const hosted = createHostedGame<GameState>({
      transport,
      engine: gameEngine as unknown as EngineAdapter<GameState>,
      store,
      settings: { ...DEFAULT_SETTINGS, playerCount: params.playerCount },
      identity,
      ...(resume && resume.log.length ? { resume: { gameId: resume.gameId, log: resume.log } } : {}),
    });
    return {
      transport,
      session: hosted.session,
      host: hosted.host,
      store,
      params,
      startGame: () => hosted.host.startGame(generateSeed()),
    };
  }

  const session = joinGame<GameState>({
    transport,
    engine: gameEngine as unknown as EngineAdapter<GameState>,
    store,
    identity,
    ...(resume ? { resume: { gameId: resume.gameId, lastSeq: resume.lastSeq, state: resume.state } } : {}),
  });
  transport.onEvent((ev) => {
    if ((ev.type === 'player-rejoined' || ev.type === 'player-joined') && ev.playerId === 0) {
      // host page reload: re-introduce ourselves so it can resync us
      session.resendHello();
    }
  });
  return {
    transport,
    session,
    host: null,
    store,
    params,
    startGame: () => {
      throw new Error('only the host can start');
    },
  };
}
