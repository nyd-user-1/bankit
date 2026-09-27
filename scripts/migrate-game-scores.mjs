// game_scores (idempotent): one row per finished game for every game except Bank It
// (Bank It keeps its scores/players tables). Each game decides what a row's score means.
//   node scripts/migrate-game-scores.mjs
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require('dotenv').config({ path: path.join(ROOT, '.env.local'), quiet: true });
const { getPool } = require('../api/_db.js');

const pool = getPool();
await pool.query(`
  CREATE TABLE IF NOT EXISTS game_scores (
    id         SERIAL PRIMARY KEY,
    game       TEXT NOT NULL,                 -- singit · ttt · four · memory
    name_key   TEXT NOT NULL,                 -- lower(trim(name)) — the same player as Bank It's
    name       TEXT NOT NULL,
    avatar     TEXT NOT NULL DEFAULT '🎯',
    score      INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_game_scores_game ON game_scores(game, name_key)`);
const { rows } = await pool.query(`SELECT count(*) AS n FROM game_scores`);
console.log('game_scores ready:', rows[0]);
