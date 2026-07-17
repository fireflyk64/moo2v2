// Map-view quick builds: hotkeys resolve to latest-tech designs, queue at the
// best-suited colony as PINNED items, the governor keeps hands off pinned
// yards, cancelling/completing hands them back, and idle scouts auto-explore.

import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { governColonies, DEFAULT_WEIGHTS } from '@ui/governor';
import {
  autoExploreScouts,
  bestColonyFor,
  cancelPin,
  pinBuild,
  pinnedStatus,
  reconcilePins,
  resolveHotkeyItem,
  unpinnedTail,
  type Pins,
} from '@ui/quickBuild';

const SEED = 'deadbeefdeadbeefdeadbeefdeadbeef';
const identity = (name: string) => ({ name, engineVersion: '0.1.0', dataVersion: 'dv-test', roomCode: 'QUIK', lobbyServer: 'memory' });

describe('unpinnedTail', () => {
  it('removes one occurrence per pin, preserving order', () => {
    expect(unpinnedTail(['a', 'b', 'a', 'c'], ['a'])).toEqual(['b', 'a', 'c']);
    expect(unpinnedTail(['a', 'b', 'a', 'c'], ['a', 'a'])).toEqual(['b', 'c']);
    expect(unpinnedTail(['b', 'c'], ['a'])).toEqual(['b', 'c']);
    expect(unpinnedTail([], ['a'])).toEqual([]);
  });
});

describe('map-view quick builds', () => {
  it('pins, protects from the governor, cancels, reconciles, auto-explores', async () => {
    const hub = new MemoryHub(2);
    const engine = gameEngine as unknown as EngineAdapter<GameState>;
    const hosted = createHostedGame<GameState>({
      transport: hub.join(),
      engine,
      store: null,
      settings: { ...DEFAULT_SETTINGS, playerCount: 2, galaxySize: 'small', startMode: 'average' },
      identity: identity('Builder'),
    });
    const client = joinGame<GameState>({ transport: hub.join(), engine, store: null, identity: identity('Idler') });
    hosted.session.setRaceConfig(JSON.stringify({ presetId: 'solari' }), true);
    client.setRaceConfig(JSON.stringify({ presetId: 'solari' }), true);
    await hub.settle();
    hosted.host.startGame(SEED);
    await hub.settle();

    // advance one turn so the per-turn auto-design refresh has run
    const advance = async () => {
      hosted.session.commitTurn();
      client.commitTurn();
      await hub.settle();
    };
    for (let i = 0; i < 3; i++) {
      const st = hosted.session.getState()!;
      if (st.empires[0]!.designs.some((d) => d.hull === 'frigate' && !d.obsolete)) break;
      await advance();
    }

    const state = () => hosted.session.getPlanned()!;

    // ---- hotkey resolution ----
    const frigate = resolveHotkeyItem(state(), 0, 'f');
    expect('item' in frigate && frigate.item.startsWith('design:')).toBe(true);
    const scout = resolveHotkeyItem(state(), 0, 's');
    expect('item' in scout && scout.item === (frigate as { item: string }).item).toBe(true);
    expect('note' in scout && !!scout.note).toBe(true); // explains the frigate stand-in
    const titan = resolveHotkeyItem(state(), 0, 't'); // hull locked this early
    expect('error' in titan).toBe(true);
    expect(resolveHotkeyItem(state(), 0, 'h')).toEqual({ item: 'housing' });

    // ---- best colony + pinning ----
    const home = state().colonies.find((c) => c.owner === 0 && !c.outpost)!;
    const homeStar = state().planets.find((p) => p.id === home.planetId)!.starId;
    const designItem = (frigate as { item: string }).item;
    const best = bestColonyFor(state(), 0, homeStar, designItem);
    expect('colony' in best).toBe(true);

    const pins: Pins = {};
    expect(pinBuild(hosted.session, pins, (best as { colony: typeof home }).colony, designItem).error).toBeUndefined();
    const colonyId = (best as { colony: typeof home }).colony.id;
    expect(pins[colonyId]).toEqual([designItem]);
    const queueAfterPin = state().colonies.find((c) => c.id === colonyId)!.queue.map((q) => q.item);
    expect(queueAfterPin[0]).toBe(designItem);

    // second pin lands behind the first, ahead of any tail
    const colonyNow = state().colonies.find((c) => c.id === colonyId)!;
    expect(pinBuild(hosted.session, pins, colonyNow, 'housing').error).toBeUndefined();
    expect(pins[colonyId]).toEqual([designItem, 'housing']);
    expect(
      state()
        .colonies.find((c) => c.id === colonyId)!
        .queue.slice(0, 2)
        .map((q) => q.item),
    ).toEqual([designItem, 'housing']);

    // ---- status bars ----
    const statuses = pinnedStatus(state(), 0, pins);
    expect(statuses).toHaveLength(2);
    expect(statuses[0]!.queuePos).toBe(0);
    expect(statuses[0]!.label).toContain('⚔');
    expect(statuses[1]!.item).toBe('housing');
    expect(statuses[1]!.queuePos).toBe(1);

    // ---- the governor must not touch a pinned yard's queue ----
    governColonies(hosted.session, { ...DEFAULT_WEIGHTS, infra: 10 }, new Set([colonyId]));
    expect(
      state()
        .colonies.find((c) => c.id === colonyId)!
        .queue.slice(0, 2)
        .map((q) => q.item),
    ).toEqual([designItem, 'housing']);

    // ---- cancel: item leaves the queue, remaining pin promotes ----
    expect(cancelPin(hosted.session, pins, state().colonies.find((c) => c.id === colonyId)!, 0).error).toBeUndefined();
    expect(pins[colonyId]).toEqual(['housing']);
    expect(state().colonies.find((c) => c.id === colonyId)!.queue[0]!.item).toBe('housing');

    // ---- and once un-pinned, the governor takes the yard back ----
    governColonies(hosted.session, { ...DEFAULT_WEIGHTS, infra: 10 }, new Set());
    // (no assertion on WHAT it builds — only that pins no longer block it)

    // ---- reconcile: a manual wipe of the queue drops the stale pin ----
    hosted.session.submit('set_build_queue', { colonyId, items: [] });
    expect(reconcilePins(state(), 0, pins)).toBe(true);
    expect(pins[colonyId]).toBeUndefined();

    // ---- auto-explore: the average start's scouts get move orders ----
    const sent = autoExploreScouts(hosted.session);
    expect(sent).toBeGreaterThan(0);
    const moving = state().ships.filter((s) => s.owner === 0 && s.shipKind === 'scout' && s.location.kind === 'transit');
    expect(moving.length).toBe(sent);

    // ---- v2-bot debt handling (autopilot parity): a negative treasury
    // raises the tax and flips the strongest unpinned yard to trade goods ----
    state().empires[0]!.bc = -600;
    governColonies(hosted.session, DEFAULT_WEIGHTS, new Set());
    expect(state().empires[0]!.taxRatePct).toBe(30);
    expect(
      state()
        .colonies.filter((c) => c.owner === 0 && !c.outpost)
        .some((c) => c.queue[0]?.item === 'trade_goods'),
    ).toBe(true);

    await hub.settle();
  }, 120_000);
});
