// Battle Lab scenarios (0.26): curated set-piece matchups where the DOCTRINE
// makes or breaks the fight. Each is a pair of fleets plus the doctrine each
// side flies — chosen so that flipping one tactic visibly changes the result,
// which is the whole point of the sandbox. Pure data; BattleLab.svelte maps
// these onto its LabGroup/LabSide shapes and the scenarios test validates
// every ship builds under a max-tech empire.
//
// Weapon arcs: F forward, FX oblique (270°), 360 turret. Doctrines: standoff
// (long band, warheads), line (medium wall), charge (knife range), flank /
// pincer (wall + a wing into the rear arcs), envelop (a closing net).

import type { BattleOrders } from '@engine/index';

export interface ScenarioWeapon {
  weapon: string;
  count: number;
  mods?: string[];
  arc?: 'F' | 'FX' | 'R' | '360';
}
export interface ScenarioGroup {
  hull: string;
  count: number;
  weapons: ScenarioWeapon[];
  /** computer/shield tier 0..5, armor tier 1..6 (default 3/3/3) */
  computer?: number;
  shield?: number;
  armor?: number;
  specials?: string[];
  /** combat speed override — the lab otherwise gives every hull the same
   * max-drive speed, which erases the drive race these scenarios turn on */
  speed?: number;
}
export interface ScenarioSide {
  groups: ScenarioGroup[];
  orders: Partial<BattleOrders>;
  style: string;
}
export interface LabScenario {
  id: string;
  name: string;
  /** one line the picker shows — what to watch, and what to try flipping */
  blurb: string;
  seed: string;
  a: ScenarioSide;
  d: ScenarioSide;
}

const g = (
  hull: string,
  count: number,
  speed: number,
  weapons: ScenarioWeapon[],
  extra?: Partial<ScenarioGroup>,
): ScenarioGroup => ({ hull, count, speed, weapons, ...extra });
const w = (weapon: string, count: number, arc: ScenarioWeapon['arc'] = 'F', mods: string[] = []): ScenarioWeapon => ({
  weapon,
  count,
  arc,
  mods,
});

export const LAB_SCENARIOS: LabScenario[] = [
  {
    id: 'combined_arms',
    name: 'Combined arms — wall vs swarm',
    blurb:
      'A slow line of graviton capitals against a fast beam swarm. The swarm flanks into the capitals’ rear arcs — but flip it to charge and it dies on the wall; flip the capitals to standoff and they kite it to death.',
    seed: 'combined-arms',
    a: {
      groups: [
        g('titan', 1, 4, [w('graviton_beam', 5, 'F', ['hv'])], { armor: 3, shield: 1 }),
        g('cruiser', 2, 6, [w('fusion_beam', 5, 'F')], { armor: 2, shield: 1 }),
        g('destroyer', 4, 8, [w('fusion_beam', 2, 'F')], { armor: 2, shield: 1 }),
      ],
      orders: { retreatThresholdPct: 0, stance: 'hold_range', formation: 'line' },
      style: 'lattice',
    },
    d: {
      groups: [
        g('titan', 1, 4, [w('graviton_beam', 5, 'F', ['hv'])], { armor: 3, shield: 1 }),
        g('cruiser', 2, 6, [w('fusion_beam', 5, 'F')], { armor: 2, shield: 1 }),
        g('destroyer', 4, 8, [w('fusion_beam', 2, 'F')], { armor: 2, shield: 1 }),
      ],
      orders: { retreatThresholdPct: 0, stance: 'charge', formation: 'flank' },
      style: 'raptor',
    },
  },
  {
    id: 'missile_alpha',
    name: 'Missiles vs the interceptor screen',
    blurb:
      'A missile fleet against a screen of interceptor rockets and point-defense. Snipe from standoff and the screen picks the warheads out of the sky one at a time; flank in and overwhelm the point-defense at close range instead. Thin the screen’s rockets and standoff starts to pay.',
    seed: 'missile-alpha',
    a: {
      groups: [g('battleship', 5, 6, [w('merculite_missile', 4, 'F'), w('laser_cannon', 2, '360', ['pd'])], { armor: 2, shield: 1 })],
      orders: { retreatThresholdPct: 0, stance: 'charge', formation: 'flank' },
      style: 'nebula',
    },
    d: {
      groups: [
        g('cruiser', 5, 8, [w('anti_missile_rocket', 4, '360'), w('laser_cannon', 4, '360', ['pd'])], { armor: 2, shield: 0 }),
        g('destroyer', 5, 10, [w('fusion_beam', 3, 'F')], { armor: 2, shield: 0 }),
      ],
      orders: { retreatThresholdPct: 0, stance: 'charge', formation: 'charge' },
      style: 'raptor',
    },
  },
  {
    id: 'shield_wall',
    name: 'Shield wall breakthrough',
    blurb:
      'A class-X shield wall shrugs off ordinary beams (this is why laser-vs-shield stalemates). The attackers bring shield-PIERCING phasors that ignore it — swap those back to plain beams and the wall becomes the stalemate you started with.',
    seed: 'shield-wall',
    a: {
      groups: [g('battleship', 5, 5, [w('fusion_beam', 5, 'F', ['co'])], { shield: 5, armor: 4, specials: ['shield_capacitor'] })],
      orders: { retreatThresholdPct: 0, stance: 'hold_range', formation: 'line' },
      style: 'lattice',
    },
    d: {
      groups: [
        g('cruiser', 4, 8, [w('phasor', 3, 'F', ['sp'])], { armor: 3 }),
        g('frigate', 6, 10, [w('phasor', 1, 'F', ['sp'])], { armor: 2 }),
      ],
      orders: { retreatThresholdPct: 0, stance: 'charge', formation: 'charge' },
      style: 'raptor',
    },
  },
  {
    id: 'lumbering_giant',
    name: 'The lumbering giant',
    blurb:
      'One slow doomstar with all-forward heavy beams against a fast frigate swarm of 360° turrets. Envelop it and its guns never bear; charge it head-on and it deletes you one at a time.',
    seed: 'lumbering-giant',
    a: {
      groups: [g('doomstar', 1, 3, [w('graviton_beam', 5, 'F', ['hv'])], { shield: 2, armor: 3 })],
      orders: { retreatThresholdPct: 0, stance: 'hold_range', formation: 'line' },
      style: 'lattice',
    },
    d: {
      groups: [
        g('frigate', 20, 10, [w('ion_pulse_cannon', 1, '360')], { armor: 2 }),
        g('destroyer', 10, 9, [w('ion_pulse_cannon', 2, '360')], { armor: 3 }),
      ],
      orders: { retreatThresholdPct: 0, stance: 'charge', formation: 'envelop' },
      style: 'raptor',
    },
  },
  {
    id: 'drive_race',
    name: 'Drive race — the engines to close the net',
    blurb:
      'Two identical destroyer wings — but one has the drives to close a net the other can’t escape. The fast side envelops and works the rear arcs; the slow line can’t keep its bows on a ring it can’t run from. Give them equal engines and it collapses back to an even brawl.',
    seed: 'drive-race',
    a: {
      groups: [g('destroyer', 11, 11, [w('fusion_beam', 3, 'F')], { armor: 3, shield: 1 })],
      orders: { retreatThresholdPct: 0, stance: 'charge', formation: 'envelop' },
      style: 'raptor',
    },
    d: {
      groups: [g('destroyer', 11, 5, [w('fusion_beam', 3, 'F')], { armor: 3, shield: 1 })],
      orders: { retreatThresholdPct: 0, stance: 'hold_range', formation: 'line' },
      style: 'lattice',
    },
  },
  {
    id: 'arcs_matter',
    name: 'Arcs & angles — pincer vs line',
    blurb:
      'Identical destroyer hulls at identical speed — one wears oblique (FX) mounts and pincers, the other has forward guns and charges. The oblique wings keep firing through the turn and pile on rear-arc hits; stand the FX side in a line instead and a steady forward line refuses the flanks.',
    seed: 'arcs-matter',
    a: {
      groups: [g('destroyer', 9, 8, [w('fusion_beam', 3, 'FX')], { armor: 3, shield: 1 })],
      orders: { retreatThresholdPct: 0, stance: 'charge', formation: 'pincer' },
      style: 'raptor',
    },
    d: {
      groups: [g('destroyer', 9, 8, [w('fusion_beam', 3, 'F')], { armor: 3, shield: 1 })],
      orders: { retreatThresholdPct: 0, stance: 'charge', formation: 'charge' },
      style: 'lattice',
    },
  },
];
