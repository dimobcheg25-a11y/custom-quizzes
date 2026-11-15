import type { Pack, Question, Media } from '../shared/pack';
import {
  DEFAULT_SETTINGS,
  type AuctionBid,
  type GameEvent,
  type GameView,
  type Phase,
  type QuestionKind,
  type ResultView,
  type Settings,
} from '../shared/protocol';

export interface Scheduler {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** A rejected action. The message is shown to the user who tried it. */
export class GameError extends Error {}

/** Who performs an action: a player id, or the host. */
export type Actor = { host: true } | { host?: false; playerId: string };
export const HOST: Actor = { host: true };
export const player = (playerId: string): Actor => ({ playerId });

interface PlayerState {
  id: string;
  token: string;
  name: string;
  color: string;
  score: number;
  connected: boolean;
  /** False-start block, server epoch ms. */
  blockedUntil: number;
  avatar?: { mime: string; data: Buffer; v: number };
}

interface CurrentQuestion {
  ti: number;
  qi: number;
  q: Question;
  kind: QuestionKind;
  themeName: string;
  /** Effective price: nominal, cat price, or auction stake. */
  price: number;
}

interface BuzzState {
  stage: 'reading' | 'open' | 'answering';
  deadline?: number;
  autoOpenAt?: number;
  readingSince?: number;
  openedAt?: number;
  answeringId?: string;
  lockedOut: Set<string>;
  solo: boolean;
  candidates: { id: string; reactionMs: number }[];
}

interface CatState {
  giverId?: string;
  theme: string;
  price: number;
  receiverId?: string;
}

interface AuctionState {
  nominal: number;
  order: string[];
  turnIdx: number;
  passed: Set<string>;
  bid?: AuctionBid;
}

interface FinalState {
  removed: boolean[];
  order: string[];
  turnIdx: number;
  participants: string[];
  bets: Map<string, number>;
  answers: Map<string, string>;
  submitted: Set<string>;
  judged: Map<string, boolean>;
  deadline?: number;
}

const MAX_PLAYERS = 12;
const MAX_AVATAR_BYTES = 40_000;

export class Game {
  settings: Settings = { ...DEFAULT_SETTINGS };
  phase: Phase = 'lobby';
  players: PlayerState[] = [];
  roundIndex = 0;
  played: boolean[][] = [];
  chooserId?: string;
  cur?: CurrentQuestion;
  buzz?: BuzzState;
  cat?: CatState;
  auction?: AuctionState;
  final?: FinalState;
  results: ResultView[] = [];
  mediaNonce = 0;
  hostConnected = false;

  private timers = new Map<string, unknown>();
  private kickedTokens = new Set<string>();
  /** State before the last verdict, so the host can undo a misclick. */
  private lastJudge?: { scores: Map<string, number>; chooserId?: string; results: ResultView[]; answeringId: string; lockedOut: Set<string>; solo: boolean };
  private nextId = 1;

  constructor(
    readonly code: string,
    readonly packId: string,
    readonly pack: Pack,
    private readonly sched: Scheduler = realScheduler,
    private readonly onChange: () => void = () => {},
    private readonly onEvent: (name: GameEvent, playerId?: string) => void = () => {},
  ) {}

  // ───────────────────────── players ─────────────────────────

  /** Join or reconnect by secret token. Returns the public player id. */
  join(token: string, name: string, color: string): string {
    name = name.trim().slice(0, 24);
    if (!name) throw new GameError("Вкажіть ім'я");
    const existing = this.players.find((p) => p.token === token);
    if (existing) {
      existing.name = name;
      existing.color = color;
      existing.connected = true;
      this.changed();
      return existing.id;
    }
    if (this.kickedTokens.has(token)) throw new GameError('Ведучий прибрав вас із цієї гри');
    const sameName = this.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (sameName) {
      // Same name on another device or after clearing the browser: take over the seat if it is offline.
      if (sameName.connected) throw new GameError("Це ім'я вже зайняте");
      sameName.token = token;
      sameName.color = color;
      sameName.connected = true;
      this.changed();
      return sameName.id;
    }
    if (this.players.length >= MAX_PLAYERS) throw new GameError('Кімната заповнена');
    const p: PlayerState = { id: `p${this.nextId++}`, token, name, color, score: 0, connected: true, blockedUntil: 0 };
    this.players.push(p);
    this.changed();
    return p.id;
  }

  /** A player sets (data URL) or clears (null) their photo. */
  setAvatar(by: Actor, dataUrl: string | null) {
    const p = 'playerId' in by ? this.get(by.playerId) : undefined;
    if (!p) throw new GameError('Аватарку може змінити лише гравець');
    if (dataUrl === null) {
      p.avatar = undefined;
    } else {
      const m = typeof dataUrl === 'string' ? dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/) : null;
      if (!m) throw new GameError('Непідтримуваний формат картинки');
      const data = Buffer.from(m[2], 'base64');
      if (data.length > MAX_AVATAR_BYTES) throw new GameError('Картинка завелика');
      p.avatar = { mime: m[1], data, v: (p.avatar?.v ?? 0) + 1 };
    }
    this.changed();
  }

  avatarOf(id: string) {
    return this.get(id)?.avatar;
  }

  setConnected(id: string, connected: boolean) {
    const p = this.get(id);
    if (p) {
      p.connected = connected;
      this.changed();
    }
  }

  setHostConnected(connected: boolean) {
    this.hostConnected = connected;
    this.changed();
  }

  kick(by: Actor, id: string) {
    this.requireHost(by);
    const p = this.get(id);
    if (!p) return;
    this.players = this.players.filter((x) => x.id !== id);
    this.kickedTokens.add(p.token);
    this.lastJudge = undefined;
    if (this.chooserId === id) this.chooserId = undefined;

    if (this.phase === 'cat' && this.cat && (this.cat.giverId === id || this.cat.receiverId === id)) return this.revealNow();
    if (this.phase === 'auction' && this.auction) {
      if (this.auction.bid?.playerId === id) return this.revealNow();
      const a = this.auction;
      const idx = a.order.indexOf(id);
      const wasTurn = idx === a.turnIdx;
      a.order = a.order.filter((x) => x !== id);
      a.passed.delete(id);
      if (idx >= 0 && idx <= a.turnIdx) a.turnIdx--; // keep pointing at the same player (or just before the next one)
      if (wasTurn) return this.advanceAuction();
      if (this.finishAuctionIfDone()) return;
      return this.changed();
    }
    if (this.phase === 'question' && this.buzz) {
      this.buzz.candidates = this.buzz.candidates.filter((c) => c.id !== id);
      if (this.buzz.answeringId === id) {
        if (this.buzz.solo) return this.revealNow();
        return this.reopenOrReveal();
      }
    }
    if (this.final) {
      const f = this.final;
      const idx = f.order.indexOf(id);
      const wasTurn = idx === f.turnIdx;
      f.participants = f.participants.filter((x) => x !== id);
      f.order = f.order.filter((x) => x !== id);
      f.bets.delete(id);
      f.answers.delete(id);
      f.submitted.delete(id);
      f.judged.delete(id);
      if (f.participants.length === 0 && this.phase.startsWith('final')) return this.gameOver();
      if (this.phase === 'final_themes' && idx >= 0) {
        if (idx < f.turnIdx) f.turnIdx--;
        if (wasTurn) f.turnIdx = f.turnIdx % f.order.length;
      }
      this.checkFinalProgress();
    }
    this.changed();
  }

  // ───────────────────────── host flow ─────────────────────────

  start(by: Actor) {
    this.requireHost(by);
    if (this.phase !== 'lobby') throw new GameError('Гра вже почалася');
    if (this.players.length === 0) throw new GameError('Немає жодного гравця');
    const pick = this.players[Math.floor(Math.random() * this.players.length)];
    this.chooserId = pick.id;
    this.enterRound(0);
  }

  nextRound(by: Actor) {
    this.requireHost(by);
    if (this.phase !== 'round_end') throw new GameError('Раунд ще не завершено');
    this.enterRound(this.roundIndex + 1);
  }

  /** Host ends the current normal round early. */
  endRound(by: Actor) {
    this.requireHost(by);
    if (this.phase !== 'board') throw new GameError('Завершити раунд можна лише з табло');
    this.played = this.played.map((t) => t.map(() => true));
    this.afterQuestion();
  }

  setScore(by: Actor, id: string, score: number) {
    this.requireHost(by);
    const p = this.get(id);
    if (!p) throw new GameError('Гравця не знайдено');
    if (!Number.isFinite(score)) throw new GameError('Невірний рахунок');
    p.score = Math.round(score);
    this.changed();
  }

  setChooser(by: Actor, id: string) {
    this.requireHost(by);
    if (!this.get(id)) throw new GameError('Гравця не знайдено');
    this.chooserId = id;
    if (this.cat && this.phase === 'cat') this.cat.giverId = id;
    this.changed();
  }

  updateSettings(by: Actor, s: Partial<Settings>) {
    this.requireHost(by);
    const num = (v: unknown, min: number, max: number, def: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
    const c = this.settings;
    this.settings = {
      buzzSeconds: num(s.buzzSeconds, 2, 60, c.buzzSeconds),
      answerSeconds: num(s.answerSeconds, 3, 120, c.answerSeconds),
      buzzWindowMs: num(s.buzzWindowMs, 0, 2000, c.buzzWindowMs),
      falseStartMs: num(s.falseStartMs, 0, 5000, c.falseStartMs),
      autoOpen: typeof s.autoOpen === 'boolean' ? s.autoOpen : c.autoOpen,
      finalSeconds: num(s.finalSeconds, 10, 300, c.finalSeconds),
    };
    if (!this.settings.autoOpen && this.buzz?.autoOpenAt) {
      const h = this.timers.get('autoOpen');
      if (h !== undefined) this.sched.clear(h);
      this.timers.delete('autoOpen');
      this.buzz.autoOpenAt = undefined;
    }
    this.changed();
  }

  // ───────────────────────── board ─────────────────────────

  pick(by: Actor, ti: number, qi: number) {
    if (this.phase !== 'board') throw new GameError('Зараз не можна обирати питання');
    if (!by.host && by.playerId !== this.chooserId) throw new GameError('Зараз обирає інший гравець');
    const round = this.round();
    const q = round.themes[ti]?.questions[qi];
    if (!q) throw new GameError('Питання не знайдено');
    if (this.played[ti][qi]) throw new GameError('Це питання вже зіграно');

    this.played[ti][qi] = true;
    this.results = [];
    this.mediaNonce = 0;
    this.cur = { ti, qi, q, kind: q.type, themeName: round.themes[ti].name, price: q.price };

    if (q.type === 'cat') {
      if (this.players.length <= 1) {
        // Nobody to give the cat to: the only player takes it.
        this.cur.price = q.catPrice ?? q.price;
        this.cur.themeName = q.catTheme ?? this.cur.themeName;
        return this.startQuestion(this.players[0]?.id);
      }
      this.phase = 'cat';
      this.cat = { giverId: this.chooserId, theme: q.catTheme ?? round.themes[ti].name, price: q.catPrice ?? q.price };
      return this.changed();
    }

    if (q.type === 'auction') {
      if (this.players.length <= 1) return this.startQuestion(this.players[0]?.id);
      const startIdx = Math.max(0, this.players.findIndex((p) => p.id === this.chooserId));
      const order = [...this.players.slice(startIdx), ...this.players.slice(0, startIdx)].map((p) => p.id);
      this.phase = 'auction';
      this.auction = { nominal: q.price, order, turnIdx: 0, passed: new Set() };
      this.onEvent('question');
      return this.changed();
    }

    this.startQuestion();
  }

  // ───────────────────────── cat in the bag ─────────────────────────

  catGive(by: Actor, to: string) {
    if (this.phase !== 'cat' || !this.cat || !this.cur) throw new GameError('Зараз немає кота в мішку');
    if (!by.host && by.playerId !== this.cat.giverId) throw new GameError('Кота передає інший гравець');
    if (!this.get(to)) throw new GameError('Гравця не знайдено');
    if (to === this.cat.giverId) throw new GameError('Кота треба віддати іншому гравцю');
    this.cat.receiverId = to;
    this.cur.price = this.cat.price;
    this.cur.themeName = this.cat.theme;
    this.startQuestion(to);
  }

  // ───────────────────────── auction ─────────────────────────

  private auctionMax(id: string) {
    const p = this.get(id)!;
    return Math.max(p.score, this.auction!.nominal);
  }

  private requireAuctionTurn(by: Actor): string {
    const a = this.auction;
    if (this.phase !== 'auction' || !a) throw new GameError('Зараз немає аукціону');
    const turn = a.order[a.turnIdx];
    if (!by.host && by.playerId !== turn) throw new GameError('Зараз хід іншого гравця');
    return turn;
  }

  auctionBid(by: Actor, amount: number) {
    const id = this.requireAuctionTurn(by);
    if (by.host) throw new GameError('Ставку робить гравець');
    const a = this.auction!;
    const max = this.auctionMax(id);
    if (!Number.isInteger(amount)) throw new GameError('Ставка має бути цілим числом');
    if (amount < a.nominal) throw new GameError(`Мінімальна ставка ${a.nominal}`);
    if (a.bid && amount <= a.bid.amount) throw new GameError(`Ставка має бути більшою за ${a.bid.amount}`);
    if (amount > max) throw new GameError(`Максимальна ставка ${max}`);
    a.bid = { playerId: id, amount, allIn: amount === max };
    this.advanceAuction();
  }

  auctionAllIn(by: Actor) {
    const id = this.requireAuctionTurn(by);
    if (by.host) throw new GameError('Ставку робить гравець');
    const a = this.auction!;
    const max = this.auctionMax(id);
    if (a.bid && max <= a.bid.amount) throw new GameError('Ва-банк менший за поточну ставку');
    a.bid = { playerId: id, amount: max, allIn: true };
    this.advanceAuction();
  }

  auctionPass(by: Actor) {
    const id = this.requireAuctionTurn(by);
    const a = this.auction!;
    if (!a.bid && id === a.order[0]) {
      // The chooser opens the auction: passing on the first move means playing for the nominal.
      a.bid = { playerId: id, amount: a.nominal, allIn: false };
      return this.advanceAuction();
    }
    a.passed.add(id);
    this.advanceAuction();
  }

  /** Move the turn forward, auto-passing players who cannot outbid, and finish when one bidder remains. */
  private advanceAuction() {
    const a = this.auction!;
    for (let guard = 0; guard < a.order.length * 2 + 2; guard++) {
      if (this.finishAuctionIfDone()) return;
      a.turnIdx = (a.turnIdx + 1) % a.order.length;
      const turn = a.order[a.turnIdx];
      if (a.passed.has(turn)) continue;
      if (a.bid?.playerId === turn) continue; // the leader does not bid against themselves
      if (a.bid && this.auctionMax(turn) <= a.bid.amount) {
        a.passed.add(turn);
        continue;
      }
      return this.changed();
    }
    this.changed();
  }

  /** Ends the auction when a single bidder is left. Returns true if it ended. */
  private finishAuctionIfDone(): boolean {
    const a = this.auction!;
    const active = a.order.filter((id) => !a.passed.has(id));
    if (active.length === 0) {
      this.revealNow();
      return true;
    }
    if (active.length === 1 && (!a.bid || a.bid.playerId === active[0])) {
      this.cur!.price = a.bid?.amount ?? a.nominal;
      this.startQuestion(active[0]);
      return true;
    }
    return false;
  }

  // ───────────────────────── question ─────────────────────────

  /** Start the question. With `soloId`, that player answers directly (cat, auction). */
  private startQuestion(soloId?: string) {
    const cur = this.cur!;
    this.clearTimers();
    this.cat = this.phase === 'cat' ? this.cat : undefined;
    this.phase = 'question';
    this.buzz = { stage: 'reading', lockedOut: new Set(), solo: !!soloId, candidates: [] };
    for (const p of this.players) p.blockedUntil = 0;

    if (soloId) {
      this.buzz.stage = 'answering';
      this.buzz.answeringId = soloId;
      const extra = cur.q.media && cur.q.media.kind !== 'image' ? 15 : 0;
      this.buzz.deadline = this.sched.now() + (this.settings.answerSeconds + extra) * 1000;
    } else if (this.settings.autoOpen && !this.hasPlayableMedia()) {
      const ms = readingMs(cur.q.text, !!cur.q.media);
      this.buzz.readingSince = this.sched.now();
      this.buzz.autoOpenAt = this.sched.now() + ms;
      this.timer('autoOpen', ms, () => this.openBuzzerNow());
    }
    this.onEvent('question');
    this.changed();
  }

  private hasPlayableMedia() {
    const k = this.cur?.q.media?.kind;
    return k === 'audio' || k === 'video';
  }

  openBuzzer(by: Actor) {
    this.requireHost(by);
    if (this.phase !== 'question' || !this.buzz || this.buzz.solo) throw new GameError('Зараз не можна відкрити кнопку');
    if (this.buzz.stage !== 'reading') return;
    this.openBuzzerNow();
  }

  /** Host's client reports that audio/video finished: open the buzzer if auto mode is on. */
  mediaEnded(by: Actor) {
    this.requireHost(by);
    if (this.settings.autoOpen && this.phase === 'question' && this.buzz?.stage === 'reading' && !this.buzz.solo) this.openBuzzerNow();
  }

  replayMedia(by: Actor) {
    this.requireHost(by);
    if (!this.cur) return;
    this.mediaNonce++;
    this.changed();
  }

  private openBuzzerNow() {
    const b = this.buzz!;
    this.clearTimers();
    b.stage = 'open';
    b.autoOpenAt = undefined;
    b.answeringId = undefined;
    b.candidates = [];
    b.openedAt = this.sched.now();
    b.deadline = b.openedAt + this.settings.buzzSeconds * 1000;
    this.timer('buzzTimeout', this.settings.buzzSeconds * 1000, () => {
      if (this.buzz?.candidates.length) return this.resolveBuzz();
      this.onEvent('timeout');
      this.revealNow();
    });
    this.changed();
  }

  buzzIn(by: Actor, reactionMs: number) {
    if (by.host) return;
    const id = by.playerId;
    const b = this.buzz;
    const p = this.get(id);
    if (this.phase !== 'question' || !b || b.solo || !p) return;
    if (b.lockedOut.has(id)) return;
    const now = this.sched.now();

    // reactionMs < 0 means the client pressed before it saw the buzzer open: that is a false start too.
    if (b.stage === 'reading' || (b.stage === 'open' && reactionMs < 0)) {
      if (this.settings.falseStartMs > 0) {
        p.blockedUntil = now + this.settings.falseStartMs;
        this.onEvent('false_start', id);
      }
      return;
    }
    // Spamming the button while someone else answers would give a near-zero reaction when the buzzer reopens.
    if (b.stage === 'answering' && b.answeringId !== id) {
      if (this.settings.falseStartMs > 0) {
        p.blockedUntil = now + this.settings.falseStartMs;
        this.onEvent('false_start', id);
      }
      return;
    }
    if (b.stage !== 'open') return;
    if (now < p.blockedUntil) return;
    if (b.candidates.some((c) => c.id === id)) return;

    const elapsed = now - (b.openedAt ?? now);
    const reaction = Number.isFinite(reactionMs) ? Math.min(Math.max(0, reactionMs), elapsed) : elapsed;
    b.candidates.push({ id, reactionMs: reaction });
    if (b.candidates.length === 1) {
      if (this.settings.buzzWindowMs <= 0) return this.resolveBuzz();
      this.timer('buzzWindow', this.settings.buzzWindowMs, () => this.resolveBuzz());
    }
  }

  private resolveBuzz() {
    const b = this.buzz!;
    if (b.stage !== 'open' || b.candidates.length === 0) return;
    // Fastest by client-measured reaction; ties go to the earliest arrival (stable sort).
    const winner = [...b.candidates].sort((x, y) => x.reactionMs - y.reactionMs)[0];
    this.clearTimers();
    b.stage = 'answering';
    b.answeringId = winner.id;
    b.candidates = [];
    b.deadline = this.sched.now() + this.settings.answerSeconds * 1000;
    this.onEvent('buzz', winner.id);
    this.changed();
  }

  judge(by: Actor, correct: boolean) {
    this.requireHost(by);
    const b = this.buzz;
    if (this.phase !== 'question' || !b || b.stage !== 'answering' || !b.answeringId || !this.cur) throw new GameError('Зараз ніхто не відповідає');
    this.lastJudge = {
      scores: new Map(this.players.map((x) => [x.id, x.score])),
      chooserId: this.chooserId,
      results: [...this.results],
      answeringId: b.answeringId,
      lockedOut: new Set(b.lockedOut),
      solo: b.solo,
    };
    const p = this.get(b.answeringId);
    const delta = correct ? this.cur.price : -this.cur.price;
    if (p) p.score += delta;
    this.results.push({ playerId: b.answeringId, correct, delta });
    this.onEvent(correct ? 'correct' : 'wrong', b.answeringId);
    if (correct) {
      this.chooserId = b.answeringId;
      return this.revealNow();
    }
    b.lockedOut.add(b.answeringId);
    if (b.solo) return this.revealNow();
    this.reopenOrReveal();
  }

  get canUndoJudge() {
    return !!this.lastJudge && (this.phase === 'reveal' || this.phase === 'question');
  }

  /** Host misclicked a verdict: restore scores and give the same player the answer again. */
  undoJudge(by: Actor) {
    this.requireHost(by);
    const u = this.lastJudge;
    if (!u || !this.canUndoJudge || !this.cur) throw new GameError('Немає що скасовувати');
    this.lastJudge = undefined;
    this.clearTimers();
    for (const p of this.players) if (u.scores.has(p.id)) p.score = u.scores.get(p.id)!;
    this.chooserId = u.chooserId;
    this.results = u.results;
    this.phase = 'question';
    this.buzz = {
      stage: 'answering',
      answeringId: u.answeringId,
      lockedOut: u.lockedOut,
      solo: u.solo,
      candidates: [],
      deadline: this.sched.now() + this.settings.answerSeconds * 1000,
    };
    this.changed();
  }

  private reopenOrReveal() {
    const b = this.buzz!;
    const canStill = this.players.some((p) => p.connected && !b.lockedOut.has(p.id));
    if (canStill) this.openBuzzerNow();
    else this.revealNow();
  }

  skipQuestion(by: Actor) {
    this.requireHost(by);
    if (!['question', 'cat', 'auction'].includes(this.phase)) throw new GameError('Немає відкритого питання');
    this.revealNow();
  }

  private revealNow() {
    this.clearTimers();
    this.phase = 'reveal';
    if (this.buzz) {
      this.buzz.deadline = undefined;
      this.buzz.autoOpenAt = undefined;
    }
    this.changed();
  }

  continue(by: Actor) {
    this.requireHost(by);
    if (this.phase === 'reveal') return this.afterQuestion();
    if (this.phase === 'final_bets') return this.finalToAnswer();
    if (this.phase === 'final_answer') return this.finalToJudging();
    if (this.phase === 'final_judging') return this.finalReveal();
    if (this.phase === 'final_reveal') {
      if (this.roundIndex + 1 < this.pack.rounds.length) {
        this.final = undefined;
        this.phase = 'round_end';
        return this.changed();
      }
      return this.gameOver();
    }
    throw new GameError('Немає що продовжувати');
  }

  private afterQuestion() {
    this.clearTimers();
    this.lastJudge = undefined;
    this.cur = undefined;
    this.buzz = undefined;
    this.cat = undefined;
    this.auction = undefined;
    this.results = [];
    const done = this.played.every((t) => t.every(Boolean));
    if (!done) {
      this.phase = 'board';
    } else if (this.roundIndex + 1 < this.pack.rounds.length) {
      this.phase = 'round_end';
    } else {
      this.phase = 'game_over';
    }
    this.changed();
  }

  // ───────────────────────── rounds ─────────────────────────

  private round() {
    return this.pack.rounds[this.roundIndex];
  }

  private enterRound(index: number) {
    this.clearTimers();
    this.roundIndex = index;
    const round = this.round();
    this.played = round.themes.map((t) => t.questions.map(() => false));
    this.cur = undefined;
    this.buzz = undefined;
    this.cat = undefined;
    this.auction = undefined;
    this.results = [];
    if (round.type === 'final') return this.enterFinal();
    if (index > 0 && this.players.length) {
      // The player with the lowest score starts a new round.
      const min = Math.min(...this.players.map((p) => p.score));
      const lowest = this.players.filter((p) => p.score === min);
      if (!lowest.some((p) => p.id === this.chooserId)) this.chooserId = lowest[0].id;
    }
    this.phase = 'board';
    this.onEvent('round_start');
    this.changed();
  }

  // ───────────────────────── final ─────────────────────────

  private enterFinal() {
    const round = this.round();
    const participants = this.players.filter((p) => p.score > 0).map((p) => p.id);
    if (participants.length === 0) return this.gameOver();
    const order = [...participants].sort((a, b) => this.get(a)!.score - this.get(b)!.score);
    this.final = {
      removed: round.themes.map(() => false),
      order,
      turnIdx: 0,
      participants,
      bets: new Map(),
      answers: new Map(),
      submitted: new Set(),
      judged: new Map(),
    };
    this.onEvent('round_start');
    if (round.themes.length === 1) return this.finalToBets();
    this.phase = 'final_themes';
    this.changed();
  }

  finalRemove(by: Actor, ti: number) {
    const f = this.final;
    if (this.phase !== 'final_themes' || !f) throw new GameError('Зараз не можна прибирати теми');
    const turn = f.order[f.turnIdx];
    if (!by.host && by.playerId !== turn) throw new GameError('Зараз хід іншого гравця');
    if (f.removed[ti] !== false) throw new GameError('Цю тему вже прибрано');
    f.removed[ti] = true;
    if (f.removed.filter((r) => !r).length === 1) return this.finalToBets();
    f.turnIdx = (f.turnIdx + 1) % f.order.length;
    this.changed();
  }

  private finalToBets() {
    const f = this.final!;
    const ti = f.removed.findIndex((r) => !r);
    const round = this.round();
    this.played[ti][0] = true;
    this.cur = { ti, qi: 0, q: round.themes[ti].questions[0], kind: 'normal', themeName: round.themes[ti].name, price: 0 };
    this.phase = 'final_bets';
    this.changed();
  }

  finalBet(by: Actor, amount: number) {
    const f = this.final;
    if (this.phase !== 'final_bets' || !f || by.host) throw new GameError('Зараз не можна робити ставку');
    if (!f.participants.includes(by.playerId)) throw new GameError('Ви не берете участі у фіналі');
    const max = this.get(by.playerId)!.score;
    if (!Number.isInteger(amount) || amount < 1 || amount > max) throw new GameError(`Ставка від 1 до ${max}`);
    f.bets.set(by.playerId, amount);
    this.checkFinalProgress();
    this.changed();
  }

  private finalToAnswer() {
    const f = this.final!;
    for (const id of f.participants) if (!f.bets.has(id)) f.bets.set(id, (this.get(id)?.score ?? 0) > 0 ? 1 : 0);
    this.phase = 'final_answer';
    f.deadline = this.sched.now() + this.settings.finalSeconds * 1000;
    this.timer('final', this.settings.finalSeconds * 1000, () => this.finalToJudging());
    this.onEvent('question');
    this.changed();
  }

  /** `submit: false` saves a draft, so a half-typed answer is not lost at the deadline. */
  finalAnswer(by: Actor, text: string, submit = true) {
    const f = this.final;
    if (this.phase !== 'final_answer' || !f || by.host) {
      if (!submit) return;
      throw new GameError('Зараз не можна відповідати');
    }
    if (!f.participants.includes(by.playerId)) throw new GameError('Ви не берете участі у фіналі');
    f.answers.set(by.playerId, String(text ?? '').trim().slice(0, 200));
    if (submit) f.submitted.add(by.playerId);
    this.checkFinalProgress();
    this.changed();
  }

  private finalToJudging() {
    this.clearTimers();
    const f = this.final!;
    f.deadline = undefined;
    this.phase = 'final_judging';
    this.changed();
  }

  finalJudge(by: Actor, id: string, correct: boolean) {
    this.requireHost(by);
    const f = this.final;
    if (this.phase !== 'final_judging' || !f) throw new GameError('Зараз не можна оцінювати фінал');
    if (!f.participants.includes(id)) throw new GameError('Гравець не бере участі у фіналі');
    f.judged.set(id, correct);
    this.checkFinalProgress();
    this.changed();
  }

  private checkFinalProgress() {
    const f = this.final;
    if (!f) return;
    if (this.phase === 'final_bets' && f.participants.every((id) => f.bets.has(id))) return this.finalToAnswer();
    if (this.phase === 'final_answer' && f.participants.every((id) => f.submitted.has(id))) return this.finalToJudging();
  }

  /** Host confirms all verdicts: apply bets and show results. Verdicts can be changed until then. */
  private finalReveal() {
    const f = this.final!;
    const missing = f.participants.filter((id) => !f.judged.has(id));
    if (missing.length) throw new GameError(`Оцініть усі відповіді (залишилось: ${missing.length})`);
    for (const id of f.participants) {
      const p = this.get(id);
      const bet = Math.max(0, f.bets.get(id) ?? 0);
      if (p) p.score += f.judged.get(id) ? bet : -bet;
    }
    this.phase = 'final_reveal';
    this.changed();
  }

  private gameOver() {
    this.clearTimers();
    this.phase = 'game_over';
    this.changed();
  }

  // ───────────────────────── view ─────────────────────────

  view(role: 'host' | 'player', meId?: string): GameView {
    const host = role === 'host';
    const round = this.phase === 'lobby' ? undefined : this.round();
    const showAnswer = host || this.phase === 'reveal' || this.phase === 'final_reveal';
    const media = (m?: Media) => (m ? { ...m, url: mediaUrl(this.packId, m.file) } : undefined);
    const cur = this.cur;
    const showQuestion = cur && !['cat', 'auction', 'final_bets'].includes(this.phase);
    const f = this.final;

    return {
      code: this.code,
      role,
      meId,
      packTitle: this.pack.title,
      phase: this.phase,
      hostConnected: this.hostConnected,
      settings: this.settings,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        score: p.score,
        connected: p.connected,
        avatar: p.avatar && `/api/rooms/${this.code}/avatars/${p.id}?v=${p.avatar.v}`,
      })),
      chooserId: this.chooserId,
      board: round && {
        index: this.roundIndex,
        total: this.pack.rounds.length,
        name: round.name,
        type: round.type,
        themes: round.themes.map((t, ti) => ({
          name: t.name,
          questions: t.questions.map((q, qi) => ({ price: q.price, played: this.played[ti]?.[qi] ?? false })),
        })),
      },
      question: cur && {
        themeIndex: cur.ti,
        questionIndex: cur.qi,
        themeName: cur.themeName,
        price: cur.price,
        kind: cur.kind,
        text: showQuestion || host ? cur.q.text : '',
        media: showQuestion || host ? media(cur.q.media) : undefined,
        answer: showAnswer ? cur.q.answer : undefined,
        answerMedia: showAnswer ? media(cur.q.answerMedia) : undefined,
        comment: showAnswer ? cur.q.comment : undefined,
        hostNote: host ? cur.q.hostNote : undefined,
        mediaNonce: this.mediaNonce,
      },
      buzz: this.buzz && {
        stage: this.buzz.stage,
        deadline: this.buzz.deadline,
        autoOpenAt: this.buzz.autoOpenAt,
        readingSince: this.buzz.readingSince,
        answeringId: this.buzz.answeringId,
        lockedOut: [...this.buzz.lockedOut],
        solo: this.buzz.solo,
      },
      cat: this.cat && { giverId: this.cat.giverId ?? '', theme: this.cat.theme, price: this.cat.price, receiverId: this.cat.receiverId },
      auction: this.auction && {
        nominal: this.auction.nominal,
        turnId: this.phase === 'auction' ? this.auction.order[this.auction.turnIdx] : undefined,
        passed: [...this.auction.passed],
        bid: this.auction.bid,
        winnerId: this.phase !== 'auction' ? this.auction.bid?.playerId : undefined,
      },
      final:
        f && this.phase !== 'game_over'
          ? {
              themes: (round?.themes ?? []).map((t, i) => ({ name: t.name, removed: f.removed[i] })),
              turnId: this.phase === 'final_themes' ? f.order[f.turnIdx] : undefined,
              participants: f.participants,
              betPlaced: [...f.bets.keys()],
              answered: [...f.submitted],
              deadline: f.deadline,
              entries:
                (host && (this.phase === 'final_judging' || this.phase === 'final_answer')) || this.phase === 'final_reveal'
                  ? f.participants.map((id) => ({
                      playerId: id,
                      bet: f.bets.get(id) ?? 0,
                      answer: f.answers.get(id) ?? '',
                      correct: f.judged.get(id),
                    }))
                  : undefined,
            }
          : undefined,
      results: this.results,
      canUndo: host ? this.canUndoJudge : undefined,
      serverNow: this.sched.now(),
    };
  }

  // ───────────────────────── helpers ─────────────────────────

  get(id: string) {
    return this.players.find((p) => p.id === id);
  }

  playerByToken(token: string) {
    return this.players.find((p) => p.token === token);
  }

  private requireHost(by: Actor) {
    if (!by.host) throw new GameError('Це може зробити лише ведучий');
  }

  private timer(name: string, ms: number, fn: () => void) {
    const old = this.timers.get(name);
    if (old !== undefined) this.sched.clear(old);
    this.timers.set(
      name,
      this.sched.set(() => {
        this.timers.delete(name);
        fn();
      }, ms),
    );
  }

  clearTimers() {
    for (const h of this.timers.values()) this.sched.clear(h);
    this.timers.clear();
  }

  private changed() {
    this.onChange();
  }
}

export function readingMs(text: string, hasImage: boolean) {
  const base = 1500 + text.length * 45 + (hasImage ? 1500 : 0);
  return Math.min(10000, Math.max(2500, base));
}

export function mediaUrl(packId: string, file: string) {
  return `/packs/${encodeURIComponent(packId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}
