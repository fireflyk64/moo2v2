import { test, expect, type Page } from '@playwright/test';

// Two real browser contexts, real WebRTC through the local lobbylink server,
// playing the actual game: lobby + race picks -> start -> spreadsheet orders
// -> commit/advance -> hash agreement -> reload-resume mid-game.

const SERVER = 'http://127.0.0.1:8787';

function roomUrl(room: string, name: string): string {
  return `/?server=${encodeURIComponent(SERVER)}&room=${room}&name=${name}&players=2`;
}

async function hashOf(page: Page): Promise<string> {
  return (await page.getByTestId('state-hash').textContent()) ?? '';
}

test('two browsers play real turns: orders, commit, hashes, reload-resume', async ({ browser }) => {
  const room = `E2E${process.pid % 10000}${Math.floor(Math.random() * 1000)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // --- lobby: join, pick races, ready, start ---
  await a.goto(roomUrl(room, 'Alice'));
  await expect(a.getByTestId('roster-count')).toHaveText('1 joined', { timeout: 30_000 });
  await b.goto(roomUrl(room, 'Bob'));
  await expect(a.getByTestId('roster-count')).toHaveText('2 joined', { timeout: 30_000 });

  await a.getByTestId('race-select').selectOption('cerebri');
  await b.getByTestId('race-select').selectOption('hivex');
  await b.getByTestId('ready').click();
  await expect(a.getByTestId('start')).toBeEnabled({ timeout: 10_000 });
  await a.getByTestId('start').click();

  // --- game starts on both, turn 1 ---
  await expect(a.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });
  await expect(b.getByTestId('turn')).toHaveText('Turn 1');
  await expect
    .poll(async () => [await hashOf(a), await hashOf(b)], { timeout: 15_000 })
    .toEqual([await hashOf(a), await hashOf(a)]);

  // --- issue real orders on the colonies spreadsheet ---
  // (housing/trade goods are always buildable regardless of start mode)
  const buildA = a.locator('[data-testid^="build-"]').first();
  await buildA.selectOption('housing');
  const buildB = b.locator('[data-testid^="build-"]').first();
  await buildB.selectOption('trade_goods');

  // set research on both (first available field button)
  await a.getByTestId('tab-research').click();
  await a.locator('[data-testid^="research-"]').first().click();
  await b.getByTestId('tab-research').click();
  await b.locator('[data-testid^="research-"]').first().click();
  await a.getByTestId('tab-colonies').click();
  await b.getByTestId('tab-colonies').click();

  // --- commit both -> turn advances deterministically ---
  await a.getByTestId('commit').click();
  await b.getByTestId('commit').click();
  await expect(a.getByTestId('turn')).toHaveText('Turn 2', { timeout: 20_000 });
  await expect(b.getByTestId('turn')).toHaveText('Turn 2');
  const h2a = await hashOf(a);
  await expect.poll(() => hashOf(b), { timeout: 10_000 }).toBe(h2a);
  expect(h2a).toMatch(/^[0-9a-f]{16}$/);

  // --- another full turn to let production tick ---
  await a.getByTestId('commit').click();
  await b.getByTestId('commit').click();
  await expect(a.getByTestId('turn')).toHaveText('Turn 3', { timeout: 20_000 });
  await expect(b.getByTestId('turn')).toHaveText('Turn 3');

  // --- chat still flows over the same channel ---
  await a.getByTestId('chat-input').fill('gl hf');
  await a.getByTestId('chat-send').click();
  await expect(b.getByTestId('chat-log')).toContainText('gl hf', { timeout: 10_000 });

  // --- reload B: resume token + sqlite + resync must converge ---
  await b.reload();
  await expect(b.getByTestId('turn')).toHaveText('Turn 3', { timeout: 30_000 });
  await expect.poll(() => hashOf(b), { timeout: 15_000 }).toBe(await hashOf(a));

  // orders still work after resume
  await b.getByTestId('commit').click();
  await a.getByTestId('commit').click();
  await expect(a.getByTestId('turn')).toHaveText('Turn 4', { timeout: 20_000 });
  await expect(b.getByTestId('turn')).toHaveText('Turn 4');
  await expect.poll(() => hashOf(b), { timeout: 10_000 }).toBe(await hashOf(a));

  await ctxA.close();
  await ctxB.close();
});
