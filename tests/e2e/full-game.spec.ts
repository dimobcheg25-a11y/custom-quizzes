import { test, expect, type Page, type Browser } from '@playwright/test';

async function joinPlayer(browser: Browser, code: string, name: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/r/${code}`);
  await page.getByLabel("Ваше ім'я").fill(name);
  await page.getByRole('button', { name: 'Увійти в гру' }).click();
  await expect(page.locator('.topbar__code')).toHaveText(code);
  return page;
}

const scoreOf = (page: Page, name: string) => page.locator('.score-row', { hasText: name }).locator('.score-row__score');
const buzzer = (page: Page) => page.getByRole('button', { name: 'Кнопка відповіді' });

test('full game: board for everyone, buzzer, cat, auction, final, reconnect', async ({ browser }) => {
  // ── host creates a room
  const hostCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  await host.goto('/');
  await host.getByRole('radio', { name: /E2E тестовий пак/ }).click();
  await host.getByRole('button', { name: 'Створити кімнату' }).click();
  await expect(host).toHaveURL(/\/host\/[A-Z0-9]{4}$/);
  const code = (await host.locator('.room-code').textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{4}$/);

  // ── three players join
  const anya = await joinPlayer(browser, code, 'Аня');
  const bohdan = await joinPlayer(browser, code, 'Богдан');
  const vika = await joinPlayer(browser, code, 'Віка');
  await expect(host.locator('.lobby-player')).toHaveCount(3);

  // ── duplicate name is rejected with a readable error
  const dupCtx = await browser.newContext();
  const dup = await dupCtx.newPage();
  await dup.goto(`/r/${code}`);
  await dup.getByLabel("Ваше ім'я").fill('аня');
  await dup.getByRole('button', { name: 'Увійти в гру' }).click();
  await expect(dup.getByText("Це ім'я вже зайняте")).toBeVisible();
  await dupCtx.close();

  await host.getByRole('button', { name: /Почати гру/ }).click();

  // ── every player sees the whole board, not just a button
  for (const p of [anya, bohdan, vika]) {
    await expect(p.locator('.board-theme')).toHaveText(['Загальне', 'Музика']);
    await expect(p.locator('.board-cell:not(.is-void)')).toHaveCount(4);
  }

  // ── host picks the first question (host may always pick)
  await host.getByRole('gridcell', { name: 'Загальне, 100' }).click();
  for (const p of [anya, bohdan, vika]) await expect(p.locator('.question-text')).toHaveText('Скільки буде два плюс два?');
  await expect(anya.getByText('Чотири')).toHaveCount(0); // answer hidden from players
  await expect(host.locator('.host-answer__text')).toHaveText('Чотири');

  // ── host opens the buzzer, Bohdan presses first
  await host.getByRole('button', { name: /Відкрити кнопку/ }).click();
  await expect(buzzer(bohdan)).toHaveClass(/buzzer--ready/);
  await buzzer(bohdan).click();
  await expect(host.locator('.host-judge')).toContainText('Богдан');
  await expect(buzzer(bohdan)).toContainText('Ваша відповідь');
  await expect(buzzer(anya)).toContainText('Відповідає Богдан');
  await host.getByRole('button', { name: /^Вірно/ }).click();

  for (const p of [anya, bohdan, vika, host]) {
    await expect(p.locator('.reveal-answer')).toHaveText('Чотири');
    await expect(scoreOf(p, 'Богдан')).toHaveText('100');
  }
  await host.getByRole('button', { name: /^Далі/ }).click();

  // ── reconnect: reload keeps identity and score
  await bohdan.reload();
  await expect(bohdan.locator('.playerbar__value')).toHaveText('100');
  await expect(bohdan.locator('.chooser-note')).toContainText('Ваш вибір');

  // ── the correct answerer chooses next; others cannot
  await expect(anya.getByRole('gridcell', { name: 'Загальне, 200' })).toBeDisabled();
  await bohdan.getByRole('gridcell', { name: 'Загальне, 200' }).click();

  // ── cat in the bag: Bohdan gives it to Vika
  await expect(anya.getByText('Богдан вирішує, кому віддати кота…')).toBeVisible();
  await bohdan.getByRole('button', { name: /Віка/ }).click();
  await expect(vika.locator('.question-head')).toContainText('Кошенята');
  await expect(vika.locator('.question-head')).toContainText('300');
  await expect(buzzer(vika)).toContainText('Ваша відповідь');
  await host.getByRole('button', { name: /^Вірно/ }).click();
  await expect(scoreOf(host, 'Віка')).toHaveText('300');
  await host.getByRole('button', { name: 'Скасувати останній вердикт' }).click(); // host misclicked
  await expect(scoreOf(host, 'Віка')).toHaveText('0');
  await host.getByRole('button', { name: /^Невірно/ }).click();
  await expect(scoreOf(host, 'Віка')).toHaveText('-300');
  await host.getByRole('button', { name: /^Далі/ }).click();

  // ── auction: Bohdan (100) goes all-in at nominal 300; others cannot outbid and are auto-passed
  await bohdan.getByRole('gridcell', { name: 'Загальне, 300' }).click();
  await expect(bohdan.locator('.special-head')).toContainText('Аукціон');
  await bohdan.getByRole('button', { name: /Ва-банк/ }).click();
  for (const p of [anya, vika]) await expect(p.locator('img.media--image')).toBeVisible();
  await expect(host.locator('.host-judge')).toContainText('Богдан');
  await host.getByRole('button', { name: /^Вірно/ }).click();
  await expect(scoreOf(anya, 'Богдан')).toHaveText('400');
  await host.getByRole('button', { name: /^Далі/ }).click();

  // ── audio question: buzzer opens after media (or by host), wrong answer reopens for others
  await bohdan.getByRole('gridcell', { name: 'Музика, 100' }).click();
  await expect(anya.locator('.media--audio')).toBeVisible();
  await expect(buzzer(anya)).toHaveClass(/buzzer--ready/, { timeout: 15_000 });
  await buzzer(vika).click();
  await expect(host.locator('.host-judge')).toContainText('Віка');
  await host.getByRole('button', { name: /^Невірно/ }).click();
  await expect(buzzer(vika)).toContainText('Ви вже відповідали');
  await expect(buzzer(anya)).toHaveClass(/buzzer--ready/);
  await buzzer(anya).click();
  await host.getByRole('button', { name: /^Вірно/ }).click();
  await expect(scoreOf(host, 'Аня')).toHaveText('100');
  await expect(scoreOf(host, 'Віка')).toHaveText('-400');
  await host.getByRole('button', { name: /^Далі/ }).click();

  // ── round end → final
  await expect(host.getByText('Раунд завершено')).toBeVisible();
  await host.getByRole('button', { name: /Наступний раунд/ }).click();

  // Final: Anya (100) and Bohdan (400) play, Vika (-400) does not. Lowest score removes first.
  await expect(vika.getByText('не у фіналі')).toBeVisible();
  await expect(anya.getByText('Ваш хід: приберіть одну тему.')).toBeVisible();
  await anya.getByRole('button', { name: 'Річки' }).click();

  await anya.getByLabel('Ставка').fill('50');
  await anya.getByRole('button', { name: 'Зробити ставку' }).click();
  await bohdan.getByLabel('Ставка').fill('400');
  await bohdan.getByRole('button', { name: 'Зробити ставку' }).click();

  await expect(anya.locator('.question-text')).toHaveText('Столиця України?');
  await anya.getByLabel('Ваша відповідь').fill('Київ');
  await anya.getByRole('button', { name: 'Надіслати' }).click();
  await bohdan.getByLabel('Ваша відповідь').fill('Львів');
  await bohdan.getByRole('button', { name: 'Надіслати' }).click();

  await expect(anya.getByText('Ведучий перевіряє відповіді…')).toBeVisible();
  const entry = (name: string) => host.locator('.host-final li', { hasText: name });
  await expect(entry('Аня')).toContainText('Київ');
  await entry('Аня').getByRole('button', { name: 'Вірно' }).click();
  await entry('Богдан').getByRole('button', { name: 'Ні' }).click();
  await host.getByRole('button', { name: 'Показати результати' }).click();

  await expect(vika.locator('.final-table')).toContainText('Львів');
  await expect(scoreOf(vika, 'Аня')).toHaveText('150');
  await expect(scoreOf(vika, 'Богдан')).toHaveText('0');
  await host.getByRole('button', { name: /Підсумки/ }).click();
  for (const p of [anya, bohdan, vika, host]) await expect(p.getByRole('heading', { name: 'Перемога: Аня' })).toBeVisible();
});

test('false start blocks the buzzer briefly', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage();
  await host.goto('/');
  await host.getByRole('radio', { name: /E2E тестовий пак/ }).click();
  await host.getByRole('button', { name: 'Створити кімнату' }).click();
  const code = (await host.locator('.room-code').textContent())!.trim();
  const p = await joinPlayer(browser, code, 'Тарас');
  await host.getByRole('button', { name: /Почати гру/ }).click();
  await host.getByRole('gridcell', { name: 'Загальне, 100' }).click();
  await expect(buzzer(p)).toContainText('Читаємо питання');
  await p.keyboard.press('Space');
  await expect(buzzer(p)).toContainText('Фальстарт');
});
