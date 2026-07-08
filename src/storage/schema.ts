// Kysely table types. The command log + snapshots are the canonical record of
// everything that has happened in a game; live sim state is never mirrored here.

export interface GamesTable {
  game_id: string;
  created_at: string;
  engine_version: string;
  data_version: string;
  protocol_version: number;
  settings_json: string;
  seed: string;
  local_player_id: number;
  lobby_server: string;
  room_code: string;
  status: 'setup' | 'active' | 'finished' | 'abandoned';
  last_turn: number;
  last_seq: number;
}

export interface GamePlayersTable {
  game_id: string;
  player_id: number; // lobbylink slot id; 0 = host
  name: string;
  race_json: string | null;
  is_host: number; // 0/1
}

export interface CommandsTable {
  game_id: string;
  seq: number; // host-assigned, gapless, global
  turn: number;
  player_id: number; // -1 = system
  kind: string;
  payload: string; // canonical JSON
  inserted_at: string;
}

export interface SnapshotsTable {
  game_id: string;
  turn: number;
  seq: number; // last command folded into this snapshot
  state: Uint8Array; // gzip of canonical state JSON
  state_hash: string;
  created_at: string;
}

export interface TurnHashesTable {
  game_id: string;
  turn: number;
  state_hash: string;
}

export interface TurnEventsTable {
  game_id: string;
  turn: number;
  idx: number;
  visible_to: number; // player_id or -1 = all
  kind: string;
  payload: string; // canonical JSON
}

export interface BattleReplaysTable {
  game_id: string;
  battle_id: string;
  turn: number;
  replay: Uint8Array; // gzip of canonical replay JSON
  summary_json: string;
}

export interface ChatMessagesTable {
  game_id: string;
  id: number; // host-assigned chat sequence
  turn: number;
  from_player: number;
  to_player: number; // -1 = all
  text: string;
  sent_at: string;
}

export interface PrefsTable {
  key: string;
  value: string;
}

export interface SchemaMigrationsTable {
  version: number;
  applied_at: string;
}

export interface Database {
  games: GamesTable;
  game_players: GamePlayersTable;
  commands: CommandsTable;
  snapshots: SnapshotsTable;
  turn_hashes: TurnHashesTable;
  turn_events: TurnEventsTable;
  battle_replays: BattleReplaysTable;
  chat_messages: ChatMessagesTable;
  prefs: PrefsTable;
  schema_migrations: SchemaMigrationsTable;
}
