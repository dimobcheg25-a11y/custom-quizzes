import { test, expect } from '@playwright/test';
import path from 'node:path';

const IMG = path.resolve('tests/fixtures/avatar.png');

test('player uploads a photo on join; everyone sees it; it is remembered for the next room', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage();
  await host.goto('/');
  await host.getByRole('radio', { name: /E2E тестовий пак/ }).click();
  await host.getByRole('button', { name: 'Створити кімнату' }).click();
  const code = (await host.locator('.room-code').textContent())!.trim();

  const anyaCtx = await browser.newContext();
  const anya = await anyaCtx.newPage();
  await anya.goto(`/r/${code}`);
  await anya.getByLabel("Ваше ім'я").fill('Аня');
  await anya.locator('input[type=file]').setInputFiles(IMG);
  await expect(anya.locator('.photo-pick .avatar--photo img')).toBeVisible();
  await anya.getByRole('button', { name: 'Увійти в гру' }).click();

  // The host sees Anya's photo, served by the server.
  const hostImg = host.locator('.lobby-player .avatar--photo img');
  await expect(hostImg).toHaveCount(1);
  await expect(hostImg).toHaveAttribute('src', /\/api\/rooms\/[A-Z0-9]{4}\/avatars\/p\d+\?v=1/);
  expect(await hostImg.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(320);

  // The photo is remembered: a new room gets it automatically.
  await host.goto('/');
  await host.getByRole('radio', { name: /E2E тестовий пак/ }).click();
  await host.getByRole('button', { name: 'Створити кімнату' }).click();
  const code2 = (await host.locator('.room-code').textContent())!.trim();
  await anya.goto(`/r/${code2}`);
  await expect(anya.locator('.photo-pick .avatar--photo img')).toBeVisible();
  await anya.getByRole('button', { name: 'Увійти в гру' }).click();
  await expect(host.locator('.lobby-player .avatar--photo img')).toHaveCount(1);
});
