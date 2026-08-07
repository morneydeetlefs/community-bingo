-- ─────────────────────────────────────────────────────────────────────────────
-- Community Bingo — D1 Schema
-- MD Works · Morney Deetlefs · mdworks.dev
--
-- Run with:
--   wrangler d1 execute community-bingo-db --file=schema.sql
--   wrangler d1 execute community-bingo-db --file=schema.sql --remote   (production)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL,
  date            TEXT    NOT NULL,                -- ISO date string e.g. "2026-08-10"
  mode            TEXT    NOT NULL DEFAULT '90',   -- '90' | '75'
  ticket_price    INTEGER NOT NULL,                -- in cents e.g. 5000 = R50
  ticket_cap      INTEGER,                         -- NULL = unlimited
  pct_one_line    INTEGER,                         -- % of pot — 90-ball only
  pct_two_lines   INTEGER,                         -- % of pot — 90-ball only
  pct_full_house  INTEGER,                         -- % of pot — both modes
  pct_any_line    INTEGER,                         -- % of pot — 75-ball only
  pct_organiser   INTEGER NOT NULL,                -- organiser's cut (remainder)
  status          TEXT    NOT NULL DEFAULT 'pending', -- pending | active | ended
  pot_locked_at   INTEGER,                         -- unix ms — set on first ball draw
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT    PRIMARY KEY,               -- uuid used in play.html URL
  session_id    TEXT    NOT NULL,
  player_name   TEXT    NOT NULL,
  player_phone  TEXT,                              -- digits only, SA format: 27xxxxxxxxx
  paid          INTEGER NOT NULL DEFAULT 0,        -- 0 | 1
  cards         TEXT    NOT NULL,                  -- JSON: array of card grids
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS called_numbers (
  session_id  TEXT    NOT NULL,
  number      INTEGER NOT NULL,
  called_at   INTEGER NOT NULL,                    -- unix ms
  PRIMARY KEY (session_id, number),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS winners (
  id            TEXT    PRIMARY KEY,               -- BNG-YYYY-NNNN
  session_id    TEXT    NOT NULL,
  ticket_id     TEXT    NOT NULL,
  player_name   TEXT    NOT NULL,
  card_index    INTEGER NOT NULL DEFAULT 0,        -- 0-based index in ticket.cards array
  prize_tier    TEXT    NOT NULL,                  -- one_line | two_lines | full_house | any_line | blackout
  prize_amount  INTEGER NOT NULL,                  -- in cents, calculated at claim time
  claimed_at    INTEGER NOT NULL,
  validated     INTEGER NOT NULL DEFAULT 0,        -- 0=pending | 1=confirmed | -1=rejected
  confirmed_at  INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (ticket_id)  REFERENCES tickets(id)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tickets_session      ON tickets(session_id);
CREATE INDEX IF NOT EXISTS idx_called_session       ON called_numbers(session_id);
CREATE INDEX IF NOT EXISTS idx_winners_session      ON winners(session_id);
CREATE INDEX IF NOT EXISTS idx_winners_ticket       ON winners(ticket_id);
CREATE INDEX IF NOT EXISTS idx_winners_tier_session ON winners(session_id, prize_tier);
