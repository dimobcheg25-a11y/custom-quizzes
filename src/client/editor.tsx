import { useEffect, useRef, useState } from 'react';
import { PackSchema } from '../shared/pack';
import { storage } from './net';
import { Button } from './ui';

// ───────── draft types (looser than the schema: a draft may be incomplete) ─────────

type Kind = 'image' | 'audio' | 'video';
interface MediaD {
  kind: Kind;
  file: string;
  start?: number;
  end?: number;
}
interface QD {
  price: number;
  type: 'normal' | 'cat' | 'auction';
  text: string;
  media?: MediaD;
  answer: string;
  answerMedia?: MediaD;
  comment?: string;
  hostNote?: string;
  catTheme?: string;
  catPrice?: number;
}
interface TD {
  name: string;
  questions: QD[];
}
interface RD {
  name: string;
  type: 'normal' | 'final';
  themes: TD[];
}
interface PD {
  title: string;
  author?: string;
  description?: string;
  rounds: RD[];
}

const blankQ = (price: number): QD => ({ price, type: 'normal', text: '', answer: '' });
const step = (d: PD, ri: number) => 100 * (d.rounds.slice(0, ri + 1).filter((r) => r.type === 'normal').length || 1);
const blankTheme = (d: PD, ri: number): TD =>
  d.rounds[ri].type === 'final' ? { name: '', questions: [blankQ(0)] } : { name: '', questions: [1, 2, 3, 4, 5].map((k) => blankQ(k * step(d, ri))) };

function normalize(raw: unknown): PD {
  const d = (raw ?? {}) as Partial<PD>;
  return {
    title: d.title ?? '',
    author: d.author,
    description: d.description,
    rounds: (d.rounds ?? []).map((r) => ({
      name: r.name ?? '',
      type: r.type === 'final' ? 'final' : 'normal',
      themes: (r.themes ?? []).map((t) => ({
        name: t.name ?? '',
        questions: (t.questions ?? []).map((q) => ({ ...blankQ(0), ...q })),
      })),
    })),
  };
}

/** Drop empty optional strings so the saved draft matches the schema shape. */
function clean(d: PD): PD {
  const opt = (s?: string) => (s && s.trim() ? s : undefined);
  return {
    ...d,
    author: opt(d.author),
    description: opt(d.description),
    rounds: d.rounds.map((r) => ({
      ...r,
      themes: r.themes.map((t) => ({
        ...t,
        questions: t.questions.map((q) => ({
          ...q,
          comment: opt(q.comment),
          hostNote: opt(q.hostNote),
          catTheme: q.type === 'cat' ? opt(q.catTheme) : undefined,
          catPrice: q.type === 'cat' && q.catPrice ? q.catPrice : undefined,
        })),
      })),
    })),
  };
}

// ───────── API ─────────

const keyHeader = (): Record<string, string> => {
  const k = storage.get('editorKey');
  return k ? { 'x-editor-key': k } : {};
};

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { ...keyHeader(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 403) throw Object.assign(new Error(d.error ?? 'Невірний пароль'), { auth: true });
  if (!r.ok) throw new Error(d.error ?? `Помилка ${r.status}`);
  return d as T;
}

function uploadMedia(packId: string, file: Blob, name: string, onProgress: (p: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/editor/packs/${packId}/media?name=${encodeURIComponent(name)}`);
    for (const [k, v] of Object.entries(keyHeader())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const d = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(d.file);
        else reject(new Error(d.error ?? `Помилка ${xhr.status}`));
      } catch {
        reject(new Error(`Помилка ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Мережева помилка'));
    xhr.send(file);
  });
}

/** Big photos are shrunk in the browser before upload. */
async function prepareImage(file: File): Promise<{ blob: Blob; name: string }> {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return { blob: file, name: file.name };
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 600_000) {
    bmp.close();
    return { blob: file, name: file.name };
  }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.86));
  return { blob, name: 'image.jpg' };
}

// ───────── pages ─────────

export function EditorApp({ packId }: { packId?: string }) {
  const [auth, setAuth] = useState<'checking' | 'need' | 'ok'>('checking');
  const [storageKind, setStorageKind] = useState<string>();
  const check = () =>
    api<{ storage: string }>('GET', '/api/editor/check').then(
      (d) => {
        setStorageKind(d.storage);
        setAuth('ok');
      },
      (e) => setAuth((e as { auth?: boolean }).auth ? 'need' : 'ok'),
    );
  useEffect(() => {
    check();
  }, []);

  if (auth === 'checking') return <div className="page-center muted">Завантаження…</div>;
  if (auth === 'need') return <KeyGate onDone={check} />;
  return packId ? <PackEditor id={packId} /> : <PackList storageKind={storageKind} />;
}

function KeyGate({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState('');
  const [bad, setBad] = useState(false);
  return (
    <div className="page-center">
      <form
        className="card join-card"
        onSubmit={async (e) => {
          e.preventDefault();
          storage.set('editorKey', key);
          try {
            await api('GET', '/api/editor/check');
            onDone();
          } catch {
            setBad(true);
          }
        }}
      >
        <p className="eyebrow">Редактор паків</p>
        <h1>Пароль</h1>
        <label className="field">
          <span>Пароль редактора</span>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
        </label>
        {bad && <p className="form-error">Невірний пароль</p>}
        <Button variant="primary" size="lg" type="submit" disabled={!key}>
          Увійти
        </Button>
        <a className="link" href="/">
          На головну
        </a>
      </form>
    </div>
  );
}

interface Summary {
  id: string;
  title: string;
  updatedAt: number;
  issues: number;
  playable: boolean;
  questions: number;
}

function PackList({ storageKind }: { storageKind?: string }) {
  const [packs, setPacks] = useState<Summary[] | null>(null);
  const [error, setError] = useState<string>();
  const load = () => api<{ packs: Summary[] }>('GET', '/api/editor/packs').then((d) => setPacks(d.packs), (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    const d: PD = { title: 'Новий пак', rounds: [{ name: 'Перший раунд', type: 'normal', themes: [] }] };
    d.rounds[0].themes.push(blankTheme(d, 0));
    try {
      const s = await api<Summary>('POST', '/api/editor/packs', { draft: d });
      location.href = `/editor/${s.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="editor">
      <header className="editor-top">
        <a className="link" href="/">
          ← На головну
        </a>
        <h1 className="editor-top__title">Мої паки</h1>
        <Button variant="primary" onClick={create}>
          + Новий пак
        </Button>
      </header>
      {storageKind === 'local' && (
        <p className="editor-note">
          Паки зберігаються в локальній папці сервера. На безкоштовному хостингу вони зникнуть після перезапуску — підключіть хмарне сховище.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
      {packs === null && !error && <p className="muted">Завантаження…</p>}
      {packs?.length === 0 && <p className="muted">Ще немає жодного паку. Створіть перший!</p>}
      <ul className="editor-packs">
        {packs?.map((p) => (
          <li key={p.id} className="editor-pack">
            <a href={`/editor/${p.id}`} className="editor-pack__main">
              <b>{p.title}</b>
              <span className="muted small">
                {p.questions} питань · {p.playable ? 'готовий до гри' : `незаповнених полів: ${p.issues}`} · змінено {new Date(p.updatedAt).toLocaleString('uk-UA')}
              </span>
            </a>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (!confirm(`Видалити пак «${p.title}» разом з усіма файлами?`)) return;
                await api('DELETE', `/api/editor/packs/${p.id}`).catch((e) => setError(e.message));
                load();
              }}
            >
              Видалити
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────── pack editor ─────────

type Save = 'saved' | 'dirty' | 'saving' | 'error';

function PackEditor({ id }: { id: string }) {
  const [d, setD] = useState<PD | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [save, setSave] = useState<Save>('saved');
  const [saveError, setSaveError] = useState<string>();
  const [ri, setRi] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<number>();
  const latest = useRef<PD | null>(null);

  useEffect(() => {
    api<{ draft: unknown }>('GET', `/api/editor/packs/${id}`).then(
      (r) => setD(normalize(r.draft)),
      (e) => setLoadError(e.message),
    );
  }, [id]);

  const flush = async () => {
    window.clearTimeout(timer.current);
    const cur = latest.current;
    if (!cur) return;
    latest.current = null;
    setSave('saving');
    try {
      await api('PUT', `/api/editor/packs/${id}`, { draft: clean(cur) });
      setSave(latest.current ? 'dirty' : 'saved');
      setSaveError(undefined);
    } catch (e) {
      latest.current ??= cur;
      setSave('error');
      setSaveError((e as Error).message);
    }
  };

  const update = (fn: (x: PD) => void) =>
    setD((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      latest.current = next;
      setSave('dirty');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 700);
      return next;
    });

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (latest.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  if (loadError) return <div className="page-center form-error">{loadError}</div>;
  if (!d) return <div className="page-center muted">Завантаження…</div>;

  const parsed = PackSchema.safeParse(clean(d));
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => humanIssue(d, i.path, i.message));
  const round = d.rounds[Math.min(ri, d.rounds.length - 1)];
  const r = Math.min(ri, d.rounds.length - 1);

  const play = async () => {
    await flush();
    const res = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packId: id }) });
    const j = await res.json();
    if (!res.ok) return alert(j.error);
    storage.set(`host:${j.code}`, j.hostToken);
    location.href = `/host/${j.code}`;
  };

  return (
    <div className="editor">
      <header className="editor-top">
        <a className="link" href="/editor" onClick={() => flush()}>
          ← Мої паки
        </a>
        <h1 className="editor-top__title">{d.title || 'Без назви'}</h1>
        <span className={`editor-save editor-save--${save}`} title={saveError}>
          {save === 'saved' ? 'Збережено' : save === 'saving' ? 'Зберігаю…' : save === 'dirty' ? 'Є зміни' : 'Не збережено!'}
        </span>
        <Button variant="primary" onClick={play} disabled={issues.length > 0} title={issues.length ? 'Спершу заповніть усі обовʼязкові поля' : undefined}>
          Грати цим паком
        </Button>
      </header>
      {save === 'error' && <p className="form-error">Не вдалося зберегти: {saveError}</p>}

      <section className="editor-card">
        <div className="editor-grid">
          <Field label="Назва паку">
            <input value={d.title} onChange={(e) => update((x) => void (x.title = e.target.value))} placeholder="Наприклад: Кіно 90-х" />
          </Field>
          <Field label="Автор">
            <input value={d.author ?? ''} onChange={(e) => update((x) => void (x.author = e.target.value))} placeholder="необовʼязково" />
          </Field>
        </div>
        <Field label="Опис">
          <input value={d.description ?? ''} onChange={(e) => update((x) => void (x.description = e.target.value))} placeholder="необовʼязково" />
        </Field>
      </section>

      <nav className="editor-tabs" aria-label="Раунди">
        {d.rounds.map((rd, i) => (
          <button key={i} className={`editor-tab ${i === r ? 'is-on' : ''}`} onClick={() => setRi(i)}>
            {rd.type === 'final' ? '🏁 ' : ''}
            {rd.name || `Раунд ${i + 1}`}
          </button>
        ))}
        <button
          className="editor-tab editor-tab--add"
          onClick={() =>
            update((x) => {
              const n = x.rounds.filter((q) => q.type === 'normal').length;
              const at = x.rounds.findIndex((q) => q.type === 'final');
              const idx = at < 0 ? x.rounds.length : at;
              x.rounds.splice(idx, 0, { name: `Раунд ${n + 1}`, type: 'normal', themes: [] });
              x.rounds[idx].themes.push(blankTheme(x, idx));
              setRi(idx);
            })
          }
        >
          + Раунд
        </button>
        {!d.rounds.some((q) => q.type === 'final') && (
          <button
            className="editor-tab editor-tab--add"
            onClick={() =>
              update((x) => {
                x.rounds.push({ name: 'Фінал', type: 'final', themes: [] });
                const idx = x.rounds.length - 1;
                for (let k = 0; k < 3; k++) x.rounds[idx].themes.push(blankTheme(x, idx));
                setRi(idx);
              })
            }
          >
            + Фінал
          </button>
        )}
      </nav>

      {round ? (
        <section className="editor-card">
          <div className="editor-row">
            <Field label={round.type === 'final' ? 'Назва фіналу' : 'Назва раунду'} grow>
              <input value={round.name} onChange={(e) => update((x) => void (x.rounds[r].name = e.target.value))} />
            </Field>
            <div className="editor-actions">
              <IconBtn label="Перемістити раунд лівіше" disabled={r === 0} onClick={() => {
                  update((x) => move(x.rounds, r, -1));
                  setRi(r - 1);
                }}>
                ←
              </IconBtn>
              <IconBtn label="Перемістити раунд правіше" disabled={r === d.rounds.length - 1} onClick={() => {
                  update((x) => move(x.rounds, r, 1));
                  setRi(r + 1);
                }}>
                →
              </IconBtn>
              <IconBtn
                label="Видалити раунд"
                onClick={() => {
                  if (!confirm(`Видалити «${round.name || `Раунд ${r + 1}`}» з усіма питаннями?`)) return;
                  update((x) => void x.rounds.splice(r, 1));
                  setRi(Math.max(0, r - 1));
                }}
              >
                ✕
              </IconBtn>
            </div>
          </div>
          {round.type === 'final' && <p className="muted small">У фіналі кожна тема має одне питання; гравці роблять ставки й пишуть відповідь.</p>}

          {round.themes.map((t, ti) => (
            <div key={ti} className="editor-theme">
              <div className="editor-row">
                <Field label={`Тема ${ti + 1}`} grow>
                  <input value={t.name} onChange={(e) => update((x) => void (x.rounds[r].themes[ti].name = e.target.value))} placeholder="Назва теми" />
                </Field>
                <div className="editor-actions">
                  <IconBtn label="Тему вище" disabled={ti === 0} onClick={() => update((x) => move(x.rounds[r].themes, ti, -1))}>
                    ↑
                  </IconBtn>
                  <IconBtn label="Тему нижче" disabled={ti === round.themes.length - 1} onClick={() => update((x) => move(x.rounds[r].themes, ti, 1))}>
                    ↓
                  </IconBtn>
                  <IconBtn
                    label="Видалити тему"
                    onClick={() => confirm(`Видалити тему «${t.name || ti + 1}»?`) && update((x) => void x.rounds[r].themes.splice(ti, 1))}
                  >
                    ✕
                  </IconBtn>
                </div>
              </div>
              <ul className="editor-questions">
                {t.questions.map((q, qi) => {
                  const key = `${r}-${ti}-${qi}`;
                  const isOpen = open === key;
                  const setQ = (fn: (q: QD) => void) => update((x) => fn(x.rounds[r].themes[ti].questions[qi]));
                  return (
                    <li key={qi} className={`editor-q ${isOpen ? 'is-open' : ''}`}>
                      <button className="editor-q__head" onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}>
                        {round.type === 'normal' && <span className="editor-q__price">{q.price}</span>}
                        {q.type !== 'normal' && <span className="badge">{q.type === 'cat' ? 'кіт' : 'аукціон'}</span>}
                        <span className="editor-q__text">
                          {q.media && <span aria-hidden>{q.media.kind === 'image' ? '🖼 ' : q.media.kind === 'audio' ? '🎵 ' : '🎬 '}</span>}
                          {q.text || <i className="muted">{q.media ? '(лише медіа)' : 'порожнє питання'}</i>}
                        </span>
                        <span className={`editor-q__answer ${q.answer ? '' : 'is-missing'}`}>{q.answer || 'без відповіді'}</span>
                      </button>
                      {isOpen && (
                        <QuestionForm
                          packId={id}
                          q={q}
                          final={round.type === 'final'}
                          setQ={setQ}
                          onDelete={
                            round.type === 'final'
                              ? undefined
                              : () => {
                                  update((x) => void x.rounds[r].themes[ti].questions.splice(qi, 1));
                                  setOpen(null);
                                }
                          }
                          onMove={
                            round.type === 'final'
                              ? undefined
                              : (dir) => {
                                  if (qi + dir < 0 || qi + dir >= t.questions.length) return;
                                  update((x) => move(x.rounds[r].themes[ti].questions, qi, dir));
                                  setOpen(`${r}-${ti}-${qi + dir}`);
                                }
                          }
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
              {round.type === 'normal' && (
                <button
                  className="link"
                  onClick={() =>
                    update((x) => {
                      const qs = x.rounds[r].themes[ti].questions;
                      qs.push(blankQ((qs.at(-1)?.price ?? 0) + step(x, r)));
                      setOpen(`${r}-${ti}-${qs.length - 1}`);
                    })
                  }
                >
                  + Питання
                </button>
              )}
            </div>
          ))}
          <Button onClick={() => update((x) => void x.rounds[r].themes.push(blankTheme(x, r)))}>+ Тема</Button>
        </section>
      ) : (
        <p className="muted">Додайте раунд.</p>
      )}

      <section className={`editor-card editor-issues ${issues.length ? '' : 'is-ok'}`}>
        {issues.length === 0 ? (
          <p>✓ Пак готовий до гри</p>
        ) : (
          <>
            <p>
              <b>Щоб грати, заповніть:</b>
            </p>
            <ul>
              {issues.slice(0, 30).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
              {issues.length > 30 && <li>…і ще {issues.length - 30}</li>}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function QuestionForm({
  packId,
  q,
  final,
  setQ,
  onDelete,
  onMove,
}: {
  packId: string;
  q: QD;
  final: boolean;
  setQ: (fn: (q: QD) => void) => void;
  onDelete?: () => void;
  onMove?: (dir: number) => void;
}) {
  return (
    <div className="editor-q__form">
      {!final && (
        <div className="editor-grid">
          <Field label="Ціна">
            <input type="number" min={1} step={100} value={q.price || ''} onChange={(e) => setQ((x) => void (x.price = Math.max(0, Math.round(Number(e.target.value) || 0))))} />
          </Field>
          <Field label="Тип">
            <select value={q.type} onChange={(e) => setQ((x) => void (x.type = e.target.value as QD['type']))}>
              <option value="normal">Звичайне</option>
              <option value="cat">Кіт у мішку</option>
              <option value="auction">Аукціон</option>
            </select>
          </Field>
        </div>
      )}
      {q.type === 'cat' && (
        <div className="editor-grid">
          <Field label="Тема кота (оголошується при передачі)">
            <input value={q.catTheme ?? ''} onChange={(e) => setQ((x) => void (x.catTheme = e.target.value))} placeholder="за замовчуванням — назва теми" />
          </Field>
          <Field label="Ціна кота">
            <input type="number" min={1} step={100} value={q.catPrice ?? ''} onChange={(e) => setQ((x) => void (x.catPrice = Math.round(Number(e.target.value)) || undefined))} placeholder="як ціна питання" />
          </Field>
        </div>
      )}
      <Field label="Питання">
        <textarea rows={3} value={q.text} onChange={(e) => setQ((x) => void (x.text = e.target.value))} placeholder="Текст, який побачать усі гравці" />
      </Field>
      <MediaField packId={packId} label="Медіа до питання" value={q.media} onChange={(m) => setQ((x) => void (x.media = m))} />
      <Field label="Відповідь">
        <input value={q.answer} onChange={(e) => setQ((x) => void (x.answer = e.target.value))} placeholder="Коротко: імʼя, слово, число" />
      </Field>
      <Field label="Нотатка ведучому (бачить лише ведучий)">
        <input value={q.hostNote ?? ''} onChange={(e) => setQ((x) => void (x.hostNote = e.target.value))} placeholder="Зараховувати: …; не зараховувати: …" />
      </Field>
      <Field label="Коментар після відповіді (бачать усі)">
        <textarea rows={2} value={q.comment ?? ''} onChange={(e) => setQ((x) => void (x.comment = e.target.value))} placeholder="Цікавий факт" />
      </Field>
      <MediaField packId={packId} label="Медіа до відповіді" value={q.answerMedia} onChange={(m) => setQ((x) => void (x.answerMedia = m))} />
      <div className="editor-row editor-row--end">
        {onMove && (
          <>
            <Button size="sm" onClick={() => onMove(-1)}>
              ↑ Вище
            </Button>
            <Button size="sm" onClick={() => onMove(1)}>
              ↓ Нижче
            </Button>
          </>
        )}
        {onDelete && (
          <Button size="sm" variant="bad" onClick={() => confirm('Видалити це питання?') && onDelete()}>
            Видалити питання
          </Button>
        )}
      </div>
    </div>
  );
}

function MediaField({ packId, label, value, onChange }: { packId: string; label: string; value?: MediaD; onChange: (m?: MediaD) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const el = useRef<HTMLMediaElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const url = value ? `/packs/${packId}/${value.file}` : '';

  const pick = async (f: File) => {
    setError(undefined);
    const kind: Kind | null = f.type.startsWith('image/') ? 'image' : f.type.startsWith('audio/') ? 'audio' : f.type.startsWith('video/') ? 'video' : null;
    if (!kind) return setError('Підтримуються картинки, аудіо й відео');
    try {
      setProgress(0);
      const { blob, name } = kind === 'image' ? await prepareImage(f) : { blob: f, name: f.name };
      const file = await uploadMedia(packId, blob, name, setProgress);
      onChange({ kind, file });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const setTime = (k: 'start' | 'end', v: number | undefined) => value && onChange({ ...value, [k]: v });

  return (
    <div className="field media-field">
      <span>{label}</span>
      {value ? (
        <div className="media-field__body">
          {value.kind === 'image' && <img src={url} alt="" className="media-field__preview" />}
          {value.kind === 'audio' && <audio ref={el as React.RefObject<HTMLAudioElement>} src={url} controls preload="metadata" />}
          {value.kind === 'video' && <video ref={el as React.RefObject<HTMLVideoElement>} src={url} controls preload="metadata" className="media-field__preview" />}
          {value.kind !== 'image' && (
            <div className="media-field__trim">
              <TimeInput label="Грати з" value={value.start} onChange={(v) => setTime('start', v)} onNow={() => setTime('start', round1(el.current?.currentTime))} />
              <TimeInput label="до" value={value.end} onChange={(v) => setTime('end', v)} onNow={() => setTime('end', round1(el.current?.currentTime))} />
            </div>
          )}
          <div className="editor-row">
            <Button size="sm" onClick={() => input.current?.click()}>
              Замінити
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
              Прибрати
            </Button>
          </div>
        </div>
      ) : (
        <div className="editor-row">
          <Button size="sm" onClick={() => input.current?.click()} disabled={progress !== null}>
            {progress !== null ? `Завантаження… ${Math.round(progress * 100)}%` : 'Додати картинку, аудіо чи відео'}
          </Button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <input
        ref={input}
        type="file"
        accept="image/*,audio/*,video/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) pick(f);
        }}
      />
    </div>
  );
}

const round1 = (v?: number) => (v === undefined ? undefined : Math.round(v * 10) / 10);
const fmt = (v?: number) => (v === undefined ? '' : `${Math.floor(v / 60)}:${(v % 60).toFixed(1).padStart(4, '0')}`);
function parseTime(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const parts = t.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
  return round1(parts.reduce((acc, n) => acc * 60 + n, 0));
}

function TimeInput({ label, value, onChange, onNow }: { label: string; value?: number; onChange: (v?: number) => void; onNow: () => void }) {
  const [draft, setDraft] = useState(fmt(value));
  useEffect(() => setDraft(fmt(value)), [value]);
  return (
    <label className="time-input">
      <span>{label}</span>
      <input value={draft} placeholder="хв:сек" onChange={(e) => setDraft(e.target.value)} onBlur={() => onChange(parseTime(draft))} />
      <button type="button" className="link" onClick={onNow} title="Взяти поточну позицію програвача">
        зараз
      </button>
    </label>
  );
}

function Field({ label, children, grow }: { label: string; children: React.ReactNode; grow?: boolean }) {
  return (
    <label className={`field ${grow ? 'field--grow' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function IconBtn({ label, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

function move<T>(arr: T[], i: number, dir: number) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function humanIssue(d: PD, path: (string | number)[], message: string): string {
  const parts: string[] = [];
  const [, r, , t, , q, field] = path as [string, number, string, number, string, number, string];
  if (path[0] === 'title') return 'Назва паку';
  if (path[0] === 'rounds' && path.length === 1) return 'Додайте хоча б один раунд';
  if (typeof r === 'number') parts.push(d.rounds[r]?.name || `Раунд ${r + 1}`);
  if (typeof t === 'number') parts.push(`тема «${d.rounds[r]?.themes[t]?.name || t + 1}»`);
  if (typeof q === 'number') {
    const qq = d.rounds[r]?.themes[t]?.questions[q];
    parts.push(d.rounds[r]?.type === 'final' ? 'питання' : `питання ${qq?.price || q + 1}`);
  }
  const what =
    path[2] === 'name' && path.length === 3
      ? 'назва раунду'
      : path[4] === 'name' && path.length === 5
        ? 'назва теми'
        : path.length === 3 && path[2] === 'themes'
          ? 'додайте хоча б одну тему'
          : path.length === 5 && path[4] === 'questions'
            ? d.rounds[r]?.type === 'final'
              ? 'у фінальній темі має бути рівно одне питання'
              : 'додайте хоча б одне питання'
            : field === 'answer'
              ? 'відповідь'
              : field === 'price'
                ? 'ціна має бути більшою за 0'
                : field === 'type'
                  ? 'у фіналі лише звичайні питання'
                  : field === 'media' || field === 'answerMedia'
                    ? 'медіа: кінець має бути після початку'
                    : message.includes('text or media')
                      ? 'текст питання або медіа'
                      : message;
  return `${parts.join(' › ')}: ${what}`;
}
