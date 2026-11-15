import { test, expect, type Browser } from '@playwright/test';
const OUT = process.env.SHOTS_DIR ?? 'test-results/shots';

async function player(browser: Browser, code: string, name: string, mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`/r/${code}`);
  await p.getByLabel("Ваше ім'я").fill(name);
  await p.getByRole('button', { name: 'Увійти в гру' }).click();
  await expect(p.locator('.topbar__code')).toBeVisible();
  return p;
}

test('screenshots', async ({ browser }) => {
  test.skip(!process.env.SHOTS, 'set SHOTS=1 to capture screenshots');
  const host = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await host.goto('/');
  await host.screenshot({ path: `${OUT}/01-home.png` });
  await host.getByRole('radio', { name: /E2E/ }).click();
  await host.getByRole('button', { name: 'Створити кімнату' }).click();
  const code = (await host.locator('.room-code').textContent())!.trim();
  const a = await player(browser, code, 'Аня');
  const b = await player(browser, code, 'Богдан Коваленко');
  const m = await player(browser, code, 'Віка', true);
  await host.screenshot({ path: `${OUT}/02-host-lobby.png` });
  await host.getByRole('button', { name: /Почати гру/ }).click();
  await host.getByRole('button', { name: 'Дії з гравцем' }).first().click();
  await host.getByRole('button', { name: 'Зробити тим, хто обирає' }).click();
  await a.screenshot({ path: `${OUT}/03-player-board-mychoice.png` });
  await b.screenshot({ path: `${OUT}/04-player-board.png` });
  await m.screenshot({ path: `${OUT}/05-mobile-board.png`, fullPage: true });
  await a.getByRole('gridcell', { name: 'Загальне, 100' }).click();
  await b.screenshot({ path: `${OUT}/06-player-question-reading.png` });
  await host.screenshot({ path: `${OUT}/07-host-question.png` });
  await expect(b.locator('.buzzer--ready')).toBeVisible({ timeout: 10000 });
  await b.screenshot({ path: `${OUT}/08-player-buzzer-open.png` });
  await m.screenshot({ path: `${OUT}/09-mobile-question.png`, fullPage: true });
  await b.locator('.buzzer').click();
  await expect(host.locator('.host-judge')).toBeVisible();
  await host.screenshot({ path: `${OUT}/10-host-judge.png` });
  await b.screenshot({ path: `${OUT}/11-player-answering.png` });
  await host.getByRole('button', { name: /^Вірно/ }).click();
  await a.screenshot({ path: `${OUT}/12-reveal.png` });
  await host.getByRole('button', { name: /^Далі/ }).click();
  await b.getByRole('gridcell', { name: 'Загальне, 300' }).click();
  await b.screenshot({ path: `${OUT}/13-auction.png` });
  await b.getByRole('button', { name: /Ва-банк/ }).click();
  await a.screenshot({ path: `${OUT}/14-image-question.png` });
});
