<script lang="ts">
  // Battle playback: re-runs the deterministic sim to produce frames, then
  // animates them with pixi. Ships are procedural pixel-art sprites in each
  // empire's chosen fleet style (shipart.ts); weapons, shields, flames and
  // deaths are layered VFX (effects.ts) split across a normal layer and an
  // additive glow layer so energy weapons genuinely glow. All effects are
  // deterministic in (tick, seed): scrubbing re-renders identical frames.
  import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
  import { onDestroy, onMount } from 'svelte';
  import { FIELD_H, FIELD_W, FP, runBattle, shipStyleOf, type BattleInput, type BattleTickFrame, type CombatShipInit } from '@engine/index';
  import { rngFor } from '@engine/rng';
  import { ownerColor, ownerName } from '../colors';
  import { app, getActive, type ReplayEntry } from '../state.svelte';
  import { artClassOf, getMonsterModel, getShipModel, glowPixels, MONSTER_KINDS, type Mount, type ShipModel } from './shipart';
  import { cssToNum, flameColorFor, paletteFor, textureForModel } from './shiptex';
  import {
    beamStyleOf, drawBeam, drawDamageSmoke, drawDissipaterWake, drawExplosion, drawFighter, drawFlame,
    drawImpact, drawLightningAura, drawMissile, drawMuzzle, drawPdPop, drawRepairDrones, drawShieldBubble,
    drawShieldCollapse, drawShieldHit, drawSlug, drawTorpedo, drawTrail, drawWarpStreak, fxHash,
    MISSILE_TINT, TORPEDO_TINT,
  } from './effects';
  import { makeBattleBackdrop, type BackdropPlanet } from './backdrop';

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
  let diverged = $state(false);
  function computeFrames(): void {
    frames = [];
    try {
      const result = runBattle(input, rngFor(replay.seed, ...input.seedLabel), (f) => frames.push(structuredClone(f)));
      // a replay recorded under a DIFFERENT engine version re-simulates under
      // today's rules (e.g. the 0.13.0 battlefield enlargement) — when the
      // outcome no longer matches the recorded summary, say so instead of
      // silently showing a battle that never happened that way
      const resimWinner = result.winner === null ? null : result.winner === 0 ? input.attacker : input.defender;
      diverged = result.ticks !== summary['ticks'] || resimWinner !== summary['winner'];
    } catch (e) {
      simError = `replay unavailable: ${e instanceof Error ? e.message : String(e)}`;
    }
    totalFrames = frames.length;
  }

  const SCALE = 1.7;
  const PAD = 26; // margin so edge brawls (and their sprites) stay on canvas
  const W = (FIELD_W / FP) * SCALE;
  const H = (FIELD_H / FP) * SCALE;
  const CW = W + PAD * 2;
  const CH = H + PAD * 2;
  const PIX = 2; // art pixel -> screen px

  let bgG: Graphics; // static backdrop
  let shipC: Container; // pixel-art sprites
  let fxG: Graphics; // normal blend: smoke, debris, munition bodies
  let glowG: Graphics; // additive blend: beams, flames, shields, fire
  let uiG: Graphics; // bars, markers, bystanders
  let elapsed = 0;

  // sparse deterministic twinkle points animated over the canvas backdrop
  const stars: Array<{ x: number; y: number; r: number; a: number }> = [];
  {
    let s = 1234567;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 36; i++) {
      stars.push({ x: rnd() * CW, y: rnd() * CH, r: rnd() * 1.1 + 0.3, a: rnd() * 0.5 + 0.15 });
    }
  }

  function empireOfSide(side: 0 | 1): number {
    return side === 0 ? input.attacker : input.defender;
  }
  function colorOf(side: 0 | 1): number {
    return cssToNum(ownerColor(empireOfSide(side)));
  }

  // ---- per-ship render info (model + sprite + fx hooks) ----
  interface ShipView {
    init: CombatShipInit;
    model: ShipModel;
    sprite: Sprite;
    color: number;
    flame: number;
    /** shield bubble / explosion radius in screen px */
    radius: number;
    flameLen: number;
    flameW: number;
    lights: Mount[];
    specials: Set<string>;
    seed: number;
  }
  const views = new Map<number, ShipView>();

  function buildView(init: CombatShipInit): ShipView {
    const empireId = empireOfSide(init.side);
    const npc = empireId < 0;
    const style = init.style ?? shipStyleOf({ id: Math.max(0, empireId) });
    const colorHex = ownerColor(empireId);
    const cls = artClassOf(init);
    const monster = MONSTER_KINDS.includes(cls);
    const heavyBeams = init.weapons.some((w) => w.classId === 0 && w.mods.includes('hv'));
    const missileTubes = init.weapons.filter((w) => w.classId === 1).reduce((n, w) => n + w.count, 0);
    const model = monster
      ? getMonsterModel(cls)
      : getShipModel({ style, cls: cls as never, variant: init.modelIdx ?? 0, specials: init.specials, heavyBeams, missileTubes });
    const pal = paletteFor(style, colorHex, npc);
    const specialsKey = (init.specials ?? []).slice().sort().join(',');
    const tex = textureForModel(`${monster ? 'npc' : style}|${cls}|${init.modelIdx ?? 0}|${colorHex}|${specialsKey}|${heavyBeams ? 1 : 0}|${Math.min(9, missileTubes)}`, model, pal);
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    sprite.scale.set(PIX * (model.pxScale ?? 1));
    sprite.visible = false;
    shipC.addChild(sprite);
    const tier = Math.min(6, Math.max(0, init.modelKind === 'scout' ? 0 : init.hullIdx));
    const allLights = glowPixels(model);
    const lights = allLights.filter((_, i) => i % Math.max(1, Math.ceil(allLights.length / 5)) === 0);
    return {
      init,
      model,
      sprite,
      color: cssToNum(colorHex),
      flame: cssToNum(flameColorFor(style, npc || monster)),
      radius: (model.radius * (model.pxScale ?? 1) + 1.5) * PIX,
      flameLen: (3.2 + tier * 1.5) * PIX,
      flameW: (0.9 + tier * 0.22) * PIX,
      lights,
      specials: new Set(init.specials ?? []),
      seed: init.shipId,
    };
  }

  /** rotate a model-local mount into world space */
  function mountWorld(v: ShipView, x: number, y: number, angle: number, m: Mount): [number, number] {
    const ps = PIX * (v.model.pxScale ?? 1);
    const lx = (m.x + 0.5 - v.model.w / 2) * ps;
    const ly = (m.y + 0.5 - v.model.h / 2) * ps;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    return [x + lx * ca - ly * sa, y + lx * sa + ly * ca];
  }

  const toScreen = (fx: number, fy: number): [number, number] => [(fx / FP) * SCALE + PAD, (fy / FP) * SCALE + PAD];
  const angleOfHeading = (h: number): number => (h * Math.PI * 2) / 32;
  function lerpAngle(a: number, b: number, t: number): number {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  type FrameShip = BattleTickFrame['ships'][number];
  /** interpolated screen position + rotation of a ship at (fi, frac) */
  function shipPose(fi: number, frac: number, s: FrameShip): { x: number; y: number; angle: number } {
    const nf = frames[fi + 1];
    const s2 = nf?.ships.find((n) => n.id === s.id);
    const useNext = frac > 0 && s2 && s2.alive && !s2.retreated && !s2.crossed;
    const fx = useNext ? s.x + (s2.x - s.x) * frac : s.x;
    const fy = useNext ? s.y + (s2.y - s.y) * frac : s.y;
    const [x, y] = toScreen(fx, fy);
    const a0 = angleOfHeading(typeof s.h === 'number' ? s.h : 0);
    const a1 = useNext && typeof s2.h === 'number' ? angleOfHeading(s2.h) : a0;
    return { x, y, angle: useNext ? lerpAngle(a0, a1, frac) : a0 };
  }

  /** the contested world: the defender's colony planet at the battle star,
   * else the system's most notable body — shown looming in the backdrop like
   * the classic battle screen. Null outside a live session (battle lab). */
  function battlePlanet(): BackdropPlanet | null {
    const s = gs();
    const starId = summary['starId'];
    if (!s || typeof starId !== 'number') {
      // battle lab / detached replays have no star — loom a deterministic
      // sample world so the sandbox still shows the backdrop art
      const climates = ['terran', 'ocean', 'desert', 'barren', 'gaia', 'tundra', 'swamp', 'arid', 'hostile', 'energized'];
      let hsh = 0;
      for (const ch of replay.battleId) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
      return { seed: hsh, climate: climates[hsh % climates.length]!, body: 'planet', sizeClass: 3 };
    }
    const planets = s.planets.filter((p) => p.starId === starId);
    if (!planets.length) return null;
    // engagement (0.22.0): the input names the engaged planet outright —
    // loom that one; an explicit deep-space fight (null) skips the colony
    // and shows the system's notable body in the distance instead
    if (typeof input.planetId === 'number') {
      const ep = planets.find((pp) => pp.id === input.planetId);
      if (ep) return { seed: ep.id, climate: ep.climate, body: ep.body, sizeClass: ep.sizeClass };
    }
    const defCol =
      input.planetId === null
        ? undefined
        : s.colonies.find((c) => c.owner === input.defender && planets.some((p) => p.id === c.planetId));
    const p = defCol
      ? planets.find((pp) => pp.id === defCol.planetId)!
      : [...planets].sort(
          (a, b) => (b.body === 'planet' ? b.sizeClass + 10 : b.body === 'gas_giant' ? 5 : 0) - (a.body === 'planet' ? a.sizeClass + 10 : a.body === 'gas_giant' ? 5 : 0),
        )[0]!;
    return { seed: p.id, climate: p.climate, body: p.body, sizeClass: p.sizeClass };
  }

  function drawBackdrop(): void {
    bgG.clear();
    // range band guides around the defender edge (dotted) — drawn over the
    // pixel-art canvas backdrop (nebula weather + planet, backdrop.ts)
    for (const [gx, ga] of [[PAD + W * 0.66, 0.5], [PAD + W * 0.33, 0.3]] as const) {
      for (let y = 4; y < CH; y += 14) {
        bgG.moveTo(gx, y).lineTo(gx, y + 6).stroke({ color: 0x2a3454, width: 1, alpha: ga });
      }
    }
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
      const x = b.side === 0 ? 12 : CW - 12;
      const y = (CH * (i + 1)) / (n + 1);
      const dir = b.side === 0 ? 1 : -1;
      const s = 7;
      // hollow arrow: civilians sit out the fight at the field edge
      uiG
        .poly([x + dir * s * 1.7, y, x - dir * s * 0.8, y - s * 0.8, x - dir * s * 0.4, y, x - dir * s * 0.8, y + s * 0.8])
        .stroke({ color: colorOf(b.side), width: 1.5, alpha: 0.85 });
      if (sideLost(b.side)) {
        // escorts gone: these ships are lost with the field
        uiG.moveTo(x - 6, y - 6).lineTo(x + 6, y + 6).stroke({ color: 0xff6b5e, width: 2 });
        uiG.moveTo(x + 6, y - 6).lineTo(x - 6, y + 6).stroke({ color: 0xff6b5e, width: 2 });
      }
    }
  }

  /** beams sweep from muzzle to target over BEAM_TRAVEL ticks; mass-driver
   * slugs fly as dots; a full src→dst line never appears */
  const BEAM_TRAVEL = 2;
  const SLUG_TRAVEL = 3;
  const FIZZLE_TICKS = 4;
  function isSlug(weaponId: string): boolean {
    return weaponId.includes('driver') || weaponId.includes('gauss');
  }

  function drawShots(fi: number, frac: number): void {
    const lookback = Math.max(BEAM_TRAVEL, SLUG_TRAVEL) + FIZZLE_TICKS + 4;
    for (let back = 0; back <= lookback; back++) {
      const sf = fi - back;
      const pf = frames[sf];
      if (!pf) continue;
      for (let si = 0; si < pf.shots.length; si++) {
        const shot = pf.shots[si]!;
        if (shot.classId !== 0) {
          // guided munitions render their FLIGHT from frame.projectiles; this
          // shot event is the impact instant. Without an arrival effect a
          // missile flew in and simply vanished — no shield fizzle, no hull
          // flash, and an ECM-evaded munition looked identical to a hit.
          if (shot.to < 0) continue;
          const impactAge = (back + frac) / FIZZLE_TICKS;
          if (impactAge > 1) continue;
          const toV2 = views.get(shot.to);
          const atShip = pf.ships.find((x) => x.id === shot.to);
          if (!toV2 || !atShip) continue;
          const nowShip = frames[fi]!.ships.find((x) => x.id === shot.to);
          const pose2 = nowShip && nowShip.alive ? shipPose(fi, frac, nowShip) : shipPose(sf, 0, atShip);
          const launcher = pf.ships.find((x) => x.id === shot.from);
          const bearing2 = launcher ? Math.atan2(launcher.y - atShip.y, launcher.x - atShip.x) : Math.PI;
          const ex = pose2.x + Math.cos(bearing2) * toV2.radius * 0.55;
          const ey = pose2.y + Math.sin(bearing2) * toV2.radius * 0.55;
          const tint = shot.classId === 1 ? (MISSILE_TINT[shot.weaponId] ?? 0xffb066) : shot.classId === 2 ? (TORPEDO_TINT[shot.weaponId] ?? 0xd07aff) : 0xffe9b0;
          if (!shot.hit) {
            // evaded/zapped at the last instant: a small fizzle pop, clearly
            // different from a detonation on the hull
            drawPdPop(glowG, ex, ey, Math.max(0, impactAge));
          } else {
            const soaked2 = shot.sh ?? 0;
            if (soaked2 > 0) {
              drawShieldHit(glowG, pose2.x, pose2.y, toV2.radius, bearing2, Math.max(0, impactAge), Math.min(1, soaked2 / 22), 0x6fc0ff, shot.from * 41 + si, shot.tick);
            }
            if (shot.dmg > soaked2 && impactAge < 0.6) {
              drawImpact(glowG, ex, ey, tint, 2 + Math.min(7, (shot.dmg - soaked2) / 5), shot.kill === true, shot.tick, shot.to * 13 + si);
            }
          }
          continue;
        }
        const fromV = views.get(shot.from);
        const from = pf.ships.find((x) => x.id === shot.from);
        // point defense intercept: tracer burst to the downed projectile
        if (shot.to === -1) {
          if (typeof shot.ix !== 'number' || typeof shot.iy !== 'number' || !from || !fromV) continue;
          const age = back + frac;
          if (age > 3) continue;
          const [tx, ty] = toScreen(shot.ix, shot.iy);
          if (age < 1.2) {
            const pose = shipPose(sf, 0, from);
            const gm = fromV.model.guns[si % fromV.model.guns.length]!;
            const [mx, my] = mountWorld(fromV, pose.x, pose.y, pose.angle, gm);
            const dx = tx - mx;
            const dy = ty - my;
            for (let k = 0; k < 3; k++) {
              const t0 = 0.2 + k * 0.25;
              glowG.moveTo(mx + dx * t0, my + dy * t0).lineTo(mx + dx * (t0 + 0.12), my + dy * (t0 + 0.12)).stroke({ color: 0xffe9b0, width: 1.1, alpha: 0.8 - age * 0.5 });
            }
          }
          if (shot.hit) drawPdPop(glowG, tx, ty, age / 3);
          continue;
        }
        const toV = views.get(shot.to);
        const to = shot.to >= 0 ? pf.ships.find((x) => x.id === shot.to) : null;
        if (!from || !to || !fromV || !toV) continue;
        const travel = (isSlug(shot.weaponId) ? SLUG_TRAVEL : BEAM_TRAVEL) + (shot.kill ? 4 : 0);
        const p = (back + frac) / travel;
        const over = shot.hit ? 1 : 1.35; // misses streak past the target
        const fizzAge = ((back + frac) - travel) / FIZZLE_TICKS; // >0 once landed
        if (p > over && fizzAge > 1) continue;
        const fromPose = shipPose(sf, 0, from);
        const toPose = shipPose(sf, 0, to);
        // muzzle: pick a hardpoint per shot so volleys spread across the hull
        const gm = fromV.model.guns[Math.floor(fxHash(shot.tick, shot.from * 31 + si, 5) * fromV.model.guns.length) % fromV.model.guns.length]!;
        const [x0, y0] = mountWorld(fromV, fromPose.x, fromPose.y, fromPose.angle, gm);
        // impact point: stop at the target's hull edge, jittered per shot
        const ddx = toPose.x - x0;
        const ddy = toPose.y - y0;
        const dl = Math.hypot(ddx, ddy) || 1;
        const edge = Math.max(0, dl - toV.radius * 0.55);
        const jit = (fxHash(shot.tick, si, 9) - 0.5) * toV.radius * 0.8;
        const x1 = x0 + (ddx / dl) * edge - (ddy / dl) * jit * (shot.hit ? 1 : 2.2);
        const y1 = y0 + (ddy / dl) * edge + (ddx / dl) * jit * (shot.hit ? 1 : 2.2);
        const lerp = (t: number) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t] as const;
        const style = beamStyleOf(shot.weaponId);
        if (p <= over) {
          if (isSlug(shot.weaponId)) {
            const [px, py] = lerp(Math.min(p, over));
            drawSlug(glowG, px, py, (x1 - x0) / dl, (y1 - y0) / dl, shot.hit);
          } else {
            const head = Math.min(p, over);
            const tail = Math.max(0, head - (style.kind === 'lance' ? 0.55 : 0.34));
            const [hx, hy] = lerp(head);
            const [tx2, ty2] = lerp(tail);
            drawBeam(glowG, tx2, ty2, hx, hy, style, shot.hit ? 1 : 0.4, shot.kill === true, shot.tick + back, shot.from * 37 + si);
            if (back === 0 && frac < 0.6) drawMuzzle(glowG, x0, y0, style.color, 1.6 + style.width * 0.4);
          }
        }
        // arrival: shield fizzle for soaked damage, hull sparks for the rest
        if (shot.hit && fizzAge >= -0.1 && fizzAge <= 1) {
          const age01 = Math.max(0, fizzAge);
          const nowShip = frames[fi]!.ships.find((x) => x.id === shot.to);
          const nowPose = nowShip && nowShip.alive ? shipPose(fi, frac, nowShip) : toPose;
          const soaked = shot.sh ?? 0;
          if (soaked > 0) {
            const bearing = Math.atan2(y0 - nowPose.y, x0 - nowPose.x);
            drawShieldHit(glowG, nowPose.x, nowPose.y, toV.radius, bearing, age01, Math.min(1, soaked / 22), 0x6fc0ff, shot.from * 41 + si, shot.tick);
          }
          if (shot.dmg > soaked && age01 < 0.6) {
            drawImpact(glowG, x1, y1, style.color, 2 + Math.min(6, (shot.dmg - soaked) / 6), shot.kill === true, shot.tick, shot.to * 13 + si);
          }
        }
      }
    }
  }

  function drawProjectiles(fi: number, frac: number): void {
    const f = frames[fi]!;
    const nf = frames[fi + 1];
    for (const pr of f.projectiles ?? []) {
      const nx = nf?.projectiles?.find((q) => q.id === pr.id);
      const fx0 = nx && frac > 0 ? pr.x + (nx.x - pr.x) * frac : pr.x;
      const fy0 = nx && frac > 0 ? pr.y + (nx.y - pr.y) * frac : pr.y;
      const [x, y] = toScreen(fx0, fy0);
      // course from motion (next frame, else previous frame, else owner side)
      let angle: number;
      const prev = frames[fi - 1]?.projectiles?.find((q) => q.id === pr.id);
      if (nx) angle = Math.atan2(nx.y - pr.y, nx.x - pr.x);
      else if (prev) angle = Math.atan2(pr.y - prev.y, pr.x - prev.x);
      else {
        const owner = input.ships.find((s) => s.shipId === pr.from);
        angle = owner?.side === 1 ? Math.PI : 0;
      }
      const ownerSide = input.ships.find((s) => s.shipId === pr.from)?.side ?? 0;
      const sideColor = colorOf(ownerSide as 0 | 1);
      // trail from recent frames
      const trail: Array<[number, number]> = [[x, y]];
      for (let k = 1; k <= 5; k++) {
        const old = frames[fi - k]?.projectiles?.find((q) => q.id === pr.id);
        if (!old) break;
        trail.push(toScreen(old.x, old.y));
      }
      trail.reverse();
      const id = pr.id ?? 0;
      if (pr.classId === 4) {
        drawFighter(fxG, glowG, x, y, angle, sideColor, pr.w === 'assault_shuttle');
        continue;
      }
      if (pr.classId === 1) {
        const tint = MISSILE_TINT[pr.w] ?? 0xffb066;
        drawTrail(glowG, trail, tint, 2);
        drawMissile(fxG, glowG, x, y, angle, tint, sideColor, f.tick, id);
      } else {
        const tint = TORPEDO_TINT[pr.w] ?? 0xd07aff;
        drawTrail(glowG, trail, tint, 3);
        drawTorpedo(glowG, x, y, tint, f.tick, frac, id);
      }
    }
  }

  function drawDeaths(fi: number, frac: number): void {
    for (let back = 0; back < 42; back++) {
      const pf = frames[fi - back];
      if (!pf) break;
      for (const dead of pf.deaths) {
        const s = pf.ships.find((x) => x.id === dead);
        const v = views.get(dead);
        if (!s || !v) continue;
        const [x, y] = toScreen(s.x, s.y);
        drawExplosion(fxG, glowG, x, y, v.radius * 0.85, back, frac, dead * 7 + 3);
      }
    }
  }

  function drawTransitions(fi: number, frac: number): void {
    // retreat / cross-line: warp-out streaks at the exit point
    for (let back = 0; back <= 5; back++) {
      const pf = frames[fi - back];
      const before = frames[fi - back - 1];
      if (!pf || !before) break;
      for (const s of pf.ships) {
        const b = before.ships.find((x) => x.id === s.id);
        if (!b || !s.alive) continue;
        const gone = (s.retreated && !b.retreated) || (s.crossed && !b.crossed);
        if (!gone) continue;
        const v = views.get(s.id);
        if (!v) continue;
        const [x, y] = toScreen(b.x, b.y);
        const angle = angleOfHeading(typeof b.h === 'number' ? b.h : 0);
        drawWarpStreak(glowG, x, y, angle, (back + frac) / 5, v.color);
      }
    }
  }

  function drawFrame(fi: number, frac = 0): void {
    const f = frames[fi];
    if (!f) return;
    fxG.clear();
    glowG.clear();
    uiG.clear();

    // twinkle a sparse subset of stars
    for (let i = 0; i < stars.length; i += 3) {
      const st = stars[i]!;
      const tw = 0.5 + 0.5 * Math.sin((f.tick + frac) * 0.35 + i);
      glowG.circle(st.x, st.y, st.r * 0.9).fill({ color: 0xdde6ff, alpha: st.a * tw * 0.5 });
    }

    const pf = frames[fi - 1];
    for (const initShip of input.ships) {
      const v = views.get(initShip.shipId);
      if (!v) continue;
      const s = f.ships.find((x) => x.id === initShip.shipId);
      if (!s || !s.alive || s.retreated || s.crossed) {
        v.sprite.visible = false;
        continue;
      }
      const pose = shipPose(fi, frac, s);
      v.sprite.visible = true;
      v.sprite.position.set(pose.x, pose.y);
      v.sprite.rotation = pose.angle;
      const sys = s.sys ?? '';

      // engine flames scale with actual motion this tick
      if (v.model.engines.length) {
        const ps = pf?.ships.find((x) => x.id === s.id);
        const moved = ps ? Math.hypot(s.x - ps.x, s.y - ps.y) / FP : 0;
        const driveOut = sys.includes('d');
        const throttle = Math.min(1.25, 0.3 + moved * 0.22);
        for (let ei = 0; ei < v.model.engines.length; ei++) {
          const [ex, ey] = mountWorld(v, pose.x, pose.y, pose.angle, v.model.engines[ei]!);
          drawFlame(glowG, ex, ey, pose.angle, v.flameLen * throttle, v.flameW, v.flame, f.tick, frac, v.seed * 5 + ei, driveOut);
        }
      } else if (v.lights.length) {
        // engineless hulls (stations, beasts): blinking running lights
        for (let li = 0; li < v.lights.length; li++) {
          if (fxHash(f.tick >> 2, v.seed, li) < 0.45) continue;
          const [lx, ly] = mountWorld(v, pose.x, pose.y, pose.angle, v.lights[li]!);
          glowG.circle(lx, ly, 1.3).fill({ color: 0xdfefff, alpha: 0.5 });
        }
      }

      // shields: standing bubble + collapse flash when it fails
      if (s.shieldPct > 0 && !sys.includes('s')) {
        drawShieldBubble(glowG, pose.x, pose.y, v.radius, s.shieldPct, f.tick, frac);
      } else if (v.init.shieldPool > 0) {
        for (let back = 0; back <= 3; back++) {
          const a = frames[fi - back]?.ships.find((x) => x.id === s.id);
          const b = frames[fi - back - 1]?.ships.find((x) => x.id === s.id);
          if (a && b && (a.shieldPct === 0 || a.sys.includes('s')) && b.shieldPct > 0 && !b.sys.includes('s')) {
            drawShieldCollapse(glowG, pose.x, pose.y, v.radius, (back + frac) / 4);
            break;
          }
        }
      }

      // specials with a visible field presence
      if (v.specials.has('lightning_field')) drawLightningAura(glowG, pose.x, pose.y, v.radius + 2, f.tick, v.seed);
      if (v.specials.has('automated_repair_unit') && s.structPct < 100) drawRepairDrones(glowG, pose.x, pose.y, v.radius + 3, f.tick, frac, v.seed);
      if (v.specials.has('warp_dissipater')) drawDissipaterWake(glowG, pose.x, pose.y, pose.angle, v.radius, f.tick, frac);

      drawDamageSmoke(fxG, glowG, pose.x, pose.y, v.radius, s.structPct, f.tick, v.seed);

      // status bars: hull + shield ribbon
      const bw = Math.max(14, v.radius * 1.5);
      const bx = pose.x - bw / 2;
      const by = pose.y + v.radius + 4;
      uiG.rect(bx, by, bw, 2.4).fill({ color: 0x232c49 });
      const hpColor = s.structPct > 60 ? 0x5ee08a : s.structPct > 30 ? 0xffd75e : 0xff6b5e;
      uiG.rect(bx, by, (bw * s.structPct) / 100, 2.4).fill({ color: hpColor });
      if (v.init.shieldPool > 0) {
        uiG.rect(bx, by - 2, (bw * s.shieldPct) / 100, 1.3).fill({ color: 0x4da3ff, alpha: sys.includes('s') ? 0.25 : 0.9 });
      }
      if (sys) {
        // knocked-out systems flag: d(rive) c(omputer) s(hields)
        uiG.circle(pose.x + v.radius * 0.8, pose.y - v.radius * 0.8, 2.2).fill({ color: 0xff6b5e, alpha: 0.9 });
      }
    }

    drawProjectiles(fi, frac);
    drawShots(fi, frac);
    drawTransitions(fi, frac);
    drawDeaths(fi, frac);
    drawBystanders(fi);
  }

  onMount(async () => {
    computeFrames();
    pixi = new Application();
    await pixi.init({ width: CW, height: CH, background: 0x04060e, antialias: true });
    host.appendChild(pixi.canvas);
    const stage = new Container();
    pixi.stage.addChild(stage);
    // pixel-art canvas backdrop: nebula weather + the contested planet
    const bgSprite = new Sprite(Texture.from(makeBattleBackdrop(`${replay.seed}|${replay.battleId}`, CW, CH, battlePlanet())));
    bgG = new Graphics();
    shipC = new Container();
    fxG = new Graphics();
    glowG = new Graphics();
    glowG.blendMode = 'add';
    uiG = new Graphics();
    stage.addChild(bgSprite, bgG, shipC, fxG, glowG, uiG);
    drawBackdrop();
    for (const s of input.ships) views.set(s.shipId, buildView(s));
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
      // sub-tick fraction keeps motion, beams and plumes gliding between ticks
      const frac = playing ? Math.min(0.999, elapsed / msPerTick) : 0;
      drawFrame(Math.min(frameIdx, frames.length - 1), frac);
    });
  });

  onDestroy(() => {
    pixi?.destroy(true, { children: true });
    pixi = null;
    views.clear();
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
  // the viewer pops up on its own after a battle — it must leave on Esc
  // without hunting for the Close button. Space toggles play while it's up.
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (!playing && frameIdx >= totalFrames - 1) frameIdx = 0;
      playing = !playing;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

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
      <button onclick={() => {
        if (!playing && frameIdx >= totalFrames - 1) frameIdx = 0; // ▶ at the end replays from the top (bugs.md)
        playing = !playing;
      }}>{playing ? '⏸ Pause' : '▶ Play'}</button>
      <button onclick={() => (speed = speed === 1 ? 2 : speed === 2 ? 4 : 1)}>{speed}×</button>
      <button data-testid="battle-skip" onclick={skip}>Skip to end</button>
      <button data-testid="battle-close" title="close (Esc) · Space = play/pause" onclick={close}>Close (Esc)</button>
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
    {#if diverged && !simError}
      <p class="err" data-testid="battle-diverged">
        ⚠ This battle was fought under an older game version — the re-simulated playback diverges from what actually
        happened (the summary below is the real outcome).
      </p>
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
    background: rgba(0, 0, 0, 0.87);
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
    box-shadow: 0 14px 60px rgba(0, 0, 0, 0.65), var(--halo);
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
