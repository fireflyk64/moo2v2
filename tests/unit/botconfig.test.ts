import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';
import { gameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { SoloBot } from '@ui/soloBot';

const identity = (name: string) => ({
  name,
  engineVersion: '0.1.0',
  dataVersion: 'dv-test',
  roomCode: 'TRNY',
  lobbyServer: 'memory',
});

describe('archetype picks land in game state', () => {
  it('forgers @16 picks, colored halo fleet', async () => {
    const hub = new MemoryHub(2);
    const engine = gameEngine as unknown as EngineAdapter<GameState>;
    const hosted = createHostedGame<GameState>({
      transport: hub.join(),
      engine,
      store: null,
      settings: { ...DEFAULT_SETTINGS, playerCount: 2, debugCommands: false, startMode: 'pre_warp', pickPoints: 16 },
      identity: identity('A'),
    });
    const client = joinGame<GameState>({ transport: hub.join(), engine, store: null, identity: identity('B') });
    const botA = new SoloBot({ session: hosted.session, mode: 'fair', personality: 'balanced', race: 'solari' });
    const botB = new SoloBot({
      session: client,
      mode: 'fair',
      personality: 'balanced',
      race: 'forgers',
      color: '#ff6b5e',
      shipStyle: 'halo',
    });
    await hub.settle();
    hosted.host.startGame('393fb1637b94ab1c3bab42a890abd11f');
    for (let i = 0; i < 20; i++) {
      await hub.settle();
      const st = hosted.session.getState();
      if (st && st.turn >= 3) break;
    }
    const st = hosted.session.getState()!;
    const emp = st.empires.find((e) => e.id === botB.seatId)!;
    console.log('empire picks:', emp.picks, 'raceName:', emp.raceName, 'color:', emp.color, 'style:', emp.shipStyle);
    expect(emp.raceName).toBe('Subterran Forgers');
    expect(emp.picks).toContain('repulsive');
    expect(emp.picks).toContain('subterranean');
    expect(emp.picks).toContain('industry3'); // 16-point upgrade
    expect(emp.picks).toContain('science2');
    expect(emp.color).toBe('#ff6b5e');
    expect(emp.shipStyle).toBe('halo');
    botA.close();
    botB.close();
  });
});
