import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { rngFor } from '@engine/rng';
import { expanderBot, replayGame, runHeadlessGame, type BotPolicy } from '../../src/headless/bots';
import type { GameState } from '@engine/types';

// Phase 8 gate: a long fuzz soak. The chaos bot layers random-but-valid
// aggressive commands (war, peace, spies, leaders, votes, proposals, resign
// is excluded) on top of the expander economy. Anything invalid is rejected
// by validation exactly like a host would; the run must stay deterministic
// under full replay.

const chaosBot: BotPolicy = (state, empireId) => {
  const out = [...expanderBot(state, empireId)];
  const rng = rngFor(state.seed, state.turn, 'chaos', empireId);
  const others = state.empires.filter((e) => e.id !== empireId && !e.eliminated);
  const me = state.empires.find((e) => e.id === empireId);
  if (!me || me.eliminated || !others.length) return out;

  // diplomacy mood swings
  if (rng.chancePct(6)) {
    const target = others[rng.int(others.length)]!;
    out.push({ kind: 'declare_war', payload: { target: target.id } });
  }
  if (rng.chancePct(8)) {
    const target = others[rng.int(others.length)]!;
    out.push({ kind: 'offer_peace', payload: { target: target.id } });
  }
  if (rng.chancePct(10)) {
    const target = others[rng.int(others.length)]!;
    const kinds = ['trade', 'research', 'non_aggression', 'gift_bc'] as const;
    const kind = kinds[rng.int(kinds.length)]!;
    out.push({ kind: 'diplo_propose', payload: { to: target.id, kind, ...(kind === 'gift_bc' ? { giveBc: 1 + rng.int(20) } : {}) } });
  }
  for (const p of state.proposals) {
    if (p.to === empireId && rng.chancePct(50)) {
      if (p.kind === 'surrender') continue; // keep the soak running long
      out.push({ kind: 'diplo_respond', payload: { proposalId: p.id, accept: rng.chancePct(60) } });
    }
  }
  // espionage
  if (rng.chancePct(10)) {
    const target = others[rng.int(others.length)]!;
    out.push({ kind: 'set_spy_orders', payload: { target: rng.chancePct(70) ? target.id : null, mode: rng.chancePct(50) ? 'steal' : 'sabotage' } });
  }
  // leaders
  for (const offer of state.leaderOffers) {
    if (offer.empireId === empireId && me.bc > offer.priceBc + 50 && rng.chancePct(60)) {
      out.push({ kind: 'hire_leader', payload: { leaderId: offer.leaderId } });
    }
  }
  const unassigned = me.leaders.find((l) => l.colonyId === null);
  if (unassigned && rng.chancePct(40)) {
    const mine = state.colonies.filter((c) => c.owner === empireId && !c.outpost);
    if (mine.length) {
      out.push({ kind: 'assign_leader', payload: { leaderId: unassigned.leaderId, colonyId: mine[rng.int(mine.length)]!.id } });
    }
  }
  // council
  if (state.council.pending && rng.chancePct(70)) {
    const cands = state.council.pending.candidates;
    out.push({ kind: 'cast_vote', payload: { candidate: rng.chancePct(80) ? cands[rng.int(cands.length)]! : -1 } });
  }
  // occasional buyouts
  if (rng.chancePct(15)) {
    const mine = state.colonies.filter((c) => c.owner === empireId && !c.outpost && c.queue.length > 0);
    if (mine.length) out.push({ kind: 'buy_production', payload: { colonyId: mine[rng.int(mine.length)]!.id } });
  }
  return out;
};

const SEED = 'deadbeefdeadbeefdeadbeefdeadbeef';
const PLAYERS = [
  { id: 0, name: 'F0', raceJson: JSON.stringify({ presetId: 'korrath' }), policy: chaosBot },
  { id: 1, name: 'F1', raceJson: JSON.stringify({ presetId: 'skyshear' }), policy: chaosBot },
];
const SETTINGS: Partial<GameState['settings']> = {
  galaxySize: 'small',
  modes: { creativeVariant: false, pickBidding: false, stickyBuild: true, antarans: true, randomEvents: true },
};

describe('500-turn fuzz soak', () => {
  it('chaos commands + wars + all systems stay replay-deterministic', () => {
    const run = runHeadlessGame({ seed: SEED, players: PLAYERS, turns: 500, settings: SETTINGS, stopOnVictory: false });
    expect(run.state.turn).toBeGreaterThan(490); // the soak really ran long
    // wars and combat actually happened
    expect(run.log.some((c) => c.kind === 'declare_war')).toBe(true);
    // full replay converges to the identical hash
    const replayed = replayGame(SEED, PLAYERS.map(({ id, name, raceJson }) => ({ id, name, raceJson })), run.state.settings, run.log);
    expect(gameEngine.hash(replayed)).toBe(gameEngine.hash(run.state));
    // and a rerun produces the identical hash trail
    const rerun = runHeadlessGame({ seed: SEED, players: PLAYERS, turns: 500, settings: SETTINGS, stopOnVictory: false });
    expect(rerun.hashes).toEqual(run.hashes);
  }, 300_000);
});
