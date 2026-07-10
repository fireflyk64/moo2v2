import { test, expect } from '@playwright/test';

// Single player must work as a STANDALONE bundle: this spec runs against the
// production build (vite preview, port 4173) and aborts every request that
// leaves that origin — no lobbylink, no PBM server, no network at all. It
// plays turns against the bot, reloads, and resumes from OPFS persistence.

const APP = 'http://localhost:4173';

test('solo vs bot runs from the production bundle with zero network', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const external: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(APP)) return route.continue();
    external.push(url);
    return route.abort();
  });

  // --- start a solo campaign (fair bot: exercises the non-cheating AI) ---
  await page.goto(`${APP}/`);
  await page.getByTestId('name').fill('Solo');
  await page.getByTestId('bot-mode').selectOption('fair');
  await page.getByTestId('solo').click();

  // the bot readies itself in the in-process lobby; the human starts
  await expect(page.getByTestId('start')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('start').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });

  // persistent storage must be real (no memory-only fallback in the bundle)
  await expect(page.getByTestId('memory-only')).toHaveCount(0);

  // --- the bot commits on its own: human commits alone advance turns ---
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 2', { timeout: 20_000 });
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 3', { timeout: 20_000 });

  // --- reload: the campaign resumes from the browser database ---
  await page.reload();
  await page.getByTestId('name').fill('Solo');
  await page.getByTestId('solo').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 3', { timeout: 30_000 });
  await expect(page.getByTestId('my-seat')).toContainText('Solo');

  // still fully playable after the resume
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 4', { timeout: 20_000 });

  // the whole session touched nothing outside the static origin
  expect(external).toEqual([]);

  await ctx.close();
});
