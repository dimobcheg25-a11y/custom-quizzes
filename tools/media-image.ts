/**
 * Download (or copy) an image into a pack and shrink it.
 *   npm run media:image -- <url|file> <out.jpg|out.webp|out.png> [--max 1600]
 * Without ffmpeg the file is saved as is (format must then match the extension).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findTool, run, USER_AGENT } from './util';

const args = process.argv.slice(2);
const maxIdx = args.indexOf('--max');
const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 1600;
const [src, out] = args.filter((a, i) => !a.startsWith('--') && (maxIdx < 0 || i !== maxIdx + 1));
if (!src || !out) {
  console.error('Використання: npm run media:image -- <url|файл> <out.jpg> [--max 1600]');
  process.exit(2);
}

async function main() {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  let input = src;
  if (!fs.existsSync(src)) {
    const res = await fetch(src, { headers: { 'user-agent': USER_AGENT, accept: 'image/*' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} для ${src}`);
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) throw new Error(`Це не картинка (content-type: ${type || 'невідомо'}). Потрібне пряме посилання на файл.`);
    const buf = Buffer.from(await res.arrayBuffer());
    input = path.join(os.tmpdir(), `svoya-img-${Date.now()}${extFromType(type)}`);
    fs.writeFileSync(input, buf);
  }
  const outExt = path.extname(out).toLowerCase();
  const ffmpeg = findTool('ffmpeg');
  if (ffmpeg && outExt !== '.svg' && outExt !== '.gif') {
    const q = outExt === '.webp' ? ['-quality', '82'] : outExt === '.png' ? [] : ['-q:v', '3'];
    run(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-frames:v', '1', '-vf', `scale='min(${max},iw)':-2`, ...q, out]);
  } else {
    if (!ffmpeg) console.warn('! ffmpeg не знайдено: зберігаю без стиснення');
    fs.copyFileSync(input, out);
  }
  if (input !== src) fs.rmSync(input, { force: true });
  console.log(`✓ ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} КБ)`);
}

function extFromType(t: string) {
  if (t.includes('png')) return '.png';
  if (t.includes('webp')) return '.webp';
  if (t.includes('gif')) return '.gif';
  if (t.includes('svg')) return '.svg';
  return '.jpg';
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
