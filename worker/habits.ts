import { dateInTimeZone, addCalendarDays } from '../shared/time';
import { getSettings } from './db';

/**
 * Habits — the behaviour side of the tracker.
 *
 * Everything the app stored before this is a measurement of an OUTCOME: macros
 * eaten, weight on the scale, a photo every four weeks. The behaviour that
 * produces the outcome had nowhere to live. "Walk 10 km" is not a meal, not a
 * weigh-in and not a photo, so it got a table of its own (migrations/0008).
 *
 * Two things here are worth reading before changing anything:
 *
 *   1. DAYS ARE LOCAL, ALWAYS. Every date in this module is a local YYYY-MM-DD
 *      in settings.timezone, never a UTC slice. A 22:00 walk in Buenos Aires is
 *      01:00 UTC the next day; bucketing on UTC would file it under tomorrow and
 *      break the streak it was meant to extend.
 *
 *   2. THE DATABASE OWNS "ONCE PER DAY". UNIQUE(habit_id, done_date) means
 *      check-in is idempotent no matter who calls it — the page, a /done reply,
 *      a double-tap on a slow connection. Nothing in this file needs to check
 *      first, and nothing should start.
 *
 * Reminders go out over Telegram from worker/habit-reminders.ts, on the same
 * every-minute cron that already drives meal reminders. See HABITS.md.
 */

/** Declared locally, as worker/progress.ts and worker/push.ts do — there is no
 *  generated `worker-configuration.d.ts` in the tree yet. */
interface Env {
  DB: D1Database;
}

export interface HabitRow {
  id: string;
  name: string;
  emoji: string;
  targetValue: number | null;
  unit: string;
  startedOn: string;
  reminderTime: string | null;
  reminderEnabled: number;
  archived: number;
  sortOrder: number;
}

export interface Habit extends HabitRow {
  /** 1 on the day it started. What "today is my second day" means. */
  dayNumber: number;
  /** Consecutive days up to and including today — see computeStreak for the grace rule. */
  streak: number;
  longestStreak: number;
  doneToday: boolean;
  todayValue: number | null;
  /** Local dates done, newest first, capped at HISTORY_DAYS. Drives the dot grid. */
  history: string[];
  totalDone: number;
  /** Sum of `value` across every entry — total km walked, for a habit with a unit. */
  totalValue: number;
}

/** How much history the UI gets. Ten weeks of dots is a readable grid and a
 *  small payload; the streak numbers below are computed over ALL entries, so a
 *  longer streak is never truncated by this. */
const HISTORY_DAYS = 70;

const MAX_NAME = 60;
const MAX_NOTE = 280;

/* ------------------------------------------------------------------ dates */

/**
 * Whole days from `from` to `to`, both local YYYY-MM-DD. Negative if `to` is
 * earlier. Anchored at noon UTC so a DST shift can never round to the wrong day
 * — the same guard shared/time.ts:addCalendarDays uses.
 */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td, 12) - Date.UTC(fy, fm - 1, fd, 12)) / 86400000);
}

/**
 * Current and longest run of consecutive days.
 *
 * The grace rule: if today is not yet done, the count starts at YESTERDAY rather
 * than reporting zero. Without it a two-week streak reads "0" every morning
 * until the walk happens, which is both wrong and exactly the moment the number
 * is supposed to be motivating. A streak is only actually broken once a full day
 * has been missed, and that is what this computes.
 */
export function computeStreak(done: Set<string>, today: string): { current: number; longest: number } {
  let cursor = done.has(today) ? today : addCalendarDays(today, -1);
  let current = 0;
  while (done.has(cursor)) {
    current++;
    cursor = addCalendarDays(cursor, -1);
  }

  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const date of [...done].sort()) {
    run = previous && daysBetween(previous, date) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    previous = date;
  }

  return { current, longest };
}

/* -------------------------------------------------------------------- read */

const SELECT_HABIT = `SELECT id, name, emoji, target_value AS targetValue, unit,
        started_on AS startedOn, reminder_time AS reminderTime,
        reminder_enabled AS reminderEnabled, archived, sort_order AS sortOrder
   FROM habits`;

export async function listHabits(env: Env, includeArchived = false): Promise<Habit[]> {
  const settings = await getSettings(env);
  const today = dateInTimeZone(new Date(), String(settings.timezone));

  const rows = await env.DB.prepare(
    `${SELECT_HABIT} ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY archived, sort_order, created_at`
  ).all<HabitRow>();
  const habits = rows.results ?? [];
  if (!habits.length) return [];

  /*
   * One query for every habit's entries rather than one per habit. At this scale
   * either is instant, but the per-habit version is an N+1 that gets quietly
   * worse as habits are added, and D1 bills per row read.
   *
   * It is deliberately unbounded: longestStreak and totalDone are only correct
   * over the full history, so a LIMIT here would silently truncate them. The
   * cost is one row per habit per day — a few hundred a year for one habit, and
   * nothing against D1's row budget. If it ever does matter, the fix is to move
   * the aggregates into SQL rather than to cap this.
   */
  const entries = await env.DB.prepare(
    `SELECT habit_id AS habitId, done_date AS doneDate, value
       FROM habit_entries ORDER BY done_date DESC`
  ).all<{ habitId: string; doneDate: string; value: number | null }>();

  const byHabit = new Map<string, { dates: Set<string>; values: number[]; today: number | null }>();
  for (const habit of habits) byHabit.set(habit.id, { dates: new Set(), values: [], today: null });

  for (const entry of entries.results ?? []) {
    const bucket = byHabit.get(entry.habitId);
    if (!bucket) continue;
    bucket.dates.add(entry.doneDate);
    if (entry.value !== null) bucket.values.push(Number(entry.value));
    if (entry.doneDate === today) bucket.today = entry.value === null ? null : Number(entry.value);
  }

  const earliest = addCalendarDays(today, -HISTORY_DAYS);

  return habits.map((habit) => {
    const bucket = byHabit.get(habit.id) as { dates: Set<string>; values: number[]; today: number | null };
    const streak = computeStreak(bucket.dates, today);
    return {
      ...habit,
      dayNumber: daysBetween(habit.startedOn, today) + 1,
      streak: streak.current,
      longestStreak: streak.longest,
      doneToday: bucket.dates.has(today),
      todayValue: bucket.today,
      history: [...bucket.dates].filter((date) => date > earliest).sort().reverse(),
      totalDone: bucket.dates.size,
      totalValue: bucket.values.reduce((sum, value) => sum + value, 0),
    };
  });
}

export async function getHabit(env: Env, id: string): Promise<Habit | null> {
  const habits = await listHabits(env, true);
  return habits.find((habit) => habit.id === id) ?? null;
}

/* ------------------------------------------------------------------- write */

export async function createHabit(
  env: Env,
  input: {
    name: string;
    emoji?: string;
    targetValue?: number | null;
    unit?: string;
    startedOn?: string;
    reminderTime?: string | null;
  }
): Promise<Habit> {
  const settings = await getSettings(env);
  const today = dateInTimeZone(new Date(), String(settings.timezone));

  const name = input.name.trim().slice(0, MAX_NAME);
  if (!name) throw new Error('Give the habit a name');

  const reminderTime = normalizeTime(input.reminderTime);
  if (input.reminderTime && !reminderTime) throw new Error('Reminder time must look like 21:00');

  const target =
    input.targetValue === undefined || input.targetValue === null || !Number.isFinite(Number(input.targetValue))
      ? null
      : Math.abs(Number(input.targetValue));
  if (target !== null && target <= 0) throw new Error('Target must be greater than zero');

  const started = normalizeDate(input.startedOn) || today;
  if (started > today) throw new Error('A habit cannot start in the future');

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO habits (id, name, emoji, target_value, unit, started_on, reminder_time, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM habits))`
  )
    .bind(
      id,
      name,
      (input.emoji || '✅').slice(0, 8),
      target,
      target === null ? '' : (input.unit || '').trim().slice(0, 12),
      started,
      reminderTime
    )
    .run();

  const created = await getHabit(env, id);
  if (!created) throw new Error('Habit was created but could not be read back');
  return created;
}

export async function updateHabit(
  env: Env,
  id: string,
  patch: {
    name?: string;
    emoji?: string;
    targetValue?: number | null;
    unit?: string;
    reminderTime?: string | null;
    reminderEnabled?: boolean;
    archived?: boolean;
  }
): Promise<boolean> {
  const columns: string[] = [];
  const values: unknown[] = [];

  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, MAX_NAME);
    if (!name) throw new Error('Give the habit a name');
    columns.push('name = ?');
    values.push(name);
  }
  if (patch.emoji !== undefined) {
    columns.push('emoji = ?');
    values.push(patch.emoji.slice(0, 8) || '✅');
  }
  if (patch.targetValue !== undefined) {
    const target =
      patch.targetValue === null || !Number.isFinite(Number(patch.targetValue))
        ? null
        : Math.abs(Number(patch.targetValue));
    if (target !== null && target <= 0) throw new Error('Target must be greater than zero');
    columns.push('target_value = ?');
    values.push(target);
  }
  if (patch.unit !== undefined) {
    columns.push('unit = ?');
    values.push(patch.unit.trim().slice(0, 12));
  }
  if (patch.reminderTime !== undefined) {
    const time = normalizeTime(patch.reminderTime);
    if (patch.reminderTime && !time) throw new Error('Reminder time must look like 21:00');
    columns.push('reminder_time = ?');
    values.push(time);
  }
  if (patch.reminderEnabled !== undefined) {
    columns.push('reminder_enabled = ?');
    values.push(patch.reminderEnabled ? 1 : 0);
  }
  if (patch.archived !== undefined) {
    columns.push('archived = ?');
    values.push(patch.archived ? 1 : 0);
  }
  if (!columns.length) return false;

  const result = await env.DB.prepare(`UPDATE habits SET ${columns.join(', ')} WHERE id = ?`)
    .bind(...values, id)
    .run();
  return Boolean(result.meta.changes);
}

/**
 * Record a day as done.
 *
 * ON CONFLICT DO UPDATE rather than read-then-write: the UNIQUE index already
 * says one per day, so a second call is an edit of the same row instead of a
 * race the caller has to reason about. Checking in with a distance after a bare
 * tap therefore just fills in the number.
 *
 * Returns whether this created a NEW day, which is the only thing a caller needs
 * in order to say "streak extended" rather than "already had that one".
 */
export async function checkIn(
  env: Env,
  habitId: string,
  input: { date?: string; value?: number | null; note?: string; source?: string } = {}
): Promise<{ created: boolean; habit: Habit } | null> {
  const settings = await getSettings(env);
  const today = dateInTimeZone(new Date(), String(settings.timezone));
  const date = normalizeDate(input.date) || today;

  // A check-in for tomorrow is always a mistake — a mistyped date, or a client
  // sending a UTC day. Accepting it would show a streak covering a day that has
  // not happened yet.
  if (date > today) throw new Error('You cannot check in for a future day');

  const exists = await env.DB.prepare('SELECT 1 AS hit FROM habits WHERE id = ?').bind(habitId).first();
  if (!exists) return null;

  const value =
    input.value === undefined || input.value === null || !Number.isFinite(Number(input.value))
      ? null
      : Math.abs(Number(input.value));

  // Was the day already there? Asked before the write, because the write itself
  // cannot answer it: D1 reports the same `changes: 1` for an INSERT and for the
  // DO UPDATE branch, so there is no flag on the result to read.
  const before = await env.DB.prepare(
    'SELECT 1 AS hit FROM habit_entries WHERE habit_id = ? AND done_date = ?'
  )
    .bind(habitId, date)
    .first();

  await env.DB.prepare(
    `INSERT INTO habit_entries (id, habit_id, done_date, value, note, source, logged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (habit_id, done_date) DO UPDATE SET
       value = COALESCE(excluded.value, habit_entries.value),
       note  = CASE WHEN excluded.note <> '' THEN excluded.note ELSE habit_entries.note END`
  )
    .bind(
      crypto.randomUUID(),
      habitId,
      date,
      value,
      (input.note ?? '').trim().slice(0, MAX_NOTE),
      input.source === 'telegram' ? 'telegram' : 'app',
      new Date().toISOString()
    )
    .run();

  const habit = await getHabit(env, habitId);
  if (!habit) return null;
  return { created: !before, habit };
}

export async function undoCheckIn(env: Env, habitId: string, date?: string): Promise<boolean> {
  const settings = await getSettings(env);
  const target = normalizeDate(date) || dateInTimeZone(new Date(), String(settings.timezone));
  const result = await env.DB.prepare('DELETE FROM habit_entries WHERE habit_id = ? AND done_date = ?')
    .bind(habitId, target)
    .run();
  return Boolean(result.meta.changes);
}

/** Hard delete. `habit_entries` cascades, so the history goes with it — which is
 *  why the UI offers archive first, and archive is what keeps the history. */
export async function deleteHabit(env: Env, id: string): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM habits WHERE id = ?').bind(id).run();
  return Boolean(result.meta.changes);
}

/* -------------------------------------------------------------- validation */

export function normalizeTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
