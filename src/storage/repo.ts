// GameStore: typed repository over the schema. One instance per open database.

import type { Kysely } from 'kysely';
import { canonicalStringify } from '@engine/canonical';
import { gzipText, gunzipText } from './gzip';
import type { Database, GamesTable, GamePlayersTable } from './schema';
import { ensureSchema } from './migrations';

export interface CommandRecord {
  seq: number;
  turn: number;
  playerId: number; // -1 = system
  kind: string;
  payload: unknown; // canonical-serializable
}

export interface TurnEventRecord {
  idx: number;
  visibleTo: number;
  kind: string;
  payload: unknown;
}

export interface ChatRecord {
  id: number;
  turn: number;
  from: number;
  to: number;
  text: string;
  sentAt: string;
}

export interface GameMeta {
  gameId: string;
  engineVersion: string;
  dataVersion: string;
  protocolVersion: number;
  settings: unknown;
  seed: string;
  localPlayerId: number;
  lobbyServer: string;
  roomCode: string;
}

export interface SaveSnapshot {
  turn: number;
  seq: number;
  stateJson: string;
  stateHash: string;
}

export interface SaveEnvelope {
  format: 'moo2v2-save';
  version: 1 | 2;
  game: GamesTable;
  players: GamePlayersTable[];
  commands: Array<{ seq: number; turn: number; playerId: number; kind: string; payload: string }>;
  /** the final snapshot: the snapshot-first load base on any future build */
  snapshot: SaveSnapshot | null;
  /** v2 history: every stored snapshot ascending by turn (what-if resume points) */
  snapshots?: SaveSnapshot[];
  /** v2: false when the log + old snapshots were stripped at save time */
  history?: boolean;
}

export class GameStore {
  constructor(private readonly db: Kysely<Database>) {}

  async init(): Promise<void> {
    await ensureSchema(this.db);
  }

  async destroy(): Promise<void> {
    await this.db.destroy();
  }

  // ----- games -----

  async createGame(meta: GameMeta, players: Array<{ id: number; name: string }>): Promise<void> {
    await this.db
      .insertInto('games')
      .values({
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
      })
      .execute();
    if (players.length) {
      await this.db
        .insertInto('game_players')
        .values(
          players.map((p) => ({
            game_id: meta.gameId,
            player_id: p.id,
            name: p.name,
            race_json: null,
            is_host: p.id === 0 ? 1 : 0,
          })),
        )
        .execute();
    }
  }

  async getGame(gameId: string): Promise<GamesTable | undefined> {
    return this.db.selectFrom('games').selectAll().where('game_id', '=', gameId).executeTakeFirst();
  }

  async listGames(): Promise<GamesTable[]> {
    return this.db.selectFrom('games').selectAll().orderBy('created_at', 'desc').execute();
  }

  async setGameStatus(gameId: string, status: GamesTable['status']): Promise<void> {
    await this.db.updateTable('games').set({ status }).where('game_id', '=', gameId).execute();
  }

  async setPlayerRace(gameId: string, playerId: number, race: unknown): Promise<void> {
    await this.db
      .updateTable('game_players')
      .set({ race_json: canonicalStringify(race) })
      .where('game_id', '=', gameId)
      .where('player_id', '=', playerId)
      .execute();
  }

  async getPlayers(gameId: string): Promise<GamePlayersTable[]> {
    return this.db
      .selectFrom('game_players')
      .selectAll()
      .where('game_id', '=', gameId)
      .orderBy('player_id')
      .execute();
  }

  async deleteGame(gameId: string): Promise<void> {
    for (const table of [
      'commands',
      'snapshots',
      'turn_hashes',
      'turn_events',
      'battle_replays',
      'chat_messages',
      'game_players',
      'games',
    ] as const) {
      await this.db.deleteFrom(table).where('game_id', '=', gameId).execute();
    }
  }

  // ----- command log -----

  async appendCommands(gameId: string, records: CommandRecord[]): Promise<void> {
    if (!records.length) return;
    const now = new Date().toISOString();
    // idempotent upsert: after a host crash-and-resume the same seq can be
    // reissued for a different command. A plain INSERT threw (swallowed by
    // the persist chain) and left the stored log permanently interleaving two
    // branches — replay(storedLog) != state and exports failed verification.
    // Last-writer-wins keeps the branch the live session actually folded.
    await this.db
      .insertInto('commands')
      .values(
        records.map((r) => ({
          game_id: gameId,
          seq: r.seq,
          turn: r.turn,
          player_id: r.playerId,
          kind: r.kind,
          payload: canonicalStringify(r.payload),
          inserted_at: now,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['game_id', 'seq']).doUpdateSet((eb) => ({
          turn: eb.ref('excluded.turn'),
          player_id: eb.ref('excluded.player_id'),
          kind: eb.ref('excluded.kind'),
          payload: eb.ref('excluded.payload'),
          inserted_at: eb.ref('excluded.inserted_at'),
        })),
      )
      .execute();
    const last = records[records.length - 1]!;
    await this.db
      .updateTable('games')
      .set({ last_seq: last.seq, last_turn: last.turn })
      .where('game_id', '=', gameId)
      .execute();
  }

  async readCommands(gameId: string, fromSeq = 0, toSeq?: number): Promise<CommandRecord[]> {
    let q = this.db
      .selectFrom('commands')
      .selectAll()
      .where('game_id', '=', gameId)
      .where('seq', '>=', fromSeq)
      .orderBy('seq');
    if (toSeq !== undefined) q = q.where('seq', '<=', toSeq);
    const rows = await q.execute();
    return rows.map((r) => ({
      seq: r.seq,
      turn: r.turn,
      playerId: r.player_id,
      kind: r.kind,
      payload: JSON.parse(r.payload) as unknown,
    }));
  }

  // ----- snapshots -----

  async saveSnapshot(gameId: string, turn: number, seq: number, stateJson: string, stateHash: string): Promise<void> {
    const state = await gzipText(stateJson);
    await this.db
      .insertInto('snapshots')
      .values({
        game_id: gameId,
        turn,
        seq,
        state,
        state_hash: stateHash,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.columns(['game_id', 'turn']).doUpdateSet({ seq, state, state_hash: stateHash }))
      .execute();
  }

  async latestSnapshot(
    gameId: string,
    maxTurn?: number,
  ): Promise<{ turn: number; seq: number; stateJson: string; stateHash: string } | undefined> {
    let q = this.db
      .selectFrom('snapshots')
      .selectAll()
      .where('game_id', '=', gameId)
      .orderBy('turn', 'desc')
      .limit(1);
    if (maxTurn !== undefined) q = q.where('turn', '<=', maxTurn);
    const row = await q.executeTakeFirst();
    if (!row) return undefined;
    const bytes = row.state instanceof Uint8Array ? row.state : new Uint8Array(row.state as ArrayBufferLike);
    return {
      turn: row.turn,
      seq: row.seq,
      stateJson: await gunzipText(bytes),
      stateHash: row.state_hash,
    };
  }

  // ----- hashes / events / replays / chat / prefs -----

  async saveTurnHash(gameId: string, turn: number, stateHash: string): Promise<void> {
    await this.db
      .insertInto('turn_hashes')
      .values({ game_id: gameId, turn, state_hash: stateHash })
      .onConflict((oc) => oc.columns(['game_id', 'turn']).doUpdateSet({ state_hash: stateHash }))
      .execute();
  }

  async getTurnHash(gameId: string, turn: number): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('turn_hashes')
      .select('state_hash')
      .where('game_id', '=', gameId)
      .where('turn', '=', turn)
      .executeTakeFirst();
    return row?.state_hash;
  }

  async appendTurnEvents(gameId: string, turn: number, events: TurnEventRecord[]): Promise<void> {
    if (!events.length) return;
    await this.db
      .insertInto('turn_events')
      .values(
        events.map((e) => ({
          game_id: gameId,
          turn,
          idx: e.idx,
          visible_to: e.visibleTo,
          kind: e.kind,
          payload: canonicalStringify(e.payload),
        })),
      )
      .onConflict((oc) => oc.columns(['game_id', 'turn', 'idx']).doNothing())
      .execute();
  }

  async readTurnEvents(gameId: string, fromTurn: number, toTurn: number, forPlayer?: number): Promise<Array<TurnEventRecord & { turn: number }>> {
    let q = this.db
      .selectFrom('turn_events')
      .selectAll()
      .where('game_id', '=', gameId)
      .where('turn', '>=', fromTurn)
      .where('turn', '<=', toTurn)
      .orderBy('turn')
      .orderBy('idx');
    if (forPlayer !== undefined) {
      q = q.where((eb) => eb.or([eb('visible_to', '=', -1), eb('visible_to', '=', forPlayer)]));
    }
    const rows = await q.execute();
    return rows.map((r) => ({
      turn: r.turn,
      idx: r.idx,
      visibleTo: r.visible_to,
      kind: r.kind,
      payload: JSON.parse(r.payload) as unknown,
    }));
  }

  async saveBattleReplay(gameId: string, battleId: string, turn: number, replayJson: string, summary: unknown): Promise<void> {
    await this.db
      .insertInto('battle_replays')
      .values({
        game_id: gameId,
        battle_id: battleId,
        turn,
        replay: await gzipText(replayJson),
        summary_json: canonicalStringify(summary),
      })
      .onConflict((oc) => oc.columns(['game_id', 'battle_id']).doNothing())
      .execute();
  }

  async getBattleReplay(gameId: string, battleId: string): Promise<{ turn: number; replayJson: string; summary: unknown } | undefined> {
    const row = await this.db
      .selectFrom('battle_replays')
      .selectAll()
      .where('game_id', '=', gameId)
      .where('battle_id', '=', battleId)
      .executeTakeFirst();
    if (!row) return undefined;
    const bytes = row.replay instanceof Uint8Array ? row.replay : new Uint8Array(row.replay as ArrayBufferLike);
    return { turn: row.turn, replayJson: await gunzipText(bytes), summary: JSON.parse(row.summary_json) as unknown };
  }

  async appendChat(gameId: string, msg: ChatRecord): Promise<void> {
    await this.db
      .insertInto('chat_messages')
      .values({
        game_id: gameId,
        id: msg.id,
        turn: msg.turn,
        from_player: msg.from,
        to_player: msg.to,
        text: msg.text,
        sent_at: msg.sentAt,
      })
      .onConflict((oc) => oc.columns(['game_id', 'id']).doNothing())
      .execute();
  }

  async readChat(gameId: string, sinceId = -1): Promise<ChatRecord[]> {
    const rows = await this.db
      .selectFrom('chat_messages')
      .selectAll()
      .where('game_id', '=', gameId)
      .where('id', '>', sinceId)
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ id: r.id, turn: r.turn, from: r.from_player, to: r.to_player, text: r.text, sentAt: r.sent_at }));
  }

  async setPref(key: string, value: string): Promise<void> {
    await this.db
      .insertInto('prefs')
      .values({ key, value })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
      .execute();
  }

  async getPref(key: string): Promise<string | undefined> {
    const row = await this.db.selectFrom('prefs').select('value').where('key', '=', key).executeTakeFirst();
    return row?.value;
  }

  // ----- export / import -----

  /** All stored snapshots, ascending by turn (gunzipped). */
  async allSnapshots(gameId: string): Promise<SaveSnapshot[]> {
    const rows = await this.db
      .selectFrom('snapshots')
      .selectAll()
      .where('game_id', '=', gameId)
      .orderBy('turn')
      .execute();
    const out: SaveSnapshot[] = [];
    for (const row of rows) {
      const bytes = row.state instanceof Uint8Array ? row.state : new Uint8Array(row.state as ArrayBufferLike);
      out.push({ turn: row.turn, seq: row.seq, stateJson: await gunzipText(bytes), stateHash: row.state_hash });
    }
    return out;
  }

  async exportGame(gameId: string, opts: { history?: boolean } = {}): Promise<SaveEnvelope> {
    const history = opts.history ?? true;
    const game = await this.getGame(gameId);
    if (!game) throw new Error(`no such game: ${gameId}`);
    const players = await this.getPlayers(gameId);
    const commands = await this.db
      .selectFrom('commands')
      .select(['seq', 'turn', 'player_id', 'kind', 'payload'])
      .where('game_id', '=', gameId)
      .orderBy('seq')
      .execute();
    const snapshots = await this.allSnapshots(gameId);
    const snapshot = snapshots.length ? snapshots[snapshots.length - 1]! : null;
    return {
      format: 'moo2v2-save',
      version: 2,
      game,
      players,
      commands: history
        ? commands.map((c) => ({ seq: c.seq, turn: c.turn, playerId: c.player_id, kind: c.kind, payload: c.payload }))
        : [],
      snapshot,
      snapshots: history ? snapshots.slice(0, -1) : [],
      history,
    };
  }

  async importGame(envelope: SaveEnvelope, overwrite = false): Promise<void> {
    if (envelope.format !== 'moo2v2-save') throw new Error('not a moo2v2 save');
    const existing = await this.getGame(envelope.game.game_id);
    if (existing) {
      if (!overwrite) throw new Error(`game ${envelope.game.game_id} already exists`);
      await this.deleteGame(envelope.game.game_id);
    }
    await this.db.insertInto('games').values(envelope.game).execute();
    if (envelope.players.length) {
      await this.db.insertInto('game_players').values(envelope.players).execute();
    }
    if (envelope.commands.length) {
      const now = new Date().toISOString();
      await this.db
        .insertInto('commands')
        .values(
          envelope.commands.map((c) => ({
            game_id: envelope.game.game_id,
            seq: c.seq,
            turn: c.turn,
            player_id: c.playerId,
            kind: c.kind,
            payload: c.payload,
            inserted_at: now,
          })),
        )
        .execute();
    }
    for (const snap of [...(envelope.snapshots ?? []), ...(envelope.snapshot ? [envelope.snapshot] : [])]) {
      await this.saveSnapshot(envelope.game.game_id, snap.turn, snap.seq, snap.stateJson, snap.stateHash);
    }
  }
}
