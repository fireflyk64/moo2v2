import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from './schema';

type AnyDb = Kysely<Database>;

/** Ordered migrations; never reorder or edit an applied entry — append instead. */
const MIGRATIONS: Array<{ version: number; up: (db: AnyDb) => Promise<void> }> = [
  {
    version: 1,
    async up(db) {
      await db.schema
        .createTable('games')
        .addColumn('game_id', 'text', (c) => c.primaryKey())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('engine_version', 'text', (c) => c.notNull())
        .addColumn('data_version', 'text', (c) => c.notNull())
        .addColumn('protocol_version', 'integer', (c) => c.notNull())
        .addColumn('settings_json', 'text', (c) => c.notNull())
        .addColumn('seed', 'text', (c) => c.notNull())
        .addColumn('local_player_id', 'integer', (c) => c.notNull())
        .addColumn('lobby_server', 'text', (c) => c.notNull())
        .addColumn('room_code', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull().defaultTo('setup'))
        .addColumn('last_turn', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('last_seq', 'integer', (c) => c.notNull().defaultTo(-1))
        .execute();

      await db.schema
        .createTable('game_players')
        .addColumn('game_id', 'text', (c) => c.notNull())
        .addColumn('player_id', 'integer', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('race_json', 'text')
        .addColumn('is_host', 'integer', (c) => c.notNull().defaultTo(0))
        .addPrimaryKeyConstraint('pk_game_players', ['game_id', 'player_id'])
        .execute();

      await db.schema
        .createTable('commands')
        .addColumn('game_id', 'text', (c) => c.notNull())
        .addColumn('seq', 'integer', (c) => c.notNull())
        .addColumn('turn', 'integer', (c) => c.notNull())
        .addColumn('player_id', 'integer', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('inserted_at', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('pk_commands', ['game_id', 'seq'])
        .execute();
      await db.schema
        .createIndex('idx_commands_game_turn')
        .on('commands')
        .columns(['game_id', 'turn'])
        .execute();

      await db.schema
        .createTable('snapshots')
        .addColumn('game_id', 'text', (c) => c.notNull())
        .addColumn('turn', 'integer', (c) => c.notNull())
        .addColumn('seq', 'integer', (c) => c.notNull())
        .addColumn('state', 'blob', (c) => c.notNull())
        .addColumn('state_hash', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('pk_snapshots', ['game_id', 'turn'])
        .execute();

      await db.schema
        .createTable('turn_hashes')
        .addColumn('game_id', 'text', (c) => c.notNull())
        .addColumn('turn', 'integer', (c) => c.notNull())
        .addColumn('state_hash', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('pk_turn_hashes', ['game_id', 'turn'])
        .execute();

      await db.schema
        .createTable('turn_events')
        .addColumn('game_id', 'text', (c) => c.notNull())
        .addColumn('turn', 'integer', (c) => c.notNull())
        .addColumn('idx', 'integer', (c) => c.notNull())
        .addColumn('visible_to', 'integer', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('pk_turn_events', ['game_id', 'turn', 'idx'])
        .execute();

      await db.schema
        .createTable('battle_replays')
        .addColumn('game_id', 'text', (c) => c.notNull())
        .addColumn('battle_id', 'text', (c) => c.notNull())
        .addColumn('turn', 'integer', (c) => c.notNull())
        .addColumn('replay', 'blob', (c) => c.notNull())
        .addColumn('summary_json', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('pk_battle_replays', ['game_id', 'battle_id'])
        .execute();

      await db.schema
        .createTable('chat_messages')
        .addColumn('game_id', 'text', (c) => c.notNull())
        .addColumn('id', 'integer', (c) => c.notNull())
        .addColumn('turn', 'integer', (c) => c.notNull())
        .addColumn('from_player', 'integer', (c) => c.notNull())
        .addColumn('to_player', 'integer', (c) => c.notNull().defaultTo(-1))
        .addColumn('text', 'text', (c) => c.notNull())
        .addColumn('sent_at', 'text', (c) => c.notNull())
        .addPrimaryKeyConstraint('pk_chat_messages', ['game_id', 'id'])
        .execute();

      await db.schema
        .createTable('prefs')
        .addColumn('key', 'text', (c) => c.primaryKey())
        .addColumn('value', 'text', (c) => c.notNull())
        .execute();
    },
  },
];

export async function ensureSchema(db: AnyDb): Promise<void> {
  await db.schema
    .createTable('schema_migrations')
    .ifNotExists()
    .addColumn('version', 'integer', (c) => c.primaryKey())
    .addColumn('applied_at', 'text', (c) => c.notNull())
    .execute();

  const applied = new Set(
    (await db.selectFrom('schema_migrations').select('version').execute()).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await m.up(db);
    await db
      .insertInto('schema_migrations')
      .values({ version: m.version, applied_at: new Date().toISOString() })
      .execute();
  }
  // WAL/pragmas are dialect-specific niceties; ignore failures (e.g. OPFS).
  try {
    await sql`pragma journal_mode = wal`.execute(db);
  } catch {
    /* not critical */
  }
}
