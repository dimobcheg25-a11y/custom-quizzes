import { test, expect } from '@playwright/test';
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';

const PACKS = path.resolve('tests/fixtures/packs');

test('zip upload: valid pack is imported, zip-slip and missing media are rejected', async ({ request }) => {
  const good = new AdmZip();
  good.addLocalFolder(path.join(PACKS, 'e2e'), 'Мій пак');
  const r1 = await request.post('/api/packs/upload?name=x.zip', { data: good.toBuffer(), headers: { 'content-type': 'application/zip' } });
  expect(r1.ok()).toBe(true);
  const { pack } = await r1.json();
  try {
    expect(pack.id).toBe('mii-pak');
    expect(pack.questions).toBe(6);
    const list = await (await request.get('/api/packs')).json();
    expect(list.packs.map((p: { id: string }) => p.id)).toContain('mii-pak');
    expect((await request.get('/packs/mii-pak/media/shape.svg')).ok()).toBe(true);
  } finally {
    fs.rmSync(path.join(PACKS, pack.id), { recursive: true, force: true });
  }

  const evil = new AdmZip();
  evil.addFile('pack.json', fs.readFileSync(path.join(PACKS, 'e2e', 'pack.json')));
  evil.addFile('media/shape.svg', Buffer.from('<svg/>'));
  evil.addFile('media/melody.wav', Buffer.from('x'));
  evil.getEntries()[2].entryName = '../../evil.txt';
  const r2 = await request.post('/api/packs/upload?name=evil.zip', { data: evil.toBuffer() });
  expect(r2.status()).toBe(400);
  expect(fs.existsSync(path.resolve('tests/evil.txt'))).toBe(false);

  const missing = new AdmZip();
  missing.addFile('pack.json', fs.readFileSync(path.join(PACKS, 'e2e', 'pack.json')));
  const r3 = await request.post('/api/packs/upload?name=m.zip', { data: missing.toBuffer() });
  expect(r3.status()).toBe(400);
  expect((await r3.json()).error).toContain('бракує файлів');
  expect(fs.readdirSync(PACKS).filter((d) => d !== 'e2e')).toEqual([]);
});
