import { test, expect, type Page } from '@playwright/test';

// Full battle flow across two real browsers: war declaration, fleet spawn
// (debug commands), commit -> battle-orders dialog on both sides -> deterministic
// resolution -> replay viewer renders and skips. Hashes must agree throughout.

const SERVER = 'http://127.0.0.1:8787';

function roomUrl(room: string, name: string): string {
  return `/?server=${encodeURIComponent(SERVER)}&room=${room}&name=${name}&players=2&debug=1`;
}

interface SpawnInfo {
  starId: number;
  designId: number;
}

async function submitCmd(page: Page, kind: string, payload: unknown): Promise<void> {
  await page.evaluate(
    ([k, p]) => {
      const hook = (window as unknown as Record<string, { session: { submit: (kind: string, payload: unknown) => { error?: string } } }>)['__moo2']!;
      const res = hook.session.submit(k as string, p);
      if (res.error) throw new Error(`submit ${k}: ${res.error}`);
    },
    [kind, payload] as const,
  );
}

async function hashOf(page: Page): Promise<string> {
  return (await page.getByTestId('state-hash').textContent()) ?? '';
}

test('war, battle orders dialog, deterministic resolve, replay viewer', async ({ browser }) => {
  const room = `BTL${process.pid % 10000}${Math.floor(Math.random() * 1000)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await a.goto(roomUrl(room, 'Ares'));
  await expect(a.getByTestId('roster-count')).toHaveText('1 joined', { timeout: 30_000 });
  await b.goto(roomUrl(room, 'Bree'));
  await expect(a.getByTestId('roster-count')).toHaveText('2 joined', { timeout: 30_000 });
  await b.getByTestId('ready').click();
  await expect(a.getByTestId('start')).toBeEnabled({ timeout: 10_000 });
  await a.getByTestId('start').click();
  await expect(a.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });
  await expect(b.getByTestId('turn')).toHaveText('Turn 1');

  // gather spawn info from A's authoritative state
  const info = await a.evaluate((): { a: SpawnInfo; b: SpawnInfo } => {
    const hook = (window as unknown as Record<string, { session: { getState: () => never } }>)['__moo2']!;
    const gs = hook.session.getState() as {
      colonies: Array<{ owner: number; planetId: number }>;
      planets: Array<{ id: number; starId: number }>;
      empires: Array<{ id: number; designs: Array<{ id: number }> }>;
    };
    const bHome = gs.colonies.find((c) => c.owner === 1)!;
    const starId = gs.planets.find((p) => p.id === bHome.planetId)!.starId;
    return {
      a: { starId, designId: gs.empires.find((e) => e.id === 0)!.designs[0]!.id },
      b: { starId, designId: gs.empires.find((e) => e.id === 1)!.designs[0]!.id },
    };
  });

  // declare war + spawn fleets at B's home system
  await submitCmd(a, 'declare_war', { target: 1 });
  await submitCmd(a, 'debug_spawn_ships', { starId: info.a.starId, designId: info.a.designId, count: 4 });
  await submitCmd(b, 'debug_spawn_ships', { starId: info.b.starId, designId: info.b.designId, count: 3 });

  // relation visible in the Empires tab
  await a.getByTestId('tab-empires').click();
  await expect(a.getByTestId('relation-1')).toContainText('war', { timeout: 10_000 });

  // commit both -> battle orders dialog on both sides
  await a.getByTestId('commit').click();
  await b.getByTestId('commit').click();
  await expect(a.getByTestId('battle-dialog')).toBeVisible({ timeout: 20_000 });
  await expect(b.getByTestId('battle-dialog')).toBeVisible({ timeout: 20_000 });

  // attacker charges + bombards; defender holds range
  await a.getByTestId('battle-stance').selectOption('charge');
  await a.getByTestId('battle-submit').click();
  await expect(a.getByTestId('battle-waiting')).toBeVisible();
  await b.getByTestId('battle-stance').selectOption('hold_range');
  await b.getByTestId('battle-submit').click();

  // resolution: turn advances on both, hashes agree
  await expect(a.getByTestId('turn')).toHaveText('Turn 2', { timeout: 30_000 });
  await expect(b.getByTestId('turn')).toHaveText('Turn 2');
  const hA = await hashOf(a);
  await expect.poll(() => hashOf(b), { timeout: 10_000 }).toBe(hA);

  // replay badge -> watch in the pixi viewer -> skip -> summary
  await expect(a.getByTestId('new-replays')).toBeVisible({ timeout: 10_000 });
  await a.getByTestId('new-replays').click();
  await a.locator('[data-testid^="watch-"]').first().click();
  await expect(a.getByTestId('battle-viewer')).toBeVisible({ timeout: 15_000 });
  await expect(a.locator('[data-testid="battle-viewer"] canvas')).toBeVisible({ timeout: 15_000 });
  await a.getByTestId('battle-skip').click();
  await expect(a.getByTestId('battle-summary')).toBeVisible();
  await a.getByTestId('battle-close').click();

  await ctxA.close();
  await ctxB.close();
});
