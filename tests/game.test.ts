import { describe, it, expect, beforeEach } from 'vitest';
import { Game, HOST, player, type Scheduler, GameError } from '../src/server/game';
import { PackSchema, type Pack } from '../src/shared/pack';

class FakeClock implements Scheduler {
  t = 1_000_000;
  private q: { at: number; fn: () => void; id: number }[] = [];
  private n = 0;
  now = () => this.t;
  set = (fn: () => void, ms: number) => {
    const id = ++this.n;
    this.q.push({ at: this.t + ms, fn, id });
    return id;
  };
  clear = (h: unknown) => {
    this.q = this.q.filter((x) => x.id !== h);
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

const pack: Pack = PackSchema.parse({
  title: 'Test',
  rounds: [
    {
      name: 'R1',
      themes: [
        {
          name: 'Theme A',
          questions: [
            { price: 100, text: 'q1', answer: 'a1' },
            { price: 200, text: 'q2', answer: 'a2', type: 'cat', catTheme: 'Cat theme', catPrice: 500 },
            { price: 300, text: 'q3', answer: 'a3', type: 'auction' },
          ],
        },
        { name: 'Theme B', questions: [{ price: 100, text: 'video', answer: 'b1', media: { kind: 'video', file: 'media/x.mp4' } }] },
      ],
    },
    {
      name: 'Final',
      type: 'final',
      themes: [
        { name: 'F1', questions: [{ text: 'f1', answer: 'fa1' }] },
        { name: 'F2', questions: [{ text: 'f2', answer: 'fa2' }] },
        { name: 'F3', questions: [{ text: 'f3', answer: 'fa3' }] },
      ],
    },
  ],
});

let clock: FakeClock;
let g: Game;
let events: string[];
let A: string, B: string, C: string;

function setup(players = 3) {
  clock = new FakeClock();
  events = [];
  g = new Game('ABCD', 'test', structuredClone(pack), clock, () => {}, (e, p) => events.push(p ? `${e}:${p}` : e));
  const ids = ['Аня', 'Богдан', 'Віка'].slice(0, players).map((n, i) => g.join(`tok${i}`, n, '#fff'));
  [A, B, C] = ids;
  g.start(HOST);
  g.setChooser(HOST, A);
}

function openNormal() {
  g.pick(player(A), 0, 0);
  g.openBuzzer(HOST);
}

beforeEach(() => setup());

describe('lobby & players', () => {
  it('reconnect by token keeps id and score', () => {
    g.setScore(HOST, B, 700);
    const again = g.join('tok1', 'Богдан', '#000');
    expect(again).toBe(B);
    expect(g.get(B)!.score).toBe(700);
  });

  it('rejects duplicate names', () => {
    expect(() => g.join('other', 'аня', '#fff')).toThrow(GameError);
  });

  it('kicked players cannot come back with the same token', () => {
    g.kick(HOST, B);
    expect(() => g.join('tok1', 'Богдан', '#fff')).toThrow(/прибрав/);
  });

  it('an offline seat can be taken over by name from another device, keeping the score', () => {
    g.setScore(HOST, B, 300);
    expect(() => g.join('newdevice', 'Богдан', '#fff')).toThrow(/зайняте/);
    g.setConnected(B, false);
    expect(g.join('newdevice', 'богдан', '#000')).toBe(B);
    expect(g.get(B)!.score).toBe(300);
  });

  it('players cannot do host actions', () => {
    expect(() => g.start(player(A))).toThrow(/ведучий/);
  });

  it('only the chooser (or host) picks', () => {
    expect(() => g.pick(player(B), 0, 0)).toThrow(/інший гравець/);
    g.pick(HOST, 0, 0);
    expect(g.phase).toBe('question');
  });

  it('players see the full board but not the answer', () => {
    g.pick(player(A), 0, 0);
    const v = g.view('player', B);
    expect(v.board!.themes).toHaveLength(2);
    expect(v.question!.text).toBe('q1');
    expect(v.question!.answer).toBeUndefined();
    expect(g.view('host').question!.answer).toBe('a1');
  });
});

describe('buzzer', () => {
  it('auto-opens after reading time for text questions', () => {
    g.pick(player(A), 0, 0);
    expect(g.buzz!.stage).toBe('reading');
    clock.advance(10_000);
    expect(g.buzz!.stage).toBe('open');
  });

  it('does not auto-open for video until media ends', () => {
    g.pick(player(A), 1, 0);
    clock.advance(30_000);
    expect(g.buzz!.stage).toBe('reading');
    g.mediaEnded(HOST);
    expect(g.buzz!.stage).toBe('open');
  });

  it('anti-ping window picks the lowest client reaction, not the first arrival', () => {
    openNormal();
    clock.advance(500);
    g.buzzIn(player(A), 480); // arrives first, slow reaction
    clock.advance(100);
    g.buzzIn(player(B), 200); // arrives later, faster reaction
    clock.advance(400);
    expect(g.buzz!.stage).toBe('answering');
    expect(g.buzz!.answeringId).toBe(B);
  });

  it('clamps reaction time to server elapsed time', () => {
    openNormal();
    clock.advance(300);
    g.buzzIn(player(A), 250);
    g.buzzIn(player(B), 99_999); // claims a slow reaction beyond elapsed -> clamped to 300
    clock.advance(400);
    expect(g.buzz!.answeringId).toBe(A);
  });

  it('pressing before seeing the buzzer open (reaction < 0) is a false start', () => {
    openNormal();
    clock.advance(100);
    g.buzzIn(player(B), -1);
    expect(events).toContain(`false_start:${B}`);
    g.buzzIn(player(B), 50);
    clock.advance(400);
    expect(g.buzz!.stage).toBe('open');
  });

  it('false start blocks the player for a while', () => {
    g.pick(player(A), 0, 0);
    g.buzzIn(player(A), 0);
    expect(events).toContain(`false_start:${A}`);
    g.openBuzzer(HOST);
    g.buzzIn(player(A), 10);
    clock.advance(400);
    expect(g.buzz!.stage).toBe('open');
    clock.advance(700);
    g.buzzIn(player(A), 1100);
    clock.advance(400);
    expect(g.buzz!.answeringId).toBe(A);
  });

  it('correct answer adds points and makes the player the chooser', () => {
    openNormal();
    g.buzzIn(player(B), 100);
    clock.advance(400);
    g.judge(HOST, true);
    expect(g.get(B)!.score).toBe(100);
    expect(g.chooserId).toBe(B);
    expect(g.phase).toBe('reveal');
    expect(g.view('player', A).question!.answer).toBe('a1');
  });

  it('wrong answer subtracts, locks the player out and reopens for others', () => {
    openNormal();
    g.buzzIn(player(B), 100);
    clock.advance(400);
    g.judge(HOST, false);
    expect(g.get(B)!.score).toBe(-100);
    expect(g.buzz!.stage).toBe('open');
    g.buzzIn(player(B), 50); // locked out
    clock.advance(400);
    expect(g.buzz!.stage).toBe('open');
    g.buzzIn(player(C), 50);
    clock.advance(400);
    expect(g.buzz!.answeringId).toBe(C);
    expect(g.chooserId).toBe(A);
  });

  it('pressing while someone else answers is a false start', () => {
    openNormal();
    g.buzzIn(player(B), 100);
    clock.advance(400);
    g.buzzIn(player(C), 0);
    expect(events).toContain(`false_start:${C}`);
  });

  it('host can undo a verdict: scores, chooser and the answering player are restored', () => {
    openNormal();
    g.buzzIn(player(B), 100);
    clock.advance(400);
    g.judge(HOST, true);
    expect(g.view('host').canUndo).toBe(true);
    g.undoJudge(HOST);
    expect(g.get(B)!.score).toBe(0);
    expect(g.chooserId).toBe(A);
    expect(g.phase).toBe('question');
    expect(g.buzz!.answeringId).toBe(B);
    g.judge(HOST, false);
    expect(g.get(B)!.score).toBe(-100);
    expect(g.buzz!.stage).toBe('open');
    g.skipQuestion(HOST);
    g.continue(HOST);
    expect(() => g.undoJudge(HOST)).toThrow(GameError);
  });

  it('everybody wrong -> reveal', () => {
    openNormal();
    for (const id of [A, B, C]) {
      g.buzzIn(player(id), 100);
      clock.advance(400);
      g.judge(HOST, false);
    }
    expect(g.phase).toBe('reveal');
  });

  it('nobody buzzes -> timeout -> reveal, chooser unchanged', () => {
    openNormal();
    clock.advance(9000);
    expect(g.phase).toBe('reveal');
    expect(events).toContain('timeout');
    expect(g.chooserId).toBe(A);
  });

  it('continue returns to board, picked question is played', () => {
    openNormal();
    g.skipQuestion(HOST);
    g.continue(HOST);
    expect(g.phase).toBe('board');
    expect(g.view('player', A).board!.themes[0].questions[0].played).toBe(true);
    expect(() => g.pick(player(A), 0, 0)).toThrow(/вже зіграно/);
  });
});

describe('cat in the bag', () => {
  it('chooser gives the cat to another player who answers alone at cat price', () => {
    g.pick(player(A), 0, 1);
    expect(g.phase).toBe('cat');
    expect(g.view('player', B).question!.text).toBe(''); // hidden until given
    expect(() => g.catGive(player(A), A)).toThrow(/іншому/);
    g.catGive(player(A), C);
    expect(g.phase).toBe('question');
    expect(g.buzz!.solo).toBe(true);
    expect(g.buzz!.answeringId).toBe(C);
    expect(g.view('player', B).question!.themeName).toBe('Cat theme');
    g.buzzIn(player(B), 10); // ignored
    expect(g.buzz!.answeringId).toBe(C);
    g.judge(HOST, false);
    expect(g.get(C)!.score).toBe(-500);
    expect(g.phase).toBe('reveal');
  });
});

describe('auction', () => {
  it('bidding in turn, passes, winner answers for the stake', () => {
    g.setScore(HOST, A, 1000);
    g.setScore(HOST, B, 800);
    g.setScore(HOST, C, 100);
    g.pick(player(A), 0, 2);
    expect(g.phase).toBe('auction');
    expect(g.view('player', A).auction!.turnId).toBe(A);
    expect(() => g.auctionBid(player(A), 200)).toThrow(/Мінімальна/);
    g.auctionBid(player(A), 400);
    expect(g.view('player', A).auction!.turnId).toBe(B);
    g.auctionBid(player(B), 500);
    // C max = max(100, 300) = 300 < 500 -> auto-passed, turn back to A
    expect(g.view('player', A).auction!.turnId).toBe(A);
    g.auctionAllIn(player(A));
    // B cannot beat 1000 -> auto-pass -> A wins
    expect(g.phase).toBe('question');
    expect(g.buzz!.answeringId).toBe(A);
    g.judge(HOST, true);
    expect(g.get(A)!.score).toBe(2000);
  });

  it('the chooser "passing" first plays for the nominal; if everyone else passes, the chooser answers', () => {
    g.setScore(HOST, B, 1000);
    g.setScore(HOST, C, 1000);
    g.pick(player(A), 0, 2);
    g.auctionPass(player(A));
    expect(g.view('player', A).auction!.bid).toMatchObject({ playerId: A, amount: 300 });
    g.auctionPass(player(B));
    g.auctionPass(player(C));
    expect(g.phase).toBe('question');
    expect(g.buzz!.answeringId).toBe(A);
    expect(g.cur!.price).toBe(300);
  });

  it('host can pass for a disconnected player', () => {
    g.setScore(HOST, B, 1000);
    g.setScore(HOST, C, 1000);
    g.pick(player(A), 0, 2);
    g.auctionBid(player(A), 300);
    g.auctionPass(HOST);
    expect(g.view('player', A).auction!.turnId).toBe(C);
  });

  it('kicking a non-turn player keeps the turn', () => {
    g.pick(player(A), 0, 2);
    g.kick(HOST, C);
    expect(g.view('player', A).auction!.turnId).toBe(A);
  });
});

describe('rounds and final', () => {
  function finishRound1() {
    g.endRound(HOST);
    expect(g.phase).toBe('round_end');
    g.nextRound(HOST);
  }

  it('final: only positive scores play, themes removed in turn from the lowest score', () => {
    g.setScore(HOST, A, 500);
    g.setScore(HOST, B, 1000);
    g.setScore(HOST, C, -100);
    finishRound1();
    expect(g.phase).toBe('final_themes');
    const v = g.view('player', A);
    expect(v.final!.participants.sort()).toEqual([A, B].sort());
    expect(v.final!.turnId).toBe(A);
    g.finalRemove(player(A), 0);
    expect(() => g.finalRemove(player(A), 1)).toThrow(/іншого/);
    g.finalRemove(player(B), 2);
    expect(g.phase).toBe('final_bets');
    expect(g.view('player', A).question!.text).toBe(''); // hidden during bets
    expect(() => g.finalBet(player(A), 600)).toThrow(/від 1 до 500/);
    g.finalBet(player(A), 500);
    expect(g.view('player', B).final!.entries).toBeUndefined();
    g.finalBet(player(B), 300);
    expect(g.phase).toBe('final_answer');
    expect(g.view('player', A).question!.text).toBe('f2');
    g.finalAnswer(player(A), 'fa2');
    expect(g.view('player', B).final!.entries).toBeUndefined(); // others' answers stay hidden
    g.finalAnswer(player(B), 'half-typ', false); // draft, never submitted
    expect(g.phase).toBe('final_answer');
    clock.advance(61_000); // timeout
    expect(g.phase).toBe('final_judging');
    expect(g.view('host').final!.entries!.find((e) => e.playerId === B)!.answer).toBe('half-typ');
    g.finalJudge(HOST, A, false);
    g.finalJudge(HOST, B, false);
    expect(g.phase).toBe('final_judging'); // verdicts stay editable until the host confirms
    g.finalJudge(HOST, A, true);
    g.continue(HOST);
    expect(g.phase).toBe('final_reveal');
    expect(g.get(A)!.score).toBe(1000);
    expect(g.get(B)!.score).toBe(700);
    g.continue(HOST);
    expect(g.phase).toBe('game_over');
  });

  it('final is skipped when nobody has a positive score', () => {
    finishRound1();
    expect(g.phase).toBe('game_over');
  });

  it('new round starts with the lowest score player choosing', () => {
    const p: Pack = structuredClone(pack);
    p.rounds[1] = { ...p.rounds[0], name: 'R2' };
    g = new Game('X', 't', p, clock);
    const a = g.join('a', 'A', '#fff');
    const b = g.join('b', 'B', '#fff');
    g.start(HOST);
    g.setScore(HOST, a, 500);
    g.setScore(HOST, b, 100);
    g.setChooser(HOST, a);
    g.endRound(HOST);
    g.nextRound(HOST);
    expect(g.chooserId).toBe(b);
    expect(g.phase).toBe('board');
  });
});

describe('avatars', () => {
  beforeEach(() => setup());
  const png = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');

  it('stores a player photo and exposes a versioned URL', () => {
    g.setAvatar(player(A), png);
    const v1 = g.view('player', B).players.find((p) => p.id === A)!.avatar;
    expect(v1).toBe(`/api/rooms/ABCD/avatars/${A}?v=1`);
    expect(g.avatarOf(A)?.data.toString()).toBe('fake-png');
    g.setAvatar(player(A), png);
    expect(g.view('host').players.find((p) => p.id === A)!.avatar).toMatch(/v=2$/);
    g.setAvatar(player(A), null);
    expect(g.view('host').players.find((p) => p.id === A)!.avatar).toBeUndefined();
  });

  it('rejects non-images, oversized files and the host', () => {
    expect(() => g.setAvatar(player(A), 'data:text/html;base64,PGI+')).toThrow(GameError);
    expect(() => g.setAvatar(player(A), 'data:image/jpeg;base64,' + 'A'.repeat(60_000))).toThrow(GameError);
    expect(() => g.setAvatar(HOST, png)).toThrow(GameError);
  });
});
