-- Bank It schema — question sets + leaderboard
-- Safe to re-run: drops and recreates.

DROP TABLE IF EXISTS board_answers CASCADE;
DROP TABLE IF EXISTS scores CASCADE;
DROP TABLE IF EXISTS players CASCADE;
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
  -- custom sets (player-created boards). Official boards: owner_key NULL (treated as
  -- public+approved by /api/boards regardless of the flags below).
  owner_key   TEXT,                          -- lower(trim(username)) of the creator
  is_public   BOOLEAN NOT NULL DEFAULT FALSE,
  is_approved BOOLEAN NOT NULL DEFAULT FALSE, -- moderation gate for the global catalog
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_boards_owner ON boards(owner_key);

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

-- ===== players (persistent per-username profile / running totals) =====
-- name_key = lowercased name, so 'FoxBanker' and 'foxbanker' are one profile.
-- Aggregates are maintained on each finished round (see api/scores.js POST).
CREATE TABLE players (
  name_key     TEXT PRIMARY KEY,            -- lower(trim(name))
  name         TEXT NOT NULL,               -- last-seen display name
  avatar       TEXT NOT NULL DEFAULT '🎯',
  total_points INTEGER NOT NULL DEFAULT 0,  -- lifetime banked points
  runs         INTEGER NOT NULL DEFAULT 0,  -- rounds finished
  sweeps       INTEGER NOT NULL DEFAULT 0,  -- perfect 10/10 clears
  best         SMALLINT NOT NULL DEFAULT 0, -- best single-round score
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_players_points ON players(total_points DESC);
