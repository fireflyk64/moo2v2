// Deterministic entity-id allocation.
//
// Init-time ids (galaxy, homeworlds, starter fleets, seeded monsters) come
// from state.nextId — a shared counter is fine there because initialization
// is a single common prefix every peer folds identically. DYNAMIC ids
// (anything allocated while the game is being played) must come from allocId
// instead: each empire owns a private id block, so the ids a player's
// entities get never depend on how OTHER empires' allocations interleave.
// That independence is what makes the fast-start mode sound: a ship built on
// a player's speculative timeline keeps the same id when the host's
// authoritative simulation builds it for real, so the player's queued
// commands still point at the right entities when they are sequenced.
//
// Block layout (all well under 2^53, the canonical-integer ceiling):
//   init-time ids:          1 .. 9,999,999   (state.nextId)
//   world/NPC dynamic ids:  10,000,000 + n   (state.nextWorldId)
//   empire k dynamic ids:   (k + 2) * 10,000,000 + n   (empire.nextEntityId)
//
// Old saves predate the split: their entities keep their global-counter ids
// and the optional per-block counters start fresh — the ranges never collide.

import type { GameState } from './types';

export const ID_BLOCK = 10_000_000;

/** Next dynamic id for an empire-owned entity (ship, colony, design,
 * proposal, pop transit, ...). owner < 0 falls through to the world block. */
export function allocId(state: GameState, owner: number): number {
  if (owner < 0) return allocWorldId(state);
  const empire = state.empires.find((e) => e.id === owner);
  if (!empire) throw new Error(`allocId: no empire ${owner}`);
  const n = empire.nextEntityId ?? 1;
  empire.nextEntityId = n + 1;
  return ID_BLOCK * (owner + 2) + n;
}

/** Next dynamic id for a world-owned entity (monster spawns, raid parties). */
export function allocWorldId(state: GameState): number {
  const n = state.nextWorldId ?? 1;
  state.nextWorldId = n + 1;
  return ID_BLOCK + n;
}
