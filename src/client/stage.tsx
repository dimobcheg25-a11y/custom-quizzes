import { useEffect, useRef, useState } from 'react';
import type { ClientMessage, GameView, QuestionView } from '../shared/protocol';
import { Avatar, Bulbs, Button, Countdown, findPlayer, formatScore, playerName, TimeBar } from './ui';
import { useTicker } from './net';
import { playSfx } from './sound';

interface StageProps {
  s: GameView;
  send: (m: ClientMessage) => void;
  serverNow: () => number;
}

const isHost = (s: GameView) => s.role === 'host';

export function Stage(props: StageProps) {
  const { s } = props;
  switch (s.phase) {
    case 'lobby':
      return <Lobby {...props} />;
    case 'board':
      return <Board {...props} />;
    case 'cat':
      return <Cat {...props} />;
    case 'auction':
      return <Auction {...props} />;
    case 'question':
    case 'reveal':
      return <QuestionStage {...props} />;
    case 'round_end':
      return <RoundEnd {...props} />;
    case 'final_themes':
      return <FinalThemes {...props} />;
    case 'final_bets':
      return <FinalBets {...props} />;
    case 'final_answer':
    case 'final_judging':
    case 'final_reveal':
      return <FinalQuestion {...props} />;
    case 'game_over':
      return <GameOver {...props} />;
  }
}

// ───────────────────────── lobby ─────────────────────────

function Lobby({ s }: StageProps) {
  return (
    <div className="center-stage">
      <p className="eyebrow">Код кімнати</p>
      <div className="room-code">
        {[...s.code].map((ch, i) => (
          <span key={i}>{ch}</span>
        ))}
      </div>
      <h1 className="stage-title">{s.packTitle}</h1>
      <p className="muted">
        {s.players.length === 0 ? 'Поки що нікого немає.' : `Гравців: ${s.players.length}.`}{' '}
        {isHost(s) ? 'Надішліть друзям посилання праворуч і натисніть «Почати гру».' : 'Чекаємо, поки ведучий почне гру.'}
      </p>
      <div className="lobby-players">
        {s.players.map((p) => (
          <div key={p.id} className={`lobby-player ${p.connected ? '' : 'is-offline'}`}>
            <Avatar p={p} size={120} />
            <span className="lobby-player__name">{p.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────── board ─────────────────────────

function Board({ s, send }: StageProps) {
  const b = s.board!;
  const myPick = isHost(s) || (s.meId !== undefined && s.meId === s.chooserId);
  const cols = Math.max(...b.themes.map((t) => t.questions.length));
  const chooser = findPlayer(s, s.chooserId);
  // Nothing played yet = the round has just started: light the cells up one by one.
  const fresh = b.themes.every((t) => t.questions.every((q) => !q.played));
  return (
    <div className={`board-wrap ${fresh ? 'board--fresh' : ''}`}>
      <div className="board-head">
        <div>
          <p className="eyebrow">
            Раунд {b.index + 1} / {b.total}
          </p>
          <h2 className="board-title">{b.name}</h2>
        </div>
        <div className={`chooser-note ${s.meId && s.meId === s.chooserId ? 'is-me' : ''}`}>
          {chooser ? (
            s.meId === chooser.id ? (
              <>Ваш вибір — оберіть питання</>
            ) : (
              <>
                <Avatar p={chooser} size={36} /> Обирає {chooser.name}
                {isHost(s) && <span className="muted"> · ви теж можете обрати</span>}
              </>
            )
          ) : (
            <>Питання обирає ведучий</>
          )}
        </div>
      </div>
      <div className="board-frame">
        <Bulbs />
        <div className="board" style={{ ['--cols' as string]: cols }} role="grid">
        {b.themes.map((t, ti) => (
          <div className="board-row" role="row" key={ti}>
            <div className="board-theme" role="rowheader">
              {t.name}
            </div>
            {Array.from({ length: cols }, (_, qi) => {
              const q = t.questions[qi];
              if (!q) return <div key={qi} className="board-cell is-void" />;
              return (
                <button
                  key={qi}
                  role="gridcell"
                  className={`board-cell ${q.played ? 'is-played' : ''}`}
                  style={{ ['--i' as string]: ti + qi }}
                  disabled={q.played || !myPick}
                  onClick={() => send({ t: 'pick', theme: ti, question: qi })}
                  aria-label={`${t.name}, ${q.price}`}
                >
                  {q.played ? '' : q.price}
                </button>
              );
            })}
          </div>
        ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── special questions ─────────────────────────

function SpecialHeader({ kind, theme, price }: { kind: string; theme: string; price?: number | string }) {
  return (
    <div className="special-head">
      <span className="badge badge--accent">{kind}</span>
      <h2 className="stage-title">{theme}</h2>
      {price !== undefined && <p className="special-price">{price}</p>}
    </div>
  );
}

function Cat({ s, send }: StageProps) {
  const c = s.cat!;
  const canGive = isHost(s) || s.meId === c.giverId;
  const giver = findPlayer(s, c.giverId);
  return (
    <div className="center-stage">
      <SpecialHeader kind="Кіт у мішку" theme={c.theme} price={formatScore(c.price)} />
      {canGive ? (
        <>
          <p className="muted">{isHost(s) && s.meId !== c.giverId ? `Передайте кота за ${giver?.name ?? 'гравця'}:` : 'Кому віддаєте кота?'}</p>
          <div className="choice-grid">
            {s.players
              .filter((p) => p.id !== c.giverId)
              .map((p) => (
                <button key={p.id} className="choice" onClick={() => send({ t: 'cat_give', to: p.id })}>
                  <Avatar p={p} size={64} />
                  <span>{p.name}</span>
                  <span className="muted">{formatScore(p.score)}</span>
                </button>
              ))}
          </div>
        </>
      ) : (
        <p className="muted">{giver ? `${giver.name} вирішує, кому віддати кота…` : 'Ведучий вирішує, кому віддати кота…'}</p>
      )}
    </div>
  );
}

function Auction({ s, send }: StageProps) {
  const a = s.auction!;
  const q = s.question!;
  const me = findPlayer(s, s.meId);
  const myTurn = !!me && a.turnId === me.id;
  const max = me ? Math.max(me.score, a.nominal) : 0;
  const min = a.bid ? a.bid.amount + 100 : a.nominal;
  const [amount, setAmount] = useState(min);
  useEffect(() => setAmount(Math.min(max, min)), [min, max]);
  const canBid = myTurn && (!a.bid || max > a.bid.amount);

  return (
    <div className="center-stage">
      <SpecialHeader kind="Аукціон" theme={q.themeName} price={`від ${formatScore(a.nominal)}`} />
      <ul className="auction-list">
        {s.players.map((p) => {
          const leader = a.bid?.playerId === p.id;
          const passed = a.passed.includes(p.id);
          return (
            <li key={p.id} className={`auction-row ${a.turnId === p.id ? 'is-turn' : ''} ${passed ? 'is-passed' : ''}`}>
              <Avatar p={p} size={48} />
              <span className="auction-name">{p.name}</span>
              <span className="auction-state">
                {leader ? (
                  <b>
                    {formatScore(a.bid!.amount)}
                    {a.bid!.allIn ? ' · ва-банк' : ''}
                  </b>
                ) : passed ? (
                  'пас'
                ) : a.turnId === p.id ? (
                  'думає…'
                ) : (
                  ''
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {myTurn && (
        <div className="auction-controls">
          {canBid && min <= max && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                send({ t: 'auction_bid', amount });
              }}
            >
              <input type="number" min={min} max={max} step={100} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Ставка" />
              <Button variant="primary" type="submit">
                Ставка
              </Button>
            </form>
          )}
          {canBid && (
            <Button onClick={() => send({ t: 'auction_allin' })}>Ва-банк ({formatScore(max)})</Button>
          )}
          <Button variant="ghost" onClick={() => send({ t: 'auction_pass' })}>
            {!a.bid && me && me.id === a.turnId && a.passed.length === 0 && isFirst(s) ? `Грати за ${formatScore(a.nominal)}` : 'Пас'}
          </Button>
        </div>
      )}
      {!myTurn && a.turnId && <p className="muted">Хід гравця {playerName(s, a.turnId)}</p>}
    </div>
  );
}

/** The chooser opens an auction; their "pass" without a bid means playing for the nominal. */
function isFirst(s: GameView) {
  return s.auction?.turnId === s.chooserId;
}

// ───────────────────────── question ─────────────────────────

function QuestionStage({ s, send, serverNow }: StageProps) {
  const q = s.question!;
  const b = s.buzz;
  const kind = q.kind === 'cat' ? 'Кіт у мішку' : q.kind === 'auction' ? 'Аукціон' : null;
  const solo = b?.solo ? findPlayer(s, b.answeringId) : undefined;
  const answering = s.phase === 'question' && b?.stage === 'answering' ? findPlayer(s, b.answeringId) : undefined;
  return (
    <div className="question-stage">
      <div className="question-head">
        <span className="question-theme">{q.themeName}</span>
        <span className="question-price">{formatScore(q.price)}</span>
        {kind && <span className="badge badge--accent">{kind}</span>}
        {solo && !answering && (
          <span className="question-solo">
            <Avatar p={solo} size={36} /> відповідає {solo.name}
          </span>
        )}
      </div>
      <QuestionBody q={q} s={s} send={send} />
      {answering && (
        <div className="lower-third" key={answering.id}>
          <Avatar p={answering} size={64} />
          <div className="lower-third__text">
            <span className="lower-third__name">{answering.name}</span>
            <span className="lower-third__role">{answering.id === s.meId ? 'ваша відповідь' : 'відповідає'}</span>
          </div>
        </div>
      )}
      {s.phase === 'question' && b && (
        <div className="question-timer">
          {b.stage === 'reading' && b.autoOpenAt && (
            <TimeBar deadline={b.autoOpenAt} total={Math.max(1, b.autoOpenAt - (b.readingSince ?? s.serverNow))} serverNow={serverNow} tone="muted" />
          )}
          {b.stage === 'open' && b.windowEndsAt ? (
            <TimeBar deadline={b.windowEndsAt} total={s.settings.randomWindowSeconds * 1000} serverNow={serverNow} />
          ) : b.stage === 'open' && b.deadline ? (
            <TimeBar deadline={b.deadline} total={s.settings.buzzSeconds * 1000} serverNow={serverNow} />
          ) : null}
          {b.stage === 'open' && !b.deadline && !b.windowEndsAt && <p className="question-hint">Кнопка відкрита — можна натискати, поки грає</p>}
          {b.stage === 'answering' && <TimeBar deadline={b.deadline} total={s.settings.answerSeconds * 1000} serverNow={serverNow} />}
          {b.stage === 'open' && b.pressed && b.pressed.length > 0 && (
            <div className="pressed">
              <span className="pressed__label">
                Натиснули · ще <Countdown deadline={b.windowEndsAt} serverNow={serverNow} /> с
              </span>
              {b.pressed.map((id) => {
                const p = findPlayer(s, id);
                return p ? (
                  <span key={id} className="pressed__who">
                    <Avatar p={p} size={40} /> {p.name}
                  </span>
                ) : null;
              })}
            </div>
          )}
        </div>
      )}
      {s.phase === 'question' && b?.stage === 'roulette' && b.roulette && <Roulette s={s} r={b.roulette} serverNow={serverNow} />}
      {s.phase === 'reveal' && <Reveal q={q} s={s} />}
    </div>
  );
}

function QuestionBody({ q, s, send }: { q: QuestionView; s: GameView; send: StageProps['send'] }) {
  const long = q.text.length > 140;
  return (
    <div className={`question-body ${q.media ? 'has-media' : ''}`}>
      {q.media && (
        <MediaView
          key={`${q.media.url}#${q.mediaNonce}`}
          url={q.media.url}
          kind={q.media.kind}
          onEnded={isHost(s) ? () => send({ t: 'media_ended' }) : undefined}
          paused={
            (s.phase === 'reveal' && !!q.answerMedia) ||
            s.phase === 'final_judging' ||
            s.phase === 'final_reveal' ||
            // Pause while someone answers (or is being drawn); it resumes from the same spot after a wrong answer.
            (s.phase === 'question' && !!s.buzz && !s.buzz.solo && (s.buzz.stage === 'answering' || s.buzz.stage === 'roulette'))
          }
        />
      )}
      {q.text && <p className={`question-text ${long ? 'is-long' : ''} ${q.media ? 'is-caption' : ''}`}>{q.text}</p>}
    </div>
  );
}

/** Ease-out schedule of highlight steps that ends on the winner. Same on every client (driven by server time). */
function rouletteSteps(n: number, winnerIdx: number) {
  let total = Math.max(14, n * 4);
  while ((total - 1) % n !== winnerIdx) total++;
  // step k happens at fraction t_k of the animation; f(t) = 1 - (1 - t)^3 is fast at first, slow at the end
  return Array.from({ length: total }, (_, k) => 1 - Math.cbrt(1 - k / (total - 1)));
}

function Roulette({ s, r, serverNow }: { s: GameView; r: NonNullable<GameView['buzz']>['roulette'] & {}; serverNow: () => number }) {
  useTicker(true, 30);
  const n = r.candidates.length;
  const winnerIdx = Math.max(0, r.candidates.indexOf(r.winnerId));
  const steps = useRef(rouletteSteps(n, winnerIdx)).current;
  const anim = (r.endsAt - r.startedAt) * 0.78; // land, then hold on the winner
  const t = Math.min(1, Math.max(0, (serverNow() - r.startedAt) / anim));
  let k = 0;
  while (k + 1 < steps.length && steps[k + 1] <= t) k++;
  const active = k % n;
  const landed = k === steps.length - 1;

  const last = useRef(-1);
  useEffect(() => {
    if (k !== last.current) {
      last.current = k;
      playSfx('tick');
    }
  }, [k]);

  return (
    <div className={`roulette ${landed ? 'is-landed' : ''}`} role="status" aria-live="polite">
      <div className="roulette__beams" aria-hidden />
      <p className="roulette__title">{landed ? `Відповідає ${playerName(s, r.winnerId)}!` : 'Хто відповідатиме?'}</p>
      <div className="roulette__row">
        {r.candidates.map((id, i) => {
          const p = findPlayer(s, id);
          if (!p) return null;
          return (
            <div key={id} className={`roulette__slot ${i === active ? 'is-active' : ''} ${landed && i === active ? 'is-winner' : ''}`} style={{ ['--ring' as string]: p.color }}>
              <Avatar p={p} size={n > 4 ? 84 : 112} />
              <span>{p.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Reveal({ q, s }: { q: QuestionView; s: GameView }) {
  return (
    <div className="reveal">
      <p className="eyebrow">Правильна відповідь</p>
      <p className="reveal-answer">{q.answer}</p>
      {q.answerMedia && <MediaView key={q.answerMedia.url} url={q.answerMedia.url} kind={q.answerMedia.kind} compact />}
      {q.comment && <p className="reveal-comment">{q.comment}</p>}
      {s.results.length > 0 && (
        <ul className="results">
          {s.results.map((r, i) => (
            <li key={i} className={r.correct ? 'is-good' : 'is-bad'}>
              {playerName(s, r.playerId)} <b>{r.delta > 0 ? `+${formatScore(r.delta)}` : formatScore(r.delta)}</b>
            </li>
          ))}
        </ul>
      )}
      {s.results.length === 0 && <p className="muted">Ніхто не відповів.</p>}
    </div>
  );
}

/** Image / audio / video with autoplay and a fallback button when the browser blocks sound. */
export function MediaView({
  url,
  kind,
  onEnded,
  compact,
  paused,
}: {
  url: string;
  kind: 'image' | 'audio' | 'video';
  onEnded?: () => void;
  compact?: boolean;
  paused?: boolean;
}) {
  const ref = useRef<HTMLMediaElement>(null);
  const [blocked, setBlocked] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || paused || el.ended) return;
    el.play().then(
      () => setBlocked(false),
      (e: DOMException) => setBlocked(e?.name === 'NotAllowedError'),
    );
  }, [url, paused]);

  useEffect(() => {
    if (paused) ref.current?.pause();
  }, [paused]);

  if (failed) return <p className="media-error">Не вдалося завантажити медіафайл</p>;
  if (kind === 'image') return <img className={`media media--image ${compact ? 'is-compact' : ''}`} src={url} alt="" onError={() => setFailed(true)} />;

  const common = {
    src: url,
    preload: 'auto' as const,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => {
      setPlaying(false);
      onEnded?.();
    },
    onError: () => {
      setFailed(true);
      onEnded?.(); // let the host's auto-open proceed
    },
  };
  const play = () => ref.current?.play().then(() => setBlocked(false), () => setBlocked(true));

  return (
    <div className={`media media--${kind} ${compact ? 'is-compact' : ''}`}>
      {kind === 'video' ? (
        <video ref={ref as React.RefObject<HTMLVideoElement>} playsInline {...common} />
      ) : (
        <>
          <audio ref={ref as React.RefObject<HTMLAudioElement>} {...common} />
          <div className={`eq ${playing ? 'is-playing' : ''}`} aria-label={playing ? 'Грає аудіо' : 'Аудіо'}>
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} style={{ animationDelay: `${(i % 4) * 0.12}s` }} />
            ))}
          </div>
        </>
      )}
      {blocked && (
        <button className="media-unblock" onClick={play}>
          ▶ Увімкнути звук
        </button>
      )}
      {!blocked && !playing && !paused && kind === 'audio' && (
        <button className="media-replay" onClick={play}>
          ▶ Ще раз у себе
        </button>
      )}
    </div>
  );
}

// ───────────────────────── round end / game over ─────────────────────────

function Standings({ s }: { s: GameView }) {
  const sorted = [...s.players].sort((a, b) => b.score - a.score);
  return (
    <ol className="standings">
      {sorted.map((p, i) => (
        <li key={p.id} className={i === 0 ? 'is-first' : ''}>
          <span className="standings-pos">{i + 1}</span>
          <Avatar p={p} size={64} />
          <span className="standings-name">{p.name}</span>
          <span className="standings-score">{formatScore(p.score)}</span>
        </li>
      ))}
    </ol>
  );
}

function RoundEnd({ s }: StageProps) {
  return (
    <div className="center-stage">
      <p className="eyebrow">Раунд завершено</p>
      <h1 className="stage-title">{s.board?.name}</h1>
      <Standings s={s} />
      {!isHost(s) && <p className="muted">Ведучий скоро почне наступний раунд.</p>}
    </div>
  );
}

function GameOver({ s }: StageProps) {
  const best = Math.max(...s.players.map((p) => p.score));
  const winners = s.players.filter((p) => p.score === best);
  return (
    <div className="center-stage">
      <p className="eyebrow">Гру завершено</p>
      {winners.length === 1 && <h1 className="stage-title">Перемога: {winners[0].name}</h1>}
      {winners.length > 1 && <h1 className="stage-title">Нічия: {winners.map((w) => w.name).join(', ')}</h1>}
      <Standings s={s} />
      <a className="btn btn--ghost" href="/">
        На головну
      </a>
    </div>
  );
}

// ───────────────────────── final ─────────────────────────

function FinalThemes({ s, send }: StageProps) {
  const f = s.final!;
  const myTurn = isHost(s) || s.meId === f.turnId;
  return (
    <div className="center-stage">
      <p className="eyebrow">Фінал</p>
      <h1 className="stage-title">Прибираємо теми</h1>
      <p className="muted">
        {s.meId === f.turnId ? 'Ваш хід: приберіть одну тему.' : `Прибирає ${playerName(s, f.turnId)}.`}
        {isHost(s) && s.meId !== f.turnId && ' Можна прибрати за гравця.'}
      </p>
      <div className="final-themes">
        {f.themes.map((t, i) => (
          <button key={i} className={`final-theme ${t.removed ? 'is-removed' : ''}`} disabled={t.removed || !myTurn} onClick={() => send({ t: 'final_remove', theme: i })}>
            {t.name}
          </button>
        ))}
      </div>
      <FinalParticipants s={s} />
    </div>
  );
}

function FinalParticipants({ s, mark }: { s: GameView; mark?: (id: string) => string | null }) {
  const f = s.final!;
  return (
    <div className="final-participants">
      {f.participants.map((id) => {
        const p = findPlayer(s, id);
        if (!p) return null;
        return (
          <span key={id} className="chip">
            <Avatar p={p} size={32} /> {p.name} {mark?.(id) && <b>{mark(id)}</b>}
          </span>
        );
      })}
    </div>
  );
}

function FinalBets({ s, send }: StageProps) {
  const f = s.final!;
  const theme = s.question?.themeName ?? f.themes.find((t) => !t.removed)?.name;
  const me = findPlayer(s, s.meId);
  const participating = !!me && f.participants.includes(me.id);
  const placed = !!me && f.betPlaced.includes(me.id);
  const [bet, setBet] = useState(1);
  return (
    <div className="center-stage">
      <p className="eyebrow">Фінал · ставки</p>
      <h1 className="stage-title">{theme}</h1>
      {participating && !placed && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            send({ t: 'final_bet', amount: bet });
          }}
        >
          <input type="number" min={1} max={me!.score} value={bet} onChange={(e) => setBet(Number(e.target.value))} aria-label="Ставка" autoFocus />
          <Button variant="primary" type="submit">
            Зробити ставку
          </Button>
          <span className="muted">від 1 до {formatScore(me!.score)}</span>
        </form>
      )}
      {placed && <p className="muted">Ставку прийнято. Чекаємо інших.</p>}
      {!participating && !isHost(s) && <p className="muted">У фіналі грають лише гравці з додатним рахунком.</p>}
      <FinalParticipants s={s} mark={(id) => (f.betPlaced.includes(id) ? '✓' : null)} />
    </div>
  );
}

function FinalQuestion({ s, send, serverNow }: StageProps) {
  const f = s.final!;
  const q = s.question!;
  const me = findPlayer(s, s.meId);
  const participating = !!me && f.participants.includes(me.id);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (s.phase !== 'final_answer' || !participating || sent) return;
    const id = setTimeout(() => send({ t: 'final_answer', text, draft: true }), 400);
    return () => clearTimeout(id);
  }, [text, s.phase, participating, sent, send]);
  return (
    <div className="question-stage">
      <div className="question-head">
        <span className="badge badge--accent">Фінал</span>
        <span className="question-theme">{q.themeName}</span>
      </div>
      <QuestionBody q={q} s={s} send={send} />
      {s.phase === 'final_answer' && (
        <>
          <div className="question-timer">
            <TimeBar deadline={f.deadline} total={s.settings.finalSeconds * 1000} serverNow={serverNow} />
          </div>
          {participating && (
            <form
              className="inline-form final-answer-form"
              onSubmit={(e) => {
                e.preventDefault();
                send({ t: 'final_answer', text });
                setSent(true);
              }}
            >
              <input value={text} onChange={(e) => (setText(e.target.value), setSent(false))} placeholder="Ваша відповідь" maxLength={200} autoFocus aria-label="Ваша відповідь" />
              <Button variant="primary" type="submit" disabled={!text.trim()}>
                {sent ? 'Надіслано ✓' : 'Надіслати'}
              </Button>
              <Countdown deadline={f.deadline} serverNow={serverNow} />
            </form>
          )}
          <FinalParticipants s={s} mark={(id) => (f.answered.includes(id) ? '✓' : null)} />
        </>
      )}
      {s.phase === 'final_judging' && <p className="muted center">Ведучий перевіряє відповіді…</p>}
      {s.phase === 'final_reveal' && (
        <div className="reveal">
          <p className="eyebrow">Правильна відповідь</p>
          <p className="reveal-answer">{q.answer}</p>
          {q.comment && <p className="reveal-comment">{q.comment}</p>}
          <table className="final-table">
            <tbody>
              {(f.entries ?? []).map((e) => (
                <tr key={e.playerId} className={e.correct ? 'is-good' : 'is-bad'}>
                  <td>{playerName(s, e.playerId)}</td>
                  <td className="final-table-answer">{e.answer || <span className="muted">без відповіді</span>}</td>
                  <td className="num">{e.correct ? `+${formatScore(e.bet)}` : `−${formatScore(e.bet)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
