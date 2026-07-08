// GameSession: the engine<->UI boundary. One per local player. Folds accepted
// commands into the authoritative state, maintains an optimistic "planned"
// state (authoritative + locally pending commands), persists the log, and
// surfaces everything the UI needs through a version counter + events.

import type { EngineAdapter, GameStartPayload } from './engineAdapter';
import type { HostLink } from './link';
import type { GameSettings, HostToClient, LogCommand, PlayerRoster } from './messages';
import { PROTOCOL_VERSION } from './messages';
import type { GameStore } from '@storage/repo';

const SNAPSHOT_EVERY_TURNS = 10;

export type SessionEvent =
  | { type: 'lobby' }
  | { type: 'started' }
  | { type: 'state' }
  | { type: 'turn-advanced'; turn: number }
  | { type: 'commit-status'; turn: number; committed: number[] }
  | { type: 'rejected'; clientId: string; reason: string }
  | { type: 'chat'; id: number; turn: number; from: number; to: number; text: string }
  | { type: 'desync'; turn: number }
  | { type: 'version-reject'; reason: string };

interface PendingCommand {
  clientId: string;
  turn: number;
  kind: string;
  payload: unknown;
}

export interface SessionOptions<S> {
  link: HostLink;
  engine: EngineAdapter<S>;
  store: GameStore | null;
  playerId: number;
  name: string;
  engineVersion: string;
  dataVersion: string;
  roomCode: string;
  lobbyServer: string;
  /** Resume state: highest seq already folded from local storage. */
  resume?: { gameId: string; lastSeq: number; state: S | null };
}

/** All peers derive the same game id from the shared seed. */
export function gameIdFromSeed(seed: string): string {
  return `g-${seed.slice(0, 16)}`;
}

export class GameSession<S> {
  readonly playerId: number;
  gameId: string | null = null;

  private link: HostLink;
  private readonly engine: EngineAdapter<S>;
  private readonly store: GameStore | null;
  private readonly name: string;
  private readonly engineVersion: string;
  private readonly dataVersion: string;
  private readonly roomCode: string;
  private readonly lobbyServer: string;

  private authState: S | null = null;
  private lastSeq = -1;
  private pending: PendingCommand[] = [];
  private plannedCache: S | null = null;
  private plannedDirty = false;
  private version = 0;
  private clientIdCounter = 0;

  private rosterCache: PlayerRoster[] = [];
  private settingsCache: GameSettings | null = null;
  private committedCache: number[] = [];
  private startedFlag = false;
  private listeners: Array<(ev: SessionEvent) => void> = [];
  private persistChain: Promise<void> = Promise.resolve();

  constructor(opts: SessionOptions<S>) {
    this.link = opts.link;
    this.engine = opts.engine;
    this.store = opts.store;
    this.playerId = opts.playerId;
    this.name = opts.name;
    this.engineVersion = opts.engineVersion;
    this.dataVersion = opts.dataVersion;
    this.roomCode = opts.roomCode;
    this.lobbyServer = opts.lobbyServer;
    if (opts.resume) {
      this.gameId = opts.resume.gameId;
      this.lastSeq = opts.resume.lastSeq;
      this.authState = opts.resume.state;
      this.startedFlag = opts.resume.state !== null;
    }
    this.link.onMessage((msg) => this.onHostMessage(msg));
    this.hello();
  }

  // ----- outbound -----

  private hello(): void {
    this.link.send({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: this.engineVersion,
      dataVersion: this.dataVersion,
      name: this.name,
      haveSeq: this.lastSeq,
    });
  }

  setRaceConfig(raceJson: string | null, ready: boolean): void {
    this.link.send({ t: 'race_config', raceJson, ready, name: this.name });
  }

  submit(kind: string, payload: unknown): { clientId: string; error?: string } {
    const turn = this.authState ? this.engine.turnOf(this.authState) : 0;
    const clientId = `${this.playerId}:${++this.clientIdCounter}`;
    const probe: LogCommand = { seq: -1, turn, playerId: this.playerId, kind, payload };
    const planned = this.getPlanned();
    if (planned) {
      const err = this.engine.validate(planned, probe);
      if (err) return { clientId, error: err };
    }
    this.pending.push({ clientId, turn, kind, payload });
    this.plannedDirty = true;
    this.bump({ type: 'state' });
    this.link.send({ t: 'cmd_submit', clientId, turn, kind, payload });
    return { clientId };
  }

  retract(clientId: string): void {
    // local-only convenience before the host accepts; if already accepted the
    // acceptance wins (there is no unsubmit in the log)
    this.pending = this.pending.filter((p) => p.clientId !== clientId);
    this.plannedDirty = true;
    this.bump({ type: 'state' });
  }

  commitTurn(): void {
    const turn = this.authState ? this.engine.turnOf(this.authState) : 0;
    this.link.send({ t: 'commit_turn', turn });
  }

  uncommitTurn(): void {
    const turn = this.authState ? this.engine.turnOf(this.authState) : 0;
    this.link.send({ t: 'uncommit_turn', turn });
  }

  sendChat(text: string, to = -1): void {
    this.link.send({ t: 'chat_send', text, to });
  }

  requestResync(): void {
    this.link.send({ t: 'resync_request', haveSeq: this.lastSeq });
  }

  // ----- inbound -----

  private onHostMessage(msg: HostToClient): void {
    switch (msg.t) {
      case 'welcome': {
        this.rosterCache = msg.players;
        this.settingsCache = msg.settings;
        this.startedFlag = msg.started || this.startedFlag;
        // host will push resync if we're behind; nothing else to do
        this.bump({ type: 'lobby' });
        return;
      }
      case 'version_reject': {
        this.bump({ type: 'version-reject', reason: msg.reason });
        return;
      }
      case 'lobby_update': {
        this.rosterCache = msg.players;
        this.settingsCache = msg.settings;
        this.bump({ type: 'lobby' });
        return;
      }
      case 'cmd_accept': {
        this.ingest(msg.cmd, msg.clientId);
        return;
      }
      case 'cmd_reject': {
        this.pending = this.pending.filter((p) => p.clientId !== msg.clientId);
        this.plannedDirty = true;
        this.bump({ type: 'rejected', clientId: msg.clientId, reason: msg.reason });
        return;
      }
      case 'commit_status': {
        this.committedCache = msg.committed;
        this.bump({ type: 'commit-status', turn: msg.turn, committed: msg.committed });
        return;
      }
      case 'resync_data': {
        if (msg.snapshot && msg.snapshot.seq > this.lastSeq) {
          this.authState = this.engine.deserialize(msg.snapshot.stateJson);
          this.lastSeq = msg.snapshot.seq;
          this.startedFlag = true;
        }
        for (const cmd of msg.commands) this.ingest(cmd, undefined, true);
        this.bump({ type: 'state' });
        return;
      }
      case 'desync_notice': {
        // authoritative recovery: drop local state and refetch everything
        this.authState = null;
        this.lastSeq = -1;
        this.startedFlag = false;
        this.bump({ type: 'desync', turn: msg.turn });
        this.requestResync();
        return;
      }
      case 'chat_deliver': {
        if (this.store && this.gameId) {
          const gameId = this.gameId;
          this.persist(() =>
            this.store!.appendChat(gameId, {
              id: msg.id,
              turn: msg.turn,
              from: msg.from,
              to: msg.to,
              text: msg.text,
              sentAt: new Date().toISOString(),
            }),
          );
        }
        this.bump({ type: 'chat', id: msg.id, turn: msg.turn, from: msg.from, to: msg.to, text: msg.text });
        return;
      }
      default:
        return;
    }
  }

  private ingest(cmd: LogCommand, clientId?: string, quiet = false): void {
    if (cmd.seq <= this.lastSeq) return; // duplicate
    if (cmd.seq > this.lastSeq + 1) {
      // missed a window (e.g. while our peer link was rebuilding)
      this.requestResync();
      return;
    }
    if (cmd.kind === 'game_start') {
      const start = cmd.payload as GameStartPayload;
      this.authState = this.engine.init(start);
      this.startedFlag = true;
      this.gameId = gameIdFromSeed(start.seed);
      if (this.store) this.persist(() => this.ensureGameRow(start));
    } else if (this.authState) {
      this.authState = this.engine.apply(this.authState, cmd);
    }
    this.lastSeq = cmd.seq;

    if (clientId) this.pending = this.pending.filter((p) => p.clientId !== clientId);
    // prune pending commands from stale turns
    const turn = this.authState ? this.engine.turnOf(this.authState) : 0;
    this.pending = this.pending.filter((p) => p.turn >= turn);
    this.plannedDirty = true;

    if (this.store && this.gameId) {
      const gameId = this.gameId;
      const record = {
        seq: cmd.seq,
        turn: cmd.turn,
        playerId: cmd.playerId,
        kind: cmd.kind,
        payload: cmd.payload,
      };
      this.persist(() => this.store!.appendCommands(gameId, [record]));
    }

    if (cmd.kind === 'game_start') {
      this.bump({ type: 'started' });
    } else if (cmd.kind === 'advance_turn' && this.authState) {
      const newTurn = this.engine.turnOf(this.authState);
      const hash = this.engine.hash(this.authState);
      this.link.send({ t: 'hash_report', turn: newTurn - 1, hash });
      if (this.store && this.gameId) {
        const gameId = this.gameId;
        this.persist(() => this.store!.saveTurnHash(gameId, newTurn - 1, hash));
        if ((newTurn - 1) % SNAPSHOT_EVERY_TURNS === 0) {
          const json = this.engine.serialize(this.authState);
          this.persist(() => this.store!.saveSnapshot(gameId, newTurn - 1, cmd.seq, json, hash));
        }
      }
      if (!quiet) this.bump({ type: 'turn-advanced', turn: newTurn });
    }
    if (!quiet) this.bump({ type: 'state' });
  }

  private async ensureGameRow(start: GameStartPayload): Promise<void> {
    if (!this.store || !this.gameId) return;
    const existing = await this.store.getGame(this.gameId);
    if (existing) {
      if (existing.seed === start.seed) return; // resume of the same game
      await this.store.deleteGame(this.gameId);
    }
    await this.store.createGame(
      {
        gameId: this.gameId,
        engineVersion: this.engineVersion,
        dataVersion: this.dataVersion,
        protocolVersion: PROTOCOL_VERSION,
        settings: start.settings as unknown,
        seed: start.seed,
        localPlayerId: this.playerId,
        lobbyServer: this.lobbyServer,
        roomCode: this.roomCode,
      },
      start.players.map((p) => ({ id: p.id, name: p.name })),
    );
    await this.store.setGameStatus(this.gameId, 'active');
  }

  private persist(fn: () => Promise<unknown>): void {
    this.persistChain = this.persistChain.then(fn).catch((e) => {
      console.error('[session] persistence error:', e);
    });
  }

  /** Await outstanding persistence (tests / graceful shutdown). */
  flush(): Promise<void> {
    return this.persistChain.then(() => undefined);
  }

  // ----- reads -----

  getState(): S | null {
    return this.authState;
  }

  getPlanned(): S | null {
    if (!this.authState) return null;
    if (!this.plannedDirty && this.plannedCache) return this.plannedCache;
    let s = this.authState;
    const turn = this.engine.turnOf(s);
    for (const p of this.pending) {
      if (p.turn !== turn) continue;
      const cmd: LogCommand = { seq: -1, turn: p.turn, playerId: this.playerId, kind: p.kind, payload: p.payload };
      if (this.engine.validate(s, cmd) === null) {
        s = this.engine.apply(s, cmd);
      }
    }
    this.plannedCache = s;
    this.plannedDirty = false;
    return s;
  }

  getVersion(): number {
    return this.version;
  }

  getRoster(): readonly PlayerRoster[] {
    return this.rosterCache;
  }

  getSettings(): GameSettings | null {
    return this.settingsCache;
  }

  getCommitted(): readonly number[] {
    return this.committedCache;
  }

  isStarted(): boolean {
    return this.startedFlag;
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  subscribe(cb: (ev: SessionEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private bump(ev: SessionEvent): void {
    this.version++;
    for (const l of [...this.listeners]) l(ev);
  }
}
