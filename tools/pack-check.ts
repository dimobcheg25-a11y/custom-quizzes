/**
 * Validate a pack folder: schema, media files, sizes, durations, common content mistakes.
 * Usage: npm run pack:check -- packs/<id>      (or several folders; no args = all packs)
 * Exit code 1 when there are errors (warnings do not fail).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PackSchema, type Pack } from '../src/shared/pack';
import { findTool } from './util';

const EXT: Record<string, string[]> = {
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.avif'],
  audio: ['.mp3', '.ogg', '.m4a', '.wav', '.opus', '.aac'],
  video: ['.mp4', '.webm'],
};
const MAX_MB = { image: 3, audio: 6, video: 25 };
const MAX_SEC = { audio: 45, video: 45 };

const ffprobe = findTool('ffprobe');

function duration(file: string): number | null {
  if (!ffprobe) return null;
  try {
    const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const d = parseFloat(out);
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

function check(dir: string): boolean {
  const errors: string[] = [];
  const warns: string[] = [];
  const file = path.join(dir, 'pack.json');
  console.log(`\n▸ ${dir}`);
  if (!fs.existsSync(file)) {
    console.log('  ✗ немає pack.json');
    return false;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`  ✗ pack.json не є валідним JSON: ${(e as Error).message}`);
    return false;
  }
  const parsed = PackSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) console.log(`  ✗ ${i.path.join('.')}: ${i.message}`);
    return false;
  }
  const pack: Pack = parsed.data;
  const used = new Set<string>();
  const answers = new Map<string, string>();
  let mediaCount = 0;
  let totalBytes = 0;

  pack.rounds.forEach((r, ri) => {
    const sizes = new Set(r.themes.map((t) => t.questions.length));
    if (r.type === 'normal' && sizes.size > 1) warns.push(`раунд ${ri + 1} «${r.name}»: різна кількість питань у темах (${[...sizes].join(', ')})`);
    if (r.type === 'normal') {
      const specials = r.themes.flatMap((t) => t.questions).filter((q) => q.type !== 'normal').length;
      if (specials === 0) warns.push(`раунд ${ri + 1} «${r.name}»: немає жодного кота в мішку чи аукціону`);
    }
    r.themes.forEach((t, ti) => {
      if (r.type === 'normal') {
        const prices = t.questions.map((q) => q.price);
        if (prices.some((p, i) => i > 0 && p < prices[i - 1])) warns.push(`«${t.name}»: ціни не за зростанням (${prices.join(', ')})`);
      }
      t.questions.forEach((q, qi) => {
        const where = `р${ri + 1} «${t.name}» #${qi + 1}${q.price ? ` (${q.price})` : ''}`;
        if (q.text.length > 300) warns.push(`${where}: дуже довгий текст (${q.text.length} символів) — важко читати з екрана`);
        if (q.answer.length > 120) warns.push(`${where}: дуже довга відповідь`);
        const key = q.answer.trim().toLowerCase();
        if (answers.has(key)) warns.push(`${where}: відповідь «${q.answer}» повторюється (${answers.get(key)})`);
        else answers.set(key, where);
        if (q.type === 'cat' && !q.catTheme) warns.push(`${where}: кіт у мішку без catTheme — гравці побачать назву поточної теми`);
        if (q.text && q.answer && q.text.toLowerCase().includes(q.answer.toLowerCase()) && q.answer.length > 3)
          warns.push(`${where}: відповідь міститься в тексті питання`);

        for (const [label, m] of [
          ['media', q.media],
          ['answerMedia', q.answerMedia],
        ] as const) {
          if (!m) continue;
          mediaCount++;
          used.add(path.normalize(m.file));
          const abs = path.join(dir, m.file);
          const ext = path.extname(m.file).toLowerCase();
          if (!EXT[m.kind].includes(ext)) errors.push(`${where} ${label}: розширення ${ext} не підходить для ${m.kind}`);
          if (!fs.existsSync(abs)) {
            errors.push(`${where} ${label}: файл не знайдено — ${m.file}`);
            continue;
          }
          const size = fs.statSync(abs).size;
          totalBytes += size;
          if (size === 0) errors.push(`${where} ${label}: порожній файл ${m.file}`);
          const mb = size / 1024 / 1024;
          if (mb > MAX_MB[m.kind]) warns.push(`${where} ${label}: ${m.file} важить ${mb.toFixed(1)} МБ (рекомендовано ≤ ${MAX_MB[m.kind]})`);
          if (m.kind !== 'image') {
            const d = duration(abs);
            if (d === null && ffprobe) errors.push(`${where} ${label}: ffprobe не може прочитати ${m.file}`);
            if (d !== null && d > MAX_SEC[m.kind]) warns.push(`${where} ${label}: ${m.file} триває ${d.toFixed(0)} с (рекомендовано ≤ ${MAX_SEC[m.kind]})`);
          }
        }
      });
    });
  });

  const mediaDir = path.join(dir, 'media');
  if (fs.existsSync(mediaDir)) {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(mediaDir)) {
      const rel = path.normalize(path.relative(dir, f));
      if (!used.has(rel)) warns.push(`зайвий файл, не використовується в паку: ${rel.replace(/\\/g, '/')}`);
    }
  }

  const q = pack.rounds.reduce((n, r) => n + r.themes.reduce((m, t) => m + t.questions.length, 0), 0);
  console.log(`  «${pack.title}»: ${pack.rounds.length} раундів, ${q} питань, ${mediaCount} медіа, ${(totalBytes / 1024 / 1024).toFixed(1)} МБ`);
  if (!ffprobe) console.log('  (ffprobe не знайдено: тривалість аудіо/відео не перевірено)');
  for (const w of warns) console.log(`  ! ${w}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  if (!errors.length) console.log(warns.length ? '  ✓ помилок немає, є попередження' : '  ✓ все добре');
  return errors.length === 0;
}

let dirs = process.argv.slice(2);
if (dirs.length === 0) {
  const root = path.resolve('packs');
  dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join('packs', d.name));
}
const ok = dirs.map(check).every(Boolean);
process.exit(ok ? 0 : 1);
