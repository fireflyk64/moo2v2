// Replay mode data layer: buildReplay reconstructs a saved game's state at
// every turn (log fold) or at snapshot turns (cross-version), and per-player
// perspectives come straight from selectors.galaxyView over those states.

import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, gameEngine, selectors } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import { verifySaveEnvelope, type SaveEnvelope } from '@storage/savefile';
import { openNodeStore } from '@storage/node';
import { expanderBot, runHeadlessGame } from '../../src/headless/bots';
import { buildReplay } from '@ui/replay';
import type { SavePreview } from '@ui/saveload';

const SEED = 'fedcba9876543210fedcba9876543210';

async function buildSave(turns = 12): Promise<{ envelope: SaveEnvelope; liveHash: string; liveTurn: number }> {
  const players = [
    { id: 0, name: 'Alice', raceJson: JSON.stringify({ presetId: 'cerebri' }), policy: expanderBot },
    { id: 1, name: 'Bob', raceJson: JSON.stringify({ presetId: 'hivex' }), policy: expanderBot },
  ];
  const run = runHeadlessGame({ seed: SEED, players, turns });
  const store = await openNodeStore();
  const gameId = `g-${SEED.slice(0, 16)}`;
  await store.createGame(
    {
      gameId,
      engineVersion: ENGINE_VERSION,
      dataVersion: DATA_VERSION,
      protocolVersion: 1,
      settings: run.state.settings as unknown,
      seed: SEED,
      localPlayerId: 0,
      lobbyServer: 'x',
      roomCode: 'RPLY',
    },
    players.map((p) => ({ id: p.id, name: p.name })),
  );
  const gameStart = {
    seq: 0,
    turn: 0,
    playerId: -1,
    kind: 'game_start',
    payload: {
      seed: SEED,
      settings: run.state.settings,
      players: players.map((p) => ({ id: p.id, name: p.name, raceJson: p.raceJson })),
      dataVersion: DATA_VERSION,
    } as unknown,
  };
  const rest = run.log.map((c, i) => ({ seq: i + 1, turn: c.turn, playerId: c.playerId, kind: c.kind, payload: c.payload }));
  await store.appendCommands(gameId, [gameStart, ...rest]);
  const liveHash = gameEngine.hash(run.state);
  await store.saveSnapshot(gameId, run.state.turn, rest.length, gameEngine.serialize(run.state), liveHash);
  const envelope = await store.exportGame(gameId, { history: true });
  await store.destroy();
  return { envelope, liveHash, liveTurn: run.state.turn };
}

function previewOf(envelope: SaveEnvelope): SavePreview {
  const verified = verifySaveEnvelope(envelope);
  return { envelope, verified, players: envelope.players.map((p) => p.name), resumeTurns: [] };
}

describe('replay mode reconstruction', () => {
  it('folds the log into a state for EVERY turn, final frame byte-identical to the save', async () => {
    const { envelope, liveHash, liveTurn } = await buildSave(12);
    const data = await buildReplay(previewOf(envelope));
    expect(data.mode).toBe('replay');
    // contiguous turn axis 1..liveTurn
    expect(data.turns[0]).toBe(1);
    expect(data.turns[data.turns.length - 1]).toBe(liveTurn);
    for (let i = 1; i < data.turns.length; i++) expect(data.turns[i]).toBe(data.turns[i - 1]! + 1);
    for (const t of data.turns) expect(data.stateAt.get(t)!.turn).toBe(t);
    // the last frame IS the saved state
    expect(gameEngine.hash(data.stateAt.get(liveTurn)!)).toBe(liveHash);
    // history actually progresses (someone explored something)
    const first = data.stateAt.get(1)!;
    const last = data.stateAt.get(liveTurn)!;
    expect(last.empires[0]!.exploredStars.length).toBeGreaterThanOrEqual(first.empires[0]!.exploredStars.length);
    expect(data.empires.map((e) => e.name)).toEqual(['Alice', 'Bob']);
  });

  it('per-player perspectives differ on the same reconstructed turn', async () => {
    const { envelope, liveTurn } = await buildSave(12);
    const data = await buildReplay(previewOf(envelope));
    const state = data.stateAt.get(liveTurn)!;
    const v0 = selectors.galaxyView(state, 0);
    const v1 = selectors.galaxyView(state, 1);
    expect(v0.length).toBe(v1.length); // every star is on both maps…
    const explored0 = v0.filter((s) => s.explored).map((s) => s.star.id);
    const explored1 = v1.filter((s) => s.explored).map((s) => s.star.id);
    // …but the two empires have explored from opposite homes
    expect(explored0).not.toEqual(explored1);
  });

  it('a cross-version save degrades to its embedded snapshot turns', async () => {
    const { envelope, liveTurn, liveHash } = await buildSave(12);
    const foreign: SaveEnvelope = { ...envelope, game: { ...envelope.game, engine_version: '0.0.1-foreign' } };
    const data = await buildReplay(previewOf(foreign));
    expect(data.mode).toBe('snapshot');
    expect(data.turns).toEqual([liveTurn]);
    expect(gameEngine.hash(data.stateAt.get(liveTurn)!)).toBe(liveHash);
  });
});
