// Storage: kysely schema + repositories persisting the command log, snapshots,
// replays, chat and prefs. May import from @engine only. Runtime factories:
// ./node (better-sqlite3) and ./browser (sqlocal/OPFS) — import those directly
// from runtime-specific code; this barrel stays runtime-neutral.

export const SCHEMA_VERSION = 1;
export * from './schema';
export * from './repo';
export * from './gzip';
export { ensureSchema } from './migrations';
export * from './savefile';
