// MemoryGameStore: a full in-RAM stand-in for GameStore, used when the
// per-room OPFS database is held by another tab (or OPFS is unavailable).
// The session persists into it exactly as it would into SQLite, so the
// Save button can always export a verified .moo2save — from any tab —
// even though nothing survives a reload (bugs.md: multi-tab save safety).

import { canonicalStringify } from '@engine/canonical';
import type { GameStore, CommandRecord, TurnEventRecord, ChatRecord, GameMeta, SaveEnvelope } from './repo';
import type { GamesTable, GamePlayersTable } from './schema';

/** The store surface the app actually uses (GameStore satisfies this). */
export type GameStoreLike = Pick<
  GameStore,
  | 'getGame'
  | 'listGames'
  | 'createGame'
  | 'setGameStatus'
  | 'deleteGame'
  | 'appendCommands'
  | 'readCommands'
  | 'latestSnapshot'
  | 'saveSnapshot'
  | 'saveTurnHash'
  | 'appendTurnEvents'
  | 'saveBattleReplay'
  | 'appendChat'
  | 'exportGame'
  | 'destroy'
>;

interface MemGame {
  row: GamesTable;
  players: GamePlayersTable[];
  commands: CommandRecord[];
  snapshots: Map<number, { seq: number; stateJson: string; stateHash: string }>;
  turnHashes: Map<number, string>;
  events: Array<{ turn: number; rec: TurnEventRecord }>;
  replays: Map<string, { turn: number; replayJson: string; summary: unknown }>;
  chat: ChatRecord[];
}

export class MemoryGameStore implements GameStoreLike {
  /** UI marker: this store cannot survive a reload */
  readonly memoryOnly = true;
  private games = new Map<string, MemGame>();

  async destroy(): Promise<void> {
    this.games.clear();
  }

  private need(gameId: string): MemGame {
    const g = this.games.get(gameId);
    if (!g) throw new Error(`no such game: ${gameId}`);
    return g;
  }

  async createGame(meta: GameMeta, players: Array<{ id: number; name: string }>): Promise<void> {
    this.games.set(meta.gameId, {
      row: {
        game_id: meta.gameId,
        created_at: new Date().toISOString(),
        engine_version: meta.engineVersion,
        data_version: meta.dataVersion,
        protocol_version: meta.protocolVersion,
        settings_json: canonicalStringify(meta.settings),
        seed: meta.seed,
        local_player_id: meta.localPlayerId,
        lobby_server: meta.lobbyServer,
        room_code: meta.roomCode,
        status: 'setup',
        last_turn: 0,
        last_seq: -1,
      },
      players: players.map((p) => ({
        game_id: meta.gameId,
        player_id: p.id,
        name: p.name,
        race_json: null,
        is_host: p.id === 0 ? 1 : 0,
      })),
      commands: [],
      snapshots: new Map(),
      turnHashes: new Map(),
      events: [],
      replays: new Map(),
      chat: [],
    });
  }

  async getGame(gameId: string): Promise<GamesTable | undefined> {
    return this.games.get(gameId)?.row;
  }

  async listGames(): Promise<GamesTable[]> {
    return [...this.games.values()].map((g) => g.row);
  }

  async setGameStatus(gameId: string, status: GamesTable['status']): Promise<void> {
    const g = this.games.get(gameId);
    if (g) g.row = { ...g.row, status };
  }

  async deleteGame(gameId: string): Promise<void> {
    this.games.delete(gameId);
  }

  async appendCommands(gameId: string, records: CommandRecord[]): Promise<void> {
    if (!records.length) return;
    const g = this.need(gameId);
    for (const r of records) {
      if (g.commands.some((c) => c.seq === r.seq)) throw new Error(`duplicate seq ${r.seq}`);
      // canonical round-trip mirrors the SQLite store's TEXT column exactly
      g.commands.push({ ...r, payload: JSON.parse(canonicalStringify(r.payload)) as unknown });
    }
    g.commands.sort((a, b) => a.seq - b.seq);
    const last = records[records.length - 1]!;
    g.row = { ...g.row, last_seq: last.seq, last_turn: last.turn };
  }

  async readCommands(gameId: string, fromSeq = 0, toSeq?: number): Promise<CommandRecord[]> {
    const g = this.need(gameId);
    return g.commands
      .filter((c) => c.seq >= fromSeq && (toSeq === undefined || c.seq <= toSeq))
      .map((c) => ({ ...c }));
  }

  async saveSnapshot(gameId: string, turn: number, seq: number, stateJson: string, stateHash: string): Promise<void> {
    this.need(gameId).snapshots.set(turn, { seq, stateJson, stateHash });
  }

  async latestSnapshot(
    gameId: string,
    maxTurn?: number,
  ): Promise<{ turn: number; seq: number; stateJson: string; stateHash: string } | undefined> {
    const g = this.games.get(gameId);
    if (!g) return undefined;
    let best: { turn: number; seq: number; stateJson: string; stateHash: string } | undefined;
    for (const [turn, snap] of g.snapshots) {
      if (maxTurn !== undefined && turn > maxTurn) continue;
      if (!best || turn > best.turn) best = { turn, ...snap };
    }
    return best;
  }

  async saveTurnHash(gameId: string, turn: number, stateHash: string): Promise<void> {
    this.need(gameId).turnHashes.set(turn, stateHash);
  }

  async appendTurnEvents(gameId: string, turn: number, events: TurnEventRecord[]): Promise<void> {
    const g = this.need(gameId);
    for (const rec of events) g.events.push({ turn, rec });
  }

  async saveBattleReplay(gameId: string, battleId: string, turn: number, replayJson: string, summary: unknown): Promise<void> {
    this.need(gameId).replays.set(battleId, { turn, replayJson, summary });
  }

  async appendChat(gameId: string, rec: ChatRecord): Promise<void> {
    this.need(gameId).chat.push(rec);
  }

  async exportGame(gameId: string, opts: { history?: boolean } = {}): Promise<SaveEnvelope> {
    const history = opts.history ?? true;
    const g = this.need(gameId);
    const snapshots = [...g.snapshots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([turn, s]) => ({ turn, ...s }));
    const snapshot = snapshots.length ? snapshots[snapshots.length - 1]! : null;
    return {
      format: 'moo2v2-save',
      version: 2,
      game: { ...g.row },
      players: g.players.map((p) => ({ ...p })),
      commands: history
        ? g.commands.map((c) => ({
            seq: c.seq,
            turn: c.turn,
            playerId: c.playerId,
            kind: c.kind,
            payload: canonicalStringify(c.payload),
          }))
        : [],
      snapshot,
      snapshots: history ? snapshots.slice(0, -1) : [],
      history,
    };
  }
}
