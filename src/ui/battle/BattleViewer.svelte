<script lang="ts">
  // Battle playback: re-runs the deterministic sim to produce frames, then
  // animates them with pixi. Sprites are procedural shapes (original art).
  import { Application, Container, Graphics } from 'pixi.js';
  import { onDestroy, onMount } from 'svelte';
  import { FIELD_H, FIELD_W, FP, runBattle, type BattleInput, type BattleTickFrame } from '@engine/index';
  import { rngFor } from '@engine/rng';
  import { playerColor } from '../colors';
  import { app, type ReplayEntry } from '../state.svelte';

  const { replay, onclose }: { replay: ReplayEntry; onclose: () => void } = $props();

  let host: HTMLDivElement;
  let pixi: Application | null = null;
  let frames: BattleTickFrame[] = [];
  let frameIdx = $state(0);
  let playing = $state(true);
  let speed = $state(2);
  let ready = $state(false);

  const input = replay.input as BattleInput;
  const summary = replay.summary;

  // precompute all frames by re-running the identical deterministic sim
  function computeFrames(): void {
    frames = [];
    runBattle(input, rngFor(replay.seed, ...input.seedLabel), (f) => frames.push(structuredClone(f)));
  }

  const SCALE = 1.6;
  const W = (FIELD_W / FP) * SCALE;
  const H = (FIELD_H / FP) * SCALE;

  let gfx: Graphics;
  let elapsed = 0;

  function sideOf(shipId: number): 0 | 1 {
    return input.ships.find((s) => s.shipId === shipId)?.side ?? 0;
  }
  function ownerOf(side: 0 | 1): number {
    return side === 0 ? input.attacker : input.defender;
  }

  function drawFrame(f: BattleTickFrame): void {
    gfx.clear();
    // band rings around the defender line for reading ranges
    gfx.rect(0, 0, W, H).fill({ color: 0x05070f });
    for (const shipInit of input.ships) {
      const s = f.ships.find((x) => x.id === shipInit.shipId);
      if (!s || !s.alive || s.retreated || s.crossed) continue;
      const x = (s.x / FP) * SCALE;
      const y = (s.y / FP) * SCALE;
      const size = 4 + shipInit.hullIdx * 2.2;
      const color = Number('0x' + playerColor(ownerOf(shipInit.side)).slice(1));
      if (shipInit.isBase) {
        gfx.rect(x - size, y - size, size * 2, size * 2).fill({ color });
      } else {
        const dir = shipInit.side === 0 ? 1 : -1;
        gfx
          .poly([x + dir * size * 1.6, y, x - dir * size, y - size, x - dir * size, y + size])
          .fill({ color });
      }
      // structure bar
      gfx.rect(x - size, y + size + 3, size * 2, 2).fill({ color: 0x333a55 });
      gfx.rect(x - size, y + size + 3, (size * 2 * s.structPct) / 100, 2).fill({ color: 0x5ee08a });
      if (s.shieldPct > 0) {
        gfx.circle(x, y, size + 3).stroke({ color: 0x4da3ff, alpha: 0.25 + s.shieldPct / 400, width: 1.5 });
      }
    }
    // shots
    for (const shot of f.shots) {
      if (!shot.hit && shot.classId !== 0) continue;
      const from = f.ships.find((x) => x.id === shot.from);
      const to = shot.to >= 0 ? f.ships.find((x) => x.id === shot.to) : null;
      if (!from || !to) continue;
      const color = shot.classId === 0 ? (shot.hit ? 0xffd75e : 0x666e90) : 0xff8a5e;
      gfx
        .moveTo((from.x / FP) * SCALE, (from.y / FP) * SCALE)
        .lineTo((to.x / FP) * SCALE, (to.y / FP) * SCALE)
        .stroke({ color, alpha: shot.hit ? 0.9 : 0.3, width: shot.hit ? 1.5 : 1 });
    }
    // deaths as expanding rings
    for (const dead of f.deaths) {
      const s = f.ships.find((x) => x.id === dead);
      if (s) {
        gfx.circle((s.x / FP) * SCALE, (s.y / FP) * SCALE, 12).stroke({ color: 0xff6b5e, width: 3, alpha: 0.9 });
      }
    }
  }

  onMount(async () => {
    computeFrames();
    pixi = new Application();
    await pixi.init({ width: W, height: H, background: 0x05070f, antialias: true });
    host.appendChild(pixi.canvas);
    const stage = new Container();
    pixi.stage.addChild(stage);
    gfx = new Graphics();
    stage.addChild(gfx);
    ready = true;
    if (frames.length) drawFrame(frames[0]!);
    pixi.ticker.add((t) => {
      if (!playing || !frames.length) return;
      elapsed += t.deltaMS;
      const msPerTick = 100 / speed;
      while (elapsed >= msPerTick && frameIdx < frames.length - 1) {
        elapsed -= msPerTick;
        frameIdx++;
      }
      drawFrame(frames[Math.min(frameIdx, frames.length - 1)]!);
      if (frameIdx >= frames.length - 1) playing = false;
    });
  });

  onDestroy(() => {
    pixi?.destroy(true, { children: true });
    pixi = null;
  });

  function skip() {
    frameIdx = frames.length - 1;
    playing = false;
    if (ready && frames.length) drawFrame(frames[frameIdx]!);
  }
  function close() {
    replay.watched = true;
    app.version++;
    onclose();
  }
</script>

<div class="overlay">
  <div class="viewer" data-testid="battle-viewer">
    <div class="bar">
      <b>Battle replay</b>
      <span>tick {frames.length ? Math.min(frameIdx, frames.length - 1) : 0}/{frames.length}</span>
      <button onclick={() => (playing = !playing)}>{playing ? 'Pause' : 'Play'}</button>
      <button onclick={() => (speed = speed === 1 ? 2 : speed === 2 ? 4 : 1)}>{speed}×</button>
      <button data-testid="battle-skip" onclick={skip}>Skip to end</button>
      <button data-testid="battle-close" onclick={close}>Close</button>
    </div>
    <div bind:this={host}></div>
    {#if frameIdx >= frames.length - 1}
      <p data-testid="battle-summary">
        Winner: {summary['winner'] === null ? 'stalemate' : `player #${summary['winner']}`} —
        attacker fleet damage {String(summary['attackerDamagePct'])}%, defender {String(summary['defenderDamagePct'])}%
        {#if summary['bombardment']}— bombardment: {JSON.stringify(summary['bombardment'])}{/if}
      </p>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(4, 6, 14, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .viewer {
    background: #10142a;
    border: 1px solid #3a4a80;
    border-radius: 10px;
    padding: 0.8rem;
  }
  .bar {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-bottom: 0.5rem;
  }
</style>
