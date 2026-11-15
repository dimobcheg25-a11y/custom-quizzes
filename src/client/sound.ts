import type { GameEvent } from '../shared/protocol';
import { storage } from './net';

let ctx: AudioContext | null = null;
let muted = storage.get('muted') === '1';

export function isMuted() {
  return muted;
}
export function setMuted(m: boolean) {
  muted = m;
  storage.set('muted', m ? '1' : '0');
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.12) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t = ctx.currentTime + start;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Call from a user gesture once so browsers allow audio. */
export function unlockAudio() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
}

export function playSfx(e: GameEvent | 'tick') {
  if (muted) return;
  if (!ctx) ctx = new AudioContext();
  switch (e) {
    case 'buzz':
      tone(880, 0, 0.12, 'square', 0.06);
      tone(1320, 0.08, 0.18, 'square', 0.05);
      break;
    case 'correct':
      tone(660, 0, 0.15);
      tone(880, 0.12, 0.15);
      tone(1100, 0.24, 0.3);
      break;
    case 'wrong':
      tone(220, 0, 0.35, 'sawtooth', 0.06);
      tone(165, 0.15, 0.4, 'sawtooth', 0.06);
      break;
    case 'false_start':
      tone(180, 0, 0.12, 'square', 0.05);
      break;
    case 'timeout':
      tone(440, 0, 0.2, 'triangle');
      tone(330, 0.2, 0.35, 'triangle');
      break;
    case 'round_start':
      tone(523, 0, 0.15);
      tone(659, 0.15, 0.15);
      tone(784, 0.3, 0.3);
      break;
    case 'question':
      tone(740, 0, 0.1, 'triangle', 0.08);
      break;
    case 'tick':
      tone(1000, 0, 0.04, 'square', 0.03);
      break;
  }
}
