import { test, expect } from '@playwright/test';

const APP = 'http://localhost:4173';

test('diagnose solo persistence in the production bundle', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(`${APP}/`);
  await page.getByTestId('name').fill('Solo');
  await page.getByTestId('solo').click();
  await expect(page.getByTestId('start')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('start').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });
  const memBanner1 = await page.getByTestId('memory-only').count();
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 2', { timeout: 20_000 });
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 3', { timeout: 20_000 });

  await page.waitForTimeout(3000); // generous settle for async persistence

  await page.reload();
  await page.getByTestId('name').fill('Solo');
  await page.getByTestId('solo').click();
  await page.waitForTimeout(5000);
  const turn = await page.getByTestId('turn').textContent().catch(() => 'NO TURN (lobby?)');
  const memBanner2 = await page.getByTestId('memory-only').count();
  console.log('=== RESULT ===');
  console.log('pre-reload memory banner:', memBanner1);
  console.log('post-reload turn:', turn, 'memory banner:', memBanner2);
  console.log('=== BROWSER LOGS ===');
  for (const l of logs) console.log(l);
});
