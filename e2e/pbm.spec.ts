import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Play by mail against the real Go server (started with --pbm-config, shared
// password "moo2"):
//   live game -> save file -> Alice CREATES a PBM room from it, plays her
//   turn, commits, mails in (leave = upload + lock release) -> Bob logs in
//   later, Alice's commit still counts, his commit ADVANCES the turn -> while
//   Bob holds the room, Alice's PBM login joins his live game instead.

const SERVER = 'http://127.0.0.1:8787';

function roomUrl(room: string, name: string): string {
  return `/?server=${encodeURIComponent(SERVER)}&room=${room}&name=${name}&players=2`;
}

/** poll the PBM REST API (also exercises it from outside the app) */
async function waitUnlocked(code: string): Promise<void> {
  const login = await fetch(`${SERVER}/pbm/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'moo2' }),
  });
  const { token } = (await login.json()) as { token: string };
  await expect
    .poll(
      async () => {
        const r = await fetch(`${SERVER}/pbm/rooms/${code}`, { headers: { 'X-PBM-Auth': token } });
        const j = (await r.json()) as { lock: unknown };
        return j.lock ?? null;
      },
      { timeout: 20_000 },
    )
    .toBeNull();
}

async function enterPbm(page: Page, room: string, name: string, password?: string): Promise<void> {
  await page.getByTestId('name').fill(name);
  await page.getByTestId('room').fill(room);
  await page.locator('.pbmbox summary').click();
  if (password) await page.getByTestId('pbm-password').fill(password);
  await page.getByTestId('pbm-enter').click();
}

test('play by mail: create from save, mail turns alternate, live-join when locked', async ({ browser }) => {
  test.setTimeout(180_000);
  const stamp = `${process.pid % 10000}${Math.floor(Math.random() * 1000)}`;
  const room1 = `PL1${stamp}`;
  const pbmRoom = `PM${stamp}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // --- a normal live game produces the save ---
  await a.goto(roomUrl(room1, 'Alice'));
  await expect(a.getByTestId('roster-count')).toHaveText('1 joined', { timeout: 30_000 });
  await b.goto(roomUrl(room1, 'Bob'));
  await expect(a.getByTestId('roster-count')).toHaveText('2 joined', { timeout: 30_000 });
  await b.getByTestId('ready').click();
  await expect(a.getByTestId('start')).toBeEnabled({ timeout: 10_000 });
  await a.getByTestId('start').click();
  await expect(a.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });
  await a.getByTestId('commit').click();
  await b.getByTestId('commit').click();
  await expect(a.getByTestId('turn')).toHaveText('Turn 2', { timeout: 20_000 });

  const downloadDir = mkdtempSync(join(tmpdir(), 'moo2pbm-'));
  const downloadPromise = a.waitForEvent('download');
  await a.getByTestId('save-game').click();
  const download = await downloadPromise;
  const savePath = join(downloadDir, download.suggestedFilename());
  await download.saveAs(savePath);
  await b.getByTestId('leave-room').click(); // Bob is done for today

  // --- Alice creates the PBM game from the save and plays her mail turn ---
  await a.goto(`/?server=${encodeURIComponent(SERVER)}`);
  await a.getByTestId('name').fill('Alice');
  await a.getByTestId('room').fill(pbmRoom);
  await a.getByTestId('load-file').setInputFiles(savePath);
  await expect(a.getByTestId('save-preview')).toContainText('turn 2', { timeout: 15_000 });
  await a.locator('.pbmbox summary').click();
  await a.getByTestId('pbm-password').fill('moo2');
  await a.getByTestId('pbm-enter').click();
  await expect(a.getByTestId('turn')).toHaveText('Turn 2', { timeout: 30_000 });
  await expect(a.getByTestId('pbm-banner')).toBeVisible();

  await a.getByTestId('commit').click();
  // Bob is outstanding: the turn must NOT advance, but progress uploads
  await expect(a.getByTestId('commit')).toContainText('Committed ✓ (1/2)', { timeout: 10_000 });
  await expect(a.getByTestId('turn')).toHaveText('Turn 2');
  await expect(a.getByTestId('pbm-banner')).toContainText('uploaded turn 2', { timeout: 15_000 });
  await a.getByTestId('leave-room').click(); // mail in: final upload + lock release
  await expect(a.locator('.pbmbox summary')).toBeVisible({ timeout: 15_000 });
  await waitUnlocked(pbmRoom); // the lock is released once her upload lands

  // --- Bob's mail session: Alice's commit persisted, his commit advances ---
  await b.goto(`/?server=${encodeURIComponent(SERVER)}`);
  await enterPbm(b, pbmRoom, 'Bob', 'moo2');
  await expect(b.getByTestId('turn')).toHaveText('Turn 2', { timeout: 30_000 });
  await expect(b.getByTestId('my-seat')).toContainText('Bob'); // his own empire, by name
  await expect(b.getByTestId('commit')).toContainText('(1/2)', { timeout: 10_000 }); // Alice already in
  await b.getByTestId('commit').click();
  await expect(b.getByTestId('turn')).toHaveText('Turn 3', { timeout: 20_000 }); // table complete -> advance
  await expect(b.getByTestId('pbm-banner')).toContainText('uploaded turn 3', { timeout: 15_000 });

  // --- Alice logs in while Bob holds the room: she joins his LIVE game ---
  await a.goto(`/?server=${encodeURIComponent(SERVER)}`);
  await enterPbm(a, pbmRoom, 'Alice'); // password remembered from login above
  await expect(a.getByTestId('turn')).toHaveText('Turn 3', { timeout: 30_000 });
  await expect(a.getByTestId('pbm-banner')).toContainText('joined their live game');
  // fully live: both commit, the turn advances for both
  await a.getByTestId('commit').click();
  await b.getByTestId('commit').click();
  await expect(b.getByTestId('turn')).toHaveText('Turn 4', { timeout: 20_000 });
  await expect(a.getByTestId('turn')).toHaveText('Turn 4', { timeout: 20_000 });

  // --- wrong shared password is rejected ---
  const c = await ctxA.newPage();
  await c.goto(`/?server=${encodeURIComponent(SERVER)}`);
  await c.evaluate(() => localStorage.clear());
  await enterPbm(c, pbmRoom, 'Carol', 'wrong-password');
  await expect(c.getByTestId('error')).toContainText(/wrong password/i, { timeout: 15_000 });

  await ctxA.close();
  await ctxB.close();
});
