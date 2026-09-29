# Bank It — project guide

A quick push-your-luck party game. Pick a category, see **20** answers, tap the **10** you
think are on the hidden list. Every correct tap is +1; one wrong tap ends the round — so
*bank it & stop* while you're ahead. A perfect 10/10 is a "clean sweep."

## Vault (process journal)

Design notes, playtest feedback, decisions, and session threads live OUTSIDE this repo in
the HQ Obsidian vault: `~/vaults/hq/bank-it/`. Read `*launchpad/000 Workflow.md` there before
doing vault work (it defines the note system); `*launchpad/002 Roadmap.md`
is the living project picture; each thread is a `NNN Topic/` folder (screenshots in `NNN img/`). The repo holds the product; the vault holds the process.

## Stack & layout

- **Frontend:** plain HTML/CSS/JS pages, **no build step**, no framework. **`index.html` is the
  app frame**: every page runs inside its `<iframe id="view">`, and the frame owns the **chat
  panel** — so moving between games never reloads the panel or loses its state. `games.html` is
  the hub (Games · High Scores · Settings); each game is its own page: `bankit.html`,
  `singit.html`, `tictactoe.html`, `mix.html`, `four.html`, `memory.html`, `vault.html`,
  `dots.html`, `mancala.html`, `rps.html`, `battle.html`, `checkers.html`, `reversi.html`, `scramble.html`, `echo.html`,
  `react.html`.
  Every page loads **`shell.css` + `shell.js`** (see "The platform shell"); opened on its own (a
  bookmark, an invite link) `shell.js` redirects into the frame as `/?p=page.html#hash`.
- **Chat:** `index.html` panel (💬 tab on the right edge; pushes the page over; unread badge;
  who's online). Server: `scripts/chat-server.mjs` on `/chat` (dev server), one room, signed-in
  players only (the shared `bankit-user-v1` identity), ≤500 chars, ~1 msg / 0.7s, last 100 sent on
  connect (or on `{t:'hist'}`), saved to `chat_messages` (`scripts/migrate-chat.mjs`). In prod the
  same messages run through `aws/ws-handler.js` (see Deploy).
- **Backend:** serverless functions in `api/` over Aurora Postgres (RDS Data API).
  - `api/_db.js` — pg-compatible facade (`getPool()`) over the Data API; `BANKIT_DB_*` env.
  - `api/boards.js` — `GET /api/boards` → all active boards + their answers/decoys.
  - `api/scores.js` — `GET` leaderboard rows; `POST` records a finished run **and** upserts
    the player's running totals (see Players below).
  - `api/players.js` — `GET /api/players?name=` → one player's aggregate + swept board titles.
  - `api/requests.js` + `api/_builder.js` + `api/play.js` — the **Request new → built game** pipeline
    (see "Player-built games" below). `scripts/migrate-requests.mjs` (idempotent; applied to the live DB).
- **Scripts:**
  - `scripts/schema.sql` — full schema (DROP+CREATE; safe to re-run on a throwaway DB).
  - `scripts/seed.mjs` — full reseed (schema + the original boards + sample scores).
  - `scripts/add-board.mjs` — add ONE board: edit the `BOARD` const, then `node scripts/add-board.mjs`.
  - `scripts/add-boards-batch.mjs` — add several boards at once (idempotent on slug).
  - `scripts/migrate-players.mjs` — idempotent: creates the `players` table + backfills from
    existing `scores`. Already applied to the live DB.
- **Deploy (AWS, us-east-1, account 638175140432):** `scripts/deploy-aws.sh` (all · `lambdas` · `site`).
  Live: **https://main.d1ecw91uspa0an.amplifyapp.com** (custom domain later).
  - **Amplify** app `playground` (id in `aws/amplify-app-id`), branch `main`, manual zip deploys of the
    static pages (not git-connected). A custom rule proxies `/api/<*>` to the API Lambda.
  - **Lambda `bankit-api`** (`aws/api-handler.js`): one function for every `api/*.js` route via a
    Function URL (shims the event into Vercel-style req/res). New route → add it to `ROUTES` there.
  - **Lambda `bankit-ws` + API Gateway WebSocket `bankit-ws`** (`aws/ws-handler.js`, stage `prod`):
    the game relay (`?ch=relay&cid=`) and chat (`?ch=chat`) with state in DynamoDB `bankit-ws`
    (TTL on `ttl`). Pages pick the socket with `Shell.wsUrl()` (localhost → dev server). Clients
    ping every 4 min (API Gateway drops idle sockets at 10 min; hard cap 2 h).
  - IAM role `bankit-lambda`: Data API, the DB secret, Bedrock, the table, ManageConnections.
  - Any `.env.local` change to `BANKIT_DB_*` → rerun `scripts/deploy-aws.sh lambdas`.
  - `vercel.json` is left over from the old host and unused.

## ⚠️ The one rule that bites: boards live in TWO places

Every board exists in **both**:
1. **The DB** (the live source, served by `/api/boards`).
2. The **`FALLBACK_BOARDS`** array in `index.html` (used only if the API is unreachable).

**Adding or editing a board means updating both.** The frontend fetches `/api/boards` and falls
back to `FALLBACK_BOARDS` on any failure. Keep titles/answers/decoys identical between them,
including typographic apostrophes (`'` U+2019, e.g. `Arby's`, `Cap'n Crunch`).

## Board data model

Each board = exactly **10 answers** (`on_list = TRUE`) + **10 decoys** (`on_list = FALSE`).
The game shows all 20 shuffled; the player taps the ones they believe are real answers.

### Decoy rule (standing design rule — do NOT re-ask the user each time)

Decoys must sit at **reasonable proximity** to the answers — same category/family, plausible —
so the **average player scores 7–9**: playable, not hard, not trivial. Generate decoys at this
difficulty automatically; pick a fitting emoji and the next `color_slot`, then proceed.

Example: for "Girls' Names With 4 Letters" the decoys are OTHER real 4-letter girls' names — the
trick is *which* names made the list, not name length. Same pattern for "Sweet Cereals" (decoys
are other real sweet-cereal brands).

**Exception — custom sets:** the player supplies their own 10 decoys in the editor; never
auto-generate for them.

## Custom sets (player-created boards)

- Extra `boards` columns: `owner_key` (`lower(trim(username))`; **NULL = official board**),
  `is_public`, `is_approved`. Custom sets are saved `is_public=TRUE, is_approved=FALSE` —
  submitted for everyone but hidden from the global catalog until a moderation pass.
  `/api/boards` filters: `owner_key IS NULL OR (is_public AND is_approved)`.
  Migration: `scripts/migrate-custom-sets.mjs` (idempotent; **must run before deploying**
  any code that references these columns).
- `api/sets.js` — `POST /api/sets` creates one (validates 10+10, no duplicate tiles, unique
  slug `custom-<owner>-<title>`); `GET /api/sets?owner=` returns that player's sets shaped
  like `/api/boards` entries.
- Frontend: `scEditor` (menu ✏️ "Create a set", `renderEditor()`); the screen carries both
  `auth` and `editor` classes so it reuses the auth field/label/input CSS. The player's sets
  (`MY_SETS`) are **folded into `BOARDS`** with `mine:true` (`mergeMySets()`), so
  `startBoard`/retry/score-submit work on them unchanged; cleared on player switch
  (`clearMySets()`). User-typed text is escaped with `esc()` wherever it hits `innerHTML`.
- Editor layout: desktop ≥861px is a wide (1080px) card capped at
  `min(744px, 100dvh − 120px)` — meta column (the card itself, title typed on it — rotating suggestions, Tab accepts / colors / icon grid / save) on the
  left, the two answer lists side-by-side on the right with their own scroll, so Save never
  leaves the screen. Mobile keeps the stacked flow. Icon + color choices style the set's
  **category card** everywhere it appears (Pick, All categories, Your sets, trophies).
- **✨ Decoy generation** (`api/decoys.js`, button `edFill` → `fillDecoys()`): POST
  title + 10 answers (+ already-typed decoys) → Claude **Haiku** (`claude-haiku-4-5`,
  official SDK, structured `json_schema` output, ~$0.001/call) returns near-miss decoys at
  the 7–9 difficulty rule; only EMPTY decoy slots are filled, user-typed decoys are never
  overwritten. Runs on Bedrock through the Lambda's IAM role (no API key). For user-created sets the user
  MAY still hand-write decoys — never auto-generate without the button press.

## Multiplayer duel (Play a friend)

- **Mode-aware from the start:** `matches.mode='duel'` today; race/party are future
  siblings (no mode picker in the UI until they exist). Stay **static + Neon + ~1.2s
  polling** — the duel is turn-based, no realtime service, no sockets.
- **Match shape: 3 boards, best 2 of 3** (first to 2 board wins ends it; the 3rd board
  decides a 1–1 split). **No −1**: a wrong tap scores 0 and passes the turn (wrong-tap
  counts are still recorded, stats only). **Points are cumulative** across the match
  (`matches.points_host/guest`, banked per finished board; the live board adds on top
  client-side) — the header badges and footer show the running totals.
- **Tables** (`scripts/migrate-matches.mjs` + `scripts/migrate-duel2.mjs`, idempotent):
  `matches` (room_code CHAR(4) unique among live matches, host/guest identity,
  `board_ids[]`, series counts, `points_*`, `winner` 1 host · 2 guest) + `match_state`
  (ONE row per match = the current board: `tiles_json` [{t,on,by}] with by 0/1/2, turn,
  scores, wrong counts, `version` bumped on every write, plus the tiebreak fields
  `tb_question/tb_answer/tb_tried_*`; `board_status` ∈ playing·tiebreak·done).
- **10s shot clock:** client shows a draining bar + a "⏰ TIME'S UP" takeover (deep
  buzzer); the SERVER enforces at 12s (2s network grace) — `expireStaleTurn()` flips
  overdue turns on every poll, and a tap on an expired turn 409s and passes instead.
  `state.turnMs` (age of the turn) keeps both phones' countdowns in sync.
- **Sudden death (tied board):** all 10 answers found at 5–5 → `board_status='tiebreak'`,
  a generated two-step mental-math question (`genTiebreak()`; answer NEVER sent to
  clients). First correct typed answer wins the board (`POST /api/match-tap` with
  `{answer}` instead of `{idx}`); one try per player per question, both wrong → fresh
  question, locks reset.
- **Routes** (flat files — the `vercel.json` functions glob is `api/*.js`; `_match.js` is
  the shared helper, underscore = not a lambda):
  - `POST /api/match` — `{name,avatar}` creates a lobby (3 random official boards, 4-digit
    code, 24h stale-lobby sweep); `{action:'start',id,key}` host-only, deals board 1.
  - `POST /api/match-join` — `{room,name,avatar}`; rejoin by the same key is allowed,
    third player / own room / dead code are 4xx.
  - `GET /api/match?id=` (or `?room=`) — THE POLL (also runs the shot-clock expiry).
    **Answers are never leaked mid-board:** untapped tiles carry no `on`; tapped tiles
    reveal only their own `hit`; full reveal once the board is in tiebreak/done.
  - `POST /api/match-tap` — tap `{id,key,idx,version}` or solve `{id,key,answer}`.
    The server is the referee: turn check, shot clock, tile lock, +1/0, flip turn; board
    ends when all 10 answers found; `advanceSeries()` banks points + deals the next board
    (opening turn alternates) or ends the match. All in a transaction with FOR UPDATE.
- **Client** (`index.html`): `M` state + `mApi()`; screens `scVersus` (Host / Join → full-width code entry),
  `scLobby` ("Invite a friend": code, invite link — share sheet on phones, players, host-only start), `scDuel`,
  `scMatch` (series winner + final points). **scDuel anatomy:** badges + "vs." header —
  whose TURN = whose badge GROWS (`.duel-p.turn`, scale 1.16 + gold ring), no turn text;
  category-only qcard (no board-strip); segmented `dprog` "X of 10 found" tracker; the
  `duel-clock` bar; tiles with tapper avatars; `duelfoot` = board № + series dots +
  cumulative totals pill left, QUIT right. Tiebreak = `tbLayer` takeover (question, typed
  entry, lockout message). Poll loop `startPoll()/applyMatch()` keys re-renders off a
  `status:version:guest` signature and re-syncs the clock from `turnMs`.
  Invite links: `#/join/1234` (`checkJoinHash()`; signs in first via `AFTER_AUTH`).
- **Known MVP gaps:** quitting only stops the local poll (the other phone is not told);
  abandoned games are swept after 24h by the next lobby creation; duel results still
  don't feed the players/leaderboard tables.

## Sing It (second game — `singit.html`)

Karaoke party game, **Zoom/Meet-first**: friends are on a video call; each opens Sing It in
a browser and joins a room. The call carries the singing; Sing It runs the card, the mic,
the timers, the track and the rules. Linked from Bank It's Games screen (`#modeSingIt`).

- **Rules:** every turn starts **face down**; the player whose turn it is taps the card to
  flip it, which starts the 5s **response clock** (the thermometer). Grabbing the mic
  (press and hold) freezes the thermometer. Sing while holding; **release to finish**. A
  hold where no singing was detected, or no grab within 5s = mic dropped + the **Mute
  Button** (skip your next turn). Any failed turn passes the same word to the next player,
  face down again. Success moves the token the card's value; START → 9 → WINNER! (10).
  Every game opens on the card **FREE**.
- **Modes:** Basic (turn order) is the focus. Race (rotating flipper, everyone grabs,
  fastest reaction time wins) exists but is parked — leave it alone unless asked.
- **Group moderation:** one veto + one override per player per game; 5s veto window after
  the mic comes down, 5s override window after a veto; singer can't override; no veto =
  the performance counts.
- **Mic:** opened ONLY while tuning or holding the mic, stopped on release. Lobby "Hold to
  tune your mic" = hold 3s in a quiet room → median level = room level. Singing =
  smoothed level (150ms) ≥ room + 8 dB for 250ms total within any 600ms window. Untuned
  players: holding counts as singing. Only a 0–1 level (+ the singing line) is sent, for
  everyone's wave; the wave draws the singing line as a mint dashed baseline. Playground
  has a "Show mic readout" toggle (live numbers for tuning the constants).
- **Live words:** the browser's Web Speech API runs on the singer's device while they hold
  the mic; text is broadcast and the prompt word lights up when heard. Display only —
  never scores. In Chrome the browser sends that audio to Google's speech service.
- **Architecture:** the **host's browser is the referee** (state machine in `hostIntent`
  and friends; broadcasts full state each change). `scripts/singit-relay.mjs` is a dumb
  WebSocket room fan-out on `/ws` (mounted by the dev server) — no game logic, nothing
  stored. In prod the same protocol runs on API Gateway WebSockets (`aws/ws-handler.js`). Host reload/leave closes the room.
- Tunables (timers, thresholds) are consts at the top of the script. The deck (`WORDS`)
  is ~250 words in three value tiers. Tokens are inline SVG neon stickers.
- Parked for later: a "Finish these lyrics" variant.

## Vault (`vault.html`)

Push-your-luck heist on the shell (navy + gold). Standard intro → mode. Five vaults a night,
drawn from the live official boards (`/api/boards`; its built-in 8 as fallback). Top row is two
columns: the vault (tap it to bank — there is no Bank button) · odds meter over the pot ladder.
Night's end = `Shell.results`; the take posts to `game_scores` as `vault` (Coins).
**Play a friend = a race:** the host deals two DIFFERENT nights (`startData`), each screen
shuffles its own tiles, both play at their own pace. A rival mirror (left column; a strip on
narrow screens) shows their vault #, pot, take and a word-less 20-tile grid (gold hit / red
trap), fed by `beacon()` messages. Higher take wins; leaving forfeits.
**Play the computer:** the same race against a local robot (`startCpu` / `robotVault`): ~90%
correct picks, taps every ~1–2.5s, banks at a random 3–7 hits (sometimes goes for the sweep).
The rival panel reads "vs. Name 🤖" / vault-or-status / pot · take / grid.

## Tic Tac Toe, Four in a Row, Memory

Small games on the shell, each with its own stage color, posting to `game_scores`:
- **Tic Tac Toe** (`tictactoe.html`, grape): vs computer (Easy = mostly random, Unbeatable =
  minimax — 0 losses across all 642 games) or Play a friend (host X, guest O). Posts `ttt` wins.
- **Four in a Row** (`four.html`, arcade blue): 7×6, vs computer (Easy / Hard = alpha-beta
  depth 5) or Play a friend (host red). Posts `four` wins.
- **Memory** (`memory.html`, sunshine): 16 cards / 8 pairs. Solo: points = max(5, 40 − 2 ×
  (tries − 8)). Play a friend: turns, a match goes again; the host deals (`startData`) so both
  screens share the deck; points = pairs + 5 for the win. Posts `memory` points.
- Online moves are small messages applied identically on both screens; the first move
  alternates each game; "Play again" resets once even if both press it.

## Dots & Boxes, Mancala, Rock Paper Scissors, Sea Battle, Checkers, Reversi, Scramble, Echo, React

Same pattern as the small games above (intro → vs computer Easy/Hard · Play a friend → results),
each posting wins to `game_scores`:
- **Dots & Boxes** (`dots.html`, green, `dots`): 4×4 boxes; closing a box goes again. Hard takes free
  boxes, never hands one over while a safe line exists, else gives away the fewest (chain sim).
- **Mancala** (`mancala.html`, terracotta, `mancala`): Kalah rules, 4 stones a pit; stone-by-stone
  animation through a move queue (keeps both screens in step). Hard = alpha-beta depth 7.
- **Rock Paper Scissors** (`rps.html`, pink, `rps`): first to 3. Tricky learns what you play after
  each move. Online picks are keyed by game + round so an early pick isn't lost.
- **Sea Battle** (`battle.html`, sea blue, `battle`): 8×8, ships 4·3·3·2 that never touch, Shuffle →
  Ready. Each screen keeps its own fleet secret: `shot` → the target answers `res` {hit, sunk, all}.
  Hard AI hunts on a checkerboard, then works along hits.
- **Checkers** (`checkers.html`, red, `checkers`): American rules — forced jumps, multi-jumps,
  crowning ends the move; 40 moves each without a capture = draw. Guest sees the board flipped.
  Hard = alpha-beta depth 6. Pieces use `--pc0/--pc1`, separate from the UI accents.
- **Reversi** (`reversi.html`, felt green, `reversi`): no move = skipped; Hard = alpha-beta depth 5
  on a corner-weighted table + mobility.
- **Scramble** (`scramble.html`, plum, `scramble` points): unjumble a word (tap or type; any listed
  anagram counts). Words come from the shared `scramble_words` pool (500 seeds,
  `scripts/migrate-scramble.mjs`; `GET /api/scramble`). Each browser remembers what it has seen
  (`scramble-seen`); once it has seen the whole pool, `POST /api/scramble` has Haiku invent ~40 new
  words, saved for everyone (Mix It's trick). Every game opens with 10 easy 4-letter then 10 easy 5-letter words (`EASY4/5`, no
  alternate spellings). Solo = a minute per word, unlimited skips, the third time-out ends it; points = letters. Play a friend = the host deals one list and
  referees: a guest solve is a `claim`, the host awards the first one; 30s per word; first to 5 (+5).
- **Echo** (`echo.html`, slate, `echo` points): Simon. Solo = rounds echoed; Play a friend = the
  host deals one sequence, both play each round at once, last one standing wins (+5).
- **React** (`react.html`, tangerine, `react` points): a kid's invention (request 69). 60s on a 4×4 grid after a
  3s countdown; player 1 (the host) owns the purple squares, player 2 the orange circles. Shapes pop up in
  empty cells (~1/s, life 2.4→1.9s, ≤5 on the grid) and wobble before they go. Own shape +1; the other's
  shape −1/+1 and it stays for its owner (a wrong tap counts only before the owner's tap); a ⚽ rolls across
  the lane above the grid every 8–12s (3.6s to cross), +3 to the first tap. The host deals a `seed`; both
  screens build the same shape + ball schedule and run their own clock; every tap is `{t:'tap', g, id, at}`
  and scores are recomputed from the tap map so both screens agree. Pause button (both screens pause).
  vs computer: Easy loses to a decent player 9 in 10; Hard is a coin flip. Posts your points.
- These pages share one head/CSS/sound block (copied into each file, no build step).
- ⚠️ The relay stamps every message with `from` (the sender id) — never use `from` as a field in
  game messages (Checkers sends `f`).

## Mix It (`mix.html`)

Infinite-Craft-style combining game in Bank It's look. Start with Water / Fire / Wind /
Earth; drag items from the list onto the board and drop one onto another.
- **`api/mix.js`** (`POST {a,b,by}` → `{name, emoji, first}`): the pair (sorted, lowercase)
  is looked up in `mix_recipes`; a hit returns instantly. A never-tried pair goes to Claude
  Haiku on Bedrock (same setup as `api/decoys.js`), then the item (`mix_items`, `first_by` =
  the first discoverer) and the recipe are saved forever — same answer for everyone after.
  Both inputs must already exist in `mix_items`, so the route can't be used to generate
  arbitrary text. Tables: `scripts/migrate-mix.mjs` (idempotent; seeds the four starters).
- **Your collection** lives in the browser (`mixit-inv`); ★ marks your First Discoveries.
- **Play a friend:** the shell's lobby. Split screen — your friend's board on the left (live
  mirror, normalized 0–1 positions ~14×/s), yours beside the item list; discoveries toast.
- Leaderboard: First Discoveries (`mix_items.first_by`).
- **Board extras (neal.fun-style):** a light "ting" + a faint ray of light behind anything new to you;
  light-blue hover on items. Bottom-left 🏆 = **Categories** (fixed lists in `CATS`, x / N progress, a
  date-seeded Daily Challenge from `DAILY_POOL`; a category shows found items, the rest faded).
  Bottom-right = **Recipes** (search your items → every pair that makes it: your own `mixit-recipes`
  history + `GET /api/mix?item=` filtered to pairs whose inputs you own).

## The platform shell (`shell.css` / `shell.js`) and the hub (`games.html`)

- **`Shell.init({brand, theme, gameMenu, playground, topExtra, beforeLeave, onJoinLink})`** adds
  the top bar (menu · wordmark · theme toggle), the **context menu** (Games / High Scores / Settings
  first, then this game's items — Bank It: Categories, Create — + theme on mobile) and the
  **playground** (stage color, display font, depth, + per-game extras: Bank It chunkiness,
  Sing It neon glow + mic readout). Global items go to `games.html#/games|highscores|settings`.
- **One identity** everywhere: `bankit-user-v1` `{name, avatar}` (Bank It's key). `Shell.player()`,
  `Shell.requirePlayer()` (the "Who's playing?" card). Sing It keeps its token per game.
- **The standard start sequence:** intro card ("Let's play!") → `Shell.mode` (Play solo / vs
  computer · Play a friend) → `Shell.friend({game, onStart, onMessage, startData, …})` = Host /
  Join → lobby (code, invite link, players, host Start) over the relay (`/ws`). The `game` tag
  stops a code from joining another game's room. Invite links: `page#/join/1234`.
  **Switching games without a new code:** the room's connection lives in the app frame
  (`window.Room` in index.html; shell.js borrows it), so it survives page changes. With a friend in
  the room, a hub tile or "Play a friend" sends `sh-invite`; the friend gets a Join / Not now card in
  the frame; Join loads the same page on both and it starts without a lobby (`joinCode(FRIEND,
  'switch')`; the picker hosts). Leaving a game mid-play sends `sh-away`. The results card's hub link
  reads "Change game" while a friend is in the room. Sing It keeps its own connection.
  Bank It keeps its own duel screens (`renderVersus`) behind the same mode choice; Sing It keeps
  its own lobby (host referee).
- **`Shell.results({em, title, big, sub, again, change})`** — the standard end card
  (Play again · Change mode · Games). `Shell.postScore(game, score)` → `POST /api/game-scores`.
- **Hub:** Games grid (Request new pinned first — the interview, see "Player-built games"), **My Games**
  (`#/mygames`: the player's built games, six slots), 
  **High Scores** (one slide per game, ‹ › + dots; `GET /api/leaderboard?game=`), **Settings**
  (identity + avatar, switch player, stats across games via `?name=`, Dark mode, Sound —
  `Shell.soundOn()`, which the games' tone functions check).
- **Scores:** Bank It → `scores`/`players` (lifetime points); Mix It → first discoveries;
  Sing It / Tic Tac Toe / Four in a Row / Dots & Boxes / Mancala / Rock Paper Scissors / Sea Battle /
  Checkers / Reversi (wins), Memory, Echo, Scramble and React (points) and Vault (coins) → `game_scores`
  (`scripts/migrate-game-scores.mjs`).
- No arrows on buttons ("Play", not "Play →").

## Player-built games (Request new → interview → build → My Games)

A kid describes a game in the hub's Request new form; the platform interviews them, writes the plan up as
their invention, asks **"Build this game?"**, builds it, and it appears under My Games. No admin step yet;
a built game is **owner-only** (`player_games.is_public=FALSE`) until an admin flips it, and the invite
link carries `by=<owner>` so a friend can still join through it.
- **Interview** (`POST /api/requests`, Claude **Haiku** on Bedrock, `api/_ai.js`): create → up to 3 rounds
  of 2–4 typed questions (`choice` · `multi` · `bool` · `text`) → the plan (`spec`: title, emoji, color from
  a fixed palette, pitch, players solo|friend|both, how[], win, builder_notes[]). Every finished plan passes
  a **referee** on the builder model that closes holes (unwinnable, stalls, guaranteed ties) and notes each
  as `Fix:`. "Not quite" (`action:'revise'`) = one more round from the kid's note. Statuses: `asking` →
  `proposed` → `building` → `built` | `failed` (legacy rows stay `new`). Transcript + round live on the row.
- **Build** (`action:'build'` → `api/_builder.js`): the plan + `aws/game-playbook.md` (the Shell API, the
  flow, house style, the real-time sync recipe, "check the plan") + `aws/game-skeleton.html` (the shared
  head/CSS/sounds of the small games with absolute `/shell.css` `/shell.js`) → **Opus 4.5**
  (`BANKIT_BUILDER_MODEL`; the strongest Claude this account has on Bedrock) → one HTML file, checked
  (shell loaded, `Shell.init`, no other scripts/fetch/eval, no skeleton placeholders, inline JS parses) with
  one retry, saved to `player_games` (slug `<title>-<request id>`, tokens, model). Prod: the API Lambda
  invokes **`bankit-builder`** asynchronously (`BUILDER_FUNCTION`, 15-min timeout, same package,
  `aws/builder-handler.js`); the dev server builds in-process. ~90 s and ~6k in / ~8k out per build.
- `aws/example-shape-bingo.html` and `aws/example-react.html` — the two pilot games, hand-built on the skeleton
  after their generated plans failed (unwinnable; an inhuman pace). They are the pages stored for `shape-bingo-70`
  and `react-69`, and the reference for what a built game should look like. `react.html` in the hub is the same
  React with relative paths and score posting.
- **Play** (`GET /api/play?g=<slug>&by=<name>` → text/html): the frame's `SAFE` allows `api/play?…` in the
  iframe; `Shell.nav` uses absolute `/games.html`; the lobby's invite link keeps `location.search`.
- **My Games** (`games.html#/mygames`): built games as tiles (emoji/color from the plan), builds in progress
  as dashed "Building…" slots, failed ones "tap to retry", placeholders to six. `shell.js` adds the **My
  Games** menu item once a player has built or is building (`bankit-mygames`), polls
  `GET /api/requests?by=` every 20 s while a build is pending (`bankit-build-pending`) and puts a dot on the
  menu button + item when one lands (`bankit-build-ready`, cleared when My Games opens).
- The **DB auto-pause** makes the first request after idle take 15–30 s; buttons show "Thinking…" meanwhile.

## Players & points

- **Points persist in the DB, keyed by username** — not in localStorage. localStorage
  (`bankit-user-v1`) holds **identity only**: `{name, avatar}`.
- **`players` table:** `name_key` PK = `lower(trim(name))` (so "FoxBanker" and "foxbanker" are one
  profile), plus `name`, `avatar`, `total_points`, `runs`, `sweeps`, `best`. It's **upserted on
  every finished round** inside the `/api/scores` POST (same request that logs the score row).
- The frontend's `STATS` object is fetched from `GET /api/players?name=` so stats follow the
  player across devices.
- There is no Profile screen any more: identity + stats across games live in the hub's
  **Settings**; leaderboards in the hub's **High Scores**.
- **No password** — username-only auth means whoever types a name owns that profile. Acceptable
  for a party game; a PIN could be added later for true ownership.
- **SQL gotcha:** in the players upsert, a single param used as both `int` (`total_points`) and
  `smallint` (`best`) needs explicit `::int` / `::smallint` casts, or Postgres errors with
  "inconsistent types deduced for parameter".

## Screen flow

Bank It (`bankit.html`): `Start (intro) → scAuth (first time only) → mode (Shell.mode: Play solo →
Pick → Board → Results · Play a friend → scVersus)`, plus `scCategories`, the editor, My sets.
"Let's play" runs `playEntry()`; `afterAuth()` opens the mode choice. Results: Play again ·
New category · Games.

- **Pick a Category is randomized:** `renderPick` shuffles board indices and shows `PICK_COUNT`
  (=5) at random each visit. "All categories" (`renderCategories`) still shows every board.
  (The old `PICK_HIDDEN` gate was removed — randomizing from the full list superseded it.)
- Tiles render as `<span class="chk">✔</span>${label}`, so a tile's `textContent` is prefixed
  with `✔` — strip it when matching tile labels programmatically.

## Conventions

- **No `Math.random` rule does NOT apply here** — `index.html` uses it freely (confetti, the
  random Pick). The deterministic `shuffle(arr, seed)` is only for the per-board tile order.
- Match the existing house style: Title-Case tile labels, chunky display font, the card/button
  CSS vocabulary (`.btn`, `.btn.teal/.ghost`, `.card`, `.stat`, color slots `c0..c3`).
- Run locally with the Node dev server (`scripts/dev-server.mjs`, port 3000): static pages, the
  `api/*.js` handlers against Aurora, and the `/ws` relay for Play a friend.

## Run it

```bash
node scripts/dev-server.mjs   # → http://localhost:3000 (hub + games + api/*.js + the /ws relay)
```
