// Hand-off from a live game to the Battle Lab: "test the ship types I have
// built or encountered". Set by the Empires tab, consumed once by BattleLab.

export interface LabSeedGroup {
  label: string;
  hull: string;
  computer: number;
  shield: number;
  specials: string[];
  weapons: Array<{ weapon: string; count: number; mods: string[]; arc: 'F' | 'FX' | 'R' | '360' }>;
  count: number;
}

let pending: { a: LabSeedGroup[]; d: LabSeedGroup[] } | null = null;

export function setLabSeed(a: LabSeedGroup[], d: LabSeedGroup[]): void {
  pending = { a, d };
}

export function takeLabSeed(): { a: LabSeedGroup[]; d: LabSeedGroup[] } | null {
  const out = pending;
  pending = null;
  return out;
}
