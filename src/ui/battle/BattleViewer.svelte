<script lang="ts">
  // Battle playback: re-runs the deterministic sim to produce frames, then
  // animates them with pixi. Sprites are procedural shapes (original art).
  import { Application, Container, Graphics } from 'pixi.js';
  import { onDestroy, onMount } from 'svelte';
  import { FIELD_H, FIELD_W, FP, runBattle, type BattleInput, type BattleTickFrame } from '@engine/index';
  import { rngFor } from '@engine/rng';
  import { ownerColor, ownerName } from '../colors';
  import { app, getActive, type ReplayEntry } from '../state.svelte';

  const { replay, onclose }: { replay: ReplayEntry; onclose: () => void } = $props();

  let host: HTMLDivElement;
  let pixi: Application | null = null;
  let frames: BattleTickFrame[] = [];
  let totalFrames = $state(0);
  let frameIdx = $state(0);
  let playing = $state(true);
  let speed = $state(2);
  let ready = $state(false);
  let simError = $state('');

  const input = replay.input as BattleInput;
  const summary = replay.summary;

  const gs = () => getActive()?.session.getState() ?? null;
  function nameOf(id: unknown): string {
    if (typeof id !== 'number') return 'stalemate';
    return ownerName(id, (x) => gs()?.empires.find((e) => e.id === x)?.name);
  }
  const sideCount = (side: 0 | 1) => input.ships.filter((s) => s.side === side).length;

  // precompute all frames by re-running the identical deterministic sim
  function computeFrames(): void {
    frames = [];
    try {
      runBattle(input, rngFor(replay.seed, ...input.seedLabel), (f) => frames.push(structuredClone(f)));
    } catch (e) {
      simError = `replay unavailable: ${e instanceof Error ? e.message : String(e)}`;
    }
    totalFrames = frames.length;
  }

  const SCALE = 1.7;
  const W = (FIELD_W / FP) * SCALE;
  const H = (FIELD_H / FP) * SCALE;

  let gfx: Graphics;
  let elapsed = 0;

  // deterministic decorative starfield for the battle backdrop
  const stars: Array<{ x: number; y: number; r: number; a: number }> = [];
  {
    let s = 1234567;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 90; i++) {
      stars.push({ x: rnd() * W, y: rnd() * H, r: rnd() * 1.4 + 0.3, a: rnd() * 0.5 + 0.15 });
    }
  }

  function colorOf(side: 0 | 1): number {
    const owner = side === 0 ? input.attacker : input.defender;
    return Number('0x' + ownerColor(owner).slice(1));
  }

  function drawShip(x: number, y: number, size: number, angle: number, isBase: boolean, color: number, driveOut = false): void {
    if (isBase) {
      // orbital platform: hex + core
      const r = size * 1.2;
      const pts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      gfx.poly(pts).fill({ color, alpha: 0.9 }).stroke({ color: 0x05070f, width: 1.5 });
      gfx.circle(x, y, r * 0.4).fill({ color: 0x05070f, alpha: 0.6 });
      return;
    }
    // hull: sleek dart rotated to the sim heading (sprites turn with the helm)
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const rot = (px: number, py: number): [number, number] => [x + px * ca - py * sa, y + px * sa + py * ca];
    const pts = [
      ...rot(size * 1.8, 0),
      ...rot(-size * 0.9, -size * 0.85),
      ...rot(-size * 0.45, 0),
      ...rot(-size * 0.9, size * 0.85),
    ];
    gfx.poly(pts).fill({ color }).stroke({ color: 0x05070f, width: 1 });
    const [ex, ey] = rot(-size * 1.1, 0);
    // engine glow dims to a red sputter when the drive is knocked out
    gfx.circle(ex, ey, size * 0.28).fill({ color: driveOut ? 0xff6b5e : 0xffd18a, alpha: driveOut ? 0.5 : 0.85 });
  }

  function drawBystanders(fi: number): void {
    const bys = input.bystanders ?? [];
    if (!bys.length) return;
    const last = fi >= frames.length - 1 && frames.length > 0;
    const f = frames[Math.min(fi, frames.length - 1)];
    const sideLost = (side: 0 | 1): boolean => {
      if (!last || !f) return false;
      const anyOwnActive = input.ships.some((si) => {
        if (si.side !== side) return false;
        const s = f.ships.find((x) => x.id === si.shipId);
        return s ? s.alive && !s.retreated && !s.crossed : false;
      });
      const enemyAlive = input.ships.some((si) => {
        if (si.side === side) return false;
        const s = f.ships.find((x) => x.id === si.shipId);
        return s ? s.alive && !s.retreated : false;
      });
      return !anyOwnActive && enemyAlive;
    };
    const counts: [number, number] = [0, 0];
    for (const b of bys) counts[b.side]++;
    const idx: [number, number] = [0, 0];
    for (const b of bys) {
      const i = idx[b.side]++;
      const n = counts[b.side]!;
      const x = b.side === 0 ? 12 : W - 12;
      const y = (H * (i + 1)) / (n + 1);
      const dir = b.side === 0 ? 1 : -1;
      const s = 7;
      // hollow arrow: civilians sit out the fight at the field edge
      gfx
        .poly([x + dir * s * 1.7, y, x - dir * s * 0.8, y - s * 0.8, x - dir * s * 0.4, y, x - dir * s * 0.8, y + s * 0.8])
        .stroke({ color: colorOf(b.side), width: 1.5, alpha: 0.85 });
      if (sideLost(b.side)) {
        // escorts gone: these ships are lost with the field
        gfx.moveTo(x - 6, y - 6).lineTo(x + 6, y + 6).stroke({ color: 0xff6b5e, width: 2 });
        gfx.moveTo(x + 6, y - 6).lineTo(x - 6, y + 6).stroke({ color: 0xff6b5e, width: 2 });
      }
    }
  }

  /** beams sweep from muzzle to target over BEAM_TRAVEL ticks; mass-driver
   * slugs fly as dots; a full src→dst line never appears */
  const BEAM_TRAVEL = 2;
  const SLUG_TRAVEL = 3;
  function isSlug(weaponId: string): boolean {
    return weaponId.includes('driver') || weaponId.includes('gauss');
  }

  function drawShots(fi: number, frac: number): void {
    const maxTravel = Math.max(BEAM_TRAVEL, SLUG_TRAVEL);
    for (let back = 0; back <= maxTravel; back++) {
      const sf = fi - back;
      const pf = frames[sf];
      if (!pf) continue;
      for (const shot of pf.shots) {
        if (shot.classId !== 0) continue; // guided munitions render from frame.projectiles
        const from = pf.ships.find((x) => x.id === shot.from);
        const to = shot.to >= 0 ? pf.ships.find((x) => x.id === shot.to) : null;
        if (!from || !to) continue;
        const travel = isSlug(shot.weaponId) ? SLUG_TRAVEL : BEAM_TRAVEL;
        const p = (back + frac) / travel;
        const over = shot.hit ? 1 : 1.35; // misses streak past the target
        if (p > over) continue;
        const x0 = (from.x / FP) * SCALE;
        const y0 = (from.y / FP) * SCALE;
        const x1 = (to.x / FP) * SCALE;
        const y1 = (to.y / FP) * SCALE;
        const lerp = (t: number) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t] as const;
        if (isSlug(shot.weaponId)) {
          const [px, py] = lerp(Math.min(p, over));
          gfx.circle(px, py, 2.4).fill({ color: shot.hit ? 0xd8e2ff : 0x8b93b8, alpha: shot.hit ? 0.95 : 0.5 });
        } else {
          const head = Math.min(p, over);
          const tail = Math.max(0, head - 0.3);
          const [hx, hy] = lerp(head);
          const [tx, ty] = lerp(tail);
          const color = shot.hit ? 0xffd75e : 0x59628c;
          gfx.moveTo(tx, ty).lineTo(hx, hy).stroke({ color, alpha: shot.hit ? 0.95 : 0.35, width: shot.hit ? 1.8 : 1 });
        }
        if (shot.hit && p >= 0.92 && p <= 1.08 && shot.dmg > 0) {
          gfx.circle(x1, y1, 3 + Math.min(6, shot.dmg / 6)).fill({ color: 0xffb066, alpha: 0.55 });
        }
      }
    }
  }

  function drawFrame(fi: number, frac = 0): void {
    const f = frames[fi];
    if (!f) return;
    gfx.clear();
    gfx.rect(0, 0, W, H).fill({ color: 0x05070f });
    for (const st of stars) {
      gfx.circle(st.x, st.y, st.r).fill({ color: 0xdde6ff, alpha: st.a });
    }
    // range band guides around the defender edge
    gfx.moveTo(W * 0.66, 0).lineTo(W * 0.66, H).stroke({ color: 0x1c2444, width: 1 });
    gfx.moveTo(W * 0.33, 0).lineTo(W * 0.33, H).stroke({ color: 0x141a33, width: 1 });

    for (const shipInit of input.ships) {
      const s = f.ships.find((x) => x.id === shipInit.shipId);
      if (!s || !s.alive || s.retreated || s.crossed) continue;
      const x = (s.x / FP) * SCALE;
      const y = (s.y / FP) * SCALE;
      const size = 4 + shipInit.hullIdx * 2.1;
      const color = colorOf(shipInit.side);
      // sim heading (0..31) -> sprite rotation; older replays fall back to side
      const angle = typeof s.h === 'number' ? (s.h * Math.PI * 2) / 32 : shipInit.side === 0 ? 0 : Math.PI;
      const sys = s.sys ?? '';
      drawShip(x, y, size, angle, shipInit.isBase, color, sys.includes('d'));
      // hp bar
      gfx.rect(x - size, y + size + 4, size * 2, 2.5).fill({ color: 0x2a3352 });
      const hpColor = s.structPct > 60 ? 0x5ee08a : s.structPct > 30 ? 0xffd75e : 0xff6b5e;
      gfx.rect(x - size, y + size + 4, (size * 2 * s.structPct) / 100, 2.5).fill({ color: hpColor });
      if (s.shieldPct > 0 && !sys.includes('s')) {
        gfx.circle(x, y, size + 4).stroke({ color: 0x4da3ff, alpha: 0.2 + s.shieldPct / 350, width: 1.5 });
      }
      if (sys) {
        // knocked-out systems flag: d(rive) c(omputer) s(hields)
        gfx.circle(x + size, y - size - 3, 2.2).fill({ color: 0xff6b5e, alpha: 0.9 });
      }
    }

    // guided munitions in flight (from the sim itself)
    for (const pr of f.projectiles ?? []) {
      const x = (pr.x / FP) * SCALE;
      const y = (pr.y / FP) * SCALE;
      const color = pr.classId === 1 ? 0xff8a5e : 0xd07aff;
      gfx.circle(x, y, pr.classId === 1 ? 2.2 : 3).fill({ color, alpha: 0.95 });
      gfx.circle(x, y, pr.classId === 1 ? 4.5 : 6).fill({ color, alpha: 0.18 });
    }

    drawShots(fi, frac);
    drawBystanders(fi);

    // deaths as expanding blast rings (persist a few frames)
    for (let back = 0; back < 9; back++) {
      const pf = frames[fi - back];
      if (!pf) break;
      for (const dead of pf.deaths) {
        const s = pf.ships.find((x) => x.id === dead);
        if (!s) continue;
        const x = (s.x / FP) * SCALE;
        const y = (s.y / FP) * SCALE;
        const age = back;
        gfx.circle(x, y, 4 + age * 4).stroke({ color: 0xff6b5e, width: Math.max(1, 4 - age * 0.4), alpha: Math.max(0, 0.95 - age * 0.11) });
        if (age < 3) gfx.circle(x, y, 3 + age * 2).fill({ color: 0xffd18a, alpha: 0.7 - age * 0.2 });
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
    if (frames.length) drawFrame(0);
    pixi.ticker.add((t) => {
      if (!frames.length) return;
      const msPerTick = 100 / speed;
      if (playing) {
        elapsed += t.deltaMS;
        while (elapsed >= msPerTick && frameIdx < frames.length - 1) {
          elapsed -= msPerTick;
          frameIdx++;
        }
        if (frameIdx >= frames.length - 1) playing = false;
      }
      // sub-tick fraction keeps beam pulses and slugs gliding between ticks
      const frac = playing ? Math.min(0.999, elapsed / msPerTick) : 0;
      drawFrame(Math.min(frameIdx, frames.length - 1), frac);
    });
  });

  onDestroy(() => {
    pixi?.destroy(true, { children: true });
    pixi = null;
  });

  function skip() {
    frameIdx = Math.max(0, frames.length - 1);
    playing = false;
    if (ready && frames.length) drawFrame(frameIdx);
  }
  function scrub(ev: Event) {
    frameIdx = Number((ev.target as HTMLInputElement).value);
    playing = false;
    if (ready && frames.length) drawFrame(Math.min(frameIdx, frames.length - 1));
  }
  function close() {
    const entry = app.replays.find((r) => r.battleId === replay.battleId);
    if (entry) entry.watched = true;
    app.version++;
    onclose();
  }
</script>

<div class="overlay">
  <div class="viewer" data-testid="battle-viewer">
    <div class="bar">
      <b>⚔ Battle replay</b>
      <span class="sides">
        <span style="color:{ownerColor(input.attacker)}">{nameOf(input.attacker)} ({sideCount(0)})</span>
        vs
        <span style="color:{ownerColor(input.defender)}">{nameOf(input.defender)} ({sideCount(1)})</span>
      </span>
      <span class="tick">tick {totalFrames ? Math.min(frameIdx, totalFrames - 1) : 0}/{totalFrames}</span>
      <button onclick={() => (playing = !playing)}>{playing ? '⏸ Pause' : '▶ Play'}</button>
      <button onclick={() => (speed = speed === 1 ? 2 : speed === 2 ? 4 : 1)}>{speed}×</button>
      <button data-testid="battle-skip" onclick={skip}>Skip to end</button>
      <button data-testid="battle-close" onclick={close}>Close</button>
    </div>
    {#if totalFrames > 1}
      <input class="scrub" type="range" min="0" max={totalFrames - 1} value={Math.min(frameIdx, totalFrames - 1)} oninput={scrub} />
    {/if}
    <div class="canvashost" bind:this={host}></div>
    {#if (input.bystanders ?? []).length > 0}
      <p class="keyline">△ hollow arrows at the edges are non-combat ships — they sit out the pass and are lost only if their escorts fall.</p>
    {/if}
    {#if simError}
      <p class="err">{simError}</p>
    {/if}
    {#if totalFrames === 0 && !simError}
      <p class="err">No combat occurred — one side had no active ships on the field.</p>
    {/if}
    {#if frameIdx >= totalFrames - 1}
      <p data-testid="battle-summary">
        Winner: <b>{summary['winner'] === null ? 'stalemate' : nameOf(summary['winner'])}</b> —
        attacker fleet damage {String(summary['attackerDamagePct'])}%, defender {String(summary['defenderDamagePct'])}%
        {#if summary['bombardment']}
          {@const b = summary['bombardment'] as Record<string, unknown>}
          — bombardment: {String(b['popKilled'] ?? 0)} pop killed{Array.isArray(b['buildingsDestroyed']) && (b['buildingsDestroyed'] as string[]).length ? `, destroyed ${(b['buildingsDestroyed'] as string[]).join(', ')}` : ''}
        {/if}
      </p>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(4, 6, 14, 0.87);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    backdrop-filter: blur(2px);
  }
  .viewer {
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--line-bright);
    border-radius: 12px;
    padding: 0.8rem;
    box-shadow: 0 14px 60px rgba(0, 0, 0, 0.65), 0 0 60px rgba(110, 168, 255, 0.1);
    max-height: 96vh;
    max-width: 96vw;
    overflow: auto;
  }
  .bar {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }
  .sides {
    font-size: 0.9rem;
  }
  .tick {
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .scrub {
    width: 100%;
    margin: 0 0 0.4rem;
  }
  .canvashost {
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--line);
  }
  .err {
    color: var(--gold);
    margin: 0.5rem 0 0;
  }
  .keyline {
    color: var(--text-dim);
    font-size: 0.78rem;
    margin: 0.4rem 0 0;
  }
</style>
