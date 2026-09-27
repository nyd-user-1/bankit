// Mix It tables (idempotent): every item ever made, and every pair's saved result.
//   node scripts/migrate-mix.mjs
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require('dotenv').config({ path: path.join(ROOT, '.env.local'), quiet: true });
const { getPool } = require('../api/_db.js');

const pool = getPool();
await pool.query(`
  CREATE TABLE IF NOT EXISTS mix_items (
    name_key   TEXT PRIMARY KEY,               -- lower(trim(name))
    name       TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    first_by   TEXT,                           -- who discovered it first (NULL = a starter)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
await pool.query(`
  CREATE TABLE IF NOT EXISTS mix_recipes (
    a_key      TEXT NOT NULL,                  -- the pair, sorted: a_key <= b_key
    b_key      TEXT NOT NULL,
    result_key TEXT NOT NULL REFERENCES mix_items(name_key),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (a_key, b_key)
  )`);
for (const [name, emoji] of [['Water', '💧'], ['Fire', '🔥'], ['Wind', '🌬️'], ['Earth', '🌍']]) {
  await pool.query(
    `INSERT INTO mix_items (name_key, name, emoji) VALUES ($1, $2, $3) ON CONFLICT (name_key) DO NOTHING`,
    [name.toLowerCase(), name, emoji]
  );
}
const { rows } = await pool.query(`SELECT (SELECT count(*) FROM mix_items) AS items, (SELECT count(*) FROM mix_recipes) AS recipes`);
console.log('mix tables ready:', rows[0]);
