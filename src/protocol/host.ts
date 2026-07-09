// HostCore: the single sequencer (runs only on player 0's machine). Assigns
// gapless global sequence numbers, validates player commands against the
// authoritative state, broadcasts acceptances, decides turn advancement, and
// serves resyncs. Persistence of the log is the host session's job (single
// writer); HostCore keeps the full log in memory for resync serving.

import type { EngineAdapter, GameStartPayload } from './engineAdapter';
import { findContested, resolveAuction, type AuctionOutcome } from './auction';
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

/** commit/reveal phase length for the sealed-bid pick auction */
export const AUCTION_PHASE_MS = 45_000;

export class HostCore<S> {
  readonly localLink: LocalHostLink;
  private readonly transport: NetTransport;
  private readonly engine: EngineAdapter<S>;
  private readonly gameId: string;
  private settings: GameSettings;
  private readonly engineVersion: string;
  private readonly dataVersion: string;

  private seats = new Map<number, Seat>();
  /** channel (transport peer id, or host-local link id) → empire seat. In a
   * fresh lobby channels and seats coincide; a game resumed from a save
   * matches each hello to a saved empire by name instead of join order. */
  private seatMap = new Map<number, number>();
  private localLinks = new Map<number, LocalHostLink>();
  private nextLocalChannel = 1000; // never collides with lobbylink peer ids
  private log: LogCommand[] = [];
  private lastSeq = -1;
  private state: S | null = null;
  private committed = new Set<number>();
  private chatSeq = -1;
  private turnHashes = new Map<number, string>();
  private unsubs: Array<() => void> = [];
  private battleTimer: ReturnType<typeof setTimeout> | null = null;
  private battleOrdersTimeoutMs = 60_000;
  /** true once any advance_turn is in the log (auto-turn eligibility) */
  private anyTurnAdvanced = false;
  private autoAdvancing = false;
  private auction: {
    seed: string;
    contested: Record<string, number[]>;
    bidders: number[];
    phase: 'commit' | 'reveal';
    commits: Map<number, string>;
    reveals: Map<number, { bids: Record<string, number>; nonce: string }>;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  constructor(opts: HostCoreOptions<S>) {
    this.transport = opts.transport;
    this.engine = opts.engine;
    this.gameId = opts.gameId;
    this.settings = opts.settings;
    this.battleOrdersTimeoutMs = opts.settings.battleOrdersTimeoutMs || 60_000;
    this.engineVersion = opts.engineVersion;
    this.dataVersion = opts.dataVersion;
    this.localLink = new LocalHostLink((msg) => this.route(0, msg));
    this.localLinks.set(0, this.localLink);

    this.seats.set(0, {
      name: opts.hostName,
      ready: false,
      raceJson: null,
      connected: true,
      hello: true,
    });

    if (opts.resumeLog?.length) {
      for (const cmd of opts.resumeLog) this.fold(cmd);
      this.battleOrdersTimeoutMs = this.settings.battleOrdersTimeoutMs || 60_000;
      this.checkBattlePhase(); // resumed mid battle-orders phase: restart the clock
      this.maybeAutoAdvance(); // resumed mid auto-turn fast-forward: keep going
    }

    this.unsubs.push(this.transport.onMessage((from, msg) => this.route(from, msg as ClientToHost)));
    this.unsubs.push(
      this.transport.onEvent((ev) => {
        const seatId = this.seatMap.get(ev.playerId);
        if (ev.type === 'player-left') {
          const seat = seatId !== undefined ? this.seats.get(seatId) : undefined;
          if (seat) seat.connected = false;
          this.broadcastLobby();
        } else if (ev.type === 'player-rejoined' || ev.type === 'player-joined') {
          const seat = seatId !== undefined ? this.seats.get(seatId) : undefined;
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
    if (this.battleTimer) clearTimeout(this.battleTimer);
  }

  // ----- message routing -----

  private route(from: number, msg: ClientToHost): void {
    if (msg.t === 'hello') return this.onHello(from, msg);
    const seat = this.seatMap.get(from);
    if (seat === undefined) return; // must hello (and get a seat) first
    switch (msg.t) {
      case 'race_config':
        return this.onRaceConfig(seat, msg);
      case 'cmd_submit':
        return this.onSubmit(seat, msg);
      case 'commit_turn':
        return this.onCommit(seat, msg.turn, true);
      case 'uncommit_turn':
        return this.onCommit(seat, msg.turn, false);
      case 'hash_report':
        return this.onHashReport(seat, msg);
      case 'resync_request':
        return this.sendResync(seat, msg.haveSeq);
      case 'chat_send':
        return this.onChat(seat, msg);
      case 'auction_commit':
        return this.onAuctionCommit(seat, msg.hash);
      case 'auction_reveal':
        return this.onAuctionReveal(seat, msg.bids, msg.nonce);
      default:
        return;
    }
  }

  private sendToChannel(channel: number, msg: HostToClient): void {
    const link = this.localLinks.get(channel);
    if (link) {
      link._deliver(msg);
      return;
    }
    void this.transport.send(channel, msg).catch(() => {
      // unreachable peer resyncs on rejoin
    });
  }

  private sendTo(seatId: number, msg: HostToClient): void {
    for (const [channel, seat] of this.seatMap) {
      if (seat === seatId) return this.sendToChannel(channel, msg);
    }
    // unclaimed seat (resumed game waiting for its player): nothing to send
  }

  /** Extra host-side channel for a locally driven session (a bot taking over
   * a seat). Its hello goes through normal seat matching by name. */
  createLocalLink(): LocalHostLink {
    const channel = this.nextLocalChannel++;
    const link = new LocalHostLink((msg) => this.route(channel, msg));
    this.localLinks.set(channel, link);
    return link;
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
    if (this.started && !this.seats.has(from)) {
      return this.sendTo(from, {
        t: 'version_reject',
        reason: 'game already started; seat not part of this game',
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

  /** Host-triggered game start; seq 0 is the game_start system command.
   * With pick bidding on, contested picks go to sealed-bid auction first. */
  startGame(seed: string): void {
    if (this.started) throw new Error('already started');
    if (this.settings.modes.pickBidding && !this.auction) {
      const contested = findContested(this.roster().map((p) => ({ id: p.id, raceJson: p.raceJson })));
      const bidders = [...new Set(Object.values(contested).flat())].sort((a, b) => a - b);
      if (bidders.length > 0) {
        this.auction = {
          seed,
          contested,
          bidders,
          phase: 'commit',
          commits: new Map(),
          reveals: new Map(),
          timer: null,
        };
        this.broadcast({ t: 'auction_begin', contested, bidders, deadlineMs: AUCTION_PHASE_MS });
        this.armAuctionTimer();
        return;
      }
    }
    this.beginGame(seed, null);
  }

  private beginGame(seed: string, auctionOutcomes: AuctionOutcome[] | null): void {
    if (this.auction?.timer) clearTimeout(this.auction.timer);
    this.auction = null;
    const payload: GameStartPayload = {
      seed,
      settings: this.settings,
      players: this.roster().map((p) => ({ id: p.id, name: p.name, raceJson: p.raceJson })),
      dataVersion: this.dataVersion,
      ...(auctionOutcomes ? { auction: auctionOutcomes } : {}),
    };
    this.accept({ turn: 0, playerId: -1, kind: 'game_start', payload });
  }

  // ----- sealed-bid pick auction -----

  private armAuctionTimer(): void {
    if (!this.auction) return;
    if (this.auction.timer) clearTimeout(this.auction.timer);
    this.auction.timer = setTimeout(() => {
      if (!this.auction) return;
      this.auction.timer = null;
      if (this.auction.phase === 'commit') this.startRevealPhase();
      else this.finishAuction();
    }, AUCTION_PHASE_MS);
  }

  private onAuctionCommit(from: number, hash: string): void {
    if (!this.auction || this.auction.phase !== 'commit') return;
    if (!this.auction.bidders.includes(from) || this.auction.commits.has(from)) return;
    this.auction.commits.set(from, hash);
    if (this.auction.commits.size >= this.auction.bidders.length) this.startRevealPhase();
  }

  private startRevealPhase(): void {
    if (!this.auction) return;
    this.auction.phase = 'reveal';
    const hashes: Record<string, string> = {};
    for (const [id, h] of this.auction.commits) hashes[String(id)] = h;
    this.broadcast({ t: 'auction_commits', hashes, deadlineMs: AUCTION_PHASE_MS });
    this.armAuctionTimer();
  }

  private onAuctionReveal(from: number, bids: Record<string, number>, nonce: string): void {
    if (!this.auction || this.auction.phase !== 'reveal') return;
    if (!this.auction.commits.has(from) || this.auction.reveals.has(from)) return;
    this.auction.reveals.set(from, { bids, nonce });
    if (this.auction.reveals.size >= this.auction.commits.size) this.finishAuction();
  }

  private finishAuction(): void {
    if (!this.auction) return;
    const { seed, contested, commits, reveals } = this.auction;
    const result = resolveAuction({
      contested,
      players: this.roster().map((p) => ({ id: p.id, raceJson: p.raceJson })),
      reveals,
      commits,
    });
    // losers' race configs are rewritten before game_start records them
    for (const [idStr, raceJson] of Object.entries(result.players)) {
      const seat = this.seats.get(Number(idStr));
      if (seat) seat.raceJson = raceJson;
    }
    this.broadcast({ t: 'auction_result', outcomes: result.outcomes, players: result.players });
    this.beginGame(seed, result.outcomes);
  }

  // ----- sequencing -----

  private currentTurn(): number {
    return this.state ? this.engine.turnOf(this.state) : 0;
  }

  private fold(cmd: LogCommand): void {
    if (cmd.kind === 'game_start') {
      const start = cmd.payload as GameStartPayload;
      this.state = this.engine.init(start);
      this.settings = start.settings;
      // Seat roster is part of game_start so a resumed host (fresh HostCore
      // folding the persisted log) still broadcasts to every player.
      for (const p of start.players) {
        const existing = this.seats.get(p.id);
        this.seats.set(p.id, {
          name: p.name,
          ready: true,
          raceJson: p.raceJson,
          connected: existing?.connected ?? p.id === 0,
          hello: existing?.hello ?? p.id === 0,
        });
      }
    } else if (this.state) {
      this.state = this.engine.apply(this.state, cmd);
      if (cmd.kind === 'advance_turn' && this.state) {
        this.anyTurnAdvanced = true;
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
    this.checkBattlePhase();
  }

  /** battle_orders sub-phase driver: when resolution paused for orders, emit
   * resolve_combat once every battle has both sides' orders, or on timeout
   * (the engine substitutes defaults for missing orders). */
  private checkBattlePhase(): void {
    if (!this.state || !this.engine.pendingBattles || !this.engine.phaseOf) return;
    if (this.engine.phaseOf(this.state) !== 'battle_orders') {
      if (this.battleTimer) {
        clearTimeout(this.battleTimer);
        this.battleTimer = null;
      }
      return;
    }
    const battles = this.engine.pendingBattles(this.state);
    const allReady = battles.every((b) => b.ordersA !== null && b.ordersD !== null);
    if (allReady) {
      if (this.battleTimer) {
        clearTimeout(this.battleTimer);
        this.battleTimer = null;
      }
      this.accept({ turn: this.currentTurn(), playerId: -1, kind: 'resolve_combat', payload: {} });
      this.broadcast({ t: 'commit_status', turn: this.currentTurn(), committed: [] });
      this.maybeAutoAdvance();
      return;
    }
    if (!this.battleTimer) {
      this.battleTimer = setTimeout(() => {
        this.battleTimer = null;
        if (this.state && this.engine.phaseOf && this.engine.phaseOf(this.state) === 'battle_orders') {
          this.accept({ turn: this.currentTurn(), playerId: -1, kind: 'resolve_combat', payload: {} });
          this.broadcast({ t: 'commit_status', turn: this.currentTurn(), committed: [] });
          this.maybeAutoAdvance();
        }
      }, this.battleOrdersTimeoutMs);
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
    if (this.engine.phaseOf && this.engine.phaseOf(this.state) !== 'planning') return;
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
    this.maybeAutoAdvance();
  }

  /** Auto-turn mode: once the table has advanced a turn together, keep
   * advancing automatically until settings.autoTurnUntil (early-game skip).
   * Battles still pause for orders; auto-advance resumes after resolution. */
  private maybeAutoAdvance(): void {
    const until = this.settings.autoTurnUntil ?? 0;
    if (until <= 0 || !this.anyTurnAdvanced || this.autoAdvancing) return;
    this.autoAdvancing = true;
    try {
      while (
        this.state &&
        this.currentTurn() < until &&
        (!this.engine.phaseOf || this.engine.phaseOf(this.state) === 'planning')
      ) {
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
    } finally {
      this.autoAdvancing = false;
    }
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
