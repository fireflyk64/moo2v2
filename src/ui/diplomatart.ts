// Procedural diplomat portraits — the shipart.ts recipe pointed at faces:
// seeded string → mulberry32 → role-indexed pixel grid (mirrored about the
// VERTICAL axis, ships mirror the horizontal spine) → per-empire palette →
// nearest-neighbor canvas. Deterministic: the same empire in the same game
// always sends the same envoy.

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
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

class Rnd {
  private f: () => number;
  constructor(seed: string) {
    this.f = mulberry32(hashStr(seed));
  }
  next(): number {
    return this.f();
  }
  int(n: number): number {
    return Math.floor(this.f() * n);
  }
  range(a: number, b: number): number {
    return a + this.int(b - a + 1);
  }
  chance(p: number): boolean {
    return this.f() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }
}

// roles
const E = 0; // empty
const SKIN = 1;
const SHADE = 2;
const LIGHT = 3;
const EYE = 4;
const GARB = 5;
const GARB_SH = 6;
const TRIM = 7;
const DARK = 8;

export interface DiplomatModel {
  w: number;
  h: number;
  px: Uint8Array;
}

const W = 26;
const H = 30;
const CX = (W - 1) / 2; // 12.5 — mirror axis between columns 12 and 13

/** symmetric painter: set (x,y) and its mirror */
class Face {
  px = new Uint8Array(W * H);
  set(x: number, y: number, r: number) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    this.px[y * W + x] = r;
  }
  sym(x: number, y: number, r: number) {
    this.set(x, y, r);
    this.set(Math.round(2 * CX - x), y, r);
  }
  /** horizontal symmetric span from the axis outward */
  band(y: number, halfW: number, r: number) {
    for (let x = Math.ceil(CX - halfW); x <= CX; x++) this.sym(x, y, r);
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}
function scaleHex(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * f, g * f, b * f);
}

/** alien skin families — chosen by seed so an empire's race keeps its hue */
const SKIN_BASES = [
  '#6cae5e', // moss green
  '#4f9e8f', // teal
  '#7d86c9', // violet blue
  '#b06ac0', // orchid
  '#c9784f', // ember
  '#9aa3ad', // ash gray
  '#c9b04f', // ochre
  '#5e7fae', // slate blue
  '#ae5e72', // dusk rose
] as const;

const EYE_GLOWS = ['#ffe066', '#7df0ff', '#ffffff', '#ff9df0', '#a0ff8a', '#ffb35e'] as const;

export interface DiplomatPalette {
  [role: number]: string;
}

export function diplomatPalette(seed: string, playerHex: string): DiplomatPalette {
  const r = new Rnd(seed + '/pal');
  const skin = mix(r.pick(SKIN_BASES), playerHex, 0.1);
  const garb = mix('#3a4258', playerHex, 0.55);
  return {
    [SKIN]: skin,
    [SHADE]: scaleHex(skin, 0.62),
    [LIGHT]: mix(scaleHex(skin, 1.4), '#ffffff', 0.15),
    [EYE]: r.pick(EYE_GLOWS),
    [GARB]: garb,
    [GARB_SH]: scaleHex(garb, 0.55),
    [TRIM]: '#d8dce8',
    [DARK]: '#10131d',
  };
}

export function diplomatModel(seed: string): DiplomatModel {
  const r = new Rnd(seed);
  const f = new Face();

  // ---- head silhouette ----
  const headTop = r.range(3, 5);
  const headBottom = r.range(21, 23);
  const headHalf = r.range(4, 6); // widest half-width
  const cranium = r.pick(['dome', 'tall', 'flat', 'lobes'] as const);
  const chinTaper = r.range(1, 3);

  for (let y = headTop; y <= headBottom; y++) {
    const t = (y - headTop) / (headBottom - headTop);
    let hw = headHalf;
    if (t < 0.25) {
      // crown rounding
      const k = t / 0.25;
      hw = cranium === 'flat' ? headHalf : Math.max(1, Math.round(headHalf * (0.55 + 0.45 * k)));
      if (cranium === 'tall') hw = Math.max(1, Math.round(headHalf * (0.4 + 0.6 * k)));
    } else if (t > 0.72) {
      // jaw taper toward the chin
      const k = (t - 0.72) / 0.28;
      hw = Math.max(1, Math.round(headHalf - chinTaper * k));
    }
    if (cranium === 'lobes' && t < 0.2) {
      // double-lobed brain-case: a notch on the axis
      f.band(y, hw, SKIN);
      f.sym(Math.round(CX), y, E);
      f.sym(Math.round(CX) - 1, y, E);
    } else {
      f.band(y, hw, SKIN);
    }
  }

  // shading: left-lit — since the face mirrors, fake it with rim shade lines
  for (let y = headTop + 1; y <= headBottom; y++) {
    // find the outermost skin pixel on the left and shade it
    for (let x = 0; x <= CX; x++) {
      if (f.px[y * W + x] === SKIN) {
        f.set(Math.round(2 * CX - x), y, SHADE); // right rim in shadow
        if (r.chance(0.5)) f.set(x, y, LIGHT); // left rim catches light
        break;
      }
    }
  }

  // ---- eyes ----
  const eyeY = headTop + Math.round((headBottom - headTop) * (0.42 + r.next() * 0.1));
  const eyeOff = r.range(2, Math.max(2, headHalf - 1));
  const eyeW = r.chance(0.35) ? 2 : 1;
  const eyeCount = r.chance(0.08) ? 1 : r.chance(0.16) ? 3 : 2;
  const socket = r.chance(0.6);
  if (eyeCount === 1) {
    // cyclops: one wide glowing eye on the axis
    f.band(eyeY, eyeW, EYE);
    f.band(eyeY - 1, eyeW, socket ? DARK : SHADE);
  } else {
    for (let k = 0; k < eyeW; k++) {
      f.sym(Math.round(CX) - eyeOff - k, eyeY, EYE);
      if (socket) f.sym(Math.round(CX) - eyeOff - k, eyeY - 1, DARK);
    }
    if (eyeCount === 3) {
      f.sym(Math.round(CX), eyeY - r.range(2, 3), EYE);
    }
  }
  // brow ridge
  if (r.chance(0.45)) {
    for (let k = -1; k <= eyeW; k++) f.sym(Math.round(CX) - eyeOff - k, eyeY - 2, SHADE);
  }

  // ---- nose / mouth ----
  const noseKind = r.pick(['none', 'slits', 'ridge'] as const);
  const noseY = eyeY + r.range(2, 3);
  if (noseKind === 'slits') f.sym(Math.round(CX) - 1, noseY, DARK);
  else if (noseKind === 'ridge') {
    f.sym(Math.round(CX), noseY - 1, LIGHT);
    f.sym(Math.round(CX), noseY, LIGHT);
  }
  const mouthY = Math.min(headBottom - 1, noseY + r.range(2, 3));
  const mouthHalf = r.range(1, 2);
  if (r.chance(0.14)) {
    // mandibles: two short angled darks
    f.sym(Math.round(CX) - 2, mouthY, DARK);
    f.sym(Math.round(CX) - 3, mouthY + 1, DARK);
  } else {
    f.band(mouthY, mouthHalf, DARK);
  }

  // ---- skin texture ----
  const speckle = r.next() * 0.12;
  for (let y = headTop; y <= headBottom; y++) {
    for (let x = 0; x <= CX; x++) {
      if (f.px[y * W + x] === SKIN && r.chance(speckle)) {
        f.sym(x, y, r.chance(0.5) ? SHADE : LIGHT);
      }
    }
  }

  // ---- appendages ----
  const app = r.pick(['antennae', 'fins', 'crest', 'ears', 'tendrils', 'none', 'none'] as const);
  if (app === 'antennae') {
    const ax = Math.round(CX) - r.range(1, 3);
    const len = r.range(2, 4);
    for (let k = 1; k <= len; k++) f.sym(ax, headTop - k, DARK);
    f.sym(ax, headTop - len - 1, EYE); // glowing tips
  } else if (app === 'fins') {
    const fy = eyeY - r.range(0, 2);
    for (let k = 1; k <= r.range(2, 3); k++) {
      f.sym(Math.round(CX - headHalf) - k, fy + k, SKIN);
      f.sym(Math.round(CX - headHalf) - k, fy + k + 1, SHADE);
    }
  } else if (app === 'crest') {
    for (let y = headTop - r.range(2, 3); y < headTop + 3; y++) f.sym(Math.round(CX), y, SHADE);
    f.sym(Math.round(CX), headTop - r.range(2, 3) - 1, LIGHT);
  } else if (app === 'ears') {
    f.sym(Math.round(CX - headHalf), eyeY - 1, SKIN);
    f.sym(Math.round(CX - headHalf) - 1, eyeY - 2, SKIN);
    f.sym(Math.round(CX - headHalf) - 1, eyeY - 3, SHADE);
  } else if (app === 'tendrils') {
    for (let k = 0; k < r.range(2, 3); k++) {
      const tx = Math.round(CX) - 1 - k * 2;
      f.sym(tx, headBottom + 1, SKIN);
      f.sym(tx, headBottom + 2, SHADE);
    }
  }

  // ---- helmet (occasionally): a garb-colored dome with a trim rim ----
  if (r.chance(0.18)) {
    for (let y = headTop - 1; y <= eyeY - 3; y++) {
      const t = (y - headTop) / Math.max(1, headBottom - headTop);
      let hw = headHalf + 1;
      if (t < 0.25) hw = Math.max(2, Math.round((headHalf + 1) * (0.55 + 0.45 * (t / 0.25))));
      f.band(y, hw, GARB);
    }
    f.band(eyeY - 2, headHalf + 1, TRIM);
  }

  // ---- bust: shoulders, collar, sash ----
  const shoulderY = Math.min(H - 4, headBottom + 3);
  for (let y = shoulderY; y < H; y++) {
    const grow = Math.min(4, y - shoulderY);
    f.band(y, Math.min(11, headHalf + 3 + grow), y === shoulderY ? TRIM : GARB);
  }
  // neck
  for (let y = headBottom + 1; y < shoulderY; y++) f.band(y, Math.max(1, headHalf - 3), SHADE);
  // collar accent + emblem
  f.band(shoulderY + 1, Math.max(2, headHalf - 1), GARB_SH);
  if (r.chance(0.6)) {
    const ey = shoulderY + r.range(2, 3);
    f.band(ey, 1, r.chance(0.5) ? TRIM : EYE);
  }
  // sash: one diagonal garb-shade line (mirrored → a V)
  if (r.chance(0.5)) {
    for (let k = 0; k < 5; k++) f.sym(Math.round(CX) - 2 - k, shoulderY + 2 + k, GARB_SH);
  }

  return { w: W, h: H, px: f.px };
}

const modelCache = new Map<string, DiplomatModel>();

export function getDiplomatModel(seed: string): DiplomatModel {
  const hit = modelCache.get(seed);
  if (hit) return hit;
  const m = diplomatModel(seed);
  if (modelCache.size > 128) modelCache.clear();
  modelCache.set(seed, m);
  return m;
}

/** rasterize at integer scale (1 art px = `px` canvas px) */
export function renderDiplomatToCanvas(seed: string, playerHex: string, px = 3): HTMLCanvasElement {
  const model = getDiplomatModel(seed);
  const pal = diplomatPalette(seed, playerHex);
  const canvas = document.createElement('canvas');
  canvas.width = model.w * px;
  canvas.height = model.h * px;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < model.h; y++) {
    for (let x = 0; x < model.w; x++) {
      const role = model.px[y * model.w + x]!;
      if (role === E) continue;
      ctx.fillStyle = pal[role]!;
      ctx.fillRect(x * px, y * px, px, px);
    }
  }
  return canvas;
}
