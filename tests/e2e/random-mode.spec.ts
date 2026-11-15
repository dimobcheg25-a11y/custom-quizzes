import { test, expect, type Browser, type Page } from '@playwright/test';

async function joinPlayer(browser: Browser, code: string, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/r/${code}`);
  await page.getByLabel("Ваше ім'я").fill(name);
  await page.getByRole('button', { name: 'Увійти в гру' }).click();
  await expect(page.locator('.topbar__code')).toHaveText(code);
  return page;
}
const buzzer = (p: Page) => p.getByRole('button', { name: 'Кнопка відповіді' });

test('draw mode: everyone who presses in the window joins a visible roulette; the drawn player answers', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await host.goto('/');
  await host.getByRole('radio', { name: /E2E тестовий пак/ }).click();
  await host.getByRole('button', { name: 'Створити кімнату' }).click();
  const code = (await host.locator('.room-code').textContent())!.trim();
  const players = [await joinPlayer(browser, code, 'Аня'), await joinPlayer(browser, code, 'Богдан'), await joinPlayer(browser, code, 'Віка')];
  const [anya, bohdan, vika] = players;

  // Settings are open in the lobby: switch to the draw and a 2 s window, 1 s delay.
  await host.getByRole('radio', { name: 'Жеребкування' }).click();
  await expect(host.getByText('Час, щоб теж натиснути')).toBeVisible();
  const windowInput = host.locator('.setting', { hasText: 'Час, щоб теж натиснути' }).locator('input');
  await windowInput.fill('2');
  await windowInput.press('Enter');
  const delayInput = host.locator('.setting', { hasText: 'Затримка перед кнопкою' }).locator('input');
  await delayInput.fill('1');
  await delayInput.press('Enter');
  if (process.env.SHOTS) await host.screenshot({ path: 'test-results/shots/rm-settings.png' });

  await host.getByRole('button', { name: /Почати гру/ }).click();
  await host.getByRole('gridcell', { name: 'Загальне, 100' }).click();

  // Buzzer opens by itself after the 1 s delay.
  await expect(buzzer(anya)).toHaveClass(/buzzer--ready/, { timeout: 3000 });
  await buzzer(anya).click();
  await expect(bohdan.locator('.pressed')).toContainText('Аня');
  await expect(buzzer(bohdan)).toContainText('Встигніть натиснути');
  await expect(buzzer(anya)).toContainText('Ви в жеребкуванні');
  if (process.env.SHOTS) await bohdan.screenshot({ path: 'test-results/shots/rm-window.png' });
  await buzzer(bohdan).click();
  await buzzer(vika).click();

  // Roulette over all three, visible to everyone, then one of them answers.
  for (const p of [host, ...players]) await expect(p.locator('.roulette__slot')).toHaveCount(3);
  if (process.env.SHOTS) {
    await host.waitForTimeout(700);
    await host.screenshot({ path: 'test-results/shots/rm-roulette.png' });
    await expect(host.locator('.roulette__slot.is-winner')).toHaveCount(1, { timeout: 4000 });
    await host.screenshot({ path: 'test-results/shots/rm-winner.png' });
  }
  await expect(host.locator('.host-judge')).toBeVisible({ timeout: 6000 });
  const judgeText = await host.locator('.host-judge').textContent();
  const winner = ['Аня', 'Богдан', 'Віка'].find((n) => judgeText!.includes(n))!;
  expect(winner).toBeTruthy();
  const winnerPage = players[['Аня', 'Богдан', 'Віка'].indexOf(winner)];
  await expect(buzzer(winnerPage)).toContainText('Ваша відповідь');
  await expect(host.locator('.roulette')).toHaveCount(0);
});
