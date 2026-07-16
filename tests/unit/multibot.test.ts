import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { createGameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot } from '@ui/soloBot';

const identity = (name: string) => ({
  name,
  engineVersion: '0.1.0',
  dataVersion: 'dv-test',
  roomCode: 'TRNY',
  lobbyServer: 'memory',
});

// Multi-bot solo games (enterSoloGame with N bot specs): one human seat plus
// two bots with distinct personalities, races, colors and fleet styles must
// produce a game that actually advances, with both bot empires dressed as
// configured.
describe('multi-bot game', () => {
  it('human + 2 configured bots plays 8 turns', async () => {
    const hub = new MemoryHub(3);
    const engine = () => createGameEngine() as unknown as EngineAdapter<GameState>;
    const hosted = createHostedGame<GameState>({
      transport: hub.join(),
      engine: engine(),
      hostEngine: engine(),
      store: null,
      settings: { ...DEFAULT_SETTINGS, playerCount: 3, debugCommands: false, startMode: 'average', pickPoints: 14 },
      identity: identity('Human'),
    });
    const bot1 = new SoloBot({
      session: joinGame<GameState>({ transport: hub.join(), engine: engine(), store: null, identity: identity('Bot') }),
      mode: 'fair',
      personality: 'expander',
      race: 'lithovores',
      color: '#5ee08a',
      shipStyle: 'lattice',
    });
    const bot2 = new SoloBot({
      session: joinGame<GameState>({ transport: hub.join(), engine: engine(), store: null, identity: identity('Bot 2') }),
      mode: 'fair',
      personality: 'militarist',
      race: 'cyborgs',
      color: '#ffd75e',
      shipStyle: 'crescent',
    });
    // the "human": ready up and rubber-stamp every planning turn
    hosted.session.setRaceConfig(JSON.stringify({ presetId: 'solari' }), true);
    hosted.session.subscribe((ev) => {
      if (ev.type === 'started' || ev.type === 'turn-advanced' || ev.type === 'state') hosted.session.commitTurn();
    });
    await hub.settle();
    hosted.host.startGame('393fb1637b94ab1c3bab42a890abd11f');
    for (let i = 0; i < 100; i++) {
      await hub.settle();
      const st = hosted.session.getState();
      if (st && st.turn >= 8) break;
      hosted.session.commitTurn();
    }
    const st = hosted.session.getState()!;
    expect(st.turn).toBeGreaterThanOrEqual(8);
    expect(st.empires).toHaveLength(3);
    const e1 = st.empires.find((e) => e.id === bot1.seatId)!;
    const e2 = st.empires.find((e) => e.id === bot2.seatId)!;
    expect(e1.raceName).toBe('Lithovore Hollows');
    expect(e1.picks).toContain('lithovore');
    expect(e1.color).toBe('#5ee08a');
    expect(e1.shipStyle).toBe('lattice');
    expect(e2.raceName).toBe('Cybernetic Union');
    expect(e2.picks).toContain('cybernetic');
    expect(e2.color).toBe('#ffd75e');
    expect(e2.shipStyle).toBe('crescent');
    bot1.close();
    bot2.close();
  });
});
