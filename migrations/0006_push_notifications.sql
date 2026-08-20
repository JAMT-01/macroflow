-- 0006_push_notifications.sql — Web Push delivery channel for iOS PWA reminders
--
-- Why this exists: `settings.reminders_json` has had reminders configured since
-- day one, but worker/telegram.ts:checkReminders opens with
--
--     if (!settings.telegram_bot_token || !settings.telegram_chat_id) return;
--
-- and Telegram was never configured. The cron has therefore been firing 1,440
-- times a day and returning immediately — `sent_reminders` has 0 rows. This adds
-- a second delivery channel that does not depend on Telegram at all.
--
-- iOS note: Safari has supported Web Push since 16.4, but ONLY for a PWA the user
-- has added to the Home Screen. In a normal Safari tab PushManager is absent and
-- subscribe() cannot succeed, which is why the client script gates on
-- `navigator.standalone`.
--
-- NO KEY MATERIAL IN THIS FILE. See PUSH-SETUP.md — the VAPID private key is set
-- with `wrangler secret put` so it never lands in D1, in git, or in a synced
-- folder. worker/push.ts:getVapidKeys reads env first and falls back to
-- `app_secrets`, matching how getOpenRouterApiKey already works.

CREATE TABLE push_subscriptions (
  id            TEXT PRIMARY KEY,
  endpoint      TEXT NOT NULL UNIQUE,   -- push service URL; identifies the device
  p256dh        TEXT NOT NULL,          -- b64url P-256 public key (65 bytes raw)
  auth          TEXT NOT NULL,          -- b64url auth secret (16 bytes raw)
  user_agent    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_success  TEXT,                   -- last 2xx from the push service
  failure_count INTEGER NOT NULL DEFAULT 0
);

-- Subscriptions are read on every reminder fire; keep the scan cheap.
CREATE INDEX push_subscriptions_created ON push_subscriptions (created_at DESC);
