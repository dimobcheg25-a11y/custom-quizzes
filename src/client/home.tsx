import { useEffect, useRef, useState } from 'react';
import { storage } from './net';
import { Bulbs, Button } from './ui';

interface PackInfo {
  id: string;
  title: string;
  author?: string;
  description?: string;
  rounds: number;
  questions: number;
  error?: string;
}

export function Home() {
  const [code, setCode] = useState('');
  const [packs, setPacks] = useState<PackInfo[] | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () =>
    fetch('/api/packs')
      .then((r) => r.json())
      .then((d: { packs: PackInfo[]; uploadNeedsKey: boolean }) => {
        setPacks(d.packs);
        setNeedsKey(d.uploadNeedsKey);
        setSelected((cur) => cur ?? d.packs.find((p) => !p.error)?.id ?? null);
      })
      .catch(() => setError('Не вдалося завантажити список паків'));
  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packId: selected }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      storage.set(`host:${d.code}`, d.hostToken);
      location.href = `/host/${d.code}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(undefined);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/zip' };
      if (needsKey) {
        const key = prompt('Ключ для завантаження паків');
        if (!key) return;
        headers['x-upload-key'] = key;
      }
      const r = await fetch(`/api/packs/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers, body: file });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      await load();
      setSelected(d.pack.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="home">
      <header className="home-head">
        <div className="marquee-sign">
          <Bulbs />
          <span className="logo logo--lg">Квізи від Дімона</span>
        </div>
        <p className="home-tagline">Квіз для друзів онлайн: табло з темами, кнопка, кіт у мішку, аукціон і фінал.</p>
      </header>

      <div className="home-grid">
        <section className="card">
          <h2>Приєднатися</h2>
          <p className="muted small">Введіть код, який дав ведучий.</p>
          <form
            className="join-code"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === 4) location.href = `/r/${code}`;
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
              placeholder="КОД"
              aria-label="Код кімнати"
              className="code-input"
              autoComplete="off"
            />
            <Button variant="primary" type="submit" disabled={code.length !== 4}>
              Увійти
            </Button>
          </form>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Створити гру</h2>
            <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
              Завантажити пак (.zip)
            </Button>
            <input ref={fileRef} type="file" accept=".zip" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </div>
          <p className="muted small">Ви будете ведучим: бачите відповіді й оцінюєте гравців.</p>
          {packs === null && <p className="muted">Завантаження…</p>}
          {packs?.length === 0 && <p className="muted">Паків поки немає. Додайте папку в packs/ або завантажте .zip.</p>}
          <ul className="pack-list" role="radiogroup" aria-label="Пак">
            {packs?.map((p) => (
              <li key={p.id}>
                <button
                  role="radio"
                  aria-checked={selected === p.id}
                  className={`pack ${selected === p.id ? 'is-selected' : ''} ${p.error ? 'is-broken' : ''}`}
                  disabled={!!p.error}
                  onClick={() => setSelected(p.id)}
                >
                  <span className="pack__title">{p.title}</span>
                  {p.error ? (
                    <span className="pack__error">Пак з помилкою: {p.error}</span>
                  ) : (
                    <span className="pack__meta">
                      {p.rounds} {plural(p.rounds, 'раунд', 'раунди', 'раундів')} · {p.questions} {plural(p.questions, 'питання', 'питання', 'питань')}
                      {p.author ? ` · ${p.author}` : ''}
                    </span>
                  )}
                  {p.description && !p.error && <span className="pack__desc">{p.description}</span>}
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="form-error">{error}</p>}
          <Button variant="primary" size="lg" onClick={create} disabled={!selected || busy}>
            Створити кімнату
          </Button>
        </section>
      </div>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
