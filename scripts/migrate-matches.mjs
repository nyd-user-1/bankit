// Multiplayer duel migration — matches + match_state tables. Idempotent; safe on the live DB.
// Run: node scripts/migrate-matches.mjs
import dotenv from 'dotenv'; dotenv.config({ path: '.env.local' });
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });

await c.connect();

// one row per hosted game. mode='duel' today; 'race'/'blooket' are future siblings.
await c.query(`CREATE TABLE IF NOT EXISTS matches (
  id                SERIAL PRIMARY KEY,
  room_code         CHAR(4) NOT NULL,            -- 4-digit shareable code
  mode              TEXT NOT NULL DEFAULT 'duel',
  status            TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby','playing','done')),
  host_key          TEXT NOT NULL,               -- lower(trim(username))
  host_name         TEXT NOT NULL,
  host_avatar       TEXT NOT NULL DEFAULT '🎯',
  guest_key         TEXT,
  guest_name        TEXT,
  guest_avatar      TEXT,
  board_ids         INTEGER[] NOT NULL,          -- the best-of-5 set list
  current_board_idx INTEGER NOT NULL DEFAULT 0,
  series_host       INTEGER NOT NULL DEFAULT 0,  -- boards won
  series_guest      INTEGER NOT NULL DEFAULT 0,
  winner            SMALLINT,                    -- 1 host · 2 guest · 0 drawn series
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
// a room code is only reserved while its match is still live
await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_room_live
  ON matches(room_code) WHERE status <> 'done'`);

// the CURRENT board's shared state (one row per match, reset as the series advances).
// tiles_json: [{t, on, by}] — by = 0 untapped · 1 host · 2 guest. version bumps on
// every write so clients can ignore stale polls.
await c.query(`CREATE TABLE IF NOT EXISTS match_state (
  match_id     INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  tiles_json   JSONB NOT NULL,
  turn         SMALLINT NOT NULL DEFAULT 1,      -- whose tap is next (1 host · 2 guest)
  score_host   INTEGER NOT NULL DEFAULT 0,
  score_guest  INTEGER NOT NULL DEFAULT 0,
  wrong_host   INTEGER NOT NULL DEFAULT 0,       -- wrong taps this board (the tiebreak)
  wrong_guest  INTEGER NOT NULL DEFAULT 0,
  board_status TEXT NOT NULL DEFAULT 'playing' CHECK (board_status IN ('playing','done')),
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

const { rows:[n] } = await c.query(`SELECT
  (SELECT COUNT(*) FROM matches) AS matches,
  (SELECT COUNT(*) FROM match_state) AS states`);
console.log(`✓ matches migrated — ${n.matches} matches, ${n.states} live states`);
await c.end();
