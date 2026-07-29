// Palette + rasterization for the procedural pixel ships (shipart.ts).
// Role-indexed grids become canvases (for DOM previews) and pixi textures
// (for the battle viewer), tinted per player color. Nearest-neighbor all the
// way down so the art stays crisp and chunky.

import { Texture } from 'pixi.js';
import { NPC_ART, STYLE_ART, type ShipModel } from './shipart';

export interface Palette {
  hull: string;
  shade: string;
  light: string;
  accent: string;
  glow: string;
  trim: string;
  nozzle: string;
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

function scale(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * f, g * f, b * f);
}

export function cssToNum(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

/** hull palette for a (style, player color) pair; NPCs tint far harder.
 * A model may override the base metal (ShipModel.hull — e.g. the crescent
 * warbird's green war-metal); it still blends the player color for team
 * readability. */
export function paletteFor(styleId: string, playerHex: string, npc = false, modelHull?: string): Palette {
  const art = STYLE_ART[styleId] ?? NPC_ART;
  // Each style may set its own base metal (chrome, war-steel, …); the default
  // is the neutral gunmetal. The player color is then blended in so hulls stay
  // team-readable without losing the style's material identity.
  const baseMetal = modelHull ?? (STYLE_ART[styleId]?.hull) ?? '#8d96ad';
  const base = mix(baseMetal, playerHex, npc ? 0.5 : 0.22);
  return {
    hull: base,
    shade: scale(base, 0.58),
    light: mix(scale(base, 1.45), '#ffffff', 0.12),
    accent: playerHex,
    glow: npc ? NPC_ART.glow : art.glow,
    trim: '#12151f',
    nozzle: '#1f2433',
  };
}

export function flameColorFor(styleId: string, npc = false): string {
  return npc ? NPC_ART.flame : (STYLE_ART[styleId] ?? NPC_ART).flame;
}

const ROLE_KEYS: Array<keyof Palette | null> = [null, 'hull', 'shade', 'light', 'accent', 'glow', 'trim', 'nozzle'];

/** rasterize a model at integer scale (1 art px = `px` canvas px) */
export function renderModelToCanvas(model: ShipModel, pal: Palette, px = 1): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = model.w * px;
  canvas.height = model.h * px;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < model.h; y++) {
    for (let x = 0; x < model.w; x++) {
      const role = ROLE_KEYS[model.px[y * model.w + x]!];
      if (!role) continue;
      ctx.fillStyle = pal[role];
      ctx.fillRect(x * px, y * px, px, px);
    }
  }
  return canvas;
}

const texCache = new Map<string, Texture>();

/** pixi texture for a model (cached by caller-provided key) */
export function textureForModel(key: string, model: ShipModel, pal: Palette): Texture {
  const hit = texCache.get(key);
  if (hit) return hit;
  const tex = Texture.from(renderModelToCanvas(model, pal, 1));
  tex.source.scaleMode = 'nearest';
  texCache.set(key, tex);
  return tex;
}
