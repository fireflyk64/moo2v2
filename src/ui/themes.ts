// UI theme registry — every entry is a [data-theme] token block in theme.css.
// The empty id is the :root default (phosphor). Cosmetic only: identity colors
// (player banners, star classes, planet art, the galaxy) never change with the
// theme, so switching mid-game is always safe.

export interface ThemeOption {
  id: string;
  label: string;
  /** four representative swatches for the picker */
  dots: [string, string, string, string];
}

export const THEMES: ThemeOption[] = [
  { id: '', label: 'Phosphor — alien terminal', dots: ['#90f03c', '#5b665c', '#0c1a10', '#f0c964'] },
  { id: 'starliner', label: 'Starliner — silver + navy', dots: ['#58a6ff', '#dde4ec', '#101c36', '#ffd479'] },
  { id: 'chrome', label: 'Chrome — polished steel', dots: ['#35d6e8', '#bcc5d0', '#12161f', '#f0c964'] },
  { id: 'cloudcity', label: 'Cloud City — glossy ivory', dots: ['#2f6fd6', '#e9e4d8', '#f4f1e9', '#b8860b'] },
  { id: 'nebula', label: 'Nebula — deep-space blue', dots: ['#6ea8ff', '#151d3f', '#0f1530', '#ffd479'] },
  { id: 'aurora', label: 'Aurora — violet iridescence', dots: ['#b78bff', '#33344a', '#12121f', '#4fe0c0'] },
  { id: 'brasswing', label: 'Brasswing — ivory + brass', dots: ['#1f5f8b', '#e0cc9e', '#f7f0e0', '#a67816'] },
  { id: 'midnight-gold', label: 'Midnight Gold — gunmetal + gold', dots: ['#ffd061', '#292e3d', '#0d1220', '#6fe08a'] },
];

const KEY = 'moo2.theme';

export function currentTheme(): string {
  try {
    const id = localStorage.getItem(KEY) ?? '';
    return THEMES.some((t) => t.id === id) ? id : '';
  } catch {
    return '';
  }
}

export function applyTheme(id: string): void {
  if (id) document.documentElement.dataset['theme'] = id;
  else delete document.documentElement.dataset['theme'];
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // private mode: theme holds for this tab only
  }
}

/** boot: restore the saved theme before first paint */
export function initTheme(): void {
  const id = currentTheme();
  if (id) document.documentElement.dataset['theme'] = id;
}
