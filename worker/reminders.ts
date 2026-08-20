/**
 * Reminder dispatch — replaces checkReminders in worker/telegram.ts.
 *
 * Three things change versus the original:
 *
 * 1. The Telegram guard moves from the top of the function to the Telegram
 *    branch. The old code opened with
 *      `if (!settings.telegram_bot_token || !settings.telegram_chat_id) return;`
 *    which meant an unconfigured Telegram disabled *all* reminders. That is why
 *    `sent_reminders` had zero rows despite reminders being configured.
 *
 * 2. Reminders carry a `kind`. 'meal' behaves as before; 'weight' is new and
 *    exists because the weight log is the input every feedback loop depends on
 *    (macros.md §10, §11) and it was not being collected.
 *
 * 3. A reminder is suppressed if the thing it asks for is already done. A
 *    tracker that pings you about a meal you logged an hour ago gets its
 *    notifications turned off within a week.
 *
 * The `sent_reminders` idempotency ledger and its UNIQUE(reminder_key) index are
 * reused unchanged.
 */

import { getSettings } from './db';
import { dateRangeUtc } from '../shared/time';
import { sendTelegramMessage } from './telegram';
import { sendPushToAll } from './push';

interface Env {
  DB: D1Database;
  APP_URL?: string;
}

type ReminderKind = 'meal' | 'weight';

interface Reminder {
  id: string;
  label: string;
  time: string;
  enabled: boolean;
  kind?: ReminderKind;
  /** For kind 'meal': which meal_type satisfies it. Defaults to `label`. */
  mealType?: string;
}

/** Reminders written before the `kind` field existed are meal reminders. */
const kindOf = (reminder: Reminder): ReminderKind => reminder.kind ?? 'meal';

function localParts(timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    time: `${read('hour')}:${read('minute')}`,
  };
}

/**
 * Has the user already done what this reminder would ask for, today?
 *
 * Failing open (returning false) is deliberate: a duplicate reminder is a much
 * smaller problem than a silently dropped one.
 */
async function alreadySatisfied(
  env: Env,
  reminder: Reminder,
  timezone: string,
  localDate: string,
): Promise<boolean> {
  const range = dateRangeUtc(localDate, timezone);

  try {
    if (kindOf(reminder) === 'weight') {
      const row = await env.DB.prepare(
        'SELECT 1 AS hit FROM weight_entries WHERE recorded_at >= ? AND recorded_at < ? LIMIT 1',
      ).bind(range.start, range.end).first();
      return Boolean(row);
    }

    const mealType = reminder.mealType ?? reminder.label;
    const row = await env.DB.prepare(
      `SELECT 1 AS hit FROM meals
       WHERE logged_at >= ? AND logged_at < ? AND LOWER(meal_type) = LOWER(?) LIMIT 1`,
    ).bind(range.start, range.end, mealType).first();
    return Boolean(row);
  } catch (error) {
    console.error('[reminders] satisfaction check failed, sending anyway:', error);
    return false;
  }
}

/** Remaining-for-the-day figures, so a reminder says something useful. */
async function remainingToday(
  env: Env,
  timezone: string,
  localDate: string,
): Promise<{ calories: number; protein: number; fiber: number }> {
  const settings = await getSettings(env);
  const range = dateRangeUtc(localDate, timezone);

  const totals = await env.DB.prepare(
    `SELECT COALESCE(SUM(mi.calories),0) calories,
            COALESCE(SUM(mi.protein),0) protein,
            COALESCE(SUM(mi.fiber),0) fiber
     FROM meals m JOIN meal_items mi ON mi.meal_id = m.id
     WHERE m.logged_at >= ? AND m.logged_at < ?`,
  ).bind(range.start, range.end).first<{ calories: number; protein: number; fiber: number }>();

  const eaten = totals ?? { calories: 0, protein: 0, fiber: 0 };
  return {
    calories: Math.max(0, Math.round(Number(settings.calorie_target) - Number(eaten.calories))),
    protein: Math.max(0, Math.round(Number(settings.protein_target) - Number(eaten.protein))),
    fiber: Math.max(0, Math.round(Number(settings.fiber_target) - Number(eaten.fiber))),
  };
}

async function buildMessage(
  env: Env,
  reminder: Reminder,
  timezone: string,
  localDate: string,
): Promise<{ title: string; body: string; url: string }> {
  if (kindOf(reminder) === 'weight') {
    return {
      title: '⚖️ Morning weigh-in',
      body: 'Before eating or drinking. One number a day is what makes the weekly average mean anything.',
      url: '/',
    };
  }

  const remaining = await remainingToday(env, timezone, localDate);
  const parts = [`${remaining.calories} kcal`, `${remaining.protein} g protein`];
  if (remaining.fiber > 0) parts.push(`${remaining.fiber} g fibre`);

  return {
    title: `🍽️ ${reminder.label}`,
    body: `${parts.join(' · ')} left today. Snap a photo — ten seconds.`,
    url: '/',
  };
}

export async function checkReminders(env: Env): Promise<void> {
  const settings = await getSettings(env);
  const timezone = String(settings.timezone);
  const { date, time } = localParts(timezone);

  let reminders: Reminder[];
  try {
    reminders = JSON.parse(String(settings.reminders_json ?? '[]'));
  } catch (error) {
    console.error('[reminders] reminders_json is not valid JSON:', error);
    return;
  }

  const due = reminders.filter((reminder) => reminder.enabled && reminder.time === time);
  if (!due.length) return;

  for (const reminder of due) {
    if (await alreadySatisfied(env, reminder, timezone, date)) continue;

    // Claim the slot before sending. Exactly one tick sees changes === 1, so a
    // slow send overlapping the next minute cannot double-notify.
    const claimed = await env.DB.prepare(
      'INSERT OR IGNORE INTO sent_reminders (id, reminder_key, sent_at) VALUES (?, ?, ?)',
    ).bind(crypto.randomUUID(), `${date}:${reminder.id}:${time}`, new Date().toISOString()).run();
    if (!claimed.meta.changes) continue;

    const message = await buildMessage(env, reminder, timezone, date);

    // Both channels are attempted; neither can break the other or the tick.
    const deliveries: Promise<unknown>[] = [
      sendPushToAll(env, {
        title: message.title,
        body: message.body,
        url: message.url,
        // One reminder replaces the previous rather than stacking a column of
        // identical banners on the lock screen.
        tag: `${kindOf(reminder)}:${reminder.id}`,
      }),
    ];

    if (settings.telegram_bot_token && settings.telegram_chat_id) {
      deliveries.push(
        sendTelegramMessage(env, `<b>${message.title}</b>\n${message.body}`),
      );
    }

    const results = await Promise.allSettled(deliveries);
    for (const result of results) {
      if (result.status === 'rejected') console.error('[reminders] delivery failed:', result.reason);
    }
  }
}
