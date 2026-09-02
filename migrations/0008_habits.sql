-- 0008_habits.sql — daily habits, their check-ins, and per-habit reminder times
--
-- Why this exists: everything the app tracks until now is a MEASUREMENT of an
-- outcome — macros eaten, weight on the scale, a photo every four weeks. None of
-- it records the BEHAVIOUR that produces the outcome. "Walk 10 km" has no home in
-- `meals`, none in `weight_entries`, and it is not a photo. This is that home.
--
-- TWO TABLES, NOT ONE. `habits` is the definition (stable, edited rarely);
-- `habit_entries` is one row per habit per day it was done (append-only in
-- practice). Folding them together — a JSON array of dates on the habit row —
-- was the obvious shortcut and is rejected for the same reason `reminders_json`
-- is a nuisance today: you cannot index it, cannot ask "what did I do on the
-- 14th" without reading and parsing every habit, and two concurrent writes lose
-- one of them. Streaks are the whole point of this feature and they are a query
-- over dates, so the dates get to be rows.
--
-- LOCAL DATES, NOT UTC. `done_date` is a local YYYY-MM-DD in settings.timezone
-- (America/Buenos_Aires), stored rather than derived — exactly the reasoning in
-- 0007_progress_photos.sql. A 22:00 walk is 01:00 UTC the NEXT day, so bucketing
-- on substr(logged_at,1,10) would file Tuesday's walk under Wednesday and break
-- the streak it was supposed to extend. shared/time.ts:dateInTimeZone computes
-- this at write time.
--
-- Metadata only — nothing here needs KV or R2, so this feature has no storage
-- caveat at all, unlike meal and progress photos.

CREATE TABLE habits (
  id               TEXT PRIMARY KEY,                 -- UUID
  name             TEXT NOT NULL,                    -- 'Walk 10 km'
  emoji            TEXT NOT NULL DEFAULT '✅',
  target_value     REAL,                             -- 10 for a 10 km walk; NULL for a plain yes/no habit
  unit             TEXT NOT NULL DEFAULT '',         -- 'km'; '' when target_value is NULL
  started_on       TEXT NOT NULL,                    -- local YYYY-MM-DD — day 1, used for the day counter
  reminder_time    TEXT,                             -- local 'HH:MM', NULL = never remind
  reminder_enabled INTEGER NOT NULL DEFAULT 1,
  archived         INTEGER NOT NULL DEFAULT 0,       -- kept, not deleted, so its history survives
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- 'HH:MM', 24-hour. The cron ticks every minute and compares this string
  -- against the local wall clock, so a malformed value would simply never fire —
  -- a reminder that silently never arrives is the worst failure this feature
  -- has, so it is rejected at write time instead.
  CHECK (reminder_time IS NULL OR reminder_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  CHECK (started_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (target_value IS NULL OR target_value > 0)
);

CREATE TABLE habit_entries (
  id        TEXT PRIMARY KEY,                        -- UUID
  habit_id  TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  done_date TEXT NOT NULL,                           -- local YYYY-MM-DD in settings.timezone
  value     REAL,                                    -- 10.4 = km actually walked; NULL = "done", no number
  note      TEXT NOT NULL DEFAULT '',
  source    TEXT NOT NULL DEFAULT 'app',             -- app|telegram — where the check-in came from
  logged_at TEXT NOT NULL,                           -- ISO 8601 UTC, the instant of the tap

  -- THE LOAD-BEARING CONSTRAINT. One check-in per habit per day, enforced by the
  -- database rather than by whoever is calling. It makes check-in idempotent for
  -- free: the app taps, the Telegram reply says /done, the cron never
  -- double-counts, and a streak can never be inflated by tapping twice. This is
  -- the same trick `sent_reminders.reminder_key UNIQUE` already uses to stop
  -- double-sends, applied to the other end of the loop.
  UNIQUE (habit_id, done_date),

  CHECK (done_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')
);

-- Streaks walk backwards day by day from today within one habit; the calendar
-- grid reads a contiguous window. Both are (habit_id, done_date DESC).
CREATE INDEX habit_entries_habit_date ON habit_entries (habit_id, done_date DESC);

-- "What did I do on this date" across all habits — the only query that leads
-- with the date, and the one a future daily-summary message would use.
CREATE INDEX habit_entries_date ON habit_entries (done_date DESC);

-- ---------------------------------------------------------------------------
-- Seed: the habit that prompted the feature.
--
-- Stated on 2026-08-27 as "I'm walking 10 km, today is my second day", so day 1
-- was 2026-08-26 and that day is backfilled as done.
--
-- TODAY IS DELIBERATELY NOT SEEDED. Under-recording is the safe direction for a
-- tracker: a missing check-in is visible on the page and one tap away, whereas a
-- fabricated one is invisible and quietly corrupts the streak it was meant to
-- measure. If the walk is already done, tap it — or reply /done to the bot.
--
-- 21:00 reminder: late enough that a daytime walk has usually happened (and the
-- reminder is then suppressed rather than sent — see worker/habits.ts), early
-- enough to still act on. It matches the existing dinner reminder slot, so the
-- app is not messaging at a new hour of the evening.
-- ---------------------------------------------------------------------------

INSERT INTO habits (id, name, emoji, target_value, unit, started_on, reminder_time, sort_order)
VALUES ('b1a7d4c2-9e35-4f18-8a6b-3c0d5e7f2a91', 'Walk 10 km', '🚶', 10, 'km', '2026-08-26', '21:00', 0);

INSERT INTO habit_entries (id, habit_id, done_date, value, note, source, logged_at)
VALUES ('4f2c8e91-7b06-4d53-9a1e-2b8f6c0d4a37', 'b1a7d4c2-9e35-4f18-8a6b-3c0d5e7f2a91',
        '2026-08-26', 10, 'Day 1', 'app', '2026-08-26T23:00:00.000Z');
