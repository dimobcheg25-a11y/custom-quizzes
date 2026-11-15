/**
 * Cut a short clip (video or audio) or grab a single frame from a YouTube/any yt-dlp URL or a local file.
 *
 *   npm run media:clip -- <url|file> <start> <end> <out.mp4>            video clip, 720p max, loudness-normalized
 *   npm run media:clip -- <url|file> <start> <end> <out.mp3>            audio only (guess the melody)
 *   npm run media:clip -- <url|file> <start> <end> <out.mp4> --mute     video without sound
 *   npm run media:clip -- <url|file> <time>  -     <out.jpg>            single frame (guess the movie by a still)
 *
 * Times: 83, 1:23, 01:01:23.5. Downloads are cached in .media-cache/.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findTool, fmtTime, parseTime, requireTool, run } from './util';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [src, startArg, endArg, out] = args.filter((a) => !a.startsWith('--'));
if (!src || !startArg || !endArg || !out) {
  console.error('Використання: npm run media:clip -- <url|файл> <початок> <кінець|-> <out.mp4|out.mp3|out.jpg> [--mute]');
  process.exit(2);
}

const ffmpeg = requireTool('ffmpeg');
const ext = path.extname(out).toLowerCase();
const start = parseTime(startArg);
const isFrame = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
const end = isFrame ? start + 1 : parseTime(endArg);
if (!isFrame && end <= start) throw new Error('Кінець має бути пізніше за початок');
const dur = end - start;
if (dur > 60) console.warn(`! Кліп триває ${dur.toFixed(0)} с — для питання зазвичай вистачає 10–30 с`);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

/** Get a local file containing at least [start-2, end+2] of the source. */
function fetchSection(): { file: string; offset: number } {
  if (fs.existsSync(src)) return { file: src, offset: 0 };
  const ytdlp = requireTool('yt-dlp');
  const cacheDir = path.resolve('.media-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const from = Math.max(0, start - 2);
  const to = end + 2;
  const audioOnly = ext === '.mp3' || ext === '.m4a' || ext === '.ogg';
  const key = crypto.createHash('sha1').update(`${src}|${from}|${to}|${audioOnly}`).digest('hex').slice(0, 16);
  const existing = fs.readdirSync(cacheDir).find((f) => f.startsWith(key + '.'));
  if (existing) return { file: path.join(cacheDir, existing), offset: from };
  const format = audioOnly ? 'ba/b' : 'bv*[height<=720]+ba/b[height<=720]/b';
  run(ytdlp, [
    '--no-playlist',
    '--quiet',
    '--progress',
    '-f',
    format,
    '--download-sections',
    `*${fmtTime(from)}-${fmtTime(to)}`,
    '--force-keyframes-at-cuts',
    '--ffmpeg-location',
    path.dirname(ffmpeg),
    // YouTube needs a JS runtime for some formats; pass deno explicitly in case it is not on PATH yet.
    ...(findTool('deno') ? ['--js-runtimes', `deno:${findTool('deno')}`] : []),
    '-o',
    path.join(cacheDir, `${key}.%(ext)s`),
    src,
  ]);
  const got = fs.readdirSync(cacheDir).find((f) => f.startsWith(key + '.') && !f.endsWith('.part'));
  if (!got) throw new Error('yt-dlp нічого не завантажив');
  return { file: path.join(cacheDir, got), offset: from };
}

const { file, offset } = fetchSection();
const ss = String(Math.max(0, start - offset));
const fadeOut = Math.max(0, dur - 0.6).toFixed(2);

if (isFrame) {
  run(ffmpeg, ['-y', '-loglevel', 'error', '-ss', ss, '-i', file, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2", '-q:v', '3', out]);
} else if (ext === '.mp3' || ext === '.m4a' || ext === '.ogg') {
  const codec = ext === '.mp3' ? ['-c:a', 'libmp3lame', '-b:a', '160k'] : ext === '.ogg' ? ['-c:a', 'libvorbis', '-q:a', '5'] : ['-c:a', 'aac', '-b:a', '160k'];
  run(ffmpeg, [
    '-y', '-loglevel', 'error', '-ss', ss, '-t', String(dur), '-i', file, '-vn',
    '-af', `afade=t=in:d=0.3,afade=t=out:st=${fadeOut}:d=0.6,loudnorm=I=-16:TP=-1.5:LRA=11`,
    ...codec, out,
  ]);
} else if (ext === '.mp4' || ext === '.webm') {
  const audio = flags.has('--mute')
    ? ['-an']
    : ['-af', `afade=t=in:d=0.3,afade=t=out:st=${fadeOut}:d=0.6,loudnorm=I=-16:TP=-1.5:LRA=11`, '-c:a', ext === '.webm' ? 'libopus' : 'aac', '-b:a', '128k'];
  const video = ext === '.webm' ? ['-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  run(ffmpeg, ['-y', '-loglevel', 'error', '-ss', ss, '-t', String(dur), '-i', file, '-vf', "scale=-2:'min(720,ih)'", ...video, ...audio, out]);
} else {
  console.error(`Невідомий формат ${ext}: використовуйте .mp4, .webm, .mp3, .m4a, .ogg, .jpg, .png`);
  process.exit(2);
}

const kb = fs.statSync(out).size / 1024;
console.log(`✓ ${out} (${kb > 1024 ? (kb / 1024).toFixed(1) + ' МБ' : kb.toFixed(0) + ' КБ'}${isFrame ? '' : `, ${dur.toFixed(1)} с`})`);
