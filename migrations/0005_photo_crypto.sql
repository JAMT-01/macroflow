-- End-to-end encryption for the body photos.
--
-- Everything here is safe for the Worker to hold: none of it can decrypt a
-- photo. The salt is public by design, the verifiers are SHA-256 hashes (so a
-- dump yields no replayable token and no wrapping key), and the two wrapped
-- blobs are the master key sealed under keys that only ever exist in the
-- browser. Losing every row here costs you the photos; leaking every row here
-- reveals nothing.
--
-- Two verifiers because the recovery key must be able to authenticate on its
-- own: if the passphrase is what you forgot, proving knowledge of it cannot be
-- the price of reaching the blob that recovers it.

CREATE TABLE IF NOT EXISTS photo_crypto (
  id                INTEGER PRIMARY KEY CHECK (id = 1),  -- single row, like settings
  version           INTEGER NOT NULL DEFAULT 1,          -- scheme version, for future migrations
  salt              TEXT NOT NULL,                       -- base64, PBKDF2 salt; not secret
  auth_verifier     TEXT NOT NULL,                       -- base64 SHA-256 of the auth key
  recovery_verifier TEXT NOT NULL,                       -- base64 SHA-256 of the recovery key
  wrapped_passphrase TEXT NOT NULL,                      -- master key sealed under the passphrase half
  wrapped_recovery  TEXT NOT NULL,                       -- master key sealed under the recovery key
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Photos taken before encryption was turned on are still plaintext in KV. The
-- flag lets both kinds coexist rather than forcing a migration that would need
-- the passphrase to run.
ALTER TABLE progress_photos ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
