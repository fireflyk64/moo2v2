// Installations render as four DISTINCT style-specific models (bugs report):
// star_base = the style's core station, battlestation = up-armed barbettes,
// star_fortress = bastion ring + more barbettes, defense_platform = the
// batteries-only ground-fed emplacement (previously drawn as a full star base).
import { describe, expect, it } from 'vitest';
import { artClassOf, ART_CLASSES, getShipModel, STYLE_ART, variantsFor, type ShipModel } from '@ui/battle/shipart';

const STYLES = Object.keys(STYLE_ART);
const STATION_CLASSES = ['star_base', 'battlestation', 'star_fortress', 'defense_platform'] as const;

function fingerprint(m: ShipModel): string {
  return `${m.w}x${m.h}:${Buffer.from(m.px).toString('base64')}`;
}

describe('station art', () => {
  it('every style draws four distinct installation models', () => {
    for (const style of STYLES) {
      const models = STATION_CLASSES.map((cls) => getShipModel({ style, cls, variant: 0 }));
      const prints = new Set(models.map(fingerprint));
      expect(prints.size, `style ${style}`).toBe(4);
      for (const [i, m] of models.entries()) {
        expect(m.px.some((p) => p !== 0), `${style}/${STATION_CLASSES[i]} is empty`).toBe(true);
        expect(m.engines.length, `${style}/${STATION_CLASSES[i]} has engines`).toBe(0);
      }
    }
  });

  it('battlestation and star_fortress visibly out-gun the star base (barbettes)', () => {
    for (const style of STYLES) {
      const [base, bs, fort] = (['star_base', 'battlestation', 'star_fortress'] as const).map(
        (cls) => getShipModel({ style, cls, variant: 0 }),
      );
      expect(bs!.guns.length, `style ${style}`).toBeGreaterThan(base!.guns.length);
      expect(fort!.guns.length, `style ${style}`).toBeGreaterThan(bs!.guns.length);
    }
  });

  it('defense_platform resolves from modelKind and has one look per style', () => {
    expect(artClassOf({ hull: 'star_base', hullIdx: 7, isBase: true, modelKind: 'defense_platform' })).toBe('defense_platform');
    // without the marker a base hull keeps its own art class
    expect(artClassOf({ hull: 'star_base', hullIdx: 7, isBase: true })).toBe('star_base');
    expect(ART_CLASSES).toContain('defense_platform');
    expect(variantsFor('defense_platform')).toBe(1);
  });

  it('models are deterministic per (style, class)', () => {
    for (const style of STYLES) {
      const a = fingerprint(getShipModel({ style, cls: 'battlestation', variant: 0 }));
      const b = fingerprint(getShipModel({ style, cls: 'battlestation', variant: 0 }));
      expect(a).toBe(b);
    }
  });
});
