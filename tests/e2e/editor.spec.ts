import { test, expect } from '@playwright/test';
import path from 'node:path';

test('editor: build a pack by hand with an image, then host a game with it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Редактор паків' }).click();
  await expect(page).toHaveURL(/\/editor$/);
  await page.getByRole('button', { name: '+ Новий пак' }).click();
  await expect(page).toHaveURL(/\/editor\/c[0-9a-f]{10}$/);

  // Not playable yet: the issues list says what is missing.
  await expect(page.locator('.editor-issues')).toContainText('Щоб грати');
  await expect(page.getByRole('button', { name: 'Грати цим паком' })).toBeDisabled();

  await page.getByLabel('Назва паку').fill('Мій ручний пак');
  await page.getByLabel('Тема 1').fill('Тварини');

  // Keep one question in the theme: delete four of the five blank ones.
  const rows = page.locator('.editor-q');
  for (let i = 0; i < 4; i++) {
    await rows.last().locator('.editor-q__head').click();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Видалити питання' }).click();
  }
  await expect(rows).toHaveCount(1);

  await rows.first().locator('.editor-q__head').click();
  await page.getByLabel('Питання', { exact: true }).fill('Хто на фото?');
  await page.locator('.media-field').first().locator('input[type=file]').setInputFiles(path.resolve('tests/fixtures/avatar.png'));
  await expect(page.locator('.media-field__preview').first()).toBeVisible();
  expect(await page.locator('.media-field__preview').first().evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  await page.getByLabel('Відповідь', { exact: true }).fill('Кіт');

  await expect(page.locator('.editor-issues')).toContainText('Пак готовий до гри');
  await expect(page.locator('.editor-save')).toHaveText('Збережено');

  // Survives a reload (saved on the server).
  await page.reload();
  await expect(page.getByLabel('Назва паку')).toHaveValue('Мій ручний пак');
  await expect(page.locator('.editor-q__answer').first()).toHaveText('Кіт');

  // Appears on the home page with the "мій" badge, and can be played.
  await page.goto('/');
  await expect(page.getByRole('radio', { name: /Мій ручний пак/ })).toContainText('мій');
  await page.goto(page.url().replace(/\/$/, '') + '/editor');
  await page.locator('.editor-pack__main', { hasText: 'Мій ручний пак' }).click();
  await page.getByRole('button', { name: 'Грати цим паком' }).click();
  await expect(page).toHaveURL(/\/host\/[A-Z0-9]{4}$/);
  await expect(page.locator('.room-code')).toBeVisible();
});
