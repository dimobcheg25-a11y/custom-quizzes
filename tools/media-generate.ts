/**
 * Generate an image with Gemini and save it into a pack.
 *   npm run media:generate -- "<prompt>" <out.jpg|out.png|out.webp> [--aspect 3:4] [--model gemini-3.1-flash-image] [--ref file.jpg] [--max 1600]
 * Key: GEMINI_API_KEY in the environment or in .env at the repo root.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findTool, run } from './util';

const argv = process.argv.slice(2);
const opts: Record<string, string> = {};
const refs: string[] = [];
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const v = argv[++i];
    if (a === '--ref') refs.push(v);
    else opts[a.slice(2)] = v;
  } else pos.push(a);
}
const [prompt, out] = pos;
if (!prompt || !out) {
  console.error('Використання: npm run media:generate -- "<промпт>" <out.jpg> [--aspect 3:4] [--model ...] [--ref файл] [--max 1600]');
  process.exit(2);
}
const model = opts.model ?? 'gemini-3.1-flash-image';
const aspect = opts.aspect ?? '1:1';
const max = Number(opts.max ?? 1600);

function apiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const envFile = path.resolve('.env');
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, 'utf8').match(/^GEMINI_API_KEY=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('Немає GEMINI_API_KEY (ні у змінних середовища, ні в .env)');
}

function mimeOf(file: string) {
  const e = path.extname(file).toLowerCase();
  return e === '.png' ? 'image/png' : e === '.webp' ? 'image/webp' : 'image/jpeg';
}

async function main() {
  const parts: unknown[] = [{ text: prompt }];
  for (const r of refs) parts.push({ inlineData: { mimeType: mimeOf(r), data: fs.readFileSync(r).toString('base64') } });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } },
    }),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${res.status} ${json?.error?.status ?? ''}: ${json?.error?.message ?? JSON.stringify(json)}`);

  const outParts: any[] = json.candidates?.[0]?.content?.parts ?? [];
  const img = outParts.find((p) => p.inlineData?.data);
  if (!img) {
    const reason = json.candidates?.[0]?.finishReason ?? json.promptFeedback?.blockReason ?? 'невідомо';
    const text = outParts.map((p) => p.text).filter(Boolean).join(' ');
    throw new Error(`Модель не повернула картинку (причина: ${reason})${text ? `: ${text}` : ''}`);
  }

  const raw = Buffer.from(img.inlineData.data, 'base64');
  const tmp = path.join(os.tmpdir(), `svoya-gen-${Date.now()}${img.inlineData.mimeType?.includes('png') ? '.png' : '.jpg'}`);
  fs.writeFileSync(tmp, raw);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

  const outExt = path.extname(out).toLowerCase();
  const ffmpeg = findTool('ffmpeg');
  if (ffmpeg) {
    const q = outExt === '.webp' ? ['-quality', '82'] : outExt === '.png' ? [] : ['-q:v', '3'];
    run(ffmpeg, ['-y', '-loglevel', 'error', '-i', tmp, '-frames:v', '1', '-vf', `scale='min(${max},iw)':-2`, ...q, out]);
  } else {
    fs.copyFileSync(tmp, out);
  }
  fs.rmSync(tmp, { force: true });
  const usage = json.usageMetadata;
  console.log(`✓ ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} КБ, ${model}${usage ? `, токенів: ${usage.totalTokenCount}` : ''})`);
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
