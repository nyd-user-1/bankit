// game_requests + player_games (idempotent): the hub's "Request new" form, from the first submit to a
// built game. A request carries the interview (transcript, round), the approved write-up (spec) and the
// build status; player_games holds the generated page a build produced (served by GET /api/play?g=slug).
//   node scripts/migrate-requests.mjs
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require('dotenv').config({ path: path.join(ROOT, '.env.local'), quiet: true });
const { getPool } = require('../api/_db.js');

const pool = getPool();
await pool.query(`
  CREATE TABLE IF NOT EXISTS game_requests (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL,                       -- the game's name, as typed
    description  TEXT NOT NULL,                       -- how it plays
    links        TEXT NOT NULL DEFAULT '',            -- example links, one per line
    requested_by TEXT,                                -- the signed-in player's name
    status       TEXT NOT NULL DEFAULT 'new',         -- new (legacy) · asking · proposed · building · built · failed
    prompt       TEXT,                                -- (legacy; the write-up lives in spec)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
await pool.query(`
  ALTER TABLE game_requests
    ADD COLUMN IF NOT EXISTS round      SMALLINT NOT NULL DEFAULT 0,        -- question rounds asked so far
    ADD COLUMN IF NOT EXISTS transcript JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{role, text}] the whole interview
    ADD COLUMN IF NOT EXISTS spec       JSONB,                              -- the write-up the kid approved
    ADD COLUMN IF NOT EXISTS game_id    INTEGER,                            -- player_games.id once built
    ADD COLUMN IF NOT EXISTS error      TEXT,                               -- why a build failed
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
await pool.query(`
  CREATE TABLE IF NOT EXISTS player_games (
    id         SERIAL PRIMARY KEY,
    request_id INTEGER,
    owner_key  TEXT NOT NULL,                         -- lower(trim(owner)), the same key as players
    owner      TEXT NOT NULL,
    slug       TEXT UNIQUE NOT NULL,                  -- /api/play?g=<slug>
    title      TEXT NOT NULL,
    emoji      TEXT NOT NULL DEFAULT '🎮',
    color      TEXT NOT NULL DEFAULT '#8b5cf6',
    html       TEXT NOT NULL,                         -- the whole generated page
    is_public  BOOLEAN NOT NULL DEFAULT FALSE,        -- owner-only until an admin approves it
    model      TEXT,
    tokens_in  INTEGER,
    tokens_out INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_player_games_owner ON player_games(owner_key)`);
const a = await pool.query(`SELECT count(*) AS n FROM game_requests`);
const b = await pool.query(`SELECT count(*) AS n FROM player_games`);
console.log('game_requests:', a.rows[0].n, '· player_games:', b.rows[0].n);
