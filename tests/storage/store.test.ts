import { describe, expect, it } from 'vitest';
import { openNodeStore } from '@storage/node';
import type { GameMeta } from '@storage/repo';
import { canonicalStringify, hashCanonical } from '@engine/canonical';

const meta: GameMeta = {
  gameId: 'g-test-1',
  engineVersion: '0.1.0',
  dataVersion: 'abcdef0123456789',
  protocolVersion: 1,
  settings: { galaxySize: 'medium', modes: { creativeVariant: false } },
  seed: '0123456789abcdef0123456789abcdef',
  localPlayerId: 0,
  lobbyServer: 'http://127.0.0.1:8787',
  roomCode: 'TESTROOM',
};

describe('GameStore (node/better-sqlite3)', () => {
  it('creates a game and round-trips the command log', async () => {
    const store = await openNodeStore();
    await store.createGame(meta, [
      { id: 0, name: 'Alice' },
      { id: 1, name: 'Bob' },
    ]);

    const game = await store.getGame('g-test-1');
    expect(game?.room_code).toBe('TESTROOM');
    expect(game?.last_seq).toBe(-1);

    const cmds = Array.from({ length: 100 }, (_, i) => ({
      seq: i,
      turn: Math.floor(i / 10),
      playerId: i % 2,
      kind: 'test_cmd',
      payload: { i, data: [i, i * 2] },
    }));
    await store.appendCommands('g-test-1', cmds);

    const back = await store.readCommands('g-test-1');
    expect(back.length).toBe(100);
    expect(back[42]).toEqual(cmds[42]);
    expect((await store.getGame('g-test-1'))?.last_seq).toBe(99);

    const tail = await store.readCommands('g-test-1', 95);
    expect(tail.map((c) => c.seq)).toEqual([95, 96, 97, 98, 99]);

    // re-appending a seq is an idempotent UPSERT (a host crash-and-resume can
    // reissue a seq for a different command; last-writer-wins keeps the live
    // branch instead of permanently interleaving two branches)
    const replacement = { seq: 0, turn: 0, playerId: 1, kind: 'replaced_cmd', payload: { i: -1, data: [] } };
    await store.appendCommands('g-test-1', [replacement]);
    const after = await store.readCommands('g-test-1', 0, 0);
    expect(after).toEqual([replacement]);
    expect((await store.readCommands('g-test-1')).length).toBe(100);
    await store.destroy();
  });

  it('snapshot gzip round-trip preserves content and hash', async () => {
    const store = await openNodeStore();
    await store.createGame(meta, []);
    const state = { turn: 7, colonies: Array.from({ length: 50 }, (_, i) => ({ id: i, pop: i * 3 })) };
    const json = canonicalStringify(state);
    const hash = hashCanonical(state);
    await store.saveSnapshot('g-test-1', 7, 123, json, hash);

    const snap = await store.latestSnapshot('g-test-1');
    expect(snap?.turn).toBe(7);
    expect(snap?.seq).toBe(123);
    expect(snap?.stateJson).toBe(json);
    expect(snap?.stateHash).toBe(hash);
    expect(hashCanonical(JSON.parse(snap!.stateJson))).toBe(hash);
    await store.destroy();
  });

  it('turn hashes, events, chat, prefs', async () => {
    const store = await openNodeStore();
    await store.createGame(meta, []);
    await store.saveTurnHash('g-test-1', 1, 'aaaa');
    expect(await store.getTurnHash('g-test-1', 1)).toBe('aaaa');

    await store.appendTurnEvents('g-test-1', 1, [
      { idx: 0, visibleTo: -1, kind: 'building_complete', payload: { colony: 1 } },
      { idx: 1, visibleTo: 1, kind: 'spy_report', payload: { target: 0 } },
    ]);
    const forP0 = await store.readTurnEvents('g-test-1', 0, 5, 0);
    expect(forP0.map((e) => e.kind)).toEqual(['building_complete']);
    const forP1 = await store.readTurnEvents('g-test-1', 0, 5, 1);
    expect(forP1.length).toBe(2);

    await store.appendChat('g-test-1', { id: 0, turn: 1, from: 0, to: -1, text: 'hi', sentAt: 'now' });
    expect((await store.readChat('g-test-1'))[0]?.text).toBe('hi');

    await store.setPref('name', 'Tester');
    expect(await store.getPref('name')).toBe('Tester');
    await store.setPref('name', 'Tester2');
    expect(await store.getPref('name')).toBe('Tester2');
    await store.destroy();
  });

  it('export/import round-trips a full game', async () => {
    const a = await openNodeStore();
    await a.createGame(meta, [{ id: 0, name: 'Alice' }]);
    await a.appendCommands('g-test-1', [
      { seq: 0, turn: 0, playerId: -1, kind: 'game_start', payload: { seed: meta.seed } },
      { seq: 1, turn: 0, playerId: 0, kind: 'set_jobs', payload: { colony: 1 } },
    ]);
    await a.saveSnapshot('g-test-1', 0, 1, canonicalStringify({ t: 0 }), hashCanonical({ t: 0 }));
    const envelope = await a.exportGame('g-test-1');

    const b = await openNodeStore();
    await b.importGame(envelope);
    const commands = await b.readCommands('g-test-1');
    expect(commands.length).toBe(2);
    expect(commands[0]!.kind).toBe('game_start');
    const snap = await b.latestSnapshot('g-test-1');
    expect(snap?.stateHash).toBe(hashCanonical({ t: 0 }));
    const reExport = await b.exportGame('g-test-1');
    expect(reExport.commands).toEqual(envelope.commands);
    expect(reExport.players).toEqual(envelope.players);
    await a.destroy();
    await b.destroy();
  });

  it('battle replays round-trip', async () => {
    const store = await openNodeStore();
    await store.createGame(meta, []);
    const replay = { seed: meta.seed, orders: { 0: 'charge' }, initial: { ships: [1, 2, 3] } };
    await store.saveBattleReplay('g-test-1', 'b1', 3, canonicalStringify(replay), { winner: 0 });
    const back = await store.getBattleReplay('g-test-1', 'b1');
    expect(JSON.parse(back!.replayJson)).toEqual(replay);
    expect(back!.summary).toEqual({ winner: 0 });
    await store.destroy();
  });
});
