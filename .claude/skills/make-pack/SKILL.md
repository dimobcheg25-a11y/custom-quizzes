---
name: make-pack
description: Build a complete quiz pack for this game (Своя гра) from a topic brief — questions, fact-checking, images, video and audio clips, validation and a zip for upload. Use whenever the user asks to make, generate, extend or fix a pack ("зроби пак", "пак про фільми", "додай раунд").
---

# Making a pack

A pack is a folder `packs/<id>/` with `pack.json` and `media/`. The schema is `src/shared/pack.ts` (zod) — read it first; it is the source of truth. The game UI is Ukrainian, so pack content is Ukrainian unless the user asks otherwise.

## 1. Brief

Get from the user (ask only what is missing, in one message): topics or the general theme, how many rounds, difficulty, and anything to avoid. Defaults when the user says "just do it":

- 2 normal rounds × 6 themes × 5 questions; prices 100–500 in round 1, 200–1000 in round 2.
- 1 final round with 5 themes (one question each).
- In each normal round: 1–2 «кіт у мішку» (`type: "cat"`, with `catTheme` and `catPrice`) and 1–2 auctions (`type: "auction"`). Never at the 100 price.
- About a third of questions with media: images, short video clips, music.

## 2. Write the questions

Delegate the writing to a subagent on model `fable` (the user asked for Fable where it improves quality; see memory). Give it the brief, the schema file path and the rules below, and ask it to return the full `pack.json` plus a list of media to collect (what each file must show, and a source idea).

Rules for good questions:

- Difficulty grows with price inside a theme. 100 = most of the table knows it; 500 = needs real knowledge or a clever chain of thought.
- Theme names are short and a little playful, but must tell players what the theme is about.
- A question has one clear answer. Put accepted variants and judging hints in `hostNote` ("Зараховувати: …; не зараховувати: …").
- `answer` is short (a name, a word, a number). Extra context goes in `comment`, shown on reveal — make it an interesting fact.
- Text fits a screen: up to ~200 characters. Do not repeat the answer in the question.
- The answer must not leak through media: file names are visible to players in the browser, so name files neutrally: `media/r1-t3-q4.jpg`, `media/r2-t1-q5-answer.jpg`.
- Mix formats: plain text, "що на фото", "вгадай фільм за кадром", "вгадай пісню за 10 секунд", "продовжи цитату", chains. Avoid trivia that depends on a single obscure date.
- Final round questions are harder and open-ended enough that players write a short answer.

## 3. Fact-check

Check every answer with WebSearch (standard mode; extended only when standard is thin). Fix or replace anything you cannot confirm. This step is not optional — a wrong answer ruins the game.

## 4. Collect media

Run tools from the repo root. They need `ffmpeg` and `yt-dlp` (the tools print the install command when missing).

- Images: prefer Wikimedia Commons. Get the direct file URL (`https://upload.wikimedia.org/...`) through the Commons API or the file page, then
  `npm run media:image -- "<url>" packs/<id>/media/r1-t2-q3.jpg`
- Video clip (10–25 s): find the YouTube video, confirm the right timestamps (the description, chapters, or a transcript), then
  `npm run media:clip -- "<youtube url>" 1:12 1:30 packs/<id>/media/r1-t4-q2.mp4`
  Add `--mute` when the sound would give the answer away.
- Music (8–15 s, guess the song): `npm run media:clip -- "<url>" 0:45 0:57 packs/<id>/media/r2-t5-q1.mp3`
  Avoid the part where the title is sung unless that is the point.
- Still frame: `npm run media:clip -- "<url>" 0:42:10 - packs/<id>/media/r1-t1-q5.jpg`
- After cutting, look at images and frames with Read to confirm they show what the question expects, and that no caption or watermark gives the answer away.

If a media file cannot be obtained, rewrite that question as text rather than leaving a broken reference.

## 5. Validate and ship

1. `npm run pack:check -- packs/<id>` — fix every ✗ error; read the ! warnings and fix what matters.
2. `npm test` must still pass (it does not test packs, but keeps the repo healthy).
3. Optionally start the server (`npm run build && npm start`) and open one media question to see it render.
4. `npm run pack:zip -- packs/<id>` produces `packs/<id>.zip` for uploading on a deployed site (home page → «Завантажити пак»). When the game runs locally, the folder in `packs/` is enough.

Report to the user: pack title, rounds and themes, how many media questions, anything you could not verify or obtain.
