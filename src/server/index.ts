import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { Rooms } from './rooms';
import { importZip, listPacks, resolveMedia } from './packs';
import { GameError } from './game';
import { PLAYER_COLORS } from '../shared/protocol';

const PORT = Number(process.env.PORT ?? 3000);
/** If set, uploading packs requires this key (header x-upload-key). Useful on a public deployment. */
const UPLOAD_KEY = process.env.UPLOAD_KEY;
const CLIENT_DIR = path.resolve('dist/client');

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

app.get('/packs/:id/*', (req, res) => {
  const rel = (req.params as Record<string, string>)[0];
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

server.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`Квізи від Дімона: http://localhost:${PORT}${lan ? `  (у мережі: http://${lan}:${PORT})` : ''}`);
  if (!fs.existsSync(CLIENT_DIR)) console.log('Клієнт не зібрано: для розробки запустіть `npm run dev` і відкрийте http://localhost:5173');
});
