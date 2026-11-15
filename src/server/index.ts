import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { Rooms } from './rooms';
import { importZip, listPacks, resolveMedia } from './packs';
import { createCustom, deleteCustom, getCustom, initCustomPacks, isCustomId, listCustom, locateCustomMedia, mimeOf, putCustomMedia, saveCustom } from './custom';
import { store } from './store';
import { GameError } from './game';
import { PLAYER_COLORS } from '../shared/protocol';

const PORT = Number(process.env.PORT ?? 3000);
/** If set, uploading packs requires this key (header x-upload-key). Useful on a public deployment. */
const UPLOAD_KEY = process.env.UPLOAD_KEY;
const CLIENT_DIR = path.resolve('dist/client');
/** Password for the pack editor (header x-editor-key). Falls back to UPLOAD_KEY; with neither set the editor is open (local use). */
const EDITOR_KEY = process.env.EDITOR_KEY || UPLOAD_KEY;
const MAX_MEDIA_BYTES = 300 * 1024 * 1024;

const app = express();
const rooms = new Rooms();

app.get('/api/packs', (_req, res) => {
  res.json({ packs: listPacks(), uploadNeedsKey: !!UPLOAD_KEY });
});

app.post('/api/packs/upload', express.raw({ type: '*/*', limit: '1gb' }), (req, res) => {
  if (UPLOAD_KEY && req.header('x-upload-key') !== UPLOAD_KEY) return res.status(403).json({ error: 'Невірний ключ завантаження' });
  try {
    const info = importZip(req.body as Buffer, String(req.query.name ?? 'pack'));
    res.json({ pack: info });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message.slice(0, 500) });
  }
});

// ───────── pack editor ─────────

const editor = express.Router();
editor.use((req, res, next) => {
  if (EDITOR_KEY && req.header('x-editor-key') !== EDITOR_KEY) return res.status(403).json({ error: 'Невірний пароль редактора' });
  next();
});
const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => {
      console.error('[editor]', e);
      res.status(400).json({ error: (e as Error).message.slice(0, 300) });
    });
const summary = (e: NonNullable<ReturnType<typeof getCustom>>) => {
  const d = (e.draft ?? {}) as { title?: string; rounds?: { themes?: { questions?: unknown[] }[] }[] };
  const questions = (d.rounds ?? []).reduce((n, r) => n + (r.themes ?? []).reduce((m, t) => m + (t.questions?.length ?? 0), 0), 0);
  return { id: e.id, title: d.title || 'Без назви', updatedAt: e.updatedAt, issues: e.issues, playable: !!e.pack, questions };
};
editor.get('/check', (_req, res) => res.json({ ok: true, storage: store.kind }));
editor.get('/packs', (_req, res) => res.json({ packs: listCustom().map(summary) }));
editor.post(
  '/packs',
  express.json({ limit: '2mb' }),
  wrap(async (req, res) => res.json(summary(await createCustom(req.body?.draft ?? { title: 'Новий пак', rounds: [] })))),
);
editor.get('/packs/:id', (req, res) => {
  const e = getCustom(req.params.id);
  if (!e) return res.status(404).json({ error: 'Пак не знайдено' });
  res.json({ id: e.id, draft: e.draft, updatedAt: e.updatedAt });
});
editor.put('/packs/:id', express.json({ limit: '2mb' }), wrap(async (req, res) => res.json(summary(await saveCustom(req.params.id, req.body?.draft)))));
editor.delete(
  '/packs/:id',
  wrap(async (req, res) => {
    await deleteCustom(req.params.id);
    res.json({ ok: true });
  }),
);
editor.put(
  '/packs/:id/media',
  wrap(async (req, res) => {
    const len = Number(req.header('content-length') ?? 0);
    if (!len) throw new Error('Порожній файл');
    if (len > MAX_MEDIA_BYTES) throw new Error('Файл завеликий (максимум 300 МБ)');
    const file = await putCustomMedia(req.params.id, String(req.query.name ?? ''), req);
    res.json({ file });
  }),
);
app.use('/api/editor', editor);

app.post('/api/rooms', express.json(), (req, res) => {
  const packId = String(req.body?.packId ?? '');
  try {
    const room = rooms.create(packId);
    res.json({ code: room.code, hostToken: room.hostToken });
  } catch (e) {
    res.status(400).json({ error: `Не вдалося відкрити пак: ${(e as Error).message.slice(0, 300)}` });
  }
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Кімнату не знайдено' });
  res.json({ code: room.code, packTitle: room.game.pack.title, phase: room.game.phase, players: room.game.players.length });
});

app.get('/api/rooms/:code/avatars/:id', (req, res) => {
  const av = rooms.get(req.params.code)?.game.avatarOf(req.params.id);
  if (!av) return res.status(404).end();
  res.set({ 'content-type': av.mime, 'cache-control': 'public, max-age=86400, immutable' }).send(av.data);
});

app.get('/packs/:id/*', async (req, res) => {
  const rel = (req.params as Record<string, string>)[0];
  if (isCustomId(req.params.id)) {
    try {
      const loc = await locateCustomMedia(req.params.id, rel);
      if (!loc) return res.sendStatus(404);
      if ('url' in loc) return res.redirect(302, loc.url);
      return res.type(mimeOf(rel)).sendFile(loc.file, { maxAge: '7d', immutable: true });
    } catch (e) {
      console.error('[media]', e);
      return res.sendStatus(502);
    }
  }
  const abs = resolveMedia(req.params.id, rel);
  if (!abs) return res.sendStatus(404);
  res.sendFile(abs, { maxAge: '1h' });
});

if (fs.existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|packs\/|ws).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 128 * 1024 });

wss.on('connection', (ws: WebSocket & { alive?: boolean }, req) => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  ws.on('error', (e) => console.warn('socket error:', e.message));
  const url = new URL(req.url ?? '', 'http://x');
  const q = (k: string) => url.searchParams.get(k) ?? '';
  const room = rooms.get(q('code'));
  const fail = (message: string, code = 4001) => {
    ws.send(JSON.stringify({ t: 'error', message, fatal: true }));
    ws.close(code, 'rejected');
  };
  if (!room) return fail('Кімнату не знайдено', 4004);

  if (q('role') === 'host') {
    if (q('token') !== room.hostToken) return fail('Невірний ключ ведучого', 4003);
    return room.attachHost(ws);
  }
  const token = q('token');
  if (token.length < 8) return fail('Невірний токен гравця');
  const color = PLAYER_COLORS.includes(q('color')) ? q('color') : PLAYER_COLORS[0];
  try {
    room.attachPlayer(ws, token, q('name'), color);
  } catch (e) {
    fail(e instanceof GameError ? e.message : 'Не вдалося приєднатися');
  }
});

// Drop dead connections so players show as offline.
setInterval(() => {
  for (const ws of wss.clients as Set<WebSocket & { alive?: boolean }>) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 20_000).unref();

initCustomPacks().catch((e) => console.error('Не вдалося прочитати паки з редактора:', (e as Error).message));

server.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`Квізи від Дімона: http://localhost:${PORT}${lan ? `  (у мережі: http://${lan}:${PORT})` : ''}`);
  if (!fs.existsSync(CLIENT_DIR)) console.log('Клієнт не зібрано: для розробки запустіть `npm run dev` і відкрийте http://localhost:5173');
});
