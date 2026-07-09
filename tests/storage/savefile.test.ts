import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, gameEngine } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import { canonicalStringify } from '@engine/canonical';
import {
  decodeSaveFile,
  encodeSaveFile,
  SaveFileError,
  verifySaveEnvelope,
  type SaveEnvelope,
} from '@storage/savefile';
import { openNodeStore } from '@storage/node';
import { expanderBot, runHeadlessGame } from '../../src/headless/bots';

const SEED = 'fedcba9876543210fedcba9876543210';

/** Play a short real game and persist it exactly like a live session would. */
async function buildRealSave(turns = 12): Promise<{ envelope: SaveEnvelope; liveHash: string }> {
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
      lobbyServer: 'http://127.0.0.1:8787',
      roomCode: 'SAVED',
    },
    players.map((p) => ({ id: p.id, name: p.name })),
  );
  // the live log starts with game_start (seq 0), then the recorded commands
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
  const rest = run.log.map((c, i) => ({
    seq: i + 1,
    turn: c.turn,
    playerId: c.playerId,
    kind: c.kind,
    payload: c.payload,
  }));
  await store.appendCommands(gameId, [gameStart, ...rest]);
  const liveHash = gameEngine.hash(run.state);
  await store.saveSnapshot(gameId, run.state.turn, rest.length, gameEngine.serialize(run.state), liveHash);
  const envelope = await store.exportGame(gameId);
  await store.destroy();
  return { envelope, liveHash };
}

describe('save file format', () => {
  it('encode -> decode round-trips and replay-verifies', async () => {
    const { envelope, liveHash } = await buildRealSave();
    const bytes = await encodeSaveFile(envelope);
    expect(bytes.length).toBeGreaterThan(64);
    const back = await decodeSaveFile(bytes);
    expect(back).toEqual(envelope);
    const verified = verifySaveEnvelope(back);
    expect(verified.finalHash).toBe(liveHash);
    expect(verified.commandCount).toBe(envelope.commands.length);
  });

  it('accepts a plain JSON envelope (debug format)', async () => {
    const { envelope } = await buildRealSave(4);
    const bytes = new TextEncoder().encode(canonicalStringify(envelope as unknown as Record<string, unknown>));
    const back = await decodeSaveFile(bytes);
    expect(back.game.game_id).toBe(envelope.game.game_id);
    expect(() => verifySaveEnvelope(back)).not.toThrow();
  });

  it('rejects corrupted files with clear layered errors', async () => {
    const { envelope } = await buildRealSave(4);
    const good = await encodeSaveFile(envelope);

    // bad magic
    const badMagic = new Uint8Array(good);
    badMagic[0] = 0x58;
    await expect(decodeSaveFile(badMagic)).rejects.toMatchObject({ stage: 'magic' });

    // unsupported version
    const badVersion = new Uint8Array(good);
    badVersion[8] = 9;
    await expect(decodeSaveFile(badVersion)).rejects.toMatchObject({ stage: 'version' });

    // truncated / corrupted compression
    const truncated = good.slice(0, Math.floor(good.length / 2));
    await expect(decodeSaveFile(truncated)).rejects.toMatchObject({ stage: 'compression' });

    // tiny file
    await expect(decodeSaveFile(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ stage: 'magic' });

    // valid gzip of non-JSON
    const { gzip } = await import('@storage/gzip');
    const notJson = await gzip(new TextEncoder().encode('definitely not json'));
    const framed = new Uint8Array(9 + notJson.length);
    framed.set(new TextEncoder().encode('MOO2SAVE'), 0);
    framed[8] = 1;
    framed.set(notJson, 9);
    await expect(decodeSaveFile(framed)).rejects.toMatchObject({ stage: 'json' });
  });

  it('rejects structural damage (gaps, wrong first command, bad seed)', async () => {
    const { envelope } = await buildRealSave(4);

    const gap = structuredClone(envelope);
    gap.commands.splice(2, 1);
    await expect(decodeSaveFile(await encodeSaveFile(gap))).rejects.toMatchObject({ stage: 'structure' });

    const noStart = structuredClone(envelope);
    noStart.commands[0]!.kind = 'not_game_start';
    await expect(decodeSaveFile(await encodeSaveFile(noStart))).rejects.toMatchObject({ stage: 'structure' });

    const badSeed = structuredClone(envelope);
    badSeed.game.seed = 'zznotaseed';
    await expect(decodeSaveFile(await encodeSaveFile(badSeed))).rejects.toMatchObject({ stage: 'structure' });
  });

  it('version mismatches degrade to snapshot-mode loading (forward compatibility)', async () => {
    const { envelope, liveHash } = await buildRealSave(12);

    const wrongEngine = structuredClone(envelope);
    wrongEngine.game.engine_version = '99.0.0';
    const v1 = verifySaveEnvelope(wrongEngine);
    expect(v1.mode).toBe('snapshot');
    expect(v1.finalHash).toBe(liveHash); // final snapshot is the load base
    expect(v1.warnings.join(' ')).toContain('99.0.0');

    const wrongData = structuredClone(envelope);
    wrongData.game.data_version = 'deadbeefdeadbeef';
    const v2 = verifySaveEnvelope(wrongData);
    expect(v2.mode).toBe('snapshot');

    // without any snapshot, a version-mismatched save is genuinely unloadable
    const noSnap = structuredClone(wrongEngine);
    noSnap.snapshot = null;
    noSnap.snapshots = [];
    expect(() => verifySaveEnvelope(noSnap)).toThrowError(
      expect.objectContaining({ stage: 'engine_version' }) as never,
    );

    // a tampered snapshot cannot pass snapshot-mode integrity
    const badSnap = structuredClone(wrongEngine);
    badSnap.snapshot = { ...badSnap.snapshot!, stateHash: 'deadbeefdeadbeef' };
    expect(() => verifySaveEnvelope(badSnap)).toThrowError(expect.objectContaining({ stage: 'snapshot' }) as never);
  });

  it('rejects tampered logs on same-version replay', async () => {
    const { envelope } = await buildRealSave(12);
    // tamper a command before the snapshot seq: the replay hash check trips
    const tampered = structuredClone(envelope);
    expect(tampered.snapshot).not.toBeNull();
    const idx = tampered.commands.findIndex(
      (c: { seq: number; kind: string }) => c.seq > 0 && c.seq < tampered.snapshot!.seq && c.kind === 'set_jobs',
    );
    expect(idx).toBeGreaterThan(0);
    const payload = JSON.parse(tampered.commands[idx]!.payload) as { groups: Array<{ farmers: number; workers: number; scientists: number }> };
    const g = payload.groups[0]!;
    if (g.workers > 0) {
      g.workers--;
      g.farmers++;
    } else {
      g.farmers = Math.max(0, g.farmers - 1);
      g.workers++;
    }
    tampered.commands[idx]!.payload = canonicalStringify(payload);
    expect(() => verifySaveEnvelope(tampered)).toThrowError(
      expect.objectContaining({ stage: 'replay' }) as never,
    );
  });
});

describe('save -> import -> re-host integration', () => {
  it('an imported save resumes to the identical state on a fresh store', async () => {
    const { envelope, liveHash } = await buildRealSave(15);
    const bytes = await encodeSaveFile(envelope);
    const decoded = await decodeSaveFile(bytes);
    verifySaveEnvelope(decoded);

    // import into a fresh database under a NEW room code (manual re-host)
    const store = await openNodeStore();
    const rehomed: SaveEnvelope = {
      ...decoded,
      game: { ...decoded.game, room_code: 'NEWROOM', local_player_id: 0, status: 'active' },
    };
    await store.importGame(rehomed, true);

    // resume exactly like the host does: snapshot + tail fold
    const games = await store.listGames();
    const g = games.find((x) => x.room_code === 'NEWROOM' && x.status === 'active');
    expect(g).toBeDefined();
    const snap = await store.latestSnapshot(g!.game_id);
    let state = snap ? gameEngine.deserialize(snap.stateJson) : null;
    let lastSeq = snap?.seq ?? -1;
    for (const c of await store.readCommands(g!.game_id, lastSeq + 1)) {
      state = c.kind === 'game_start' ? gameEngine.init(c.payload as never) : state ? gameEngine.apply(state, c as never) : null;
      gameEngine.takeEvents();
      lastSeq = c.seq;
    }
    expect(state).not.toBeNull();
    expect(gameEngine.hash(state!)).toBe(liveHash);

    // and the game continues: advance a turn without error
    state = gameEngine.apply(state!, { turn: state!.turn, playerId: -1, kind: 'advance_turn', payload: {} } as never);
    gameEngine.takeEvents();
    expect(state.turn).toBeGreaterThan(0);
    await store.destroy();
  });
});
