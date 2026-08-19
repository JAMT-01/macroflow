-- Body progress photos.
--
-- This table already exists in production, created outside the migration system
-- when the feature was first built. IF NOT EXISTS makes applying this a no-op
-- there while still creating it for a fresh database or a local one.

CREATE TABLE IF NOT EXISTS progress_photos (
  id          TEXT PRIMARY KEY,
  taken_at    TEXT NOT NULL,                       -- ISO 8601 UTC, the instant of capture
  taken_date  TEXT NOT NULL,                       -- local YYYY-MM-DD in settings.timezone
  pose        TEXT NOT NULL DEFAULT 'front',       -- front|side|back
  image_path  TEXT NOT NULL,                       -- '/progress-photos/<uuid>.jpg'
  weight_kg   REAL,                                -- bodyweight snapshot at capture; NULL if unknown
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK (pose IN ('front', 'side', 'back'))
);

CREATE INDEX IF NOT EXISTS progress_photos_taken_at ON progress_photos (taken_at DESC);
