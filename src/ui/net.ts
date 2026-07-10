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
import { MemoryHub } from '@protocol/memoryTransport';
import { DEFAULT_SETTINGS, type LogCommand } from '@protocol/messages';
import { createHostedGame, generateSeed, joinGame } from '@protocol/setup';
import { GameSession } from '@protocol/session';
import type { NetTransport } from '@protocol/transport';
import { SoloBot, type BotMode, type BotPersonality } from './soloBot';
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
  transport: Pick<NetTransport, 'close' | 'onEvent' | 'selfId'>;
  session: GameSession<GameState>;
  host: HostCore<GameState> | null;
  store: GameStoreLike | null;
  sqlocal: SQLocalKysely | null;
  /** persistence is RAM-only: browser storage is unavailable to this tab
   * (saves still download fine, but nothing survives a reload) */
  memoryOnly: boolean;
  params: RoomParams;
  startGame: () => void;
  /** single-player mode: the bot opponent (aggression toggle lives here) */
  solo: SoloBot | null;
  /** bots subbed in for absent players (host only; name-matched to seats) */
  bots: SoloBot[];
  /** play-by-mail session info (set by enterPbmGame); null in normal games */
  pbm: {
    role: 'host' | 'guest';
    note: string;
    /** final upload + lock release; called by leaveGame */
    stop: () => Promise<void>;
  } | null;
}

/** Host-side: let a bot take over an absent player's seat. The bot helloes
 * with the seat's name, so the host's name matching hands it that empire. */
export function addBotForSeat(active: ActiveGame, seatName: string, mode: BotMode = 'fair'): SoloBot | null {
  if (!active.host) return null;
  const link = active.host.createLocalLink();
  const session = new GameSession<GameState>({
    link,
    engine: gameEngine as unknown as EngineAdapter<GameState>,
    store: null, // the host's own session already records the game
    playerId: -1, // the host's welcome assigns the real seat
    name: seatName,
    engineVersion: ENGINE_VERSION,
    dataVersion: DATA_VERSION,
    roomCode: active.params.code,
    lobbyServer: active.params.server,
  });
  const bot = new SoloBot({ session, mode, personality: 'auto' });
  active.bots.push(bot);
  return bot;
}

/** Host-side: retire a stand-in bot and free its seat for the returning human. */
export function removeBotForSeat(active: ActiveGame, bot: SoloBot): void {
  bot.close();
  if (active.host && bot.seatId >= 0) active.host.releaseSeat(bot.seatId);
  active.bots = active.bots.filter((b) => b !== bot);
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

/** Open the room's OPFS database, detecting sqlocal's silent RAM fallback.
 * The fallback swaps in a memory driver (storageType 'memory') — that is the
 * signal that nothing will survive a reload. Note: the `persisted` flag is
 * just navigator.storage.persisted(), a browser permission that is false for
 * nearly everyone — it must NOT be used for this. */
async function openRoomStore(
  roomCode: string,
): Promise<{ store: GameStoreLike; sqlocal: SQLocalKysely | null; memoryOnly: boolean }> {
  if (isOpfsLikelyAvailable()) {
    try {
      const opened = await openBrowserStore(`moo2v2-room-${roomCode}.sqlite3`);
      const info = await opened.sqlocal.getDatabaseInfo().catch(() => null);
      if (info && (info.storageType === 'memory' || info.databasePath === ':memory:')) {
        await opened.store.destroy().catch(() => undefined);
      } else {
        return { store: opened.store, sqlocal: opened.sqlocal, memoryOnly: false };
      }
    } catch (e) {
      console.warn('[net] persistence unavailable:', e);
    }
  }
  // safety net: keep the whole game record in memory so a verified save file
  // can always be downloaded from this tab
  return { store: new MemoryGameStore(), sqlocal: null, memoryOnly: true };
}

export async function enterRoom(params: RoomParams): Promise<ActiveGame> {
  const transport = await LobbylinkTransport.connect({
    server: params.server,
    code: params.code,
    maxPlayers: params.playerCount,
  });

  const { store, sqlocal, memoryOnly } = await openRoomStore(params.code);

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
      solo: null,
      bots: [],
      pbm: null,
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
    solo: null,
    bots: [],
    pbm: null,
  };
}

/** Single-player mode: an in-process game against the simple bot — no
 * lobbylink server, no WebRTC. Persists like any room (code SOLO), so a
 * reload resumes the campaign. */
export async function enterSoloGame(
  name: string,
  botMode: BotMode = 'parity',
  personality: BotPersonality | 'auto' = 'militarist',
): Promise<ActiveGame> {
  const params: RoomParams = { server: 'local', code: 'SOLO', name, playerCount: 2 };
  const hub = new MemoryHub(2);
  const hostTransport = hub.join();
  const botTransport = hub.join();

  const { store, sqlocal, memoryOnly } = await openRoomStore(params.code);

  const identity = {
    name,
    engineVersion: ENGINE_VERSION,
    dataVersion: DATA_VERSION,
    roomCode: params.code,
    lobbyServer: params.server,
  };
  const resume = await loadResume(store, params.code, gameEngine as unknown as EngineAdapter<GameState>);

  const hosted = createHostedGame<GameState>({
    transport: hostTransport,
    engine: gameEngine as unknown as EngineAdapter<GameState>,
    store,
    // debugCommands power the parity bot's logged "grants" — the sim has no
    // bot cases; the fair bot never uses them
    settings: { ...DEFAULT_SETTINGS, playerCount: 2, debugCommands: botMode === 'parity' },
    identity,
    ...(resume && resume.log.length ? { resume: { gameId: resume.gameId, log: resume.log } } : {}),
  });
  const botSession = joinGame<GameState>({
    transport: botTransport,
    engine: gameEngine as unknown as EngineAdapter<GameState>,
    store: null, // the human's store records the game; the bot keeps nothing
    identity: { ...identity, name: 'Bot' },
  });
  const solo = new SoloBot({ session: botSession, mode: botMode, personality });

  return {
    transport: hostTransport,
    session: hosted.session,
    host: hosted.host,
    store,
    sqlocal,
    memoryOnly,
    params,
    startGame: () => hosted.host.startGame(generateSeed()),
    solo,
    bots: [],
    pbm: null,
  };
}
