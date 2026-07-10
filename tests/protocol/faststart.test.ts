// Fast start (async turns until contact): the host advances the authoritative
// sim only as fast as the slowest player, everyone ahead plays a local
// preview, and the preview's OWN-empire slice must match the authoritative
// sim bit-for-bit when it catches up (per-empire entity ids + per-empire rng
// labels make that possible). First contact rewinds everyone to the synced
// turn and the table returns to classic lockstep.

import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS, FAST_MAX_AHEAD } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { createGameEngine } from '@engine/adapter';
import { canonicalStringify } from '@engine/canonical';
import type { GameState } from '@engine/types';

const SEED = '0123456789abcdef0123456789abcdef';

function identity(name: string) {
  return { name, engineVersion: '0.1.0', dataVersion: 'dv-test', roomCode: 'FAST', lobbyServer: 'memory' };
}

function engine(): EngineAdapter<GameState> {
  return createGameEngine() as unknown as EngineAdapter<GameState>;
}

/** Everything empire `id` owns — the part of the world a player's preview
 * must predict exactly while nobody has met anybody. */
function ownSlice(state: GameState, id: number): string {
  return canonicalStringify({
    empire: state.empires.find((e) => e.id === id),
    colonies: state.colonies.filter((c) => c.owner === id),
    ships: state.ships.filter((s) => s.owner === id),
  });
}

function makeTable(opts?: { debug?: boolean; startMode?: 'pre_warp' | 'average' | 'advanced' }) {
  const hub = new MemoryHub(2);
  const hosted = createHostedGame<GameState>({
    transport: hub.join(),
    engine: engine(),
    hostEngine: engine(),
    branchEngine: engine(),
    store: null,
    settings: {
      ...DEFAULT_SETTINGS,
      playerCount: 2,
      galaxySize: 'small',
      startMode: opts?.startMode ?? 'average',
      fastStart: true,
      debugCommands: opts?.debug ?? false,
      // keep the fidelity assertion sharp: no global-target events
      modes: { ...DEFAULT_SETTINGS.modes, antarans: false, randomEvents: false },
    },
    identity: identity('Ann'),
  });
  const joiner = joinGame<GameState>({
    transport: hub.join(),
    engine: engine(),
    branchEngine: engine(),
    store: null,
    identity: identity('Bob'),
  });
  return { hub, hosted, joiner };
}

describe('fast start', () => {
  it('runs ahead locally, and the preview own-slice matches the authoritative sim exactly', async () => {
    const { hub, hosted, joiner } = makeTable({ debug: true });
    await hub.settle();
    hosted.host.startGame(SEED);
    await hub.settle();

    const a = hosted.session; // seat 0 (host player) races ahead
    const b = joiner; // seat 1 lags

    // authoritative slices, captured at each turn boundary as Bob's client
    // folds them (identical on every peer by lockstep construction)
    const authSlices = new Map<number, string>();
    b.subscribe((ev) => {
      if (ev.type === 'turn-advanced') {
        authSlices.set(ev.turn, ownSlice(b.getState()!, 0));
      }
    });

    // Ann races 5 turns ahead. Her orders each turn include a save_design —
    // an APPLY-TIME id allocation. Under a global id counter Bob's later
    // interleaved allocations would renumber her entities and break the
    // preview; per-empire id blocks are what this assertion pins down.
    const previewSlices = new Map<number, string>();
    const homeColony = a.getPlanned()!.colonies.find((c) => c.owner === 0)!;
    for (let i = 0; i < 5; i++) {
      const turn = a.fastTurn();
      a.submit('set_build_queue', { colonyId: homeColony.id, items: [i % 2 ? 'trade_goods' : 'housing'] });
      a.submit('set_tax_rate', { pct: (i % 2) * 5 });
      a.submit('save_design', {
        name: `Lance ${i + 1}`,
        hull: 'frigate',
        computer: 0,
        shield: 0,
        specials: [],
        weapons: [{ weapon: 'laser_cannon', count: 1, mods: [] }],
      });
      expect(a.endTurnFast()).toBe(true);
      await hub.settle();
      // capture the boundary state BEFORE planning the next turn
      previewSlices.set(turn + 1, ownSlice(a.getPlanned()!, 0));
      expect(a.fastTurn()).toBe(turn + 1);
    }

    // the authoritative sim has not moved: Bob never committed
    expect(a.getState()!.turn).toBe(1);
    expect(b.getState()!.turn).toBe(1);
    expect(a.fastAheadTurns()).toBe(5);

    // Bob catches up turn by turn, spawning ships as he goes so HIS entity
    // allocations interleave with Ann's drained orders in the log
    const bobState = b.getState()!;
    const bobHome = bobState.colonies.find((c) => c.owner === 1)!;
    const bobStar = bobState.planets.find((p) => p.id === bobHome.planetId)!.starId;
    const bobDesign = bobState.empires.find((e) => e.id === 1)!.designs[0]!;
    for (let i = 0; i < 5; i++) {
      b.submit('debug_spawn_ships', { starId: bobStar, designId: bobDesign.id, count: 2 });
      b.commitTurn();
      await hub.settle();
    }
    expect(a.getState()!.turn).toBe(6);
    expect(b.getState()!.turn).toBe(6);

    // every peer folded the same log
    const eng = engine();
    expect(eng.hash(a.getState()!)).toBe(eng.hash(b.getState()!));

    // the preview predicted Ann's empire EXACTLY at every boundary
    for (const [turn, slice] of previewSlices) {
      expect(authSlices.get(turn), `authoritative boundary for turn ${turn}`).toBeDefined();
      expect(authSlices.get(turn), `own-slice fidelity at turn ${turn}`).toBe(slice);
    }
  }, 120_000);

  it('the flagship combo: fast start on an advanced (big identical empires) map', async () => {
    const { hub, hosted, joiner } = makeTable({ startMode: 'advanced' });
    await hub.settle();
    hosted.host.startGame(SEED);
    await hub.settle();

    const a = hosted.session;
    const b = joiner;
    const authSlices = new Map<number, string>();
    b.subscribe((ev) => {
      if (ev.type === 'turn-advanced') authSlices.set(ev.turn, ownSlice(b.getState()!, 0));
    });

    // developed empires: many colonies, freighters and scouts from turn one —
    // and still strangers, so the fast phase is live
    const start = a.getState()!;
    expect(start.colonies.filter((c) => c.owner === 0).length).toBeGreaterThanOrEqual(4);
    expect(a.fastPhaseActive()).toBe(true);

    // Ann races 3 turns, ordering builds across her whole empire
    const previewSlices = new Map<number, string>();
    for (let i = 0; i < 3; i++) {
      const turn = a.fastTurn();
      for (const c of a.getPlanned()!.colonies.filter((x) => x.owner === 0).slice(0, 4)) {
        a.submit('set_build_queue', { colonyId: c.id, items: [i % 2 ? 'trade_goods' : 'housing'] });
      }
      expect(a.endTurnFast()).toBe(true);
      await hub.settle();
      previewSlices.set(turn + 1, ownSlice(a.getPlanned()!, 0));
    }
    expect(a.fastAheadTurns()).toBe(3);

    for (let i = 0; i < 3; i++) {
      b.commitTurn();
      await hub.settle();
    }
    expect(a.getState()!.turn).toBe(4);
    const eng = engine();
    expect(eng.hash(a.getState()!)).toBe(eng.hash(b.getState()!));
    for (const [turn, slice] of previewSlices) {
      expect(authSlices.get(turn), `own-slice fidelity at turn ${turn}`).toBe(slice);
    }
  }, 120_000);

  it('both players ahead: the host cascades through every mutually-committed turn', async () => {
    const { hub, hosted, joiner } = makeTable();
    await hub.settle();
    hosted.host.startGame(SEED);
    await hub.settle();

    const a = hosted.session;
    const b = joiner;
    // both race 3 turns without ever waiting for each other
    for (let i = 0; i < 3; i++) {
      expect(a.endTurnFast()).toBe(true);
      await hub.settle();
    }
    expect(a.getState()!.turn).toBe(1); // Bob has not committed anything
    for (let i = 0; i < 3; i++) {
      expect(b.endTurnFast()).toBe(true);
      await hub.settle();
    }
    // Bob's commits complete turns 1..3: the pump cascades all of them
    expect(a.getState()!.turn).toBe(4);
    expect(b.getState()!.turn).toBe(4);
    expect(a.fastAheadTurns()).toBe(0);
    expect(b.fastAheadTurns()).toBe(0);
    const eng = engine();
    expect(eng.hash(a.getState()!)).toBe(eng.hash(b.getState()!));
  }, 120_000);

  it('blocks End Turn at the +10 cap over the slowest player', async () => {
    const { hub, hosted } = makeTable();
    await hub.settle();
    hosted.host.startGame(SEED);
    await hub.settle();

    const a = hosted.session;
    let capped = 0;
    a.subscribe((ev) => {
      if (ev.type === 'fast-cap') capped++;
    });
    for (let i = 0; i < FAST_MAX_AHEAD; i++) {
      expect(a.endTurnFast()).toBe(true);
      await hub.settle();
    }
    expect(a.fastAheadTurns()).toBe(FAST_MAX_AHEAD);
    expect(a.endTurnFast()).toBe(false); // the 11th is refused
    expect(capped).toBe(1);
  }, 120_000);

  it('first contact rewinds the fast player and returns the table to lockstep', async () => {
    const { hub, hosted, joiner } = makeTable({ debug: true });
    await hub.settle();
    hosted.host.startGame(SEED);
    await hub.settle();

    const a = hosted.session;
    const b = joiner;
    const contacts: Array<{ who: string; turn: number }> = [];
    a.subscribe((ev) => {
      if (ev.type === 'contact') contacts.push({ who: 'a', turn: ev.turn });
    });
    b.subscribe((ev) => {
      if (ev.type === 'contact') contacts.push({ who: 'b', turn: ev.turn });
    });

    // Ann races ahead; on her 4th turn she plants a colony in Bob's home
    // system (debug command — buffered like any other order)
    const start = a.getState()!;
    const bobHome = start.colonies.find((c) => c.owner === 1)!;
    const bobStar = start.planets.find((p) => p.id === bobHome.planetId)!.starId;
    const sibling = start.planets.find(
      (p) => p.starId === bobStar && p.body === 'planet' && !start.colonies.some((c) => c.planetId === p.id),
    );
    expect(sibling, 'an unsettled sibling planet in the joiner home system').toBeDefined();

    for (let i = 0; i < 5; i++) {
      if (a.fastTurn() === 4) {
        a.submit('debug_found_colony', { planetId: sibling!.id });
      }
      expect(a.endTurnFast()).toBe(true);
      await hub.settle();
    }
    expect(a.fastAheadTurns()).toBe(5);

    // Bob catches up; the drain of turn 4 plants the colony -> CONTACT
    for (let i = 0; i < 5 && contacts.length === 0; i++) {
      b.commitTurn();
      await hub.settle();
    }

    // both sides saw the flash at the same synced turn
    expect(contacts.map((c) => c.who).sort()).toEqual(['a', 'b']);
    const contactTurn = contacts[0]!.turn;
    expect(contacts.every((c) => c.turn === contactTurn)).toBe(true);

    // Ann was rewound: preview gone, everyone stands at the synced turn
    expect(a.fastPhaseActive()).toBe(false);
    expect(b.fastPhaseActive()).toBe(false);
    expect(a.getPlanned()!.turn).toBe(a.getState()!.turn);
    expect(a.getState()!.turn).toBe(contactTurn);
    expect(a.fastAheadTurns()).toBe(0);

    // classic lockstep from here: one commit each, ONE turn advances
    const before = a.getState()!.turn;
    a.commitTurn();
    await hub.settle();
    expect(a.getState()!.turn).toBe(before); // still waiting on Bob
    b.commitTurn();
    await hub.settle();
    expect(a.getState()!.turn).toBe(before + 1);
    expect(b.getState()!.turn).toBe(before + 1);

    // determinism: refolding the full log reproduces the live state
    const eng = engine();
    let replayed: GameState | null = null;
    for (const cmd of hosted.host.getLog()) {
      replayed = cmd.kind === 'game_start' ? eng.init(cmd.payload as never) : eng.apply(replayed!, cmd);
    }
    expect(eng.hash(replayed!)).toBe(eng.hash(a.getState()!));
  }, 120_000);
});
