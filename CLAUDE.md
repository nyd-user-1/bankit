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
  - ⚠️ **New `api/*.js` files can silently miss the cloud build** (deployment shows only the
    old lambdas under "Builds"; the new route 404s in prod even though the HTML deployed).
    Fix: `vercel pull --yes && vercel build --prod && vercel deploy --prebuilt --prod`.
    After adding any API file, verify with `vercel inspect <url>` that its λ is listed.

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
