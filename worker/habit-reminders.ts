import { dateInTimeZone } from '../shared/time';
import { getSettings } from './db';
import { sendTelegramMessage } from './telegram';
import { listHabits, checkIn, undoCheckIn, type Habit } from './habits';

/**
 * Habit reminders over Telegram, and the bot commands that close the loop.
 *
 * WHY TELEGRAM AND NOT PUSH. worker/push.ts exists but is not in the deployed
 * bundle, and web push on iOS only fires for an installed PWA with notification
 * permission granted. Telegram is already wired end to end in the running
 * Worker — `sendTelegramMessage`, the webhook, and the secret are all live — and
 * it delivers to a phone that is already unlocked and in hand. When push does
 * ship, add a sendPushToAll call beside the sendTelegramMessage call in
 * checkHabitReminders and settle both with Promise.allSettled, as
 * worker/reminders.ts already does for meals; nothing else changes.
 *
 * WHY THE REMINDER IS ALSO AN INPUT. A notification you can only read is a
 * nag. This one is answerable: reply `/done` and the day is checked off from the
 * lock screen, without opening the app. That is the whole reason to put habits
 * on this channel rather than a banner.
 *
 * WHAT IS REUSED, DELIBERATELY:
 *   * the existing every-minute cron — no new trigger (macroflow-kb.md §2)
 *   * `sent_reminders` and its UNIQUE(reminder_key) index, as the once-only
 *     claim, exactly as meal reminders and scheduled reports already use it
 *   * `sendTelegramMessage`, which already carries the "Open Macroflow" button
 */

interface Env {
  DB: D1Database;
  APP_URL?: string;
}

/**
 * Telegram renders with parse_mode HTML, and habit names are user input. A habit
 * called "Run <10 min/km" would otherwise produce an unparseable entity and
 * Telegram rejects the whole message — the reminder silently never arrives.
 */
function escapeHtml(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** "Walk 10 km" with the target spelled out when there is one. */
function targetLine(habit: Habit): string {
  if (habit.targetValue === null) return '';
  return ` (${trim(habit.targetValue)}${habit.unit ? ' ' + habit.unit : ''})`;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/* --------------------------------------------------------------- reminders */

export function reminderText(habit: Habit): string {
  const head = `${habit.emoji} <b>${escapeHtml(habit.name)}</b>${targetLine(habit)}`;

  // The streak is the reason the reminder works, so it leads. Framing differs
  // by state on purpose: an existing streak is something to protect, a broken
  // one should read as a clean slate rather than an accusation — the second is
  // the moment people quit.
  const standing =
    habit.streak > 0
      ? `Day ${habit.dayNumber} · ${plural(habit.streak, 'day')} on the line.`
      : `Day ${habit.dayNumber} · nothing on the board yet. Start the streak tonight.`;

  const how = habit.targetValue === null
    ? 'Reply <code>/done</code> when it is in.'
    : `Reply <code>/done</code> when it is in — or <code>/done ${trim(habit.targetValue)}</code> to record the actual ${escapeHtml(habit.unit || 'amount')}.`;

  return `${head}\n${standing}\n${how}`;
}

/**
 * Fire any habit reminder due this minute.
 *
 * Called from the `scheduled` handler on the existing `* * * * *` trigger, so
 * a reminder set for 21:00 goes out at 21:00 local rather than on the hour of
 * whatever coarser schedule happened to exist.
 */
export async function checkHabitReminders(env: Env): Promise<void> {
  const settings = await getSettings(env);

  // Telegram is the only channel today, so no token means no work to do. This
  // guard is scoped to habits alone — worker/reminders.ts documents how the
  // original global version of this check disabled *all* reminders and left
  // `sent_reminders` empty for weeks.
  if (!settings.telegram_bot_token || !settings.telegram_chat_id) return;

  const timezone = String(settings.timezone);
  const { date, time } = localParts(timezone);

  const habits = await listHabits(env);
  const due = habits.filter(
    (habit) => habit.reminderEnabled && habit.reminderTime === time && !habit.archived
  );
  if (!due.length) return;

  for (const habit of due) {
    // Already walked? Then say nothing. A tracker that pings you about
    // something you finished two hours ago gets muted within a week, and a
    // muted channel cannot deliver the reminder that would have mattered.
    if (habit.doneToday) continue;

    /*
     * Claim the slot before sending, so a send that runs past the minute
     * boundary cannot be re-entered by the next tick. Exactly one caller sees
     * changes === 1.
     *
     * The key is `habit:<id>:<date>` — deliberately WITHOUT the time. Keying on
     * the time too would let a reminder fire a second time on the same day if
     * the time were edited between ticks, and "at most one nudge per habit per
     * day" is the property worth guaranteeing.
     */
    const claimed = await env.DB.prepare(
      'INSERT OR IGNORE INTO sent_reminders (id, reminder_key, sent_at) VALUES (?, ?, ?)'
    )
      .bind(crypto.randomUUID(), `habit:${habit.id}:${date}`, new Date().toISOString())
      .run();
    if (!claimed.meta.changes) continue;

    try {
      await sendTelegramMessage(env, reminderText(habit));
    } catch (error) {
      // Release the claim so the next tick retries — the same self-healing the
      // scheduled reports use. A dropped reminder is worse than a late one.
      console.error('[habits] reminder send failed, releasing claim:', error);
      await env.DB.prepare('DELETE FROM sent_reminders WHERE reminder_key = ?')
        .bind(`habit:${habit.id}:${date}`)
        .run();
    }
  }
}

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

/* ---------------------------------------------------------- bot commands */

function statusLine(habit: Habit): string {
  const mark = habit.doneToday ? '✅' : '⬜';
  const done = habit.doneToday && habit.todayValue !== null
    ? ` ${trim(habit.todayValue)}${habit.unit ? ' ' + habit.unit : ''}`
    : '';
  const totals = habit.totalValue > 0 && habit.unit
    ? ` · ${trim(habit.totalValue)} ${escapeHtml(habit.unit)} total`
    : '';
  return (
    `${mark} ${habit.emoji} <b>${escapeHtml(habit.name)}</b>${done}\n` +
    `   Day ${habit.dayNumber} · ${plural(habit.streak, 'day')} streak · best ${habit.longestStreak}${totals}`
  );
}

export async function habitsSummary(env: Env): Promise<string> {
  const habits = await listHabits(env);
  if (!habits.length) return 'No habits yet. Add one in Macroflow and it will show up here.';

  const remaining = habits.filter((habit) => !habit.doneToday).length;
  const footer = remaining
    ? `\n${plural(remaining, 'habit')} left today. Reply <code>/done</code> to check one off.`
    : '\nAll clear for today.';

  return `📋 <b>Habits</b>\n\n${habits.map(statusLine).join('\n\n')}\n${footer}`;
}

/**
 * Resolve which habit a bare command refers to.
 *
 * With one habit there is nothing to disambiguate, which is the common case and
 * the reason `/done` alone works at all. With several, a name fragment picks
 * one; an ambiguous or missing fragment returns the list rather than guessing,
 * because a check-in written to the wrong habit is invisible and corrupts two
 * streaks at once.
 */
function resolveHabit(habits: Habit[], query: string): { habit?: Habit; error?: string } {
  if (!habits.length) return { error: 'No habits yet. Add one in Macroflow first.' };

  if (!query) {
    if (habits.length === 1) return { habit: habits[0] };
    return {
      error:
        'Which one?\n' +
        habits.map((habit) => `• <code>/done ${escapeHtml(habit.name.split(/\s+/)[0].toLowerCase())}</code> — ${habit.emoji} ${escapeHtml(habit.name)}`).join('\n'),
    };
  }

  const needle = query.toLowerCase();
  const matches = habits.filter((habit) => habit.name.toLowerCase().includes(needle));
  if (matches.length === 1) return { habit: matches[0] };
  if (!matches.length) return { error: `No habit matching "${escapeHtml(query)}". Try <code>/habits</code>.` };
  return {
    error:
      `"${escapeHtml(query)}" matches several:\n` +
      matches.map((habit) => `• ${habit.emoji} ${escapeHtml(habit.name)}`).join('\n'),
  };
}

/**
 * Split "/done walk 10.4" into a name fragment and a value.
 *
 * The number is only taken from the END of the text, so a habit called "Walk 10
 * km" is not read as the value 10 with the name "Walk". Decimal commas are
 * accepted — the phone keyboard here is es-AR.
 */
function parseCheckIn(rest: string): { query: string; value: number | null } {
  const match = rest.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s*$/);
  if (!match) return { query: rest.trim(), value: null };
  return {
    query: rest.slice(0, match.index).trim(),
    value: Number(match[1].replace(',', '.')),
  };
}

/**
 * Handle /habits, /done and /undo.
 *
 * Returns the reply text, or null when the message is not a habit command — the
 * caller then falls through to the existing /today, /log and /help dispatch in
 * worker/telegram.ts.
 */
export async function handleHabitCommand(env: Env, text: string): Promise<string | null> {
  const trimmed = text.trim();

  if (/^\/(habits|streaks?)\b/i.test(trimmed)) return habitsSummary(env);

  const doneMatch = trimmed.match(/^\/done\b\s*(.*)$/is);
  if (doneMatch) {
    const habits = await listHabits(env);
    const { query, value } = parseCheckIn(doneMatch[1] || '');
    const resolved = resolveHabit(habits, query);
    if (!resolved.habit) return resolved.error as string;

    const result = await checkIn(env, resolved.habit.id, { value, source: 'telegram' });
    if (!result) return 'That habit no longer exists.';

    const habit = result.habit;
    const amount = habit.todayValue !== null
      ? ` — ${trim(habit.todayValue)}${habit.unit ? ' ' + habit.unit : ''}`
      : '';

    if (!result.created) {
      return `Already logged for today${amount}. ${plural(habit.streak, 'day')} streak intact.`;
    }
    return (
      `✅ <b>${escapeHtml(habit.name)}</b> done${amount}\n` +
      `Day ${habit.dayNumber} · ${plural(habit.streak, 'day')} streak` +
      `${habit.streak >= habit.longestStreak && habit.streak > 1 ? ' — your best yet.' : '.'}`
    );
  }

  const undoMatch = trimmed.match(/^\/undo\b\s*(.*)$/is);
  if (undoMatch) {
    const habits = await listHabits(env);
    const resolved = resolveHabit(habits, (undoMatch[1] || '').trim());
    if (!resolved.habit) return resolved.error as string;

    const removed = await undoCheckIn(env, resolved.habit.id);
    if (!removed) return `Nothing logged today for ${escapeHtml(resolved.habit.name)}.`;

    const habit = await refresh(env, resolved.habit.id);
    return `↩️ Removed today's check-in for <b>${escapeHtml(resolved.habit.name)}</b>. Streak is now ${plural(habit?.streak ?? 0, 'day')}.`;
  }

  return null;
}

async function refresh(env: Env, id: string): Promise<Habit | null> {
  const habits = await listHabits(env, true);
  return habits.find((habit) => habit.id === id) ?? null;
}

/** Used by the /help text, so the command list has one source. */
export const HABIT_HELP =
  '/habits — streaks and what is left today\n' +
  '/done — check off today (add a number: /done 10.4)\n' +
  '/undo — remove today&#39;s check-in';

/** Exported for the daily-summary path and tests; see HABITS.md. */
export async function todayLocalDate(env: Env): Promise<string> {
  const settings = await getSettings(env);
  return dateInTimeZone(new Date(), String(settings.timezone));
}
