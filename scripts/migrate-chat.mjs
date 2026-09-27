// chat_messages (idempotent): the platform chat's history.
//   node scripts/migrate-chat.mjs
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require('dotenv').config({ path: path.join(ROOT, '.env.local'), quiet: true });
const { getPool } = require('../api/_db.js');

const pool = getPool();
await pool.query(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         SERIAL PRIMARY KEY,
    name_key   TEXT NOT NULL,               -- lower(trim(name)) — the platform identity
    name       TEXT NOT NULL,
    avatar     TEXT NOT NULL DEFAULT '🎯',
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at DESC)`);
const { rows } = await pool.query(`SELECT count(*) AS n FROM chat_messages`);
console.log('chat_messages ready:', rows[0]);
