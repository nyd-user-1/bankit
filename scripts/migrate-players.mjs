// Idempotent migration: add the players table (if missing) and backfill from existing scores.
// Run: node scripts/migrate-players.mjs
import dotenv from 'dotenv'; dotenv.config({ path: '.env.local' });
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

await c.query(`
  CREATE TABLE IF NOT EXISTS players (
    name_key     TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    avatar       TEXT NOT NULL DEFAULT '🎯',
    total_points INTEGER NOT NULL DEFAULT 0,
    runs         INTEGER NOT NULL DEFAULT 0,
    sweeps       INTEGER NOT NULL DEFAULT 0,
    best         SMALLINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`);
await c.query(`CREATE INDEX IF NOT EXISTS idx_players_points ON players(total_points DESC);`);

// Backfill: aggregate every existing score row by lowercased name.
// Re-runnable: recomputes totals from scratch for names found in scores.
const { rowCount } = await c.query(`
  INSERT INTO players (name_key, name, avatar, total_points, runs, sweeps, best, updated_at)
  SELECT
    lower(btrim(player_name))                              AS name_key,
    (array_agg(player_name ORDER BY created_at DESC))[1]   AS name,    -- most recent display name
    (array_agg(avatar      ORDER BY created_at DESC))[1]   AS avatar,  -- most recent avatar
    COALESCE(SUM(score), 0)                                AS total_points,
    COUNT(*)                                               AS runs,
    COUNT(*) FILTER (WHERE how_ended = 'clear')            AS sweeps,
    COALESCE(MAX(score), 0)                                AS best,
    now()
  FROM scores
  WHERE btrim(player_name) <> ''
  GROUP BY lower(btrim(player_name))
  ON CONFLICT (name_key) DO UPDATE SET
    total_points = EXCLUDED.total_points,
    runs         = EXCLUDED.runs,
    sweeps       = EXCLUDED.sweeps,
    best         = GREATEST(players.best, EXCLUDED.best),
    avatar       = EXCLUDED.avatar,
    name         = EXCLUDED.name,
    updated_at   = now();
`);
console.log(`✓ players table ready; backfilled/updated ${rowCount} player(s) from scores`);

const { rows } = await c.query(`SELECT name, avatar, total_points, runs, sweeps, best FROM players ORDER BY total_points DESC LIMIT 20`);
console.table(rows);
await c.end();
