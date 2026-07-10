// Engine: the pure, deterministic game core.
//
// Layer rules (enforced by scripts/check-boundaries.mjs):
// - No imports from outside src/engine (zero runtime dependencies).
// - No sources of nondeterminism; randomness comes only from the seeded PRNG.

export const ENGINE_VERSION = '0.9.0'; // fast-start groundwork: per-empire dynamic entity ids (ids.ts), freighter in-use upkeep (0.5 BC), settler runs on second-best drive, Unification skips morale tech, PD weapons mount as 360 at base space, colony_ship_arrived event; starts: pre-warp loses the free colony ship, new 'advanced' big-identical-empires mode

export * from './types';
export * from './ids';
export * from './canonical';
export * from './hash';
export * from './isqrt';
export * from './imath';
export { Rng, rngFor, isValidMasterSeed, type MasterSeed } from './rng';
export * from './race';
export * from './galaxy';
export * from './economy';
export * from './research';
export * from './effects';
export * from './items';
export * from './movement';
export * from './terraform';
export * from './leaders';
export * from './npc';
export * from './ground';
export * from './espionage';
export * from './diplomacy';
export * from './commands';
export * from './shipdesign';
export * from './shipstyles';
export * from './combat';
export * from './battles';
export * from './pipeline';
export * from './adapter';
export * as selectors from './selectors';
