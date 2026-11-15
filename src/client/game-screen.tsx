import { useEffect, useRef, useState } from 'react';
import type { ClientMessage, GameView, PlayerView, Settings } from '../shared/protocol';
import type { GameConnection } from './net';
import { isMuted, playSfx, setMuted, unlockAudio } from './sound';
import { Stage } from './stage';
import { Avatar, Button, Countdown, CopyLink, findPlayer, formatScore, Panel, playerName, Toasts, useHotkey, useToasts } from './ui';

export function GameScreen({ conn, toasts }: { conn: GameConnection; toasts: ReturnType<typeof useToasts> }) {
  const s = conn.state!;
  const host = s.role === 'host';
  const [muted, setM] = useState(isMuted());

  return (
    <div className={`game ${host ? 'game--host' : 'game--player'}`} onPointerDown={unlockAudio}>
      <header className="topbar">
        <div className="topbar__title">
          <span className="logo">Квізи від Дімона</span>
          <span className="topbar__pack">{s.packTitle}</span>
        </div>
        <div className="topbar__meta">
          {conn.status !== 'open' && <span className="badge badge--bad">Перепідключення…</span>}
          {!host && !s.hostConnected && s.phase !== 'lobby' && <span className="badge">Ведучий не на зв'язку</span>}
          <span className="topbar__code" title="Код кімнати">
            {s.code}
          </span>
          <button
            className="icon-btn"
            onClick={() => {
              setMuted(!muted);
              setM(!muted);
            }}
            title={muted ? 'Увімкнути звуки' : 'Вимкнути звуки'}
            aria-label={muted ? 'Увімкнути звуки' : 'Вимкнути звуки'}
          >
            {muted ? <SpeakerOff /> : <SpeakerOn />}
          </button>
        </div>
      </header>

      <main className="stage">
        <Stage s={s} send={conn.send} serverNow={conn.serverNow} />
      </main>

      <aside className="side">
        <Scoreboard s={s} send={conn.send} />
        {host && <HostPanel s={s} send={conn.send} serverNow={conn.serverNow} />}
      </aside>

      {!host && <PlayerBar s={s} send={conn.send} serverNow={conn.serverNow} />}
      <Toasts items={toasts.items} />
    </div>
  );
}

// ───────────────────────── scoreboard ─────────────────────────

function playerStatus(s: GameView, p: PlayerView): { text: string; tone?: 'accent' | 'good' | 'bad' | 'muted' } | null {
  const b = s.buzz;
  if (s.phase === 'question' && b?.answeringId === p.id) return { text: 'відповідає', tone: 'accent' };
  if (s.phase === 'question' && b?.lockedOut.includes(p.id)) return { text: 'помилився', tone: 'bad' };
  if (s.phase === 'auction' && s.auction) {
    if (s.auction.turnId === p.id) return { text: 'хід', tone: 'accent' };
    if (s.auction.passed.includes(p.id)) return { text: 'пас', tone: 'muted' };
  }
  if (s.final && s.phase.startsWith('final')) {
    if (!s.final.participants.includes(p.id)) return { text: 'не у фіналі', tone: 'muted' };
    if (s.phase === 'final_themes' && s.final.turnId === p.id) return { text: 'прибирає', tone: 'accent' };
    if (s.phase === 'final_bets') return s.final.betPlaced.includes(p.id) ? { text: 'ставка ✓', tone: 'good' } : { text: 'ставить…' };
    if (s.phase === 'final_answer') return s.final.answered.includes(p.id) ? { text: 'відповів ✓', tone: 'good' } : { text: 'пише…' };
  }
  if ((s.phase === 'board' || s.phase === 'cat') && s.chooserId === p.id) return { text: s.phase === 'cat' ? 'передає кота' : 'обирає', tone: 'accent' };
  return null;
}

function Scoreboard({ s, send }: { s: GameView; send: (m: ClientMessage) => void }) {
  const host = s.role === 'host';
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  return (
    <Panel title="Гравці">
      {s.players.length === 0 && <p className="muted small">Ще ніхто не приєднався.</p>}
      <ul className="scores">
        {s.players.map((p) => {
          const st = playerStatus(s, p);
          const answering = s.phase === 'question' && s.buzz?.answeringId === p.id;
          return (
            <li key={p.id} className={`score-row ${answering ? 'is-answering' : ''} ${p.connected ? '' : 'is-offline'} ${p.id === s.meId ? 'is-me' : ''}`}>
              <Avatar p={p} size={34} />
              <div className="score-row__main">
                <span className="score-row__name">
                  {p.name}
                  {p.id === s.meId && <span className="muted"> (ви)</span>}
                </span>
                <span className={`score-row__status tone-${st?.tone ?? 'muted'}`}>{!p.connected ? 'не в мережі' : st?.text ?? ''}</span>
              </div>
              {host && editing === p.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const raw = String(new FormData(e.currentTarget).get('score') ?? '').trim();
                    const v = Number(raw);
                    if (raw !== '' && Number.isFinite(v)) send({ t: 'set_score', playerId: p.id, score: v });
                    setEditing(null);
                  }}
                >
                  <input name="score" className="score-input" type="number" defaultValue={p.score} autoFocus onBlur={() => setEditing(null)} aria-label="Рахунок" />
                </form>
              ) : (
                <button className={`score-row__score ${p.score < 0 ? 'is-negative' : ''}`} disabled={!host} onClick={() => setEditing(p.id)} title={host ? 'Змінити рахунок' : undefined}>
                  {formatScore(p.score)}
                </button>
              )}
              {host && (
                <div className="row-menu">
                  <button className="icon-btn icon-btn--sm" onClick={() => setMenu(menu === p.id ? null : p.id)} aria-label="Дії з гравцем">
                    ⋯
                  </button>
                  {menu === p.id && (
                    <div className="row-menu__pop" onMouseLeave={() => setMenu(null)}>
                      <button
                        onClick={() => {
                          send({ t: 'set_chooser', playerId: p.id });
                          setMenu(null);
                        }}
                      >
                        Зробити тим, хто обирає
                      </button>
                      <button onClick={() => (setEditing(p.id), setMenu(null))}>Змінити рахунок</button>
                      <button
                        className="danger"
                        onClick={() => {
                          if (confirm(`Вигнати ${p.name}?`)) send({ t: 'kick', playerId: p.id });
                          setMenu(null);
                        }}
                      >
                        Вигнати
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ───────────────────────── player buzzer ─────────────────────────

function PlayerBar({ s, send, serverNow }: { s: GameView; send: (m: ClientMessage) => void; serverNow: () => number }) {
  const b = s.phase === 'question' ? s.buzz : undefined;
  const me = s.meId;
  const openedAt = useRef<number | null>(null);
  const openKey = b?.stage === 'open' ? `${s.question?.themeIndex}-${s.question?.questionIndex}-${b.deadline}` : null;
  const [pressedAt, setPressedAt] = useState<{ key: string; at: number } | null>(null);
  const [, rerender] = useState(0);
  const [falseStart, setFalseStart] = useState(false);

  useEffect(() => {
    openedAt.current = openKey ? performance.now() : null;
  }, [openKey]);

  // false start feedback comes as an event; listen via a custom DOM event dispatched by the page
  useEffect(() => {
    const h = (e: Event) => {
      if ((e as CustomEvent).detail === me) {
        setFalseStart(true);
        setTimeout(() => setFalseStart(false), Math.max(600, s.settings.falseStartMs));
      }
    };
    window.addEventListener('false-start', h);
    return () => window.removeEventListener('false-start', h);
  }, [me, s.settings.falseStartMs]);

  const lockedOut = !!me && !!b?.lockedOut.includes(me);
  const answeringOther = b?.stage === 'answering' && b.answeringId !== me;
  const canPress = !!b && !b.solo && !lockedOut && (b.stage === 'reading' || b.stage === 'open' || answeringOther);
  const justPressed = !!pressedAt && pressedAt.key === openKey && performance.now() - pressedAt.at < 900;

  const press = () => {
    if (!canPress || !b) return;
    unlockAudio();
    if (b.stage === 'open' && openedAt.current !== null && openKey) {
      // The server ignores repeats, so the button stays usable (e.g. if a press landed during a false-start block).
      send({ t: 'buzz', reactionMs: Math.round(performance.now() - openedAt.current) });
      setPressedAt({ key: openKey, at: performance.now() });
      setTimeout(() => rerender((x) => x + 1), 950);
    } else {
      send({ t: 'buzz', reactionMs: -1 });
    }
  };
  useHotkey('Space', press, !!b);

  let label = '';
  let sub = '';
  let state: 'idle' | 'ready' | 'wait' | 'me' | 'bad' = 'idle';
  if (!b) {
    label = phaseHint(s);
  } else if (b.stage === 'answering') {
    const who = findPlayer(s, b.answeringId);
    if (b.answeringId === me) {
      state = 'me';
      label = 'Ваша відповідь!';
      sub = 'Скажіть відповідь голосом — ведучий оцінить';
    } else {
      state = 'wait';
      label = `Відповідає ${who?.name ?? '…'}`;
    }
  } else if (b.solo) {
    label = 'Питання для одного гравця';
  } else if (lockedOut) {
    state = 'wait';
    label = 'Ви вже відповідали на це питання';
  } else if (falseStart) {
    state = 'bad';
    label = 'Фальстарт';
    sub = 'Зачекайте, поки кнопка відкриється';
  } else if (b.stage === 'reading') {
    state = 'wait';
    label = 'Читаємо питання';
    sub = 'Не поспішайте: раннє натискання блокує кнопку';
  } else if (b.stage === 'open') {
    if (justPressed) {
      state = 'wait';
      label = 'Натиснуто…';
    } else {
      state = 'ready';
      label = 'Відповідати!';
      sub = 'Пробіл або натисніть тут';
    }
  }

  const myScore = findPlayer(s, me)?.score ?? 0;

  return (
    <footer className="playerbar">
      <button className={`buzzer buzzer--${state}`} disabled={!canPress} onPointerDown={press} aria-label="Кнопка відповіді">
        <span className="buzzer__label">{label}</span>
        {sub && <span className="buzzer__sub">{sub}</span>}
        {b?.stage === 'answering' && b.answeringId === me && <Countdown deadline={b.deadline} serverNow={serverNow} />}
      </button>
      <div className="playerbar__score">
        <span className="eyebrow">Ваш рахунок</span>
        <span className={`playerbar__value ${myScore < 0 ? 'is-negative' : ''}`}>{formatScore(myScore)}</span>
      </div>
    </footer>
  );
}

function phaseHint(s: GameView): string {
  switch (s.phase) {
    case 'lobby':
      return 'Чекаємо початку гри';
    case 'board':
      return s.chooserId === s.meId ? 'Ваш вибір: оберіть питання на табло' : `Питання обирає ${playerName(s, s.chooserId)}`;
    case 'cat':
      return 'Кіт у мішку';
    case 'auction':
      return s.auction?.turnId === s.meId ? 'Ваш хід в аукціоні' : 'Аукціон';
    case 'reveal':
      return 'Правильна відповідь на екрані';
    case 'round_end':
      return 'Раунд завершено';
    case 'game_over':
      return 'Гру завершено';
    default:
      return 'Фінал';
  }
}

// ───────────────────────── host panel ─────────────────────────

function HostPanel({ s, send, serverNow }: { s: GameView; send: (m: ClientMessage) => void; serverNow: () => number }) {
  const q = s.question;
  const b = s.buzz;
  const primary = hostPrimary(s);
  useHotkey('Space', () => primary && !primary.disabled && send(primary.msg), !!primary?.hotkey);
  const answering = s.phase === 'question' && b?.stage === 'answering';
  useHotkey('Digit1', () => send({ t: 'judge', correct: true }), answering);
  useHotkey('Digit2', () => send({ t: 'judge', correct: false }), answering);
  const playUrl = `${location.origin}/r/${s.code}`;
  const hostUrl = `${location.origin}/host/${s.code}#${hostToken(s.code)}`;

  return (
    <>
      {s.phase === 'lobby' && (
        <Panel title="Запросити гравців">
          <CopyLink url={playUrl} label="Посилання для гравців" />
          <p className="muted small">Або код {s.code} на головній сторінці.</p>
          <CopyLink url={hostUrl} label="Посилання ведучого — не діліться ним" />
        </Panel>
      )}

      <Panel title="Ведучий">
        {q && s.phase !== 'final_reveal' && (
          <div className="host-answer">
            <span className="eyebrow">Відповідь</span>
            <p className="host-answer__text">{q.answer}</p>
            {q.hostNote && <p className="host-answer__note">{q.hostNote}</p>}
          </div>
        )}

        {answering && (
          <div className="host-judge">
            <p>
              Відповідає <b>{playerName(s, b!.answeringId)}</b> за {formatScore(q!.price)}
              <span className="host-judge__time">
                <Countdown deadline={b!.deadline} serverNow={serverNow} /> с
              </span>
            </p>
            <div className="btn-row">
              <Button variant="good" size="lg" hotkey="1" onClick={() => send({ t: 'judge', correct: true })}>
                Вірно
              </Button>
              <Button variant="bad" size="lg" hotkey="2" onClick={() => send({ t: 'judge', correct: false })}>
                Невірно
              </Button>
            </div>
          </div>
        )}

        {s.phase === 'question' && b?.stage === 'open' && <p className="host-status">Кнопка відкрита — чекаємо натискань…</p>}
        {s.phase === 'question' && b?.stage === 'reading' && b.autoOpenAt && <p className="host-status">Кнопка відкриється автоматично.</p>}
        {s.phase === 'question' && b?.stage === 'reading' && !b.autoOpenAt && q?.media && q.media.kind !== 'image' && (
          <p className="host-status">{s.settings.autoOpen ? 'Кнопка відкриється, коли медіа доіграє у вас.' : 'Відкрийте кнопку, коли будете готові.'}</p>
        )}

        {s.phase === 'final_answer' && <p className="host-status">Гравці пишуть відповіді. Можна завершити раніше.</p>}
        {(s.phase === 'final_judging' || s.phase === 'final_answer') && s.final?.entries && (
          <ul className="host-final">
            {s.final.entries.map((e) => (
              <li key={e.playerId}>
                <div>
                  <b>{playerName(s, e.playerId)}</b> <span className="muted">ставка {formatScore(e.bet)}</span>
                  <p className="host-final__answer">{e.answer || <span className="muted">—</span>}</p>
                </div>
                {s.phase === 'final_judging' && (
                  <div className="btn-row">
                    <Button size="sm" variant={e.correct === true ? 'good' : 'default'} onClick={() => send({ t: 'final_judge', playerId: e.playerId, correct: true })}>
                      Вірно
                    </Button>
                    <Button size="sm" variant={e.correct === false ? 'bad' : 'default'} onClick={() => send({ t: 'final_judge', playerId: e.playerId, correct: false })}>
                      Ні
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {s.phase === 'auction' && s.auction?.turnId && (
          <p className="host-status">
            Хід: {playerName(s, s.auction.turnId)}.{' '}
            <button className="link" onClick={() => send({ t: 'auction_pass' })}>
              Пас за гравця
            </button>
          </p>
        )}

        <div className="btn-col">
          {primary && (
            <Button variant="primary" size="lg" hotkey={primary.hotkey ? 'Пробіл' : undefined} disabled={primary.disabled} onClick={() => send(primary.msg)}>
              {primary.label}
            </Button>
          )}
          {s.canUndo && (
            <Button variant="ghost" onClick={() => send({ t: 'undo_judge' })}>
              Скасувати останній вердикт
            </Button>
          )}
          {q?.media && q.media.kind !== 'image' && (s.phase === 'question' || s.phase === 'reveal') && (
            <Button onClick={() => send({ t: 'replay_media' })}>Програти медіа ще раз (у всіх)</Button>
          )}
          {['question', 'cat', 'auction'].includes(s.phase) && (
            <Button variant="ghost" onClick={() => send({ t: 'skip_question' })}>
              Закрити питання без відповіді
            </Button>
          )}
          {s.phase === 'board' && (
            <Button
              variant="ghost"
              onClick={() => {
                if (confirm('Завершити раунд достроково?')) send({ t: 'end_round' });
              }}
            >
              Завершити раунд
            </Button>
          )}
        </div>
      </Panel>

      <SettingsPanel s={s} send={send} />
    </>
  );
}

function hostToken(code: string) {
  try {
    return localStorage.getItem(`host:${code}`) ?? '';
  } catch {
    return '';
  }
}

/** Main host action. `hotkey: false` for actions that cut players off, so a habitual Space press cannot trigger them. */
function hostPrimary(s: GameView): { label: string; msg: ClientMessage; disabled?: boolean; hotkey: boolean } | null {
  switch (s.phase) {
    case 'lobby':
      return { label: 'Почати гру', msg: { t: 'start' }, disabled: s.players.length === 0, hotkey: true };
    case 'question':
      if (s.buzz?.stage === 'reading' && !s.buzz.solo) return { label: 'Відкрити кнопку', msg: { t: 'open_buzzer' }, hotkey: true };
      return null;
    case 'reveal':
      return { label: 'Далі', msg: { t: 'continue' }, hotkey: true };
    case 'round_end':
      return { label: 'Наступний раунд', msg: { t: 'next_round' }, hotkey: true };
    case 'final_bets':
      return { label: 'Далі без решти ставок', msg: { t: 'continue' }, hotkey: false };
    case 'final_answer':
      return { label: 'Завершити прийом відповідей', msg: { t: 'continue' }, hotkey: false };
    case 'final_judging': {
      const left = (s.final?.entries ?? []).filter((e) => e.correct === undefined).length;
      return { label: left ? `Оцініть відповіді (ще ${left})` : 'Показати результати', msg: { t: 'continue' }, disabled: left > 0, hotkey: false };
    }
    case 'final_reveal':
      return { label: s.board && s.board.index + 1 < s.board.total ? 'Далі' : 'Підсумки', msg: { t: 'continue' }, hotkey: true };
    default:
      return null;
  }
}

function SettingsPanel({ s, send }: { s: GameView; send: (m: ClientMessage) => void }) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<Settings>) => send({ t: 'settings', settings: patch });
  const num = (key: keyof Settings, label: string, unit: string, min: number, max: number, step = 1) => (
    <label className="setting">
      <span>{label}</span>
      <span className="setting__input">
        <SettingInput value={s.settings[key] as number} min={min} max={max} step={step} onCommit={(v) => set({ [key]: v })} />
        <span className="muted">{unit}</span>
      </span>
    </label>
  );
  return (
    <Panel
      title="Налаштування"
      actions={
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'Сховати' : 'Показати'}
        </button>
      }
    >
      {open && (
        <div className="settings">
          <label className="setting setting--check">
            <input type="checkbox" checked={s.settings.autoOpen} onChange={(e) => set({ autoOpen: e.target.checked })} />
            <span>Відкривати кнопку автоматично</span>
          </label>
          {num('buzzSeconds', 'Час на натискання', 'с', 2, 60)}
          {num('answerSeconds', 'Час на відповідь', 'с', 3, 120)}
          {num('buzzWindowMs', 'Вікно анти-пінгу', 'мс', 0, 2000, 50)}
          {num('falseStartMs', 'Блок за фальстарт', 'мс', 0, 5000, 100)}
          {num('finalSeconds', 'Час у фіналі', 'с', 10, 300)}
        </div>
      )}
    </Panel>
  );
}

/** Number input that shows the server value, lets the host type freely, and commits on blur/Enter. Empty input is ignored. */
function SettingInput({ value, min, max, step, onCommit }: { value: number; min: number; max: number; step: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);
  const commit = () => {
    const v = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(v) && v !== value) onCommit(v);
    else setDraft(String(value));
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function SpeakerOn() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
    </svg>
  );
}
function SpeakerOff() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="m23 9-6 6M17 9l6 6" />
    </svg>
  );
}

export { playSfx };
