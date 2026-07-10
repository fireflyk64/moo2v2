// Player color assignments (by seat id) and star color rendering.

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

export function playerColor(id: number): string {
  if (id < 0) return ownerColor(id);
  return PLAYER_COLORS[id % PLAYER_COLORS.length]!;
}

/** Like playerColor but with distinct colors for NPC factions (monsters -2, Andromedans -3). */
export function ownerColor(id: number): string {
  if (id === -2) return '#9df06f'; // space monsters: toxic green
  if (id === -3) return '#efe9ff'; // Andromedans: ghostly white
  if (id < 0) return '#9aa3c7';
  return PLAYER_COLORS[id % PLAYER_COLORS.length]!;
}

export function ownerName(id: number, lookup: (id: number) => string | undefined): string {
  if (id === -2) return 'Space Monsters';
  if (id === -3) return 'the Andromedans';
  return lookup(id) ?? `player #${id}`;
}

export const STAR_COLORS: Record<string, string> = {
  blue: '#7fb4ff',
  white: '#f2f4ff',
  yellow: '#ffe58a',
  orange: '#ffb35e',
  red: '#ff7a6b',
  brown: '#a9825f',
  black_hole: '#5b4a75',
};
