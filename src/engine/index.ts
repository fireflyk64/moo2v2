// Engine: the pure, deterministic game core.
//
// Layer rules (enforced by scripts/check-boundaries.mjs):
// - No imports from outside src/engine (zero runtime dependencies).
// - No sources of nondeterminism; randomness comes only from the seeded PRNG.

export const ENGINE_VERSION = '0.19.0'; // research-target + outpost-raze fixes: (1) completeField now runs BEFORE research.targetApp is cleared — non-creative empires finally receive the application they targeted instead of always the field's first app (any replay where a player set a non-first target diverges at that discovery); (2) a victorious bombard order at a star whose defender holds only outposts destroys one outpost regardless of bomb damage (previously needed >=20 bomb-class damage), preferring the dome on a colonizable (body=planet) world, and bombardment at a mixed star always targets the populated colony, never an outpost. Prior: 0.18.0 campaign-timelapse opt-in: new timelapse_vote command + GameState.timelapseVotes/timelapseReadyTurn (optional-additive) — when every living empire votes, the ready turn latches and the ballot resets so groups can end a session with a full-map history replay. Saves containing a vote diverge on older builds. Prior: 0.17.0 planet-generation overhaul + discovery payouts: sizes skew large (weights 1/4/20/45/30 tiny→huge, size-1 possible again), black holes 6%→1% and brown dwarfs 6%→3% with fuller orbits, body split 62/18/20→72/12/16, gravity now also skews with mineral richness; every monster-guarded system's best world is upgraded to a prize (terran/gaia, rich/ultra-rich, size 4-5, sometimes artifacts/splinter, often heavy-G); ancient_artifacts pay ONE free technology to the first empire that visits the system after any keeper falls (new s6b discovery step, Planet.artifactsLooted); splinter colonies now JOIN the discovering empire outright as a colony of up to 3 farm-only natives (founding fallback grants natives, not owner-race workers); splinter rolls restricted to farmable climates. Every galaxy generated and any save touching these systems diverges. Prior: 0.16.0 colony leaders are system administrators: an assigned colony leader's colony-scope bonuses (farming/labor/science/financial/spiritual/environmentalist/medicine) now apply to EVERY colony the empire owns in the same star system, not just their seat — any save with a colony leader assigned in a multi-colony system diverges. Prior: 0.15.0 android units implemented (cybertechnics): android_farmers/workers/scientists are buildable projects that add hardwired race -2 pop units (+3 category output, 1 prod upkeep, no food/income/morale, own subterranean cap of 2×size, destroyed on capture) — any save where a player researched cybertechnics diverges. Prior: 0.14.0 advanced governments implemented (confederation/imperium/federation/galactic_unification now amplify their base government) and feudal warships cost 2/3 per racepicks.md — feudal build costs and any empire holding an advanced-gov app diverge old replays. Prior: 0.13.0 battlefield enlarged 512x384 -> 768x576: fleets deploy farther apart (the defender line is now relative to the field edge), so closing, flanking and retreating off-field all take meaningfully longer. Combat replays from 0.12.0 diverge at the first battle tick, so older saves load snapshot-first. (0.12.0: engine-maintained default designs per hull class that track research.)

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
