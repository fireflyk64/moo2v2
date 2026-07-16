// Leader pool, hand-transcribed from mechanics/leaders.md (46 leaders).
// The mechanics docs list names/titles/skills but omit magnitudes, costs, and
// hiring cadence; those are OUR documented decisions (L1-L4, see data/README.md):
//
// L1  Skill magnitudes are (base × level); a starred skill in the source table
//     is "enhanced" = 2× base. Levels run 1..5.
// L2  Leaders are colony leaders or ship officers by their rank: Admiral /
//     Commander / Captain / Commodore ranks are ship officers; civil ranks
//     (Director, Magistrate, Commissioner, Lord, Governor, Administrator) are
//     colony leaders. Colony leaders are seated at one colony but administer
//     the whole star system (their colony-scope bonuses reach every colony the
//     empire owns in that system); ship officers command fleet-wide (bonuses
//     apply to all of the empire's warships).
// L3  Hiring: points = Σ (enhanced ? 2 : 1) over skills. Hire cost =
//     50 + 25×points BC (Famous discount applies), salary = points BC/turn.
//     Max 4 colony leaders + 4 ship officers per empire.
// L4  XP: +1/turn hired (+Instructor, +1 with any Space Academy); level
//     thresholds 30/90/180/300 cumulative XP for levels 2/3/4/5.

export type LeaderKind = 'colony' | 'ship';

export type LeaderSkillId =
  | 'assassin'
  | 'commando'
  | 'diplomat'
  | 'engineer'
  | 'environmentalist'
  | 'famous'
  | 'farming_leader'
  | 'fighter_pilot'
  | 'financial_leader'
  | 'galactic_lore'
  | 'helmsman'
  | 'instructor'
  | 'labor_leader'
  | 'medicine'
  | 'megawealth'
  | 'navigator'
  | 'operations'
  | 'ordnance'
  | 'researcher'
  | 'science_leader'
  | 'security'
  | 'spiritual_leader'
  | 'spy_master'
  | 'tactics'
  | 'telepath'
  | 'trader'
  | 'weaponry';

export interface LeaderSkill {
  skill: LeaderSkillId;
  enhanced: boolean;
}

export interface LeaderRow {
  id: string;
  name: string;
  title: string;
  kind: LeaderKind;
  skills: LeaderSkill[];
}

/** Per-level base magnitudes (L1). Enhanced doubles these. */
export const SKILL_BASE: Record<LeaderSkillId, number> = {
  assassin: 10, // % chance/turn to eliminate one enemy spy targeting us
  commando: 5, // ground combat strength (attack + defense), empire-wide
  diplomat: 5, // % council vote weight
  engineer: 1, // any level: fleet repairs anywhere (value unused as scalar)
  environmentalist: 2, // flat pollution absorption at colony
  famous: 10, // % hire discount; also +2%/level leader offer chance
  farming_leader: 3, // % colony food
  fighter_pilot: 10, // % fighter squadron damage
  financial_leader: 5, // % colony BC
  galactic_lore: 1, // scan bonus (parsecs)
  helmsman: 5, // beam defense, fleet-wide
  instructor: 1, // +XP/turn for all leaders (best instructor only)
  labor_leader: 3, // % colony production
  medicine: 5, // % colony growth
  megawealth: 5, // flat BC/turn empire income
  navigator: 1, // +1 parsec/turn per 2 levels (per level when enhanced)
  operations: 2, // flat command points
  ordnance: 10, // % maximum weapon damage, fleet-wide
  researcher: 3, // flat RP/turn empire-wide
  science_leader: 3, // % colony research
  security: 3, // ground combat defense, empire-wide
  spiritual_leader: 3, // colony morale %
  spy_master: 10, // spy offense
  tactics: 5, // % combat speed, fleet-wide
  telepath: 5, // spy offense; assimilation twice as fast
  trader: 25, // % trade treaty income
  weaponry: 5, // beam attack, fleet-wide
};

const s = (skill: LeaderSkillId, enhanced = false): LeaderSkill => ({ skill, enhanced });

export const LEADERS: LeaderRow[] = [
  { id: 'sparky', name: 'Commander Sparky', title: 'the Meklar Cybernaut', kind: 'ship', skills: [s('engineer', true), s('ordnance')] },
  { id: 'garron', name: 'Director Garron', title: 'the Ambassador', kind: 'colony', skills: [s('diplomat', true), s('famous'), s('megawealth')] },
  { id: 'nhagg', name: 'Captain Nhagg', title: 'the Armsmaster', kind: 'ship', skills: [s('ordnance', true), s('weaponry'), s('commando', true)] },
  { id: 'rash_lki', name: 'Magistrate Rash-lki', title: 'the Warlord', kind: 'colony', skills: [s('instructor', true), s('labor_leader', true), s('tactics'), s('commando')] },
  { id: 'loknar', name: 'Lord Admiral Loknar', title: 'the Last Orion', kind: 'ship', skills: [s('fighter_pilot', true), s('galactic_lore', true), s('helmsman', true), s('ordnance', true), s('weaponry', true)] },
  { id: 'matrix', name: 'Magistrate Matrix', title: 'the Cyber Mage', kind: 'colony', skills: [s('science_leader', true), s('spiritual_leader', true), s('assassin'), s('telepath', true)] },
  { id: 'jarred', name: 'Lord Admiral Jarred', title: 'the Explorer', kind: 'ship', skills: [s('helmsman'), s('navigator', true), s('weaponry'), s('diplomat')] },
  { id: 'vott', name: 'Commissioner Vott', title: 'the Technomancer', kind: 'colony', skills: [s('financial_leader', true), s('science_leader', true), s('megawealth'), s('researcher', true)] },
  { id: 'xantus', name: 'Commissioner Xantus', title: 'the Supreme Leader', kind: 'colony', skills: [s('environmentalist', true), s('financial_leader', true), s('labor_leader', true), s('science_leader', true), s('spiritual_leader', true)] },
  { id: 'torg', name: 'Lord Torg', title: 'the Overlord', kind: 'colony', skills: [s('farming_leader', true), s('financial_leader', true), s('labor_leader', true), s('commando')] },
  { id: 'kimbuzzi', name: 'Magistrate Kimbuzzi', title: 'the Farming Leader', kind: 'colony', skills: [s('farming_leader')] },
  { id: 'feling', name: 'Magistrate Feling', title: 'the Naturalist', kind: 'colony', skills: [s('environmentalist', true), s('farming_leader', true)] },
  { id: 'kytryl', name: 'Rear Admiral Kytryl', title: 'the Privateer', kind: 'ship', skills: [s('helmsman', true), s('navigator', true), s('weaponry'), s('famous'), s('trader')] },
  { id: 'crassis', name: 'Commissioner Crassis', title: 'the Labor Leader', kind: 'colony', skills: [s('labor_leader')] },
  { id: 'electra', name: 'Commissioner Electra', title: 'the High Priestess', kind: 'colony', skills: [s('environmentalist', true), s('farming_leader', true), s('spiritual_leader', true), s('telepath')] },
  { id: 'dantos', name: 'Admiral Dantos', title: 'the Bandit Lord', kind: 'ship', skills: [s('fighter_pilot', true), s('helmsman'), s('weaponry', true), s('famous', true), s('megawealth')] },
  { id: 'claw', name: 'Commissioner Claw', title: 'the Klackon Taskmaster', kind: 'colony', skills: [s('farming_leader', true), s('labor_leader', true), s('operations', true)] },
  { id: 'kronos', name: 'Rear Admiral Kronos', title: 'the Ancient Spacefarer', kind: 'ship', skills: [s('galactic_lore', true), s('helmsman'), s('navigator', true)] },
  { id: 'tulock', name: 'Commodore Tulock', title: 'the Bounty Hunter', kind: 'ship', skills: [s('helmsman', true), s('navigator'), s('weaponry', true), s('assassin'), s('commando')] },
  { id: 'grogg', name: 'Director Grogg', title: 'the Gnolam Capitalist', kind: 'colony', skills: [s('financial_leader', true), s('labor_leader'), s('megawealth')] },
  { id: 'androgena', name: 'Director Androgena', title: '', kind: 'colony', skills: [s('farming_leader'), s('financial_leader'), s('labor_leader'), s('medicine')] },
  { id: 'megatron', name: 'Commissioner Megatron', title: 'the Relic Android', kind: 'colony', skills: [s('farming_leader', true), s('labor_leader', true), s('science_leader', true)] },
  { id: 'cyr', name: 'Lord Admiral Cyr', title: 'the Fighter Ace', kind: 'ship', skills: [s('fighter_pilot')] },
  { id: 'tanus', name: 'Governor Tanus', title: 'the Revolutionary', kind: 'colony', skills: [s('farming_leader'), s('labor_leader'), s('science_leader'), s('spiritual_leader')] },
  { id: 'brainac', name: 'Director Brainac', title: '', kind: 'colony', skills: [s('farming_leader', true), s('instructor'), s('science_leader', true), s('spiritual_leader', true), s('assassin')] },
  { id: 'orphus', name: 'Lord Orphus', title: 'the Peacemaker', kind: 'colony', skills: [s('instructor'), s('medicine'), s('spiritual_leader', true), s('diplomat', true), s('famous')] },
  { id: 'ailis', name: 'Commissioner Ailis', title: 'the Gifted', kind: 'colony', skills: [s('environmentalist'), s('medicine', true), s('spiritual_leader')] },
  { id: 'houri', name: 'Governor Houri', title: 'the Environmentalist', kind: 'colony', skills: [s('environmentalist', true)] },
  { id: 'nimraaz', name: 'Lord Nimraaz', title: 'the Master Tactician', kind: 'colony', skills: [s('instructor'), s('tactics', true), s('commando', true), s('operations', true)] },
  { id: 'emo', name: 'Lord Emo', title: 'the Science Leader', kind: 'colony', skills: [s('science_leader')] },
  { id: 'khunagg', name: 'Lord Khunagg', title: 'the Ruthless', kind: 'colony', skills: [s('farming_leader'), s('labor_leader'), s('tactics'), s('commando')] },
  { id: 'ralleia', name: 'Lord Ralleia', title: 'the Siren', kind: 'colony', skills: [s('spiritual_leader', true), s('diplomat', true), s('famous')] },
  { id: 'mukirr', name: 'Lord Admiral Mukirr', title: 'the Mrrshan Warrior', kind: 'ship', skills: [s('weaponry', true), s('commando')] },
  { id: 'galis', name: 'Lord Galis', title: 'the Financial Leader', kind: 'colony', skills: [s('financial_leader')] },
  { id: 'grum', name: 'Lord Admiral Grum', title: 'the Armsman', kind: 'ship', skills: [s('security'), s('commando')] },
  { id: 'chug', name: 'Lord Chug', title: 'the Planetologist', kind: 'colony', skills: [s('environmentalist'), s('farming_leader'), s('researcher')] },
  { id: 'altos', name: 'Lord Admiral Altos', title: 'the Alkari Pilot', kind: 'ship', skills: [s('fighter_pilot'), s('helmsman', true), s('navigator')] },
  { id: 'gizmo', name: 'Commander Gizmo', title: 'the Gadgeteer', kind: 'ship', skills: [s('engineer'), s('researcher')] },
  { id: 'ruola', name: 'Commander Ruola', title: 'the Weapons Officer', kind: 'ship', skills: [s('weaponry')] },
  { id: 'draxx', name: 'Administrator Draxx', title: 'the Spy Master', kind: 'colony', skills: [s('assassin', true), s('spy_master', true)] },
  { id: 'hawk', name: 'Commander Hawk', title: 'the Astrogator', kind: 'ship', skills: [s('helmsman'), s('navigator')] },
  { id: 'slith', name: 'Captain Slith', title: 'the Rebel Pilot', kind: 'ship', skills: [s('helmsman'), s('navigator'), s('ordnance'), s('weaponry')] },
  { id: 'aquasarrious', name: 'Commander Aquasarrious', title: 'the Trilarian Navigator', kind: 'ship', skills: [s('helmsman'), s('navigator', true), s('weaponry')] },
  { id: 'caern', name: 'Captain Caern', title: 'the Tulosian Mercenary', kind: 'ship', skills: [s('helmsman'), s('navigator'), s('ordnance'), s('security'), s('weaponry')] },
  { id: 'skaine', name: 'Rear Admiral Skaine', title: 'the Legendary Pilot', kind: 'ship', skills: [s('fighter_pilot'), s('helmsman', true), s('navigator'), s('weaponry'), s('famous', true)] },
  { id: 'nile', name: 'Rear Admiral Nile', title: 'the Forsaken Warrior', kind: 'ship', skills: [s('security', true), s('weaponry', true), s('commando', true)] },
];

export const leaderById = new Map(LEADERS.map((l) => [l.id, l]));

export const MAX_LEADERS_PER_KIND = 4;

/** cumulative XP needed to sit at each level (index = level-1) */
export const LEVEL_XP = [0, 30, 90, 180, 300] as const;
export const MAX_LEVEL = LEVEL_XP.length;

export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 1; i < LEVEL_XP.length; i++) {
    if (xp >= LEVEL_XP[i]!) level = i + 1;
  }
  return level;
}

export function leaderPoints(row: LeaderRow): number {
  let pts = 0;
  for (const sk of row.skills) pts += sk.enhanced ? 2 : 1;
  return pts;
}

export function skillMagnitude(sk: LeaderSkill, level: number): number {
  return SKILL_BASE[sk.skill] * (sk.enhanced ? 2 : 1) * level;
}
