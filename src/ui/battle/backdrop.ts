// Battle backdrop: the same pixel-art language as the galaxy map — stippled
// nebula weather, true 1px stars — plus the contested planet looming at the
// edge of the field like the classic MOO2 battle screen. Deterministic in
// (seed, planet), drawn once per battle onto a canvas that pixi wraps as a
// texture under all combat layers.

export interface BackdropPlanet {
  /** planet id — deterministic sprite variant */
  seed: number;
  climate: string;
  body: string;
  sizeClass: number;
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// same chunky palette family as PixelPlanet.svelte, tuned a touch brighter
// because the battle planet is large and lit by the fight
const PAL: Record<string, [string, string, string, string]> = {
  gaia: ['#2c8fd0', '#4fd06a', '#a8f0b8', '#1a5a38'],
  terran: ['#2c6cc0', '#5cb455', '#b8e8a8', '#274a7a'],
  ocean: ['#1f6ad0', '#3f9ae8', '#a8d8ff', '#123a78'],
  swamp: ['#4a6a3a', '#7aa85a', '#c0d890', '#2c4020'],
  arid: ['#c09a50', '#d8bb6a', '#f0e0a0', '#7a5c28'],
  desert: ['#c08040', '#e0a35e', '#f8d8a0', '#7a4a20'],
  tundra: ['#88a8c0', '#bcd7e8', '#f0f8ff', '#4a6a88'],
  barren: ['#6f6a62', '#8f8a80', '#c0bab0', '#3f3b35'],
  energized: ['#8a50c0', '#c78bff', '#e8d0ff', '#4a2878'],
  hostile: ['#b04030', '#ff6b5e', '#ffb0a0', '#601810'],
};
const GAS: [string, string, string, string] = ['#b08850', '#e8c894', '#f8e8c0', '#6e5432'];

const NEB_COLORS = [
  [72, 200, 118],
  [134, 82, 224],
  [214, 72, 134],
  [224, 96, 58],
  [62, 182, 192],
] as const;

/** draw a big pixel-art world onto ctx, centered at (cx, cy), diameter px */
function drawPlanet(
  ctx: CanvasRenderingContext2D,
  rnd: () => number,
  planet: BackdropPlanet,
  cx: number,
  cy: number,
  diameter: number,
): void {
  const G = 44; // finer grid than the tiny table sprites — it's a hero prop
  const cell = diameter / G;
  const pal = planet.body === 'gas_giant' ? GAS : (PAL[planet.climate] ?? PAL['barren']!);
  const [base, detail, light, dark] = pal;
  const c = (G - 1) / 2;
  const r = c + 0.3;
  const inside = (x: number, y: number) => (x - c) ** 2 + (y - c) ** 2 <= r * r;
  const banded = planet.body === 'gas_giant' || planet.climate === 'arid' || planet.climate === 'desert' || planet.climate === 'energized';
  const cratered = planet.climate === 'barren' || planet.climate === 'hostile' || planet.climate === 'tundra';
  const capped = planet.climate === 'gaia' || planet.climate === 'terran' || planet.climate === 'tundra';

  const blob = new Set<number>();
  if (!banded) {
    const n = 8 + Math.floor(rnd() * 5);
    for (let i = 0; i < n; i++) {
      let x = 3 + Math.floor(rnd() * (G - 6));
      let y = 3 + Math.floor(rnd() * (G - 6));
      for (let s = 0; s < 18 + rnd() * 22; s++) {
        blob.add(y * G + x);
        if (rnd() < 0.5) blob.add(y * G + Math.min(G - 2, x + 1));
        x = Math.min(G - 2, Math.max(1, x + Math.floor(rnd() * 3) - 1));
        y = Math.min(G - 2, Math.max(1, y + Math.floor(rnd() * 3) - 1));
      }
    }
  }
  const bandShift = Math.floor(rnd() * 5);
  const px = (x: number, y: number, col: string) => {
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(cx - diameter / 2 + x * cell), Math.round(cy - diameter / 2 + y * cell), Math.ceil(cell), Math.ceil(cell));
  };
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      if (!inside(x, y)) continue;
      let col = base;
      if (banded) {
        const band = Math.floor((y + bandShift) / 3) % 3;
        col = band === 0 ? detail : band === 2 && rnd() < 0.7 ? dark : base;
        if (rnd() < 0.05) col = light;
      } else if (blob.has(y * G + x)) {
        col = detail;
      } else if (cratered && rnd() < 0.06) {
        col = dark;
      }
      if (capped && (y <= 2 || y >= G - 3)) col = light;
      // lit from the battlefield (lower-left), night side on the far rim
      const d = ((x - c) * 0.7 + (c - y) * 0.7) / r;
      if (d > 0.45) col = dark;
      else if (d < -0.7 && rnd() < 0.8) col = light;
      // per-pixel stipple keeps it in the galaxy-weather family
      if (rnd() < 0.3) {
        px(x, y, col);
        ctx.globalAlpha = 0.22;
        px(x, y, rnd() < 0.5 ? dark : light);
        ctx.globalAlpha = 1;
      } else {
        px(x, y, col);
      }
    }
  }
}

export function makeBattleBackdrop(
  seedText: string,
  w: number,
  h: number,
  planet: BackdropPlanet | null,
): HTMLCanvasElement {
  const PX = 6;
  const rnd = mulberry32(hashText(seedText));
  const lw = Math.ceil(w / PX);
  const lh = Math.ceil(h / PX);
  const lo = document.createElement('canvas');
  lo.width = lw;
  lo.height = lh;
  const lctx = lo.getContext('2d')!;

  lctx.fillStyle = '#04060e';
  lctx.fillRect(0, 0, lw, lh);
  const blob = (x: number, y: number, r: number, rgba: string) => {
    const g = lctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    lctx.fillStyle = g;
    lctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  // two or three quiet nebula patches — dimmer than the map's so the ships own
  // the frame, but the same colored-weather language
  const order = [...NEB_COLORS].sort(() => rnd() - 0.5);
  const nCount = 2 + Math.floor(rnd() * 2);
  for (let n = 0; n < nCount; n++) {
    const pxc = lw * (0.15 + rnd() * 0.7);
    const pyc = lh * (0.15 + rnd() * 0.7);
    const [cr, cg, cb] = order[n % order.length]!;
    for (let k = 0; k < 10; k++) {
      blob(
        pxc + (rnd() - 0.5) * lw * 0.22,
        pyc + (rnd() - 0.5) * lh * 0.18,
        4 + rnd() * (Math.min(lw, lh) * 0.12),
        `rgba(${cr},${cg},${cb},${0.05 + rnd() * 0.07})`,
      );
    }
  }
  // gas stipple, same trick as the galaxy map
  const img = lctx.getImageData(0, 0, lw, lh);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const j = rnd() < 0.12 ? 0.5 + rnd() * 0.3 : 0.76 + rnd() * 0.48;
    d[i] = Math.min(255, d[i]! * j);
    d[i + 1] = Math.min(255, d[i + 1]! * j);
    d[i + 2] = Math.min(255, d[i + 2]! * j);
  }
  lctx.putImageData(img, 0, 0);

  const full = document.createElement('canvas');
  full.width = w;
  full.height = h;
  const ctx = full.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(lo, 0, 0, w, h);

  // 1px starfield
  const starCount = Math.floor((w * h) / 1400);
  for (let i = 0; i < starCount; i++) {
    const b = rnd();
    const tint = rnd();
    ctx.fillStyle =
      tint < 0.12
        ? `rgba(255,225,190,${0.2 + b * 0.5})`
        : tint > 0.9
          ? `rgba(190,215,255,${0.2 + b * 0.5})`
          : `rgba(240,246,255,${0.15 + b * 0.5})`;
    ctx.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * h), 1, 1);
  }

  // the contested world looms half off-frame behind the DEFENDER's edge
  // (right side) like the classic battle screen, dimmed a step so the ships
  // stay the brightest thing on the field
  if (planet && (planet.body === 'planet' || planet.body === 'gas_giant')) {
    const dia = Math.min(w, h) * (0.38 + Math.min(4, planet.sizeClass) * 0.04);
    const cx = w - dia * 0.3;
    const cy = dia * 0.26;
    drawPlanet(ctx, rnd, planet, cx, cy, dia);
    ctx.fillStyle = 'rgba(4, 6, 14, 0.22)';
    ctx.beginPath();
    ctx.arc(cx, cy, dia / 2 + 1, 0, Math.PI * 2);
    ctx.fill();
  }
  return full;
}
