import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/** Find an executable on PATH or in common Windows install locations (winget links). */
export function findTool(name: 'ffmpeg' | 'ffprobe' | 'yt-dlp' | 'deno'): string | null {
  const env = process.env[name.toUpperCase().replace('-', '_')];
  if (env && fs.existsSync(env)) return env;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim();
    if (out) return out;
  } catch {
    /* not on PATH */
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const links = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', `${name}.exe`);
    if (fs.existsSync(links)) return links;
    const pkgs = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(pkgs)) {
      for (const d of fs.readdirSync(pkgs)) {
        const found = findFile(path.join(pkgs, d), `${name}.exe`, 4);
        if (found) return found;
      }
    }
  }
  return null;
}

function findFile(dir: string, file: string, depth: number): string | null {
  if (depth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === file) return path.join(dir, e.name);
  for (const e of entries) if (e.isDirectory()) {
    const f = findFile(path.join(dir, e.name), file, depth - 1);
    if (f) return f;
  }
  return null;
}

export function requireTool(name: 'ffmpeg' | 'ffprobe' | 'yt-dlp'): string {
  const t = findTool(name);
  if (!t) {
    const id = name === 'yt-dlp' ? 'yt-dlp.yt-dlp' : 'Gyan.FFmpeg';
    console.error(`Не знайдено ${name}. Встановіть: winget install --id ${id} -e   (після встановлення відкрийте новий термінал)`);
    process.exit(2);
  }
  return t;
}

export function run(bin: string, args: string[]) {
  const r = spawnSync(bin, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    console.error(`✗ ${path.basename(bin)} завершився з кодом ${r.status}`);
    process.exit(1);
  }
}

/** "1:23", "01:02:03", "83.5" → seconds */
export function parseTime(t: string): number {
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const parts = t.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) throw new Error(`Невірний час: ${t}`);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function fmtTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
}

export const USER_AGENT = 'SvoyaGraPackTools/1.0 (private quiz pack builder)';
