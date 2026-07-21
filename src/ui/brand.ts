// The game's name, in ONE place. bugs.md keeps the final title open (Mantle
// of Oblivion / Magistrate of Ophidian / Mediators of Omega are still in the
// running), so no component may hardcode it — everything user-visible reads
// from here. index.html's <title> is the only duplicate (needed before JS
// loads); main.ts overwrites it with FULL_TITLE at boot.
export const BRAND = {
  /** full name — splash screen, in-game header, window title */
  title: 'Mantle of Ophion',
  subtitle: 'Battle across Andromeda',
  /** short mark for tight chrome and running text */
  acronym: 'MOOv2',
} as const;

export const FULL_TITLE = `${BRAND.title}: ${BRAND.subtitle}`;
