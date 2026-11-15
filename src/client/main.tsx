import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/exo-2/400.css';
import '@fontsource/exo-2/500.css';
import '@fontsource/exo-2/600.css';
import '@fontsource/exo-2/700.css';
import '@fontsource/oswald/500.css';
import '@fontsource/oswald/600.css';
import '@fontsource/oswald/700.css';
import '@fontsource/russo-one/400.css';
import './styles.css';
import { PLAYER_COLORS } from '../shared/protocol';
import { GameScreen } from './game-screen';
import { Home } from './home';
import { randomToken, storage, useGameConnection } from './net';
import { playSfx, unlockAudio } from './sound';
import { Avatar, Button, useAvatarPicker, useToasts } from './ui';

function App() {
  const path = location.pathname;
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/host\/([A-Za-z0-9]{4})\/?$/))) return <HostPage code={m[1].toUpperCase()} />;
  if ((m = path.match(/^\/r\/([A-Za-z0-9]{4})\/?$/))) return <PlayPage code={m[1].toUpperCase()} />;
  return <Home />;
}

function useEventHandlers() {
  const toasts = useToasts();
  return {
    toasts,
    onEvent: (e: { name: Parameters<typeof playSfx>[0]; playerId?: string }) => {
      if (e.name === 'false_start') window.dispatchEvent(new CustomEvent('false-start', { detail: e.playerId }));
      playSfx(e.name);
    },
    onError: (msg: string) => toasts.push(msg, 'bad'),
  };
}

function HostPage({ code }: { code: string }) {
  const fromHash = location.hash.slice(1);
  if (fromHash) {
    storage.set(`host:${code}`, fromHash);
    history.replaceState(null, '', location.pathname);
  }
  const token = fromHash || storage.get(`host:${code}`);
  const { toasts, onEvent, onError } = useEventHandlers();
  const conn = useGameConnection(token ? { code, role: 'host', token } : null, onEvent, onError);
  if (!token) return <Message title="Немає доступу ведучого" text="Цю кімнату створили в іншому браузері. Створіть нову гру на головній сторінці." />;
  if (conn.status === 'fatal') return <Message title="Не вдалося підключитися" text={conn.fatalError ?? ''} />;
  if (!conn.state) return <Message title="Підключення…" />;
  return <GameScreen conn={conn} toasts={toasts} />;
}

function PlayPage({ code }: { code: string }) {
  const [room, setRoom] = useState<{ packTitle: string } | null | 'missing'>(null);
  const [joined, setJoined] = useState<{ name: string; color: string } | null>(() => {
    const saved = storage.get(`joined:${code}`);
    return saved ? JSON.parse(saved) : null;
  });
  const [error, setError] = useState<string>();
  const [token] = useState(
    () =>
      storage.get('playerToken') ??
      (() => {
        const t = randomToken();
        storage.set('playerToken', t);
        return t;
      })(),
  );

  useEffect(() => {
    fetch(`/api/rooms/${code}`).then(
      async (r) => setRoom(r.ok ? await r.json() : 'missing'),
      () => setRoom('missing'),
    );
  }, [code]);

  const { toasts, onEvent, onError } = useEventHandlers();
  const conn = useGameConnection(joined ? { code, role: 'player', token, name: joined.name, color: joined.color } : null, onEvent, onError);

  // Send the saved photo once per connection if the server does not have it yet (new room, server restart).
  const me = conn.state?.players.find((p) => p.id === conn.state?.meId);
  const avatarSent = useRef(false);
  useEffect(() => {
    if (conn.status !== 'open') avatarSent.current = false;
    if (!me || conn.status !== 'open' || me.avatar || avatarSent.current) return;
    const saved = storage.get('playerAvatar');
    if (!saved) return;
    avatarSent.current = true;
    conn.send({ t: 'set_avatar', data: saved });
  }, [me, conn.status, conn.send]);

  useEffect(() => {
    if (conn.status === 'fatal' && joined) {
      setError(conn.fatalError);
      storage.set(`joined:${code}`, '');
      setJoined(null);
    }
  }, [conn.status, conn.fatalError, joined, code]);

  if (room === 'missing') return <Message title="Кімнату не знайдено" text={`Кімнати ${code} немає. Перевірте код або попросіть ведучого нове посилання.`} />;
  if (conn.kicked) return <Message title="Ведучий прибрав вас із гри" />;
  if (!joined)
    return (
      <JoinForm
        code={code}
        packTitle={room?.packTitle}
        error={error}
        onJoin={(name, color) => {
          unlockAudio();
          storage.set('playerName', name);
          storage.set('playerColor', color);
          storage.set(`joined:${code}`, JSON.stringify({ name, color }));
          setError(undefined);
          setJoined({ name, color });
        }}
      />
    );
  if (!conn.state) return <Message title="Підключення…" />;
  return <GameScreen conn={conn} toasts={toasts} />;
}

function JoinForm({ code, packTitle, error, onJoin }: { code: string; packTitle?: string; error?: string; onJoin: (name: string, color: string) => void }) {
  const [name, setName] = useState(storage.get('playerName') ?? '');
  const [color, setColor] = useState(storage.get('playerColor') ?? PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]);
  const [photo, setPhoto] = useState(storage.get('playerAvatar') || undefined);
  const [photoError, setPhotoError] = useState<string>();
  const picker = useAvatarPicker(
    (url) => {
      storage.set('playerAvatar', url);
      setPhoto(url);
      setPhotoError(undefined);
    },
    setPhotoError,
  );
  return (
    <div className="page-center">
      <form
        className="card join-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onJoin(name.trim(), color);
        }}
      >
        <p className="eyebrow">Кімната {code}</p>
        <h1>{packTitle ?? 'Квізи від Дімона'}</h1>
        <label className="field">
          <span>Ваше ім'я</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} autoFocus placeholder="Як вас звати?" />
        </label>
        <div className="field">
          <span>Колір</span>
          <div className="colors" role="radiogroup" aria-label="Колір">
            {PLAYER_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                role="radio"
                aria-checked={c === color}
                aria-label={c}
                className={`color ${c === color ? 'is-selected' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        <div className="field">
          <span>Аватарка</span>
          <div className="photo-pick">
            <Avatar p={{ name: name.trim() || '?', color, avatar: photo }} size={112} />
            <div className="photo-pick__actions">
              <Button type="button" size="sm" onClick={picker.open}>
                {photo ? 'Змінити фото' : 'Завантажити фото'}
              </Button>
              {photo && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    storage.set('playerAvatar', '');
                    setPhoto(undefined);
                  }}
                >
                  Прибрати
                </Button>
              )}
            </div>
            {picker.input}
          </div>
          {photoError && <p className="form-error">{photoError}</p>}
        </div>
        {error && <p className="form-error">{error}</p>}
        <Button variant="primary" size="lg" type="submit" disabled={!name.trim()}>
          Увійти в гру
        </Button>
      </form>
    </div>
  );
}

function Message({ title, text }: { title: string; text?: string }) {
  return (
    <div className="page-center">
      <div className="card message-card">
        <h1>{title}</h1>
        {text && <p className="muted">{text}</p>}
        <a className="btn btn--ghost" href="/">
          На головну
        </a>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
