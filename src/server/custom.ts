/**
 * Packs made in the site editor. Drafts may be incomplete; only drafts that pass PackSchema can be played.
 * All writes go through this server, so an in-memory copy (loaded at startup) is the source for reads.
 */
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { PackSchema, type Pack } from '../shared/pack';
import { store } from './store';

const ROOT = 'custom-packs/';
export const CUSTOM_ID_RE = /^c[0-9a-f]{10}$/;
export const MEDIA_NAME_RE = /^media\/[0-9a-f]{16}\.(jpg|jpeg|png|webp|gif|mp3|m4a|ogg|oga|wav|mp4|webm|mov)$/;

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

export interface CustomEntry {
  id: string;
  draft: unknown;
  updatedAt: number;
  pack?: Pack;
  issues: number;
}

const packs = new Map<string, CustomEntry>();
let ready: Promise<void> | null = null;

function entry(id: string, draft: unknown, updatedAt: number): CustomEntry {
  const r = PackSchema.safeParse(draft);
  return { id, draft, updatedAt, pack: r.success ? r.data : undefined, issues: r.success ? 0 : r.error.issues.length };
}

export function initCustomPacks() {
  ready ??= (async () => {
    const keys = await store.list(ROOT);
    for (const key of keys) {
      const m = key.match(/^custom-packs\/(c[0-9a-f]{10})\/pack\.json$/);
      if (!m) continue;
      try {
        const doc = JSON.parse((await store.get(key))!.toString('utf8'));
        packs.set(m[1], entry(m[1], doc.draft, doc.updatedAt ?? 0));
      } catch (e) {
        console.warn(`custom pack ${m[1]}: cannot read`, (e as Error).message);
      }
    }
    console.log(`Паки з редактора: ${packs.size} (${store.kind === 's3' ? 'хмарне сховище' : 'локальна папка'})`);
  })();
  return ready;
}

export const isCustomId = (id: string) => CUSTOM_ID_RE.test(id);
export const getCustom = (id: string) => packs.get(id);
export const listCustom = () => [...packs.values()].sort((a, b) => b.updatedAt - a.updatedAt);

async function persist(e: CustomEntry) {
  await store.put(`${ROOT}${e.id}/pack.json`, Buffer.from(JSON.stringify({ draft: e.draft, updatedAt: e.updatedAt })), 'application/json');
}

export async function createCustom(draft: unknown): Promise<CustomEntry> {
  let id: string;
  do id = 'c' + crypto.randomBytes(5).toString('hex');
  while (packs.has(id));
  const e = entry(id, draft, Date.now());
  await persist(e);
  packs.set(id, e);
  return e;
}

export async function saveCustom(id: string, draft: unknown): Promise<CustomEntry> {
  if (!packs.has(id)) throw new Error('Пак не знайдено');
  const e = entry(id, draft, Date.now());
  await persist(e);
  packs.set(id, e);
  return e;
}

export async function deleteCustom(id: string) {
  if (!packs.has(id)) return;
  await store.deletePrefix(`${ROOT}${id}/`);
  packs.delete(id);
}

/** Stores an uploaded media file under a random name (names are visible to players, so they must not hint at answers). */
export async function putCustomMedia(id: string, originalName: string, body: Buffer | Readable): Promise<string> {
  if (!packs.has(id)) throw new Error('Пак не знайдено');
  const ext = (originalName.split('.').pop() ?? '').toLowerCase();
  if (!MIME[ext]) throw new Error(`Непідтримуваний тип файлу: .${ext}`);
  const rel = `media/${crypto.randomBytes(8).toString('hex')}.${ext}`;
  await store.put(`${ROOT}${id}/${rel}`, body, MIME[ext]);
  return rel;
}

export async function locateCustomMedia(id: string, rel: string) {
  if (!packs.has(id) || !MEDIA_NAME_RE.test(rel)) return null;
  return store.locate(`${ROOT}${id}/${rel}`);
}

export function mimeOf(rel: string) {
  return MIME[(rel.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream';
}
