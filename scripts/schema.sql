-- Bank It schema — question sets + leaderboard
-- Safe to re-run: drops and recreates.

DROP TABLE IF EXISTS board_answers CASCADE;
DROP TABLE IF EXISTS scores CASCADE;
DROP TABLE IF EXISTS boards CASCADE;

-- ===== question sets =====
CREATE TABLE boards (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,      -- e.g. 'goes-with-milk'
  title       TEXT NOT NULL,             -- 'Things That Go Well With Milk'
  icon        TEXT NOT NULL,             -- emoji
  color_slot  SMALLINT NOT NULL DEFAULT 0,  -- 0 purple · 1 teal · 2 pink · 3 green
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE board_answers (
  id          SERIAL PRIMARY KEY,
  board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,             -- the tile label
  on_list     BOOLEAN NOT NULL,          -- TRUE = real answer, FALSE = decoy
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_answers_board ON board_answers(board_id);

-- ===== leaderboard =====
CREATE TABLE scores (
  id          SERIAL PRIMARY KEY,
  player_name TEXT NOT NULL,
  avatar      TEXT NOT NULL DEFAULT '🎯',
  board_id    INTEGER REFERENCES boards(id) ON DELETE SET NULL,  -- NULL = whole-game / aggregate run
  score       SMALLINT NOT NULL CHECK (score >= 0 AND score <= 10),
  how_ended   TEXT NOT NULL CHECK (how_ended IN ('banked','busted','clear')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_scores_board ON scores(board_id);
CREATE INDEX idx_scores_score ON scores(score DESC);
