import { describe, expect, it } from 'vitest';
import { ART_CLASSES, getShipModel, variantsFor, type ArtClass, type ShipModel } from '@ui/battle/shipart';

/** sizes of the 4-connected components of non-empty pixels, largest first */
function componentSizes(m: ShipModel): number[] {
  const seen = new Uint8Array(m.w * m.h);
  const sizes: number[] = [];
  for (let i = 0; i < m.px.length; i++) {
    if (m.px[i] === 0 || seen[i]) continue;
    let size = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % m.w;
      const y = (j / m.w) | 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
        const nj = ny * m.w + nx;
        if (m.px[nj] !== 0 && !seen[nj]) {
          seen[nj] = 1;
          stack.push(nj);
        }
      }
    }
    sizes.push(size);
  }
  return sizes.sort((a, b) => b - a);
}

function dump(m: ShipModel): string {
  const glyphs = '.#=+*oxn'; // R_EMPTY..R_NOZZLE
  let out = '';
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) out += glyphs[m.px[y * m.w + x]!] ?? '?';
    out += '\n';
  }
  return out;
}

describe('crescent ship models are 4-connected', () => {
  for (const cls of ART_CLASSES) {
    for (let variant = 0; variant < variantsFor(cls as ArtClass); variant++) {
      it(`crescent/${cls}/v${variant} is a single connected component`, () => {
        const m = getShipModel({ style: 'crescent', cls: cls as ArtClass, variant });
        const sizes = componentSizes(m);
        expect(sizes.length, `disconnected (components ${sizes.join(',')}):\n${dump(m)}`).toBe(1);
      });
    }
  }
});
