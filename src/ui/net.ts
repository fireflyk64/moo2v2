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
import { MemoryGameStore, type GameStoreLike } from '@storage/memory';
import type { SQLocalKysely } from 'sqlocal/kysely';

export const DEFAULT_SERVER = 'https://pqrstuvw.xyz/lobbylink';

export interface RoomParams {
  server: string;
  code: string;
  name: string;
  playerCount: number;
  /** enable logged debug commands (testing) — host setting */
  debug?: boolean;
}

export interface ActiveGame {
  transport: LobbylinkTransport;
  session: GameSession<GameState>;
  host: HostCore<GameState> | null;
  store: GameStoreLike | null;
  sqlocal: SQLocalKysely | null;
  /** persistence is RAM-only: another tab holds this room's database (saves
   * still download fine, but nothing survives a reload of THIS tab) */
  memoryOnly: boolean;
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
  store: GameStoreLike,
  roomCode: string,
  engine: EngineAdapter<GameState>,
): Promise<ResumeInfo | null> {
  const games = await store.listGames();
  const g = games.find((x) => x.room_code === roomCode && x.status === 'active');
  if (!g) return null;
  if (g.engine_version !== ENGINE_VERSION || g.data_version !== DATA_VERSION) {
    // replaying an old log through a newer engine could silently diverge —
    // leave the stored game alone; the save-file loader knows how to rebase it
    console.warn(
      `[net] not auto-resuming ${g.game_id}: stored ${g.engine_version}/${g.data_version} vs build ${ENGINE_VERSION}/${DATA_VERSION}`,
    );
    return null;
  }
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

  let store: GameStoreLike | null = null;
  let sqlocal: SQLocalKysely | null = null;
  let memoryOnly = false;
  if (isOpfsLikelyAvailable()) {
    try {
      const opened = await openBrowserStore(`moo2v2-room-${params.code}.sqlite3`);
      // sqlocal silently falls back to a RAM database when another tab holds
      // the OPFS handle — detect that so the UI can tell the truth about it
      const info = await opened.sqlocal.getDatabaseInfo().catch(() => null);
      if (info && info.persisted === false) {
        await opened.store.destroy().catch(() => undefined);
        memoryOnly = true;
      } else {
        store = opened.store;
        sqlocal = opened.sqlocal;
      }
    } catch (e) {
      console.warn('[net] persistence unavailable (another tab in this room?):', e);
      memoryOnly = true;
    }
  } else {
    memoryOnly = true;
  }
  if (!store) {
    // multi-tab safety net: keep the whole game record in memory so a
    // verified save file can always be downloaded from this tab
    store = new MemoryGameStore();
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
      settings: { ...DEFAULT_SETTINGS, playerCount: params.playerCount, debugCommands: params.debug ?? false },
      identity,
      ...(resume && resume.log.length ? { resume: { gameId: resume.gameId, log: resume.log } } : {}),
    });
    return {
      transport,
      session: hosted.session,
      host: hosted.host,
      store,
      sqlocal,
      memoryOnly,
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
    sqlocal,
    memoryOnly,
    params,
    startGame: () => {
      throw new Error('only the host can start');
    },
  };
}
