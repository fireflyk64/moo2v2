import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, gameEngine } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import {
  decodeSaveFile,
  encodeSaveFile,
  resumePoints,
  verifySaveEnvelope,
  type SaveEnvelope,
} from '@storage/savefile';
import { rebaseSave } from '@storage/rebase';
import { openNodeStore } from '@storage/node';
import { expanderBot, runHeadlessGame } from '../../src/headless/bots';

const SEED = 'fedcba9876543210fedcba9876543210';
const BRANCH_SEED = '00112233445566778899aabbccddeeff';

async function buildSave(turns = 15, history = true): Promise<{ envelope: SaveEnvelope; liveHash: string; liveTurn: number }> {
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
      roomCode: 'FWD',
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
  // periodic snapshot at turn 10 (mirrors the live session cadence)…
  let midState = null as ReturnType<typeof gameEngine.init> | null;
  let midSeq = 0;
  {
    let s = null as ReturnType<typeof gameEngine.init> | null;
    for (const c of [gameStart, ...rest]) {
      s = c.kind === 'game_start' ? gameEngine.init(c.payload as never) : gameEngine.apply(s!, c as never);
      gameEngine.takeEvents();
      if (gameEngine.turnOf(s!) === 10 && !midState) {
        midState = s;
        midSeq = c.seq;
      }
    }
  }
  if (midState) await store.saveSnapshot(gameId, 10, midSeq, gameEngine.serialize(midState), gameEngine.hash(midState));
  // …and the save-time snapshot of the final state
  const liveHash = gameEngine.hash(run.state);
  await store.saveSnapshot(gameId, run.state.turn, rest.length, gameEngine.serialize(run.state), liveHash);
  const envelope = await store.exportGame(gameId, { history });
  await store.destroy();
  return { envelope, liveHash, liveTurn: run.state.turn };
}

describe('forward-compatible saves (bug: the last time we break save games)', () => {
  it('v2 saves embed history snapshots and advertise resume points', async () => {
    const { envelope, liveTurn } = await buildSave(15);
    expect(envelope.version).toBe(2);
    expect(envelope.history).toBe(true);
    expect(envelope.snapshot!.turn).toBe(liveTurn);
    expect((envelope.snapshots ?? []).some((s) => s.turn === 10)).toBe(true);
    const verified = verifySaveEnvelope(envelope);
    expect(verified.mode).toBe('replay');
    const points = resumePoints(envelope, verified.mode);
    expect(points).toContain(10);
    expect(points).toContain(5); // any logged turn works in replay mode
  });

  it('no-history saves keep only the final snapshot and still load', async () => {
    const { envelope, liveHash, liveTurn } = await buildSave(15, false);
    expect(envelope.history).toBe(false);
    expect(envelope.commands).toHaveLength(0);
    expect(envelope.snapshots).toHaveLength(0);
    const bytes = await encodeSaveFile(envelope);
    const back = await decodeSaveFile(bytes);
    const verified = verifySaveEnvelope(back);
    expect(verified.mode).toBe('snapshot'); // no log to replay
    expect(verified.turn).toBe(liveTurn);
    expect(verified.finalHash).toBe(liveHash);
  });

  it('what-if: rebasing to an older turn produces a playable branch', async () => {
    const { envelope } = await buildSave(15);
    const { envelope: branch, turn } = rebaseSave(envelope, 'replay', 8, BRANCH_SEED);
    expect(turn).toBe(8);
    expect(branch.game.game_id).toBe(`g-${BRANCH_SEED.slice(0, 16)}`);
    // the branch is a valid same-version save in its own right
    const verified = verifySaveEnvelope(branch);
    expect(verified.mode).toBe('replay'); // one game_start command, replayable
    expect(verified.turn).toBe(8);
    // and the game continues from there
    let state = gameEngine.init(JSON.parse(branch.commands[0]!.payload) as never);
    expect(state.turn).toBe(8);
    state = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'advance_turn', payload: {} });
    gameEngine.takeEvents();
    if (state.phase === 'battle_orders') {
      state = gameEngine.apply(state, { turn: state.turn, playerId: -1, kind: 'resolve_combat', payload: {} });
      gameEngine.takeEvents();
    }
    expect(state.turn).toBe(9);
  });

  it('a save from a "different version" loads via snapshot rebase (simulated future build)', async () => {
    const { envelope, liveHash, liveTurn } = await buildSave(15);
    const foreign = structuredClone(envelope);
    foreign.game.engine_version = '0.0.1-ancient';
    const verified = verifySaveEnvelope(foreign);
    expect(verified.mode).toBe('snapshot');
    const { envelope: branch, turn } = rebaseSave(foreign, 'snapshot', undefined, BRANCH_SEED);
    expect(turn).toBe(liveTurn);
    // the rebased branch is stamped with THIS build's versions and replays
    expect(branch.game.engine_version).toBe(ENGINE_VERSION);
    const v2 = verifySaveEnvelope(branch);
    expect(v2.mode).toBe('replay');
    expect(v2.finalHash).toBe(liveHash); // identical state, new lineage
    // snapshot-mode branching to an older turn picks the nearest snapshot
    const { turn: t10 } = rebaseSave(foreign, 'snapshot', 12, BRANCH_SEED);
    expect(t10).toBe(10);
  });
});
