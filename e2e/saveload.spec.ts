import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The full host save/load cycle across rooms and browsers:
//   play in room 1 -> host downloads a binary save -> host loads it into a
//   fresh room -> the game resumes hash-identical -> a client rejoins the new
//   room and play continues.

const SERVER = 'http://127.0.0.1:8787';

function roomUrl(room: string, name: string): string {
  return `/?server=${encodeURIComponent(SERVER)}&room=${room}&name=${name}&players=2`;
}

async function hashOf(page: Page): Promise<string> {
  return (await page.getByTestId('state-hash').textContent()) ?? '';
}

test('host saves a binary file, re-hosts it in a new room, client rejoins', async ({ browser }) => {
  const stamp = `${process.pid % 10000}${Math.floor(Math.random() * 1000)}`;
  const room1 = `SV1${stamp}`;
  const room2 = `SV2${stamp}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // --- play a bit in room 1 ---
  await a.goto(roomUrl(room1, 'Alice'));
  await expect(a.getByTestId('roster-count')).toHaveText('1 joined', { timeout: 30_000 });
  await b.goto(roomUrl(room1, 'Bob'));
  await expect(a.getByTestId('roster-count')).toHaveText('2 joined', { timeout: 30_000 });
  await b.getByTestId('ready').click();
  await expect(a.getByTestId('start')).toBeEnabled({ timeout: 10_000 });
  await a.getByTestId('start').click();
  await expect(a.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });

  await a.locator('[data-testid^="build-"]').first().selectOption('housing');
  await a.getByTestId('commit').click();
  await b.getByTestId('commit').click();
  await expect(a.getByTestId('turn')).toHaveText('Turn 2', { timeout: 20_000 });
  await expect(b.getByTestId('turn')).toHaveText('Turn 2');
  const savedHash = await hashOf(a);
  expect(savedHash).toMatch(/^[0-9a-f]{16}$/);

  // --- host downloads the save file ---
  const downloadDir = mkdtempSync(join(tmpdir(), 'moo2save-'));
  const downloadPromise = a.waitForEvent('download');
  await a.getByTestId('save-game').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^moo2v2-.*turn2\.moo2save$/);
  const savePath = join(downloadDir, download.suggestedFilename());
  await download.saveAs(savePath);
  await expect(a.getByTestId('save-note')).toContainText('saved', { timeout: 10_000 });

  // --- host loads it into a brand-new room (fresh page, no auto-join params) ---
  await a.goto(`/?server=${encodeURIComponent(SERVER)}`);
  await a.getByTestId('name').fill('Alice');
  await a.getByTestId('room').fill(room2);
  await a.getByTestId('load-file').setInputFiles(savePath);
  // the save is verified and previewed (turn + resume options), then loaded
  await expect(a.getByTestId('save-preview')).toContainText('turn 2', { timeout: 15_000 });
  await a.getByTestId('confirm-load').click();
  await expect(a.getByTestId('turn')).toHaveText('Turn 2', { timeout: 30_000 });
  await expect.poll(() => hashOf(a), { timeout: 15_000 }).toBe(savedHash);

  // --- the other player joins the new room and resyncs to the same state ---
  await b.goto(roomUrl(room2, 'Bob'));
  await expect(b.getByTestId('turn')).toHaveText('Turn 2', { timeout: 30_000 });
  await expect.poll(() => hashOf(b), { timeout: 15_000 }).toBe(savedHash);

  // --- the resumed game is fully live: play another round ---
  await a.getByTestId('commit').click();
  await b.getByTestId('commit').click();
  await expect(a.getByTestId('turn')).toHaveText('Turn 3', { timeout: 20_000 });
  await expect(b.getByTestId('turn')).toHaveText('Turn 3');
  await expect.poll(() => hashOf(b), { timeout: 10_000 }).toBe(await hashOf(a));

  // --- ANY player can save, not just the host: the client downloads a save
  // mid-game and re-hosts it — name matching hands them their own empire ---
  const hashT3 = await hashOf(b);
  const bDownload = b.waitForEvent('download');
  await b.getByTestId('save-game').click();
  const bSave = await bDownload;
  expect(bSave.suggestedFilename()).toMatch(/turn3\.moo2save$/);
  const bSavePath = join(downloadDir, `client-${bSave.suggestedFilename()}`);
  await bSave.saveAs(bSavePath);
  await expect(b.getByTestId('save-note')).toContainText('saved', { timeout: 10_000 });
  await b.goto(`/?server=${encodeURIComponent(SERVER)}`);
  await b.getByTestId('name').fill('Bob');
  await b.getByTestId('room').fill(`SV4${stamp}`);
  await b.getByTestId('load-file').setInputFiles(bSavePath);
  await expect(b.getByTestId('save-preview')).toContainText('turn 3', { timeout: 15_000 });
  await b.getByTestId('confirm-load').click();
  await expect(b.getByTestId('turn')).toHaveText('Turn 3', { timeout: 30_000 });
  await expect.poll(() => hashOf(b), { timeout: 15_000 }).toBe(hashT3);
  await expect(b.getByTestId('my-seat')).toContainText('Bob'); // his empire, seat 1

  // --- a corrupted file is rejected with a clear error ---
  const badPath = join(downloadDir, 'corrupt.moo2save');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const bytes = readFileSync(savePath);
  bytes[20] = (bytes[20] ?? 0) ^ 0xff;
  writeFileSync(badPath, bytes);
  await b.goto(`/?server=${encodeURIComponent(SERVER)}`);
  await b.getByTestId('name').fill('Bob');
  await b.getByTestId('room').fill(`SV3${stamp}`);
  await b.getByTestId('load-file').setInputFiles(badPath);
  await expect(b.getByTestId('error')).toContainText(/corrupted|mismatch|failed/, { timeout: 15_000 });

  await ctxA.close();
  await ctxB.close();
});
