// GameSession: the engine<->UI boundary. One per local player. Folds accepted
// commands into the authoritative state, maintains an optimistic "planned"
// state (authoritative + locally pending commands), persists the log, and
// surfaces everything the UI needs through a version counter + events.

import { bidHash } from './auction';
import type { EngineAdapter, GameStartPayload } from './engineAdapter';
import type { HostLink } from './link';
import type { GameSettings, HostToClient, LogCommand, PlayerRoster } from './messages';
import { FAST_MAX_AHEAD, PROTOCOL_VERSION } from './messages';
import type { SessionStore } from './persistence';

const SNAPSHOT_EVERY_TURNS = 10;

export type SessionEvent =
  | { type: 'lobby' }
  | { type: 'started' }
  | { type: 'state' }
  | { type: 'battle-phase' }
  | { type: 'turn-advanced'; turn: number }
  | { type: 'commit-status'; turn: number; committed: number[] }
  | { type: 'rejected'; clientId: string; reason: string }
  | { type: 'chat'; id: number; turn: number; from: number; to: number; text: string }
  | { type: 'desync'; turn: number }
  | { type: 'version-reject'; reason: string }
  | { type: 'auction'; phase: 'commit' | 'reveal' | 'done' }
  /** fast start: the local preview advanced a turn without the table */
  | { type: 'fast-advanced'; turn: number }
  /** fast start: End Turn refused — at the +10 cap over the slowest player */
  | { type: 'fast-cap'; turn: number; ahead: number }
  /** fast start: first contact — the preview was rewound to the synced turn */
  | { type: 'contact'; turn: number; pairs: Array<[number, number]> };

interface PendingCommand {
  clientId: string;
  turn: number;
  kind: string;
  payload: unknown;
}

export interface SessionOptions<S> {
  link: HostLink;
  engine: EngineAdapter<S>;
  /** Separate adapter instance for the fast-start preview branch (adapters
   * carry a mutable event buffer; sharing one would corrupt the authoritative
   * report flushes). Absent = the fast preview is disabled and End Turn falls
   * back to a plain commit. */
  branchEngine?: EngineAdapter<S>;
  store: SessionStore | null;
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
  /** empire seat we play — may be reassigned by the host's welcome (a resumed
   * game matches players to saved empires by name) */
  playerId: number;
  gameId: string | null = null;

  private link: HostLink;
  private readonly engine: EngineAdapter<S>;
  private readonly store: SessionStore | null;
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
  /** random per-session nonce inside clientIds: a reloaded tab restarts the
   * counter, and the host dedupes re-sent fast-phase buffers by clientId */
  private readonly clientNonce: string;

  // ----- fast start: the local preview branch -----
  private readonly branchEngine: EngineAdapter<S> | null;
  /** my commands for turns at/after the authoritative turn, in play order */
  private fastCmds: PendingCommand[] = [];
  /** highest turn ended locally (absolute turn number; -1 = none) */
  private fastEndedThrough = -1;
  /** host says my commits reach this turn but the commands live only in its
   * buffer (this tab reloaded): show the authoritative state and wait */
  private fastBlindThrough = -1;
  private fastCache: S | null = null;
  private fastDirty = true;
  /** events from the newest locally-previewed turn boundary */
  private fastEvents: Array<{ visibleTo: number; kind: string; payload: Record<string, unknown> }> = [];
  /** contact happened (authoritative): the fast phase is over for good */
  private contactSeen: { turn: number; pairs: Array<[number, number]> } | null = null;

  private rosterCache: PlayerRoster[] = [];
  private settingsCache: GameSettings | null = null;
  private auctionCache: {
    phase: 'commit' | 'reveal' | 'done';
    contested: Record<string, number[]>;
    bidders: number[];
    committed: boolean;
    outcomes: Array<{ pickId: string; winner: number | null; price: number }> | null;
  } | null = null;
  private pendingReveal: { bids: Record<string, number>; nonce: string } | null = null;
  private committedCache: number[] = [];
  /** fast phase: per-seat committed-through turns from the last commit_status */
  private fastTurnsCache: Record<string, number> = {};
  /** wall-clock ms when the host's auto-turn timer fires (null = not armed) */
  private autoTurnDeadline: number | null = null;
  private startedFlag = false;
  private listeners: Array<(ev: SessionEvent) => void> = [];
  private persistChain: Promise<void> = Promise.resolve();
  private lastReportedTurn = 0;
  /** pre-combat events drained on a battle-pausing advance_turn, prepended to
   * the boundary flush so combat turns don't lose their pre-combat reports */
  private stashedEvents: Array<{ visibleTo: number; kind: string; payload: Record<string, unknown> }> = [];
  /** deterministic events from the most recent turn resolution (for reports UI) */
  lastTurnEvents: Array<{ visibleTo: number; kind: string; payload: Record<string, unknown> }> = [];

  constructor(opts: SessionOptions<S>) {
    this.link = opts.link;
    this.engine = opts.engine;
    this.branchEngine = opts.branchEngine ?? null;
    const rand = new Uint32Array(1);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(rand);
    else rand[0] = Math.floor(Math.random() * 0x100000000);
    this.clientNonce = rand[0]!.toString(36);
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
    const clientId = `${this.playerId}:${this.clientNonce}:${++this.clientIdCounter}`;
    if (this.fastPhaseActive()) {
      // blind after a reload: the screen shows the authoritative state but
      // new orders would land on a future turn the player cannot see
      if (this.fastBlind()) {
        return { clientId, error: 'recovering your fast-forwarded turns — planning resumes when the sync catches up' };
      }
      // fast phase: orders target the PREVIEW turn and validate against the
      // preview state; the host buffers anything past the authoritative turn
      const turn = this.fastTurn();
      const probe: LogCommand = { seq: -1, turn, playerId: this.playerId, kind, payload };
      const preview = this.getPlanned();
      if (preview) {
        const err = this.engine.validate(preview, probe);
        if (err) return { clientId, error: err };
      }
      this.fastCmds.push({ clientId, turn, kind, payload });
      this.fastDirty = true;
      this.bump({ type: 'state' });
      this.link.send({ t: 'cmd_submit', clientId, turn, kind, payload });
      return { clientId };
    }
    const turn = this.authState ? this.engine.turnOf(this.authState) : 0;
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
    // acceptance wins (there is no unsubmit in the log). Fast phase: only the
    // still-open preview turn may retract — earlier turns are history the
    // host will replay.
    const open = this.fastTurn();
    this.fastCmds = this.fastCmds.filter((p) => p.clientId !== clientId || p.turn !== open);
    this.pending = this.pending.filter((p) => p.clientId !== clientId);
    this.plannedDirty = true;
    this.fastDirty = true;
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

  // ----- fast start (async turns until contact) -----

  /** The game was created in fast-start mode. */
  fastConfigured(): boolean {
    return !!this.settingsCache?.fastStart && this.branchEngine !== null;
  }

  /** The fast phase is running NOW: started, no contact, no winner. */
  fastPhaseActive(): boolean {
    if (!this.fastConfigured() || !this.authState || this.contactSeen) return false;
    if ((this.engine.winnerOf?.(this.authState) ?? null) !== null) return false;
    return (this.engine.contactPairs?.(this.authState) ?? []).length === 0;
  }

  /** The turn the local preview is planning (== authoritative turn when the
   * player is not ahead). */
  fastTurn(): number {
    const auth = this.authState ? this.engine.turnOf(this.authState) : 0;
    if (!this.fastPhaseActive()) return auth;
    return Math.max(auth, Math.max(this.fastEndedThrough, this.fastBlindThrough) + 1);
  }

  /** How many turns the preview runs ahead of the authoritative (slowest) sim. */
  fastAheadTurns(): number {
    const auth = this.authState ? this.engine.turnOf(this.authState) : 0;
    return Math.max(0, this.fastTurn() - auth);
  }

  /** Reloaded mid-fast-phase: the host holds our committed turns but this tab
   * lost the local copy — planning waits for the log to catch up. */
  fastBlind(): boolean {
    if (!this.fastPhaseActive() || !this.authState) return false;
    return this.fastBlindThrough >= this.engine.turnOf(this.authState);
  }

  /** Fast-phase End Turn: commit the preview turn to the host and advance the
   * local preview immediately — nobody is waited on. Returns false when
   * blocked (at the +10 cap over the slowest player, or blind after reload). */
  endTurnFast(): boolean {
    if (!this.fastPhaseActive() || !this.authState) {
      this.commitTurn();
      return true;
    }
    if (this.fastBlind()) return false;
    const turn = this.fastTurn();
    const auth = this.engine.turnOf(this.authState);
    if (turn - auth >= FAST_MAX_AHEAD) {
      this.bump({ type: 'fast-cap', turn, ahead: turn - auth });
      return false;
    }
    this.link.send({ t: 'commit_turn', turn });
    this.fastEndedThrough = Math.max(this.fastEndedThrough, turn);
    this.fastDirty = true;
    this.bump({ type: 'fast-advanced', turn: turn + 1 });
    this.bump({ type: 'state' });
    return true;
  }

  /** First contact / rewind: authoritative history is already correct — just
   * drop the whole preview buffer. Anything the host actually sequenced
   * arrives via cmd_accept and folds into the authoritative state regardless;
   * keeping local copies would show phantom orders the host discarded. */
  private onContact(turn: number, pairs: Array<[number, number]>): void {
    if (this.contactSeen) return;
    this.contactSeen = { turn, pairs };
    this.fastCmds = [];
    this.fastEndedThrough = -1;
    this.fastBlindThrough = -1;
    this.fastDirty = true;
    this.plannedDirty = true;
    this.fastEvents = [];
    void this.snapshotNow(); // a save-ready snapshot of the contact state
    this.bump({ type: 'contact', turn, pairs });
    this.bump({ type: 'state' });
  }

  /** Rebuild the preview: authoritative state + my buffered orders, advancing
   * locally through every turn I ended. NPC battles auto-resolve exactly as
   * the host will resolve them (same system commands, same seeds). */
  private rebuildFast(): S | null {
    if (!this.authState || !this.branchEngine) return this.authState;
    const eng = this.branchEngine;
    let s: S = this.authState;
    let t = this.engine.turnOf(s);
    let guard = 0;
    for (;;) {
      for (const c of this.fastCmds) {
        if (c.turn !== t) continue;
        const cmd: LogCommand = { seq: -1, turn: t, playerId: this.playerId, kind: c.kind, payload: c.payload };
        if (eng.validate(s, cmd) === null) s = eng.apply(s, cmd);
      }
      if (t > this.fastEndedThrough || guard++ > FAST_MAX_AHEAD + 2) break;
      // drain stale boundary events so fastEvents ends up holding only the
      // newest previewed boundary (mirrors the authoritative flush contract)
      eng.takeEvents?.();
      s = eng.apply(s, { seq: -1, turn: t, playerId: -1, kind: 'advance_turn', payload: { fromTurn: t } });
      let combatGuard = 0;
      while (eng.phaseOf?.(s) === 'battle_orders' && combatGuard++ < 8) {
        s = eng.apply(s, { seq: -1, turn: t, playerId: -1, kind: 'resolve_combat', payload: {} });
      }
      const nt = eng.turnOf(s);
      if (nt <= t) break; // no progress (should not happen): bail out safely
      t = nt;
    }
    this.fastEvents = eng.takeEvents?.() ?? [];
    return s;
  }

  sendChat(text: string, to = -1): void {
    this.link.send({ t: 'chat_send', text, to });
  }

  requestResync(): void {
    this.link.send({ t: 'resync_request', haveSeq: this.lastSeq });
  }

  /** Re-introduce ourselves (call when the host peer reconnects/restarts). */
  resendHello(): void {
    this.hello();
  }

  // ----- inbound -----

  private onHostMessage(msg: HostToClient): void {
    switch (msg.t) {
      case 'welcome': {
        this.rosterCache = msg.players;
        this.settingsCache = msg.settings;
        this.startedFlag = msg.started || this.startedFlag;
        if (typeof msg.seat === 'number' && msg.seat !== this.playerId) {
          this.playerId = msg.seat;
          this.plannedDirty = true;
        }
        // fast phase: a restarted host lost its buffers — re-send our
        // committed-through mark and every not-yet-sequenced buffered order
        // (the host dedupes by clientId, so a mere reconnect is harmless)
        if (this.fastPhaseActive() && this.authState) {
          const auth = this.engine.turnOf(this.authState);
          if (this.fastEndedThrough >= auth) {
            this.link.send({ t: 'commit_turn', turn: this.fastEndedThrough });
          }
          for (const c of this.fastCmds) {
            if (c.turn > auth) {
              this.link.send({ t: 'cmd_submit', clientId: c.clientId, turn: c.turn, kind: c.kind, payload: c.payload });
            }
          }
        }
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
        const nFast = this.fastCmds.length;
        this.fastCmds = this.fastCmds.filter((p) => p.clientId !== msg.clientId);
        if (this.fastCmds.length !== nFast) this.fastDirty = true;
        this.plannedDirty = true;
        this.bump({ type: 'rejected', clientId: msg.clientId, reason: msg.reason });
        return;
      }
      case 'commit_status': {
        this.committedCache = msg.committed;
        this.autoTurnDeadline = msg.autoTurnInMs !== undefined ? Date.now() + msg.autoTurnInMs : null;
        // fast phase: the host remembers commits this tab lost in a reload —
        // adopt them as "blind" turns and wait for the log to replay them
        this.fastTurnsCache = msg.fastTurns ?? {};
        if (msg.fastTurns && this.fastConfigured()) {
          const mine = msg.fastTurns[String(this.playerId)];
          if (mine !== undefined && mine > this.fastEndedThrough && mine > this.fastBlindThrough) {
            this.fastBlindThrough = mine;
            this.fastDirty = true;
          }
        }
        this.bump({ type: 'commit-status', turn: msg.turn, committed: msg.committed });
        return;
      }
      case 'contact_notice': {
        this.onContact(msg.turn, msg.pairs);
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
      case 'auction_begin': {
        this.auctionCache = {
          phase: 'commit',
          contested: msg.contested,
          bidders: msg.bidders,
          committed: false,
          outcomes: null,
        };
        this.pendingReveal = null;
        this.bump({ type: 'auction', phase: 'commit' });
        return;
      }
      case 'auction_commits': {
        if (this.auctionCache) this.auctionCache = { ...this.auctionCache, phase: 'reveal' };
        // reveal automatically: the commits are now public, our bid is bound
        if (this.pendingReveal) {
          this.link.send({ t: 'auction_reveal', bids: this.pendingReveal.bids, nonce: this.pendingReveal.nonce });
        }
        this.bump({ type: 'auction', phase: 'reveal' });
        return;
      }
      case 'auction_result': {
        if (this.auctionCache) {
          this.auctionCache = { ...this.auctionCache, phase: 'done', outcomes: msg.outcomes };
        }
        this.pendingReveal = null;
        this.bump({ type: 'auction', phase: 'done' });
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

    if (clientId) {
      this.pending = this.pending.filter((p) => p.clientId !== clientId);
      this.fastCmds = this.fastCmds.filter((p) => p.clientId !== clientId);
    }
    // prune pending commands from stale turns
    const turn = this.authState ? this.engine.turnOf(this.authState) : 0;
    this.pending = this.pending.filter((p) => p.turn >= turn);
    this.fastCmds = this.fastCmds.filter((p) => p.turn >= turn);
    this.plannedDirty = true;
    this.fastDirty = true;

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
      // NEVER reset backwards: a resync refolds the log from scratch, and
      // resetting here made the session re-send the same mismatching
      // hash_report forever (the desync/full-resync loop of finding 54)
      const startTurn = this.authState ? this.engine.turnOf(this.authState) : 1;
      this.lastReportedTurn = Math.max(this.lastReportedTurn, startTurn);
      this.bump({ type: 'started' });
    } else if ((cmd.kind === 'advance_turn' || cmd.kind === 'resolve_combat') && this.authState) {
      const newTurn = this.engine.turnOf(this.authState);
      const events = [...this.stashedEvents, ...(this.engine.takeEvents?.() ?? [])];
      this.stashedEvents = [];
      const pausedForBattle =
        cmd.kind === 'advance_turn' && this.engine.phaseOf?.(this.authState) === 'battle_orders';
      if (pausedForBattle) {
        // hold the pre-combat events (research done, buildings, battle_pending
        // ...) for the boundary flush resolve_combat will trigger
        this.stashedEvents = events;
      } else if (events.length) {
        this.lastTurnEvents = events;
      }
      if (newTurn > this.lastReportedTurn) {
        // the turn boundary actually happened (advance may pause for battles)
        this.lastReportedTurn = newTurn;
        const hash = this.engine.hash(this.authState);
        this.link.send({ t: 'hash_report', turn: newTurn - 1, hash });
        if (this.store && this.gameId) {
          const gameId = this.gameId;
          if (events.length) {
            const rows = events.map((e, idx) => ({ idx, visibleTo: e.visibleTo, kind: e.kind, payload: e.payload }));
            this.persist(() => this.store!.appendTurnEvents(gameId, newTurn - 1, rows));
            for (const e of events) {
              if (e.kind === 'battle_replay') {
                const p = e.payload as { battleId: string; summary: unknown };
                const json = JSON.stringify(e.payload);
                this.persist(() => this.store!.saveBattleReplay(gameId, p.battleId, newTurn - 1, json, p.summary));
              }
            }
          }
          this.persist(() => this.store!.saveTurnHash(gameId, newTurn - 1, hash));
          if ((newTurn - 1) % SNAPSHOT_EVERY_TURNS === 0) {
            const json = this.engine.serialize(this.authState);
            this.persist(() => this.store!.saveSnapshot(gameId, newTurn - 1, cmd.seq, json, hash));
          }
        }
        if (!quiet) this.bump({ type: 'turn-advanced', turn: newTurn });
      } else if (!quiet && cmd.kind === 'advance_turn') {
        this.bump({ type: 'battle-phase' });
      }
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
    this.persistChain = this.persistChain
      .then(() => fn())
      .then(
        () => undefined,
        (e) => {
          console.error('[session] persistence error:', e);
        },
      );
  }

  /** Await outstanding persistence (tests / graceful shutdown). */
  flush(): Promise<void> {
    return this.persistChain.then(() => undefined);
  }

  /** Persist a snapshot of the CURRENT authoritative state (save-time base:
   * guarantees the exported file loads snapshot-first on any future build). */
  snapshotNow(): Promise<void> {
    if (!this.store || !this.gameId || !this.authState) return Promise.resolve();
    const gameId = this.gameId;
    const turn = this.engine.turnOf(this.authState);
    const seq = this.lastSeq;
    const json = this.engine.serialize(this.authState);
    const hash = this.engine.hash(this.authState);
    this.persist(() => this.store!.saveSnapshot(gameId, turn, seq, json, hash));
    return this.flush();
  }

  // ----- reads -----

  getState(): S | null {
    return this.authState;
  }

  getPlanned(): S | null {
    if (!this.authState) return null;
    if (this.fastPhaseActive() && !this.fastBlind()) {
      if (!this.fastDirty && this.fastCache) return this.fastCache;
      this.fastCache = this.rebuildFast();
      this.fastDirty = false;
      return this.fastCache;
    }
    if (!this.plannedDirty && this.plannedCache) return this.plannedCache;
    let s: S = this.authState;
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

  /** Sealed-bid pick auction state (pick-bidding mode), null outside one. */
  getAuction(): {
    phase: 'commit' | 'reveal' | 'done';
    contested: Record<string, number[]>;
    bidders: number[];
    committed: boolean;
    outcomes: Array<{ pickId: string; winner: number | null; price: number }> | null;
  } | null {
    return this.auctionCache;
  }

  /** Commit sealed bids for the contested picks we hold; the reveal is sent
   * automatically once every commit is public. */
  submitBids(bids: Record<string, number>): void {
    if (!this.auctionCache || this.auctionCache.phase !== 'commit' || this.auctionCache.committed) return;
    const rand = new Uint32Array(4);
    crypto.getRandomValues(rand);
    const nonce = [...rand].map((x) => x.toString(16)).join('');
    this.pendingReveal = { bids, nonce };
    this.auctionCache = { ...this.auctionCache, committed: true };
    this.link.send({ t: 'auction_commit', hash: bidHash(bids, nonce) });
    this.bump({ type: 'auction', phase: 'commit' });
  }

  getCommitted(): readonly number[] {
    return this.committedCache;
  }

  /** ms epoch when the host force-advances (auto-turn), or null. */
  getAutoTurnDeadline(): number | null {
    return this.autoTurnDeadline;
  }

  isStarted(): boolean {
    return this.startedFlag;
  }

  getPendingCount(): number {
    return this.pending.length + this.fastCmds.length;
  }

  /** Events from the newest locally-previewed turn (fast phase, when ahead). */
  getFastEvents(): ReadonlyArray<{ visibleTo: number; kind: string; payload: Record<string, unknown> }> {
    return this.fastEvents;
  }

  /** Fast phase: per-seat committed-through turns (host commit_status). */
  getFastTurns(): Readonly<Record<string, number>> {
    return this.fastTurnsCache;
  }

  /** Contact record once the fast phase ended (never cleared). */
  getContact(): { turn: number; pairs: Array<[number, number]> } | null {
    return this.contactSeen;
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
