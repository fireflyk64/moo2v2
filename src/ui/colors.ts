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
  return PLAYER_COLORS[id % PLAYER_COLORS.length]!;
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
