// Leader presentation: every leader card must SAY what the leader does.
// Playtest: skill chips with no explanation ("what does the leader actually
// do?") and two Directors whose blank epithet line read as "no attribute".
import { describe, expect, it } from 'vitest';
import {
  LEADERS,
  SKILL_BASE,
  SHIP_COMBAT_SKILLS,
  skillDescription,
  skillMagnitude,
  type LeaderSkillId,
} from '@engine/data/leaders';

describe('leader skill descriptions', () => {
  it('every skill id describes itself at every level, plain and enhanced', () => {
    for (const skill of Object.keys(SKILL_BASE) as LeaderSkillId[]) {
      for (const enhanced of [false, true]) {
        for (let level = 1; level <= 5; level++) {
          for (const kind of ['colony', 'ship'] as const) {
            const text = skillDescription({ skill, enhanced }, level, kind);
            expect(text.length).toBeGreaterThan(10);
            expect(text).not.toMatch(/undefined|NaN/);
          }
        }
      }
    }
  });

  it('quotes the actual magnitude for scaling skills', () => {
    const text = skillDescription({ skill: 'farming_leader', enhanced: true }, 3, 'colony');
    expect(text).toContain(`+${skillMagnitude({ skill: 'farming_leader', enhanced: true }, 3)}%`);
  });

  it('flags ship-combat skills as decorative on colony leaders', () => {
    for (const skill of SHIP_COMBAT_SKILLS) {
      expect(skillDescription({ skill, enhanced: false }, 1, 'colony')).toContain('ship officers only');
      expect(skillDescription({ skill, enhanced: false }, 1, 'ship')).not.toContain('ship officers only');
    }
  });

  it('every leader has a non-empty epithet (a blank title line reads as "no attribute")', () => {
    for (const row of LEADERS) {
      expect(row.title, row.id).not.toBe('');
    }
  });
});
