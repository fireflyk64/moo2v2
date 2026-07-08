import { test, expect, type Page } from '@playwright/test';

// Two real browser contexts, real WebRTC through the local lobbylink server:
// create/join -> lobby -> start -> lockstep submits -> commit/advance ->
// hash agreement -> client reload resumes via resume token + sqlite + resync.

const SERVER = 'http://127.0.0.1:8787';

function roomUrl(room: string, name: string): string {
  return `/?server=${encodeURIComponent(SERVER)}&room=${room}&name=${name}&players=2`;
}

async function counter(page: Page, id: number): Promise<number> {
  return Number(await page.getByTestId(`counter-${id}`).textContent());
}

test('two browsers: lobby, lockstep turns, hash agreement, reload-resume', async ({ browser }) => {
  const room = `E2E${process.pid % 10000}${Math.floor(Math.random() * 1000)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // --- lobby ---
  await a.goto(roomUrl(room, 'Alice'));
  await expect(a.getByTestId('roster-count')).toHaveText('1 joined', { timeout: 30_000 });
  await b.goto(roomUrl(room, 'Bob'));
  await expect(a.getByTestId('roster-count')).toHaveText('2 joined', { timeout: 30_000 });
  await expect(b.getByTestId('roster-count')).toHaveText('2 joined');

  await b.getByTestId('ready').click();
  await expect(a.getByTestId('start')).toBeEnabled({ timeout: 10_000 });
  await a.getByTestId('start').click();

  // --- game starts on both ---
  await expect(a.getByTestId('turn')).toHaveText('1', { timeout: 15_000 });
  await expect(b.getByTestId('turn')).toHaveText('1');
  expect(await a.getByTestId('self-id').textContent()).toBe('0');
  expect(await b.getByTestId('self-id').textContent()).toBe('1');

  // --- submits propagate (optimistic locally, authoritative remotely) ---
  await a.getByTestId('inc1').click();
  await a.getByTestId('inc1').click();
  await b.getByTestId('inc5').click();
  await expect
    .poll(async () => [await counter(a, 0), await counter(a, 1), await counter(b, 0), await counter(b, 1)])
    .toEqual([2, 5, 2, 5]);

  // --- commit both -> turn advances, hashes agree ---
  await a.getByTestId('commit').click();
  await b.getByTestId('commit').click();
  await expect(a.getByTestId('turn')).toHaveText('2', { timeout: 15_000 });
  await expect(b.getByTestId('turn')).toHaveText('2');
  const hashA = await a.getByTestId('state-hash').textContent();
  const hashB = await b.getByTestId('state-hash').textContent();
  expect(hashA).toBe(hashB);
  expect(hashA).toMatch(/^[0-9a-f]{16}$/);

  // --- chat over the same reliable channel ---
  await a.getByTestId('chat-input').fill('gl hf');
  await a.getByTestId('chat-send').click();
  await expect(b.getByTestId('chat-log')).toContainText('gl hf', { timeout: 10_000 });

  // --- client reload: resume token + sqlite + resync converge ---
  await b.reload();
  await expect(b.getByTestId('turn')).toHaveText('2', { timeout: 30_000 });
  await expect.poll(async () => counter(b, 0)).toBe(2);
  await a.getByTestId('inc1').click();
  await expect.poll(async () => counter(b, 0), { timeout: 15_000 }).toBe(3);
  const hashA2 = await a.getByTestId('state-hash').textContent();
  const hashB2 = await b.getByTestId('state-hash').textContent();
  expect(hashA2).toBe(hashB2);

  await ctxA.close();
  await ctxB.close();
});
