import { describe, expect, it } from 'vitest';
import { ALWAYS_KNOWN_ITEMS, APPLICATION_ROWS, BUILDABLE_ROWS, CURATED_BUILDABLES, applicationById } from '@engine/data/index';
import { BUILDABLE_APP_ALIAS, DEFERRED_BUILDABLES, MODE_GATED_BUILDABLES } from '@engine/items';

// Systemic audit (bug: "I can't build planetary supercomputer after researching"):
// every buildable must be reachable — always-known, unlocked by an application
// with the same id, via an explicit alias, or deliberately deferred.

describe('every buildable is unlockable', () => {
  const appIds = new Set(APPLICATION_ROWS.map((a) => a.id));
  for (const b of [...BUILDABLE_ROWS, ...CURATED_BUILDABLES]) {
    it(`${b.id} is reachable`, () => {
      const reachable =
        (ALWAYS_KNOWN_ITEMS as readonly string[]).includes(b.id) ||
        appIds.has(b.id) ||
        (BUILDABLE_APP_ALIAS[b.id] !== undefined && appIds.has(BUILDABLE_APP_ALIAS[b.id]!)) ||
        DEFERRED_BUILDABLES.has(b.id) ||
        MODE_GATED_BUILDABLES.has(b.id);
      expect(reachable, `buildable ${b.id} (techId ${b.techId}) has no unlock path`).toBe(true);
    });
  }

  it('every alias points at a real application', () => {
    for (const [buildable, app] of Object.entries(BUILDABLE_APP_ALIAS)) {
      expect(applicationById.has(app), `alias ${buildable} -> ${app} names a missing application`).toBe(true);
    }
  });
});
