// HostCore: the single sequencer (runs only on player 0's machine). Assigns
// gapless global sequence numbers, validates player commands against the
// authoritative state, broadcasts acceptances, decides turn advancement, and
// serves resyncs. Persistence of the log is the host session's job (single
// writer); HostCore keeps the full log in memory for resync serving.

import type { EngineAdapter, GameStartPayload } from './engineAdapter';
import { LocalHostLink } from './link';
import {
  PROTOCOL_VERSION,
  type ClientToHost,
  type GameSettings,
  type HostToClient,
  type LogCommand,
  type PlayerRoster,
} from './messages';
import type { NetTransport } from './transport';

interface Seat {
  name: string;
  ready: boolean;
  raceJson: string | null;
  connected: boolean;
  hello: boolean;
}

export interface HostCoreOptions<S> {
  transport: NetTransport;
  engine: EngineAdapter<S>;
  gameId: string;
  settings: GameSettings;
  engineVersion: string;
  dataVersion: string;
  hostName: string;
  /** resume from an existing log (page reload) */
  resumeLog?: LogCommand[];
}

export class HostCore<S> {
  readonly localLink: LocalHostLink;
  private readonly transport: NetTransport;
  private readonly engine: EngineAdapter<S>;
  private readonly gameId: string;
  private settings: GameSettings;
  private readonly engineVersion: string;
  private readonly dataVersion: string;

  private seats = new Map<number, Seat>();
  private log: LogCommand[] = [];
  private lastSeq = -1;
  private state: S | null = null;
  private committed = new Set<number>();
  private chatSeq = -1;
  private turnHashes = new Map<number, string>();
  private unsubs: Array<() => void> = [];

  constructor(opts: HostCoreOptions<S>) {
    this.transport = opts.transport;
    this.engine = opts.engine;
    this.gameId = opts.gameId;
    this.settings = opts.settings;
    this.engineVersion = opts.engineVersion;
    this.dataVersion = opts.dataVersion;
    this.localLink = new LocalHostLink((msg) => this.route(0, msg));

    this.seats.set(0, {
      name: opts.hostName,
      ready: false,
      raceJson: null,
      connected: true,
      hello: true,
    });

    if (opts.resumeLog?.length) {
      for (const cmd of opts.resumeLog) this.fold(cmd);
    }

    this.unsubs.push(this.transport.onMessage((from, msg) => this.route(from, msg as ClientToHost)));
    this.unsubs.push(
      this.transport.onEvent((ev) => {
        if (ev.type === 'player-left') {
          const seat = this.seats.get(ev.playerId);
          if (seat) seat.connected = false;
          this.broadcastLobby();
        } else if (ev.type === 'player-rejoined' || ev.type === 'player-joined') {
          const seat = this.seats.get(ev.playerId);
          if (seat) seat.connected = true;
          // roster broadcast happens after their hello
        }
      }),
    );
  }

  get started(): boolean {
    return this.log.length > 0;
  }

  getLog(): readonly LogCommand[] {
    return this.log;
  }

  close(): void {
    for (const u of this.unsubs) u();
  }

  // ----- message routing -----

  private route(from: number, msg: ClientToHost): void {
    switch (msg.t) {
      case 'hello':
        return this.onHello(from, msg);
      case 'race_config':
        return this.onRaceConfig(from, msg);
      case 'cmd_submit':
        return this.onSubmit(from, msg);
      case 'commit_turn':
        return this.onCommit(from, msg.turn, true);
      case 'uncommit_turn':
        return this.onCommit(from, msg.turn, false);
      case 'hash_report':
        return this.onHashReport(from, msg);
      case 'resync_request':
        return this.sendResync(from, msg.haveSeq);
      case 'chat_send':
        return this.onChat(from, msg);
      default:
        return;
    }
  }

  private sendTo(playerId: number, msg: HostToClient): void {
    if (playerId === 0) {
      this.localLink._deliver(msg);
      return;
    }
    void this.transport.send(playerId, msg).catch(() => {
      // unreachable peer resyncs on rejoin
    });
  }

  private broadcast(msg: HostToClient): void {
    for (const id of this.seats.keys()) this.sendTo(id, msg);
  }

  // ----- lobby -----

  private roster(): PlayerRoster[] {
    return [...this.seats.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, s]) => ({
        id,
        name: s.name,
        ready: s.ready,
        connected: s.connected,
        raceJson: s.raceJson,
      }));
  }

  private broadcastLobby(): void {
    this.broadcast({ t: 'lobby_update', players: this.roster(), settings: this.settings });
  }

  private onHello(from: number, msg: Extract<ClientToHost, { t: 'hello' }>): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      return this.sendTo(from, {
        t: 'version_reject',
        reason: `protocol ${msg.protocolVersion} != ${PROTOCOL_VERSION}`,
      });
    }
    if (msg.dataVersion !== this.dataVersion) {
      return this.sendTo(from, {
        t: 'version_reject',
        reason: `data version mismatch (host ${this.dataVersion}, you ${msg.dataVersion})`,
      });
    }
    const seat: Seat = this.seats.get(from) ?? {
      name: msg.name,
      ready: false,
      raceJson: null,
      connected: true,
      hello: true,
    };
    seat.name = msg.name || seat.name;
    seat.connected = true;
    seat.hello = true;
    this.seats.set(from, seat);
    this.sendTo(from, {
      t: 'welcome',
      gameId: this.gameId,
      settings: this.settings,
      players: this.roster(),
      lastSeq: this.lastSeq,
      started: this.started,
    });
    if (this.started && msg.haveSeq < this.lastSeq) {
      this.sendResync(from, msg.haveSeq);
    }
    this.broadcastLobby();
    if (this.started) {
      this.sendTo(from, { t: 'commit_status', turn: this.currentTurn(), committed: [...this.committed] });
    }
  }

  private onRaceConfig(from: number, msg: Extract<ClientToHost, { t: 'race_config' }>): void {
    if (this.started) return;
    const seat = this.seats.get(from);
    if (!seat) return;
    seat.raceJson = msg.raceJson;
    seat.ready = msg.ready;
    if (msg.name) seat.name = msg.name;
    this.broadcastLobby();
  }

  updateSettings(settings: GameSettings): void {
    if (this.started) return;
    this.settings = settings;
    this.broadcastLobby();
  }

  /** Host-triggered game start; seq 0 is the game_start system command. */
  startGame(seed: string): void {
    if (this.started) throw new Error('already started');
    const payload: GameStartPayload = {
      seed,
      settings: this.settings,
      players: this.roster().map((p) => ({ id: p.id, name: p.name, raceJson: p.raceJson })),
      dataVersion: this.dataVersion,
    };
    this.accept({ turn: 0, playerId: -1, kind: 'game_start', payload });
  }

  // ----- sequencing -----

  private currentTurn(): number {
    return this.state ? this.engine.turnOf(this.state) : 0;
  }

  private fold(cmd: LogCommand): void {
    if (cmd.kind === 'game_start') {
      this.state = this.engine.init(cmd.payload as GameStartPayload);
    } else if (this.state) {
      this.state = this.engine.apply(this.state, cmd);
      if (cmd.kind === 'advance_turn' && this.state) {
        const t = this.engine.turnOf(this.state) - 1; // hash of the completed turn boundary
        this.turnHashes.set(t, this.engine.hash(this.state));
      }
    }
    this.log.push(cmd);
    this.lastSeq = cmd.seq;
  }

  private accept(partial: Omit<LogCommand, 'seq'>, clientId?: string, submitter?: number): void {
    const cmd: LogCommand = { ...partial, seq: this.lastSeq + 1 };
    this.fold(cmd);
    for (const id of this.seats.keys()) {
      // clientId only meaningful for the submitter's optimistic dedupe
      this.sendTo(id, { t: 'cmd_accept', cmd, ...(id === submitter && clientId ? { clientId } : {}) });
    }
  }

  private onSubmit(from: number, msg: Extract<ClientToHost, { t: 'cmd_submit' }>): void {
    if (!this.started || !this.state) {
      return this.sendTo(from, { t: 'cmd_reject', clientId: msg.clientId, reason: 'not started' });
    }
    const cmd: LogCommand = {
      seq: -1,
      turn: msg.turn,
      playerId: from,
      kind: msg.kind,
      payload: msg.payload,
    };
    const err = this.engine.validate(this.state, cmd);
    if (err) return this.sendTo(from, { t: 'cmd_reject', clientId: msg.clientId, reason: err });
    this.accept({ turn: msg.turn, playerId: from, kind: msg.kind, payload: msg.payload }, msg.clientId, from);
  }

  private onCommit(from: number, turn: number, committed: boolean): void {
    if (!this.started || turn !== this.currentTurn()) return;
    if (committed) this.committed.add(from);
    else this.committed.delete(from);
    this.broadcast({ t: 'commit_status', turn, committed: [...this.committed].sort((a, b) => a - b) });
    this.maybeAdvance();
  }

  private maybeAdvance(): void {
    if (!this.state) return;
    const seated = [...this.seats.keys()];
    if (seated.length < 1) return;
    if (!seated.every((id) => this.committed.has(id))) return;
    const turn = this.currentTurn();
    this.committed.clear();
    this.accept({
      turn,
      playerId: -1,
      kind: 'advance_turn',
      payload: this.engine.advancePayload(this.state),
    });
    this.broadcast({ t: 'commit_status', turn: this.currentTurn(), committed: [] });
  }

  private onHashReport(from: number, msg: Extract<ClientToHost, { t: 'hash_report' }>): void {
    const expected = this.turnHashes.get(msg.turn);
    if (expected && expected !== msg.hash) {
      this.sendTo(from, { t: 'desync_notice', turn: msg.turn, expected });
    }
  }

  private sendResync(to: number, haveSeq: number): void {
    // Phase 2: command tail only; snapshot-based fast resync arrives with the
    // real engine (session snapshots exist; host serves tail which is correct
    // regardless, just less efficient for very long games).
    const commands = this.log.filter((c) => c.seq > haveSeq);
    this.sendTo(to, { t: 'resync_data', snapshot: null, commands });
  }

  private onChat(from: number, msg: Extract<ClientToHost, { t: 'chat_send' }>): void {
    const text = msg.text.slice(0, 2000);
    if (!text) return;
    const deliver: HostToClient = {
      t: 'chat_deliver',
      id: ++this.chatSeq,
      turn: this.currentTurn(),
      from,
      to: msg.to,
      text,
    };
    if (msg.to === -1) this.broadcast(deliver);
    else {
      this.sendTo(msg.to, deliver);
      if (msg.to !== from) this.sendTo(from, deliver);
    }
  }
}
