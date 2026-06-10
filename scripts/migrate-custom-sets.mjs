// Custom sets migration — adds ownership columns to boards. Idempotent; safe on the live DB.
// Run: node scripts/migrate-custom-sets.mjs
import dotenv from 'dotenv'; dotenv.config({ path: '.env.local' });
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });

await c.connect();
await c.query(`ALTER TABLE boards ADD COLUMN IF NOT EXISTS owner_key TEXT`);
await c.query(`ALTER TABLE boards ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE`);
await c.query(`ALTER TABLE boards ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT FALSE`);
// official boards (no owner) are the public, approved catalog
await c.query(`UPDATE boards SET is_public=TRUE, is_approved=TRUE WHERE owner_key IS NULL`);
await c.query(`CREATE INDEX IF NOT EXISTS idx_boards_owner ON boards(owner_key)`);
const { rows:[n] } = await c.query(`SELECT COUNT(*) AS total, COUNT(owner_key) AS custom FROM boards`);
console.log(`✓ boards migrated — ${n.total} total, ${n.custom} custom`);
await c.end();
