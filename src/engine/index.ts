// Engine: the pure, deterministic game core.
//
// Layer rules (enforced by scripts/check-boundaries.mjs):
// - No imports from outside src/engine (zero runtime dependencies).
// - No sources of nondeterminism; randomness comes only from the seeded PRNG.

export const ENGINE_VERSION = '0.16.0'; // colony leaders are system administrators: an assigned colony leader's colony-scope bonuses (farming/labor/science/financial/spiritual/environmentalist/medicine) now apply to EVERY colony the empire owns in the same star system, not just their seat — any save with a colony leader assigned in a multi-colony system diverges. Prior: 0.15.0 android units implemented (cybertechnics): android_farmers/workers/scientists are buildable projects that add hardwired race -2 pop units (+3 category output, 1 prod upkeep, no food/income/morale, own subterranean cap of 2×size, destroyed on capture) — any save where a player researched cybertechnics diverges. Prior: 0.14.0 advanced governments implemented (confederation/imperium/federation/galactic_unification now amplify their base government) and feudal warships cost 2/3 per racepicks.md — feudal build costs and any empire holding an advanced-gov app diverge old replays. Prior: 0.13.0 battlefield enlarged 512x384 -> 768x576: fleets deploy farther apart (the defender line is now relative to the field edge), so closing, flanking and retreating off-field all take meaningfully longer. Combat replays from 0.12.0 diverge at the first battle tick, so older saves load snapshot-first. (0.12.0: engine-maintained default designs per hull class that track research.)

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
