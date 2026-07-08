import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';

const SEED = '0123456789abcdef0123456789abcdef';
const engine = gameEngine as unknown as EngineAdapter<GameState>;

function identity(name: string) {
  return {
    name,
    engineVersion: '0.1.0',
    dataVersion: 'dv-test',
    roomCode: 'WARROOM',
    lobbyServer: 'memory',
  };
}

async function warGame(battleTimeoutMs: number) {
  const hub = new MemoryHub(2);
  const t0 = hub.join();
  const t1 = hub.join();
  const hosted = createHostedGame<GameState>({
    transport: t0,
    engine,
    store: null,
    settings: {
      ...DEFAULT_SETTINGS,
      playerCount: 2,
      battleOrdersTimeoutMs: battleTimeoutMs,
      debugCommands: true,
    },
    identity: identity('Host'),
  });
  const client = joinGame<GameState>({
    transport: t1,
    engine,
    store: null,
    identity: identity('Client'),
  });
  await hub.settle();
  hosted.host.startGame(SEED);
  await hub.settle();

  // to war, and fleets to the client's home system
  const state = client.getState()!;
  const clientHome = state.colonies.find((c) => c.owner === 1)!;
  const starId = state.planets.find((p) => p.id === clientHome.planetId)!.starId;
  hosted.session.submit('declare_war', { target: 1 });
  await hub.settle();
  hosted.session.submit('debug_spawn_ships', {
    starId,
    designId: hosted.session.getState()!.empires[0]!.designs[0]!.id,
    count: 3,
  });
  client.submit('debug_spawn_ships', {
    starId,
    designId: client.getState()!.empires[1]!.designs[0]!.id,
    count: 2,
  });
  await hub.settle();
  hosted.session.commitTurn();
  client.commitTurn();
  await hub.settle();
  return { hub, hosted, client };
}

describe('battle-orders sub-phase over the protocol', () => {
  it('pauses on encounters, resumes when both sides order, hashes agree', async () => {
    const { hub, hosted, client } = await warGame(60_000);
    expect(hosted.session.getState()!.phase).toBe('battle_orders');
    expect(client.getState()!.phase).toBe('battle_orders');
    const turnBefore = client.getState()!.turn;
    const battle = client.getState()!.pendingBattles[0]!;

    // normal orders are rejected during the sub-phase
    const rejected = client.submit('set_research', { fieldNum: 3, targetApp: null });
    expect(rejected.error).toMatch(/battle/);

    hosted.session.submit('battle_orders', {
      battleId: battle.id,
      orders: { stance: 'charge', priority: 'nearest', retreatThresholdPct: 25, bombard: false },
    });
    await hub.settle();
    expect(client.getState()!.turn).toBe(turnBefore); // still waiting for defender

    client.submit('battle_orders', {
      battleId: battle.id,
      orders: { stance: 'hold_range', priority: 'biggest', retreatThresholdPct: 25, bombard: false },
    });
    await hub.settle();

    // host auto-emitted resolve_combat
    expect(hosted.session.getState()!.phase).toBe('planning');
    expect(client.getState()!.turn).toBe(turnBefore + 1);
    expect(engine.hash(hosted.session.getState()!)).toBe(engine.hash(client.getState()!));
    hosted.host.close();
  });

  it('host resolves with defaults after the order timeout', async () => {
    const { hub, hosted, client } = await warGame(80);
    const turnBefore = client.getState()!.turn;
    expect(client.getState()!.phase).toBe('battle_orders');
    // nobody submits orders; wait past the timeout
    await new Promise((r) => setTimeout(r, 200));
    await hub.settle();
    expect(hosted.session.getState()!.phase).toBe('planning');
    expect(client.getState()!.turn).toBe(turnBefore + 1);
    expect(engine.hash(hosted.session.getState()!)).toBe(engine.hash(client.getState()!));
    hosted.host.close();
  });
});
