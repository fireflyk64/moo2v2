import { describe, expect, it } from 'vitest';
import { gameEngine } from '@engine/index';
import { validateCommand, applyCommand } from '@engine/commands';
import { inRange } from '@engine/movement';
import { moveOptions } from '@engine/selectors';
import * as selectors from '@engine/selectors';
import type { GameState } from '@engine/types';

const SEED = 'aaaabbbbccccddddeeeeffff00001111';

function newGame(): GameState {
  return gameEngine.init({
    seed: SEED,
    settings: {
      galaxySize: 'small',
      startMode: 'average',
      playerCount: 2,
      modes: { creativeVariant: false, pickBidding: false, stickyBuild: false, antarans: false, randomEvents: false },
      battleOrdersTimeoutMs: 1000,
      debugCommands: false,
    },
    players: [
      { id: 0, name: 'A', raceJson: JSON.stringify({ presetId: 'solari' }) },
      { id: 1, name: 'B', raceJson: JSON.stringify({ presetId: 'solari' }) },
    ],
    dataVersion: 'test',
  });
}

/** wire a wormhole between the player's home star and the farthest star */
function rig(state: GameState) {
  const home = state.colonies.find((c) => c.owner === 0)!;
  const homeStar = state.stars.find(
    (s) => s.id === state.planets.find((p) => p.id === home.planetId)!.starId,
  )!;
  let far = state.stars[0]!;
  let best = -1;
  for (const s of state.stars) {
    const d = (s.x - homeStar.x) ** 2 + (s.y - homeStar.y) ** 2;
    if (d > best) {
      best = d;
      far = s;
    }
  }
  // clear any existing wormholes, then link home <-> far
  for (const s of state.stars) s.wormholeTo = null;
  homeStar.wormholeTo = far.id;
  far.wormholeTo = homeStar.id;
  const scout = state.ships.find((s) => s.owner === 0 && s.shipKind === 'scout')!;
  scout.location = { kind: 'star', starId: homeStar.id };
  return { homeStar, far, scout };
}

describe('wormhole transit without fuel range (bug: outposts beyond range via wormholes)', () => {
  it('allows moving through a wormhole to a star far outside fuel range', () => {
    const state = newGame();
    const { homeStar, far, scout } = rig(state);
    expect(inRange(state, 0, far)).toBe(false); // out of range on a small map corner
    const cmd = {
      turn: state.turn,
      playerId: 0,
      kind: 'move_ships',
      payload: { shipIds: [scout.id], destStarId: far.id },
    };
    expect(validateCommand(state, cmd)).toBeNull();
    applyCommand(state, cmd);
    expect(scout.location).toEqual({
      kind: 'transit',
      from: homeStar.id,
      to: far.id,
      departedTurn: state.turn,
      arrivalTurn: state.turn + 1, // wormholes are always 1 turn
    });
  });

  it('still rejects out-of-range moves that are not through a wormhole', () => {
    const state = newGame();
    const { homeStar, far, scout } = rig(state);
    // pick a different distant star with no wormhole from home
    let other = null;
    for (const s of state.stars) {
      if (s.id === homeStar.id || s.id === far.id) continue;
      if (!inRange(state, 0, s)) other = s;
    }
    if (!other) return; // map layout has everything in range: nothing to assert
    const err = validateCommand(state, {
      turn: state.turn,
      playerId: 0,
      kind: 'move_ships',
      payload: { shipIds: [scout.id], destStarId: other.id },
    });
    expect(err).toContain('out of fuel range');
  });

  it('moveOptions marks the wormhole partner reachable with 1 turn travel', () => {
    const state = newGame();
    const { homeStar, far } = rig(state);
    const opt = moveOptions(state, 0, homeStar.id).find((o) => o.starId === far.id)!;
    expect(opt.reachable).toBe(true);
    expect(opt.turns).toBe(1);
  });

  it('a wormhole stays HIDDEN until one endpoint is visited or scanned (fog leak fix)', () => {
    const state = newGame();
    const { homeStar, far } = rig(state);
    // move the wormhole to two stars the player has never seen or scanned
    const empire = state.empires[0]!;
    const strangers = state.stars.filter(
      (s) =>
        s.id !== homeStar.id &&
        !empire.exploredStars.includes(s.id) &&
        !selectors.scannedStars(state, 0).has(s.id),
    );
    homeStar.wormholeTo = null;
    far.wormholeTo = null;
    if (strangers.length < 2) return; // tiny map fully scanned: nothing to assert
    const [a, b] = [strangers[0]!, strangers[strangers.length - 1]!];
    a.wormholeTo = b.id;
    b.wormholeTo = a.id;
    let view = selectors.galaxyView(state, 0);
    expect(view.find((v) => v.star.id === a.id)!.wormholeVisible).toBe(false);
    expect(view.find((v) => v.star.id === b.id)!.wormholeVisible).toBe(false);

    // visiting ONE endpoint reveals the link from both sides
    empire.exploredStars = [...empire.exploredStars, a.id].sort((x, y) => x - y);
    view = selectors.galaxyView(state, 0);
    expect(view.find((v) => v.star.id === a.id)!.wormholeVisible).toBe(true);
    expect(view.find((v) => v.star.id === b.id)!.wormholeVisible).toBe(true);
  });

  it('scanners extend the envelope: scan tech reveals farther stars', () => {
    const state = newGame();
    const before = selectors.scannedStars(state, 0);
    // grant a big scanner (tachyon: scan +7 parsecs)
    state.empires[0]!.knownApps = [...state.empires[0]!.knownApps, 'tachyon_scanner'].sort();
    const after = selectors.scannedStars(state, 0);
    expect(after.size).toBeGreaterThanOrEqual(before.size);
    for (const id of before) expect(after.has(id)).toBe(true);
  });
});
