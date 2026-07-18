import { test, expect } from '@playwright/test';

// Campaign timelapse: opt-in ballot -> the solo bot seconds it -> the engine
// latches ready and resets the ballot -> the client replays the stored log
// and pops the unfogged timelapse viewer for everyone.

test('timelapse ballot completes with bot consent and the viewer plays', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto('/');
  await page.getByTestId('name').fill('Director');
  await page.getByTestId('bot-mode').selectOption('fair');
  await page.getByTestId('solo').click();
  await expect(page.getByTestId('start')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('start').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });

  // a little history to replay
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 2', { timeout: 20_000 });
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 3', { timeout: 20_000 });

  // opt in: the bot has no secrets and immediately seconds the motion,
  // which latches readiness and auto-opens the viewer
  await page.getByTestId('tab-empires').click();
  await page.getByTestId('timelapse-optin').click();
  await expect(page.getByTestId('timelapse-viewer')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('timelapse-turn')).toContainText('/ 3');

  // scrub + close by keyboard
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('timelapse-viewer')).toHaveCount(0);

  // the ballot reset: the table can vote again next session
  await expect(page.getByTestId('timelapse-optin')).toBeVisible();

  await ctx.close();
});
