import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { PackSchema, packMediaFiles, type Pack } from '../shared/pack';
import { getCustom, isCustomId, listCustom } from './custom';

export const PACKS_DIR = path.resolve(process.env.PACKS_DIR ?? 'packs');
fs.mkdirSync(PACKS_DIR, { recursive: true });

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface PackInfo {
  id: string;
  title: string;
  author?: string;
  description?: string;
  rounds: number;
  questions: number;
  error?: string;
  /** Made in the site editor. */
  custom?: boolean;
}

interface Cached {
  mtimeMs: number;
  pack: Pack;
  media: Set<string>;
}
const cache = new Map<string, Cached>();

export function loadPack(id: string): Pack {
  if (isCustomId(id)) {
    const e = getCustom(id);
    if (!e) throw new Error('Пак не знайдено');
    if (!e.pack) throw new Error('Пак ще не заповнено до кінця — відкрийте його в редакторі');
    return e.pack;
  }
  return loadCached(id).pack;
}

const countQuestions = (p: Pack) => p.rounds.reduce((n, r) => n + r.themes.reduce((m, t) => m + t.questions.length, 0), 0);

function loadCached(id: string): Cached {
  if (!ID_RE.test(id)) throw new Error('Невірний ідентифікатор паку');
  const file = path.join(PACKS_DIR, id, 'pack.json');
  const stat = fs.statSync(file);
  const hit = cache.get(id);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pack = PackSchema.parse(raw);
  const entry = { mtimeMs: stat.mtimeMs, pack, media: new Set(packMediaFiles(pack)) };
  cache.set(id, entry);
  return entry;
}

export function listPacks(): PackInfo[] {
  const out: PackInfo[] = [];
  for (const d of fs.readdirSync(PACKS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || !ID_RE.test(d.name)) continue;
    if (!fs.existsSync(path.join(PACKS_DIR, d.name, 'pack.json'))) continue;
    try {
      const p = loadPack(d.name);
      out.push({
        id: d.name,
        title: p.title,
        author: p.author,
        description: p.description,
        rounds: p.rounds.length,
        questions: countQuestions(p),
      });
    } catch (e) {
      out.push({ id: d.name, title: d.name, rounds: 0, questions: 0, error: (e as Error).message.slice(0, 300) });
    }
  }
  out.sort((a, b) => a.title.localeCompare(b.title, 'uk'));
  const custom = listCustom()
    .filter((e) => e.pack)
    .map((e) => ({ id: e.id, title: e.pack!.title, author: e.pack!.author, description: e.pack!.description, rounds: e.pack!.rounds.length, questions: countQuestions(e.pack!), custom: true }));
  return [...custom, ...out];
}

/** Absolute path of a media file, only if the pack references it (pack.json and other files are never served). */
export function resolveMedia(id: string, rel: string): string | null {
  try {
    const { media } = loadCached(id);
    if (!media.has(rel)) return null;
    const abs = path.resolve(PACKS_DIR, id, rel);
    if (!abs.startsWith(path.resolve(PACKS_DIR, id) + path.sep)) return null;
    return fs.existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

/** Import a zipped pack folder. pack.json may be at the zip root or inside one top-level folder. */
export function importZip(buf: Buffer, nameHint: string): PackInfo {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !e.entryName.startsWith('__MACOSX/'));
  const packEntry = entries.find((e) => /(^|\/)pack\.json$/.test(e.entryName) && e.entryName.split('/').length <= 2);
  if (!packEntry) throw new Error('У архіві немає pack.json');
  const prefix = packEntry.entryName.slice(0, -'pack.json'.length);
  const pack = PackSchema.parse(JSON.parse(packEntry.getData().toString('utf8')));

  const base = slug(prefix.replace(/\/$/, '') || nameHint.replace(/\.zip$/i, '') || pack.title);
  let id = base;
  for (let i = 2; fs.existsSync(path.join(PACKS_DIR, id)); i++) id = `${base}-${i}`;
  const dir = path.join(PACKS_DIR, id);
  const tmp = `${dir}.tmp-${Date.now()}`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const e of entries) {
      if (!e.entryName.startsWith(prefix)) continue;
      const rel = e.entryName.slice(prefix.length);
      const target = path.resolve(tmp, rel);
      if (!target.startsWith(path.resolve(tmp) + path.sep)) throw new Error(`Небезпечний шлях в архіві: ${e.entryName}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.getData());
    }
    const missing = packMediaFiles(pack).filter((f) => !fs.existsSync(path.join(tmp, f)));
    if (missing.length) throw new Error(`В архіві бракує файлів: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
    fs.renameSync(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return listPacks().find((p) => p.id === id)!;
}

function slug(s: string) {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l',
    м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu',
    я: 'ia', ы: 'y', э: 'e', ъ: '', ё: 'e',
  };
  const out = s
    .toLowerCase()
    .split('')
    .map((c) => map[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return out || 'pack';
}
