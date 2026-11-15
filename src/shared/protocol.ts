import type { Media } from './pack';

export interface Settings {
  /** Seconds the buzzer stays open before the question closes unanswered. */
  buzzSeconds: number;
  /** Seconds the answering player has (visual; the host still judges). */
  answerSeconds: number;
  /** Anti-ping window: after the first buzz arrives, wait this long and pick the fastest by client-measured reaction. */
  buzzWindowMs: number;
  /** Pressing before the buzzer opens blocks the player for this long. 0 disables. */
  falseStartMs: number;
  /** Open the buzzer automatically `openDelaySeconds` after the question appears (all question types). */
  autoOpen: boolean;
  /** Same delay for every question before the buzzer opens. Audio/video keep playing after it opens. */
  openDelaySeconds: number;
  /** fastest: the quickest reaction answers. random: everyone who presses within `randomWindowSeconds` of the first press gets a fair random draw. */
  buzzMode: 'fastest' | 'random';
  randomWindowSeconds: number;
  /** Seconds to type an answer in the final round. */
  finalSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  buzzSeconds: 8,
  answerSeconds: 20,
  buzzWindowMs: 350,
  falseStartMs: 1000,
  autoOpen: true,
  openDelaySeconds: 3,
  buzzMode: 'fastest',
  randomWindowSeconds: 3,
  finalSeconds: 60,
};

export type QuestionKind = 'normal' | 'cat' | 'auction';

export interface PlayerView {
  id: string;
  name: string;
  color: string;
  score: number;
  connected: boolean;
  /** URL of the player's photo, if they uploaded one. */
  avatar?: string;
}

export interface BoardView {
  index: number;
  total: number;
  name: string;
  type: 'normal' | 'final';
  themes: { name: string; questions: { price: number; played: boolean }[] }[];
}

export interface QuestionView {
  themeIndex: number;
  questionIndex: number;
  themeName: string;
  price: number;
  kind: QuestionKind;
  text: string;
  media?: Media & { url: string };
  /** Present for the host always; for players only on reveal. */
  answer?: string;
  answerMedia?: Media & { url: string };
  comment?: string;
  /** Host only. */
  hostNote?: string;
  /** Increments when the host asks to replay media. */
  mediaNonce: number;
}

export type Phase =
  | 'lobby'
  | 'board'
  | 'cat'
  | 'auction'
  | 'question'
  | 'reveal'
  | 'round_end'
  | 'final_themes'
  | 'final_bets'
  | 'final_answer'
  | 'final_judging'
  | 'final_reveal'
  | 'game_over';

export interface BuzzView {
  /** reading = buzzer closed, open = accepting buzzes, roulette = random draw animation, answering = someone answers */
  stage: 'reading' | 'open' | 'roulette' | 'answering';
  /** Server epoch ms when the current stage ends (open: question closes; answering: answer time is up). Open without a deadline: media is still playing. */
  deadline?: number;
  /** Changes every time the buzzer (re)opens. */
  openId: number;
  /** Random mode: players who pressed during the current window, and when the window closes. */
  pressed?: string[];
  windowEndsAt?: number;
  /** Random mode: the draw. Clients animate a highlight over `candidates` that stops on `winnerId` at `endsAt`. */
  roulette?: { candidates: string[]; winnerId: string; startedAt: number; endsAt: number };
  /** Server epoch ms when an auto-open happens during reading. */
  autoOpenAt?: number;
  readingSince?: number;
  answeringId?: string;
  /** Players who already answered wrong on this question. */
  lockedOut: string[];
  /** Fixed answerer (cat / auction winner): no buzzer, they answer directly. */
  solo: boolean;
}

export interface CatView {
  /** Player who gives the cat away. */
  giverId: string;
  theme: string;
  price: number;
  receiverId?: string;
}

export interface AuctionBid {
  playerId: string;
  amount: number;
  allIn: boolean;
}

export interface AuctionView {
  nominal: number;
  turnId?: string;
  passed: string[];
  bid?: AuctionBid;
  winnerId?: string;
}

export interface FinalView {
  themes: { name: string; removed: boolean }[];
  turnId?: string;
  participants: string[];
  /** Who already placed a bet / submitted an answer (amounts hidden until reveal). */
  betPlaced: string[];
  answered: string[];
  deadline?: number;
  /** Visible to the host during judging and to everyone on reveal. */
  entries?: { playerId: string; bet: number; answer: string; correct?: boolean }[];
}

export interface ResultView {
  playerId?: string;
  correct: boolean;
  delta: number;
}

export interface GameView {
  code: string;
  role: 'host' | 'player';
  meId?: string;
  packTitle: string;
  phase: Phase;
  hostConnected: boolean;
  settings: Settings;
  players: PlayerView[];
  chooserId?: string;
  board?: BoardView;
  question?: QuestionView;
  buzz?: BuzzView;
  cat?: CatView;
  auction?: AuctionView;
  final?: FinalView;
  /** Results of attempts on the current question, in order. */
  results: ResultView[];
  /** Host only: the last verdict can be undone. */
  canUndo?: boolean;
  /** For the final scoreboard. */
  serverNow: number;
}

export type ClientMessage =
  // player
  | { t: 'pick'; theme: number; question: number }
  | { t: 'buzz'; reactionMs: number }
  | { t: 'cat_give'; to: string }
  | { t: 'auction_bid'; amount: number }
  | { t: 'auction_allin' }
  | { t: 'auction_pass' }
  | { t: 'final_remove'; theme: number }
  | { t: 'final_bet'; amount: number }
  | { t: 'final_answer'; text: string; draft?: boolean }
  | { t: 'set_avatar'; data: string | null }
  // host
  | { t: 'start' }
  | { t: 'open_buzzer' }
  | { t: 'judge'; correct: boolean }
  | { t: 'undo_judge' }
  | { t: 'skip_question' }
  | { t: 'continue' }
  | { t: 'next_round' }
  | { t: 'end_round' }
  | { t: 'media_ended' }
  | { t: 'replay_media' }
  | { t: 'set_score'; playerId: string; score: number }
  | { t: 'set_chooser'; playerId: string }
  | { t: 'kick'; playerId: string }
  | { t: 'settings'; settings: Partial<Settings> }
  | { t: 'final_judge'; playerId: string; correct: boolean }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'state'; state: GameView }
  | { t: 'event'; name: GameEvent; playerId?: string }
  | { t: 'error'; message: string }
  | { t: 'kicked' }
  | { t: 'pong'; serverNow: number };

export type GameEvent = 'buzz' | 'correct' | 'wrong' | 'false_start' | 'timeout' | 'round_start' | 'question';

export const PLAYER_COLORS = ['#e8604c', '#e5a03a', '#7fb34d', '#3fae9b', '#4a90d9', '#8b6fd6', '#d65fa3', '#9a9a9a'];
