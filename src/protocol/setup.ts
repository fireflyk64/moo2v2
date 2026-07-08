// Wiring helpers: create a hosted game (HostCore + host's own session over the
// local link) or join as a remote player (session over the transport link).

import type { EngineAdapter } from './engineAdapter';
import { HostCore } from './host';
import { RemoteHostLink } from './link';
import type { GameSettings, LogCommand } from './messages';
import { GameSession } from './session';
import type { NetTransport } from './transport';
import type { GameStore } from '@storage/repo';

export interface PeerIdentity {
  name: string;
  engineVersion: string;
  dataVersion: string;
  roomCode: string;
  lobbyServer: string;
}

export interface HostedGame<S> {
  host: HostCore<S>;
  session: GameSession<S>;
}

export function createHostedGame<S>(opts: {
  transport: NetTransport;
  engine: EngineAdapter<S>;
  store: GameStore | null;
  settings: GameSettings;
  identity: PeerIdentity;
  resume?: { gameId: string; log: LogCommand[] };
}): HostedGame<S> {
  const { transport, engine, store, settings, identity } = opts;
  if (transport.selfId !== 0) throw new Error('host must be player 0 (room creator)');
  const host = new HostCore<S>({
    transport,
    engine,
    gameId: opts.resume?.gameId ?? '',
    settings,
    engineVersion: identity.engineVersion,
    dataVersion: identity.dataVersion,
    hostName: identity.name,
    ...(opts.resume ? { resumeLog: opts.resume.log } : {}),
  });
  // The host's own session folds the same log (resume replays it locally).
  let resume: { gameId: string; lastSeq: number; state: S | null } | undefined;
  if (opts.resume) {
    let state: S | null = null;
    for (const cmd of opts.resume.log) {
      state =
        cmd.kind === 'game_start'
          ? engine.init(cmd.payload as never)
          : state
            ? engine.apply(state, cmd)
            : null;
    }
    resume = {
      gameId: opts.resume.gameId,
      lastSeq: opts.resume.log.length ? opts.resume.log[opts.resume.log.length - 1]!.seq : -1,
      state,
    };
  }
  const session = new GameSession<S>({
    link: host.localLink,
    engine,
    store,
    playerId: 0,
    name: identity.name,
    engineVersion: identity.engineVersion,
    dataVersion: identity.dataVersion,
    roomCode: identity.roomCode,
    lobbyServer: identity.lobbyServer,
    ...(resume ? { resume } : {}),
  });
  return { host, session };
}

export function joinGame<S>(opts: {
  transport: NetTransport;
  engine: EngineAdapter<S>;
  store: GameStore | null;
  identity: PeerIdentity;
  resume?: { gameId: string; lastSeq: number; state: S | null };
}): GameSession<S> {
  const link = new RemoteHostLink(opts.transport);
  return new GameSession<S>({
    link,
    engine: opts.engine,
    store: opts.store,
    playerId: opts.transport.selfId,
    name: opts.identity.name,
    engineVersion: opts.identity.engineVersion,
    dataVersion: opts.identity.dataVersion,
    roomCode: opts.identity.roomCode,
    lobbyServer: opts.identity.lobbyServer,
    ...(opts.resume ? { resume: opts.resume } : {}),
  });
}

/** 128-bit hex seed; uses crypto where available (never inside the engine). */
export function generateSeed(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
