import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { GameView, PlayerView } from '../shared/protocol';
import { useTicker } from './net';

export const findPlayer = (s: GameView, id?: string) => (id ? s.players.find((p) => p.id === id) : undefined);
export const playerName = (s: GameView, id?: string) => findPlayer(s, id)?.name ?? '—';

export function Avatar({ p, size = 32 }: { p: Pick<PlayerView, 'name' | 'color'>; size?: number }) {
  const initials = p.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="avatar" style={{ background: p.color, width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {initials}
    </span>
  );
}

export function formatScore(n: number) {
  return n.toLocaleString('uk-UA').replace(/ /g, ' ');
}

/** Thin bar that empties until `deadline` (server ms). */
export function TimeBar({ deadline, total, serverNow, tone = 'accent' }: { deadline?: number; total: number; serverNow: () => number; tone?: 'accent' | 'muted' }) {
  useTicker(!!deadline, 100);
  if (!deadline) return <div className="timebar timebar--empty" />;
  const left = Math.max(0, deadline - serverNow());
  const pct = Math.min(100, (left / total) * 100);
  return (
    <div className={`timebar timebar--${tone}`} role="progressbar" aria-valuenow={Math.ceil(left / 1000)}>
      <div className="timebar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Countdown({ deadline, serverNow }: { deadline?: number; serverNow: () => number }) {
  useTicker(!!deadline, 200);
  if (!deadline) return null;
  const s = Math.max(0, Math.ceil((deadline - serverNow()) / 1000));
  return <span className={`countdown ${s <= 3 ? 'countdown--low' : ''}`}>{s}</span>;
}

export function Button({
  children,
  variant = 'default',
  size,
  hotkey,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'good' | 'bad' | 'ghost'; size?: 'lg' | 'sm'; hotkey?: string }) {
  return (
    <button
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        e.currentTarget.blur(); // Space is a game hotkey; a focused button would be clicked again
      }}
      className={`btn btn--${variant} ${size ? `btn--${size}` : ''} ${rest.className ?? ''}`}
    >
      {children}
      {hotkey && <kbd>{hotkey}</kbd>}
    </button>
  );
}

export function Toasts({ items }: { items: { id: number; text: string; tone?: 'bad' | 'info' }[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone ?? 'info'}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function useToasts() {
  const [items, setItems] = useState<{ id: number; text: string; tone?: 'bad' | 'info' }[]>([]);
  const n = useRef(0);
  const push = (text: string, tone?: 'bad' | 'info') => {
    const id = ++n.current;
    setItems((x) => [...x.slice(-3), { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 3500);
  };
  return { items, push };
}

/** Global keyboard shortcut, ignored while typing in inputs. */
export function useHotkey(key: string, fn: () => void, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (t.tagName === 'BUTTON' && e.code === 'Space') (t as HTMLButtonElement).blur();
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === key || e.key === key) {
        e.preventDefault();
        if (!e.repeat) ref.current();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [key, enabled]);
}

export function Panel({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="panel">
      {(title || actions) && (
        <header className="panel__head">
          <h3>{title}</h3>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function CopyLink({ url, label }: { url: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copylink"
      onClick={() => {
        void navigator.clipboard?.writeText(url);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      title="Скопіювати"
    >
      <span className="copylink__label">{label}</span>
      <span className="copylink__url">{url.replace(/^https?:\/\//, '')}</span>
      <span className="copylink__state">{done ? 'Скопійовано' : 'Копіювати'}</span>
    </button>
  );
}
