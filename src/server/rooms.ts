import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { Game, GameError, HOST, player, type Actor } from './game';
import { loadPack } from './packs';
import type { ClientMessage, GameEvent, ServerMessage } from '../shared/protocol';

interface Client {
  ws: WebSocket;
  role: 'host' | 'player';
  playerId?: string;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const IDLE_MS = 6 * 60 * 60 * 1000;

export class Room {
  readonly game: Game;
  readonly hostToken = crypto.randomBytes(16).toString('hex');
  private clients = new Set<Client>();
  private pending = false;
  lastActivity = Date.now();

  constructor(code: string, packId: string) {
    this.game = new Game(
      code,
      packId,
      loadPack(packId),
      undefined,
      () => this.scheduleBroadcast(),
      (name, pid) => this.event(name, pid),
    );
  }

  get code() {
    return this.game.code;
  }

  get empty() {
    return this.clients.size === 0;
  }

  attachHost(ws: WebSocket) {
    this.attach({ ws, role: 'host' });
    this.game.setHostConnected(true);
  }

  /** Throws GameError if the join is rejected. */
  attachPlayer(ws: WebSocket, token: string, name: string, color: string) {
    const id = this.game.join(token, name, color);
    this.attach({ ws, role: 'player', playerId: id });
    this.game.setConnected(id, true);
  }

  private attach(c: Client) {
    this.clients.add(c);
    this.lastActivity = Date.now();
    this.send(c, { t: 'state', state: this.game.view(c.role, c.playerId) });
    c.ws.on('message', (raw) => this.onMessage(c, raw.toString()));
    c.ws.on('close', () => this.detach(c));
    c.ws.on('error', (e) => console.warn(`[room ${this.code}] socket error:`, e.message));
  }

  private detach(c: Client) {
    this.clients.delete(c);
    const still = [...this.clients].some((x) => x.role === c.role && x.playerId === c.playerId);
    if (still) return;
    if (c.role === 'host') this.game.setHostConnected(false);
    else if (c.playerId) this.game.setConnected(c.playerId, false);
  }

  private onMessage(c: Client, raw: string) {
    this.lastActivity = Date.now();
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof (msg as { t?: unknown }).t !== 'string') return;
    const by: Actor = c.role === 'host' ? HOST : player(c.playerId!);
    const g = this.game;
    try {
      if (msg.t === 'ping') return this.send(c, { t: 'pong', serverNow: Date.now() });
      if (c.role === 'player' && c.playerId && !this.game.get(c.playerId)) return; // kicked
      switch (msg.t) {
        case 'pick': return g.pick(by, msg.theme, msg.question);
        case 'buzz': return g.buzzIn(by, msg.reactionMs);
        case 'cat_give': return g.catGive(by, msg.to);
        case 'auction_bid': return g.auctionBid(by, msg.amount);
        case 'auction_allin': return g.auctionAllIn(by);
        case 'auction_pass': return g.auctionPass(by);
        case 'final_remove': return g.finalRemove(by, msg.theme);
        case 'final_bet': return g.finalBet(by, msg.amount);
        case 'final_answer': return g.finalAnswer(by, msg.text, !msg.draft);
        case 'set_avatar': return g.setAvatar(by, msg.data);
        case 'start': return g.start(by);
        case 'open_buzzer': return g.openBuzzer(by);
        case 'judge': return g.judge(by, msg.correct);
        case 'undo_judge': return g.undoJudge(by);
        case 'skip_question': return g.skipQuestion(by);
        case 'continue': return g.continue(by);
        case 'next_round': return g.nextRound(by);
        case 'end_round': return g.endRound(by);
        case 'media_ended': return g.mediaEnded(by);
        case 'replay_media': return g.replayMedia(by);
        case 'set_score': return g.setScore(by, msg.playerId, msg.score);
        case 'set_chooser': return g.setChooser(by, msg.playerId);
        case 'settings': return g.updateSettings(by, msg.settings ?? {});
        case 'final_judge': return g.finalJudge(by, msg.playerId, msg.correct);
        case 'kick': {
          g.kick(by, msg.playerId);
          for (const x of this.clients)
            if (x.playerId === msg.playerId) {
              this.send(x, { t: 'kicked' });
              x.ws.close(4003, 'kicked');
            }
          return;
        }
      }
    } catch (e) {
      if (e instanceof GameError) this.send(c, { t: 'error', message: e.message });
      else {
        console.error(`[room ${this.code}]`, e);
        this.send(c, { t: 'error', message: 'Внутрішня помилка сервера' });
      }
    }
  }

  private scheduleBroadcast() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      for (const c of this.clients) this.send(c, { t: 'state', state: this.game.view(c.role, c.playerId) });
    });
  }

  private event(name: GameEvent, playerId?: string) {
    // Let the state go out first so clients render the new phase before sounds/toasts.
    setImmediate(() => {
      for (const c of this.clients) this.send(c, { t: 'event', name, playerId });
    });
  }

  private send(c: Client, msg: ServerMessage) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  close() {
    this.game.clearTimers();
    for (const c of this.clients) c.ws.close(4004, 'room closed');
  }
}

export class Rooms {
  private rooms = new Map<string, Room>();

  constructor() {
    setInterval(() => this.sweep(), 10 * 60 * 1000).unref();
  }

  create(packId: string): Room {
    let code: string;
    do code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
    while (this.rooms.has(code));
    const room = new Room(code, packId);
    this.rooms.set(code, room);
    return room;
  }

  get(code: string) {
    return this.rooms.get(code.toUpperCase());
  }

  private sweep() {
    const now = Date.now();
    for (const [code, r] of this.rooms)
      if (r.empty && now - r.lastActivity > IDLE_MS) {
        r.close();
        this.rooms.delete(code);
      }
  }
}
