// Duel rework migration — cumulative match points + math tiebreak state. Idempotent.
// Run: node scripts/migrate-duel2.mjs
import dotenv from 'dotenv'; dotenv.config({ path: '.env.local' });
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });

await c.connect();
// cumulative points across the match (completed boards; the live board adds on top client-side)
await c.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS points_host INTEGER NOT NULL DEFAULT 0`);
await c.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS points_guest INTEGER NOT NULL DEFAULT 0`);
// sudden-death math tiebreak (board tied → typed answer, first correct wins the board)
await c.query(`ALTER TABLE match_state ADD COLUMN IF NOT EXISTS tb_question TEXT`);
await c.query(`ALTER TABLE match_state ADD COLUMN IF NOT EXISTS tb_answer INTEGER`);
await c.query(`ALTER TABLE match_state ADD COLUMN IF NOT EXISTS tb_tried_host BOOLEAN NOT NULL DEFAULT FALSE`);
await c.query(`ALTER TABLE match_state ADD COLUMN IF NOT EXISTS tb_tried_guest BOOLEAN NOT NULL DEFAULT FALSE`);
// widen the board_status CHECK to allow the sudden-death state
await c.query(`ALTER TABLE match_state DROP CONSTRAINT IF EXISTS match_state_board_status_check`);
await c.query(`ALTER TABLE match_state ADD CONSTRAINT match_state_board_status_check
  CHECK (board_status IN ('playing','tiebreak','done'))`);
console.log('✓ matches.points_* + match_state.tb_* + tiebreak status in place');
await c.end();
