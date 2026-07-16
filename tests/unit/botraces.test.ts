import { describe, expect, it } from 'vitest';
import { validatePicks } from '@engine/data/index';
import { BOT_RACES, botRacePicks } from '@ui/botRaces';

// Bot race archetypes must scale to the game's pick-point budget: a 16-point
// game should produce a strictly richer race than a 10-point one, and no
// points may be left on the table (the whole reason these exist).

const BUDGETS = [10, 12, 14, 16];

describe('bot race archetypes', () => {
  for (const def of BOT_RACES) {
    for (const budget of BUDGETS) {
      it(`${def.id} @ ${budget} picks is legal and spends the full budget`, () => {
        const picks = botRacePicks(def.id, budget)!;
        const v = validatePicks(picks, budget);
        expect(v.errors).toEqual([]);
        expect(v.ok).toBe(true);
        // every archetype milks repulsive for the free 6 points
        expect(picks).toContain('repulsive');
        // full spend: the want-lists are ordered so nothing is wasted
        expect(v.cost).toBe(budget);
      });
    }

    it(`${def.id} scales up monotonically with the budget`, () => {
      const costAt = (b: number) => validatePicks(botRacePicks(def.id, b)!, b).cost;
      expect(costAt(12)).toBeGreaterThan(costAt(10));
      expect(costAt(16)).toBeGreaterThan(costAt(12));
    });
  }

  it('unknown archetype ids return null (stock preset fallback)', () => {
    expect(botRacePicks('hivex', 10)).toBeNull();
  });

  it('signature traits survive at every budget', () => {
    for (const budget of BUDGETS) {
      expect(botRacePicks('lithovores', budget)).toContain('lithovore');
      expect(botRacePicks('cyborgs', budget)).toContain('cybernetic');
      expect(botRacePicks('creatives', budget)).toContain('creative');
      expect(botRacePicks('forgers', budget)).toContain('subterranean');
      expect(botRacePicks('scholars', budget)).toContain('subterranean');
    }
  });
});
