# Bank It — project guide

A quick push-your-luck party game. Pick a category, see **20** answers, tap the **10** you
think are on the hidden list. Every correct tap is +1; one wrong tap ends the round — so
*bank it & stop* while you're ahead. A perfect 10/10 is a "clean sweep."

## Stack & layout

- **Frontend:** ONE self-contained `index.html` — plain HTML/CSS/JS, **no build step**, no
  framework. All screens, styles, and game logic live in this single file. Light/dark toggle
  (persisted) + a desktop-only design playground.
- **Backend:** serverless functions in `api/` over Postgres (Neon) via `pg`.
  - `api/_db.js` — shared pooled connection (`getPool()`); `DATABASE_URL` from env.
  - `api/boards.js` — `GET /api/boards` → all active boards + their answers/decoys.
  - `api/scores.js` — `GET` leaderboard rows; `POST` records a finished run **and** upserts
    the player's running totals (see Players below).
  - `api/players.js` — `GET /api/players?name=` → one player's aggregate + swept board titles.
- **Scripts:**
  - `scripts/schema.sql` — full schema (DROP+CREATE; safe to re-run on a throwaway DB).
  - `scripts/seed.mjs` — full reseed (schema + the original boards + sample scores).
  - `scripts/add-board.mjs` — add ONE board: edit the `BOARD` const, then `node scripts/add-board.mjs`.
  - `scripts/add-boards-batch.mjs` — add several boards at once (idempotent on slug).
  - `scripts/migrate-players.mjs` — idempotent: creates the `players` table + backfills from
    existing `scores`. Already applied to the live DB.
- **Deploy:** static + serverless on **Vercel** (prod alias `bankit-pearl.vercel.app`).
  `DATABASE_URL` lives in `.env.local` (gitignored) locally and in Vercel env in prod.
  No Vercel deployment-count limit — retry on failure.
  - ⚠️ **Git auto-deploys are DISCONNECTED for this project** (2026-06-10). Vercel's
    git-triggered builds repeatedly produced deployments missing newly-added `api/*.js`
    lambdas (the route 404s in prod), and even raced a good build with a stale function-less
    copy that stole the prod alias. `vercel.json` now pins explicit function detection
    (`"functions": {"api/*.js": ...}`), but don't reconnect git. **Deploying = a manual step
    after every push:** `vercel build --prod && vercel deploy --prebuilt --prod`, then verify
    with `vercel inspect <url>` that every λ is listed (and curl any new route).

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
  `min(744px, 100dvh − 120px)` — meta column (title / 4×4 icon grid / colors / save) on the
  left, the two answer lists side-by-side on the right with their own scroll, so Save never
  leaves the screen. Mobile keeps the stacked flow. Icon + color choices style the set's
  **category card** everywhere it appears (Pick, All categories, Your sets, trophies).
- **✨ Decoy generation** (`api/decoys.js`, button `edFill` → `fillDecoys()`): POST
  title + 10 answers (+ already-typed decoys) → Claude **Haiku** (`claude-haiku-4-5`,
  official SDK, structured `json_schema` output, ~$0.001/call) returns near-miss decoys at
  the 7–9 difficulty rule; only EMPTY decoy slots are filled, user-typed decoys are never
  overwritten. Needs `ANTHROPIC_API_KEY_BANKIT` in the **Vercel env** (it's marked
  sensitive, so it cannot be pulled/exported — and `vercel dev` ignores `.env.local`, so
  local dev needs it added to the Vercel *Development* environment by hand). Without it
  the route returns 503 "Decoy magic is not set up yet." For user-created sets the user
  MAY still hand-write decoys — never auto-generate without the button press.

## Multiplayer duel (Play a friend)

- **Mode-aware from the start:** `matches.mode='duel'` today; race/party are future
  siblings (the lobby's mode picker shows them greyed). Stay **static + Neon + ~1.2s
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
- **Client** (`index.html`): `M` state + `mApi()`; screens `scVersus` (host / join-by-code),
  `scLobby` (code, copy-invite-link, players, mode picker, host-only start), `scDuel`,
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

## Players, points & the Profile screen

- **Points persist in the DB, keyed by username** — not in localStorage. localStorage
  (`bankit-user-v1`) holds **identity only**: `{name, avatar}`.
- **`players` table:** `name_key` PK = `lower(trim(name))` (so "FoxBanker" and "foxbanker" are one
  profile), plus `name`, `avatar`, `total_points`, `runs`, `sweeps`, `best`. It's **upserted on
  every finished round** inside the `/api/scores` POST (same request that logs the score row).
- The frontend's `STATS` object is fetched from `GET /api/players?name=` so stats follow the
  player across devices.
- **Profile screen** (`scProfile`, rendered by `renderProfile()`, menu item 👤 "Profile"): avatar,
  name, lifetime points, a stat row (boards swept / best run / runs played), and a trophy list of
  swept boards. Markup uses `.profile-*` classes and `profile*` element IDs (`profileAv`,
  `profileName`, `profilePts`, `profileSweeps`, …). This is the permanent home for a perfect 10/10
  sweep. The **High Scores** screen is the separate global/leaderboard view.
- **No password** — username-only auth means whoever types a name owns that profile. Acceptable
  for a party game; a PIN could be added later for true ownership.
- **SQL gotcha:** in the players upsert, a single param used as both `int` (`total_points`) and
  `smallint` (`best`) needs explicit `::int` / `::smallint` casts, or Postgres errors with
  "inconsistent types deduced for parameter".

## Screen flow

`Start → scAuth (sign in/up) → Pick → Board → Results`, plus `scProfile` (profile), `scHighScores`,
`scHowTo`, `scCategories` (all boards). "Let's play" runs `playEntry()` → `renderAuth()`.

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
- Run locally with any static server for UI work: `python3 -m http.server 8000`. The `/api/*`
  routes won't run under that (you'll get the fallback boards + 404s on scores) — use `vercel dev`
  if you need the live API, or test API handlers directly against the DB.

## Run it

```bash
python3 -m http.server 8000   # static UI only; open http://localhost:8000
# or, with the serverless API:
vercel dev
```
