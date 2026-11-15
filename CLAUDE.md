# Квізи від Дімона — online quiz for friends

Multiplayer "Своя гра"-style quiz (board of themes × prices, buzzer, cat in the bag, auction, final with bets). Played remotely: each player opens the game in their own browser (usually alongside a Discord call); the host judges answers. UI language: Ukrainian.

## Stack

- `src/shared/` — types shared by server and client: `pack.ts` (zod schema of a pack, source of truth), `protocol.ts` (messages, `GameView`, settings).
- `src/server/game.ts` — the whole game as one state machine (`Game`), no I/O, injectable `Scheduler` for timers. All rules live here.
- `src/server/rooms.ts` — WebSocket clients ↔ `Game`; sends each client its own view (host sees answers, players do not).
- `src/server/packs.ts` — loads `packs/<id>/pack.json`, serves only media files referenced by the pack, imports zip uploads.
- `src/server/custom.ts` + `store.ts` — packs made in the site editor (`/editor`, `src/client/editor.tsx`). Stored in an S3-compatible bucket when `S3_BUCKET` (+ `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) is set, else in `DATA_DIR` (default `./data`). Editor password: `EDITOR_KEY`, falls back to `UPLOAD_KEY`.
- `src/server/index.ts` — express + ws, REST: `/api/packs`, `/api/packs/upload`, `/api/rooms`; media at `/packs/<id>/<file>`.
- `src/client/` — React (Vite). `stage.tsx` renders the main area per phase, `game-screen.tsx` the layout, scoreboard, player buzzer bar and host panel. Plain CSS with tokens in `styles.css`.
- `tools/` — pack tooling: `pack-check`, `pack-zip`, `media-clip` (yt-dlp + ffmpeg), `media-image`, `media-generate` (Gemini image API, key `GEMINI_API_KEY` in env or `.env`).

## Commands

- `npm run dev` — server on :3000 + Vite on :5173 (open 5173).
- `npm run build && npm start` — production on :3000 (`PORT`, `PACKS_DIR`, `UPLOAD_KEY` env).
- `npm test` — engine unit tests (Vitest). `npm run test:e2e` — Playwright: host + 3 players play a full game against `tests/fixtures/packs`.
- `SHOTS=1 npx playwright test shots` — screenshots of key screens into `test-results/shots/` for visual review.
- `npm run typecheck`.

Run `npm test`, `npm run typecheck` and `npm run test:e2e` after any change to game logic or UI. When changing UI, also take screenshots and look at them (desktop and mobile).

## Rules worth knowing

- Buzzer fairness: the client measures its own reaction time from the moment it saw the buzzer open; the server waits `buzzWindowMs` after the first buzz and picks the lowest reaction (clamped to server elapsed time). Pressing before seeing it open is a false start.
- The player who answered correctly chooses next. A new round starts with the lowest score choosing.
- Final: only players with a positive score; themes are removed in turn from the lowest score; bets are secret until reveal.

## Packs

Use the `make-pack` skill (`.claude/skills/make-pack/SKILL.md`) for creating packs. Media file names must not reveal answers (players can see URLs).
