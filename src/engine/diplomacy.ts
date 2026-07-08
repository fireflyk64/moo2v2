// Diplomacy between human players: proposals (peace, non-aggression, alliance,
// trade, research, gifts, tech exchange), treaty income, and the Galactic
// Council (every 25 turns, two largest empires stand; 2/3 of population-weighted
// votes wins a diplomatic victory).

import { relationKey, setRelation } from './battles';
import { colonyPopUnits } from './economy';
import { floorDiv } from './imath';
import { grantApp } from './research';
import type { Empire, GameState, Proposal, RelationEntry, TurnEvent } from './types';

export const COUNCIL_INTERVAL = 25;
export const PROPOSAL_TTL = 5;

export function relationOf(state: GameState, a: number, b: number): RelationEntry {
  const [x, y] = relationKey(a, b);
  let rel = state.relations.find((r) => r.a === x && r.b === y);
  if (!rel) {
    rel = {
      a: x,
      b: y,
      status: 'peace',
      peaceOfferedBy: [],
      treaties: { nap: false, alliance: false, trade: false, research: false },
    };
    state.relations.push(rel);
    state.relations.sort((r1, r2) => r1.a - r2.a || r1.b - r2.b);
  }
  return rel;
}

export function breakTreaties(state: GameState, a: number, b: number): void {
  const rel = relationOf(state, a, b);
  rel.treaties = { nap: false, alliance: false, trade: false, research: false };
}

export function acceptProposal(state: GameState, proposal: Proposal, events: TurnEvent[]): string | null {
  const from = state.empires.find((e) => e.id === proposal.from);
  const to = state.empires.find((e) => e.id === proposal.to);
  if (!from || !to) return 'empire missing';
  const rel = relationOf(state, proposal.from, proposal.to);

  switch (proposal.kind) {
    case 'peace':
      setRelation(state, proposal.from, proposal.to, 'peace');
      break;
    case 'non_aggression':
      if (rel.status === 'war') return 'make peace first';
      rel.treaties.nap = true;
      break;
    case 'alliance':
      if (rel.status === 'war') return 'make peace first';
      rel.treaties.nap = true;
      rel.treaties.alliance = true;
      break;
    case 'trade':
      if (rel.status === 'war') return 'make peace first';
      rel.treaties.trade = true;
      break;
    case 'research':
      if (rel.status === 'war') return 'make peace first';
      rel.treaties.research = true;
      break;
    case 'gift_bc': {
      if (from.bc < proposal.giveBc) return 'giver lacks the funds';
      from.bc -= proposal.giveBc;
      to.bc += proposal.giveBc;
      break;
    }
    case 'tech_exchange': {
      if (!proposal.giveApp || !proposal.wantApp) return 'malformed exchange';
      if (!from.knownApps.includes(proposal.giveApp)) return 'offered tech unknown to giver';
      if (!to.knownApps.includes(proposal.wantApp)) return 'requested tech unknown to partner';
      grantApp(to, proposal.giveApp);
      grantApp(from, proposal.wantApp);
      break;
    }
  }
  events.push({
    visibleTo: -1,
    kind: 'treaty_signed',
    payload: { kind: proposal.kind, a: proposal.from, b: proposal.to },
  });
  return null;
}

function empirePop(state: GameState, empireId: number): number {
  let pop = 0;
  for (const c of state.colonies) {
    if (c.owner === empireId && !c.outpost) pop += colonyPopUnits(c);
  }
  return pop;
}

/** S11: treaty income, proposal expiry, council votes. */
export function diplomacyUpkeep(state: GameState, events: TurnEvent[]): void {
  // treaty income: each side earns floor(min(pop)/4) BC (trade) / RP (research)
  for (const rel of state.relations) {
    if (rel.status === 'war') continue;
    const a = state.empires.find((e) => e.id === rel.a);
    const b = state.empires.find((e) => e.id === rel.b);
    if (!a || !b || a.eliminated || b.eliminated) continue;
    const bond = Math.min(empirePop(state, rel.a), empirePop(state, rel.b));
    if (rel.treaties.trade) {
      const bc = floorDiv(bond, 4);
      a.bc += bc;
      b.bc += bc;
    }
    if (rel.treaties.research) {
      const rp = floorDiv(bond, 4);
      a.research.accumRP += rp;
      b.research.accumRP += rp;
    }
  }

  // proposals expire
  state.proposals = state.proposals.filter((p) => p.expiresTurn > state.turn);

  // council scheduling + tally
  if (state.council.pending) {
    const alive = state.empires.filter((e) => !e.eliminated);
    const votesCast = Object.keys(state.council.pending.votes).length;
    if (votesCast >= alive.length || state.turn >= state.council.nextVoteTurn + 3) {
      tallyCouncil(state, events);
    }
  } else if (state.turn >= state.council.nextVoteTurn && state.empires.filter((e) => !e.eliminated).length > 1) {
    const ranked = state.empires
      .filter((e) => !e.eliminated)
      .map((e) => ({ id: e.id, pop: empirePop(state, e.id) }))
      .sort((x, y) => y.pop - x.pop || x.id - y.id);
    state.council.pending = {
      candidates: [ranked[0]!.id, ranked[1]!.id],
      votes: {},
    };
    events.push({
      visibleTo: -1,
      kind: 'council_convened',
      payload: { candidates: state.council.pending.candidates, deadline: state.turn + 3 },
    });
  }
}

function tallyCouncil(state: GameState, events: TurnEvent[]): void {
  const pending = state.council.pending!;
  const weights = new Map<number, number>();
  let totalWeight = 0;
  for (const e of state.empires) {
    if (e.eliminated) continue;
    const w = Math.max(1, floorDiv(empirePop(state, e.id), 5));
    weights.set(e.id, w);
    totalWeight += w;
  }
  const tally = new Map<number, number>();
  for (const [voterStr, candidate] of Object.entries(pending.votes)) {
    const voter = Number(voterStr);
    if (candidate >= 0 && pending.candidates.includes(candidate)) {
      tally.set(candidate, (tally.get(candidate) ?? 0) + (weights.get(voter) ?? 0));
    }
  }
  let winner: number | null = null;
  for (const c of pending.candidates) {
    if ((tally.get(c) ?? 0) * 3 >= totalWeight * 2) winner = c;
  }
  events.push({
    visibleTo: -1,
    kind: 'council_result',
    payload: {
      candidates: pending.candidates,
      tally: Object.fromEntries([...tally.entries()].map(([k, v]) => [String(k), v])),
      totalWeight,
      winner,
    },
  });
  state.council.pending = null;
  state.council.nextVoteTurn = state.turn + COUNCIL_INTERVAL;
  if (winner !== null && state.winner === null) {
    state.winner = winner;
    state.winType = 'council';
    events.push({ visibleTo: -1, kind: 'victory', payload: { empireId: winner, type: 'council' } });
  }
}

export function empirePopulation(state: GameState, empire: Empire): number {
  return empirePop(state, empire.id);
}
