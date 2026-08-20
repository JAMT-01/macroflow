-- 0007_progress_photos.sql — body progress photos, stored privately alongside the weight trend
--
-- Why this exists: macros.md §10 prescribes photos "every 4 weeks, same light,
-- pose, time of day" and calls them the metric that "catches what the scale
-- can't". Nothing in the app stored them, so the one measurement that survives a
-- stalled scale had no home. Weight already has `weight_entries`; this is the
-- visual companion to it.
--
-- STORAGE SPLIT: this table holds only metadata. The image bytes live in the
-- `PHOTOS` KV namespace, exactly as meal photos do, because R2 is not enabled on
-- this account (API error 10042 — see macroflow-kb.md §2). Bytes in D1 would
-- bloat a database whose whole point is fast macro queries, and would land in
-- `/api/export`'s JSON.
--
-- KEY PREFIX IS A PRIVACY BOUNDARY, NOT A NAMING CHOICE. Meal photos are
-- `uploads/<uuid>.jpg`; these are `progress/<uuid>.jpg`. That separation matters
-- because meal photos are deliberately uploaded to a third-party LLM
-- (OpenRouter) for macro estimation, and body photos must never be. Two existing
-- behaviours already respect the prefix:
--   * worker/index.ts DELETE /api/meals/:id filters `startsWith('/uploads/')`
--     before deleting KV objects, so meal deletion cannot reach these.
--   * worker/analysis.ts only ever analyses paths that /api/analyze minted
--     itself, and those are always `/uploads/`.
-- See PROGRESS-PHOTOS.md §4 for the one path that does NOT yet enforce this
-- (/api/analyze/refine trusts a client-supplied imagePath) and the two-line fix.

CREATE TABLE progress_photos (
  id          TEXT PRIMARY KEY,                    -- UUID
  taken_at    TEXT NOT NULL,                       -- ISO 8601 UTC, the instant of capture
  taken_date  TEXT NOT NULL,                       -- local YYYY-MM-DD in settings.timezone
  pose        TEXT NOT NULL DEFAULT 'front',       -- front|side|back
  image_path  TEXT NOT NULL,                       -- '/progress-photos/<uuid>.jpg'
  weight_kg   REAL,                                -- bodyweight snapshot at capture; NULL if unknown
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK (pose IN ('front', 'side', 'back'))
);

-- `taken_date` is stored rather than derived because the app is timezone-aware
-- (settings.timezone = America/Buenos_Aires). A photo taken at 22:00 local is
-- 01:00 UTC the NEXT day, so bucketing on substr(taken_at,1,10) would scatter a
-- single evening session across two dates and break "same time of day"
-- comparisons. shared/time.ts:dateInTimeZone computes this at write time.

-- The gallery reads newest-first; the compare view walks one pose at a time.
CREATE INDEX progress_photos_taken ON progress_photos (taken_at DESC);
CREATE INDEX progress_photos_pose_taken ON progress_photos (pose, taken_at DESC);

-- `weight_kg` is denormalised on purpose. A progress photo without the
-- bodyweight beside it is close to useless, and recovering it later means a
-- fuzzy "nearest weight_entries row" join that gets worse the more sporadic the
-- weight log is (it currently holds 1 row). Capturing the number at the moment
-- of the photo is a point-in-time record, not a cache — if the weight is later
-- corrected, the photo should still show what the scale said that morning.
