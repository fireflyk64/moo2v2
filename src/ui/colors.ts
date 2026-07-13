// Player color assignments (by seat id) and star color rendering.

import type { StarColor } from '@engine/types';

export const PLAYER_COLORS = [
  '#4da3ff', // 0 blue
  '#ff6b5e', // 1 red
  '#5ee08a', // 2 green
  '#ffd75e', // 3 yellow
  '#c78bff', // 4 purple
  '#5ee6e0', // 5 cyan
  '#ff9d3d', // 6 orange
  '#ff7ad1', // 7 pink
];

/** empires that picked a banner color at game start override the seat default;
 * synced from the live game state (GameShell) so EVERY surface — map, fleets,
 * battles, reports — shows one consistent color per player */
const chosenColors = new Map<number, string>();

export function syncEmpireColors(empires: ReadonlyArray<{ id: number; color?: string }>): void {
  chosenColors.clear();
  for (const e of empires) {
    if (e.color) chosenColors.set(e.id, e.color);
  }
}

export function playerColor(id: number): string {
  if (id < 0) return ownerColor(id);
  return chosenColors.get(id) ?? PLAYER_COLORS[id % PLAYER_COLORS.length]!;
}

/** Like playerColor but with distinct colors for NPC factions (monsters -2, Andromedans -3). */
export function ownerColor(id: number): string {
  if (id === -2) return '#9df06f'; // space monsters: toxic green
  if (id === -3) return '#efe9ff'; // Andromedans: ghostly white
  if (id < 0) return '#9aa3c7';
  return chosenColors.get(id) ?? PLAYER_COLORS[id % PLAYER_COLORS.length]!;
}

export function ownerName(id: number, lookup: (id: number) => string | undefined): string {
  if (id === -2) return 'Space Monsters';
  if (id === -3) return 'the Andromedans';
  return lookup(id) ?? `player #${id}`;
}

export const STAR_COLORS: Record<StarColor, string> = {
  blue: '#7fb4ff',
  white: '#f2f4ff',
  yellow: '#ffe58a',
  orange: '#ffb35e',
  red: '#ff7a6b',
  brown: '#a9825f',
  black_hole: '#5b4a75',
};
