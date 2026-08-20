import { addCalendarDays, dateInTimeZone, dateRangeUtc, partsAt } from '../shared/time';
import { getOpenRouterApiKey, getSettings, listFoods } from './db';

/**
 * Periodic nutrition reports.
 *
 * The cron fires every minute to service meal reminders. This piggybacks on
 * that tick: each invocation asks whether a weekly or monthly report is due and
 * not yet generated, and builds one if so.
 *
 * Once-only generation reuses the `sent_reminders` ledger the same way
 * `checkReminders` does — INSERT OR IGNORE against its UNIQUE `reminder_key`,
 * then check `meta.changes`. Because the test is "due at or after T" rather
 * than "exactly at T", a missed minute self-heals on the next tick instead of
 * dropping the period.
 *
 * Wire up in worker/index.ts:
 *   ctx.waitUntil(runScheduledReports(env).catch((e) => console.error('Report failed:', e)));
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_REPORT_MODEL = 'moonshotai/kimi-k3';

/** Local hour at which a finished period's report becomes due. */
const DUE_HOUR = 8;

type PeriodKind = 'weekly' | 'monthly';

interface Period {
  kind: PeriodKind;
  key: string; // '2026-W34' | '2026-08'
  start: string; // local YYYY-MM-DD, inclusive
  end: string; // local YYYY-MM-DD, inclusive
  days: number;
}

/** Monday=0 … Sunday=6 for a local calendar date. */
function weekdayIndex(date: string): number {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

/** ISO-8601 week key, e.g. '2026-W34'. */
function isoWeekKey(date: string): string {
  const thursday = new Date(`${addCalendarDays(date, 3 - weekdayIndex(date))}T12:00:00Z`);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4, 12));
  const week = 1 + Math.round((thursday.getTime() - jan4.getTime()) / 86400000 / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * A weekly report covers the Mon–Sun that just ended, due Monday 08:00 local.
 * A monthly report covers the calendar month that just ended, due on the 1st at
 * 08:00 local. Both stay due until generated; the caller's claim stops repeats.
 */
export function duePeriods(now: Date, timezone: string): Period[] {
  const today = dateInTimeZone(now, timezone);
  const { hour } = partsAt(now, timezone);
  const [year, month, day] = today.split('-').map(Number);
  const due: Period[] = [];

  const dow = weekdayIndex(today);
  if (dow > 0 || hour >= DUE_HOUR) {
    const start = addCalendarDays(today, -dow - 7);
    due.push({ kind: 'weekly', key: isoWeekKey(start), start, end: addCalendarDays(start, 6), days: 7 });
  }

  if (day > 1 || hour >= DUE_HOUR) {
    const end = addCalendarDays(`${year}-${String(month).padStart(2, '0')}-01`, -1);
    const start = `${end.slice(0, 8)}01`;
    due.push({ kind: 'monthly', key: start.slice(0, 7), start, end, days: Number(end.slice(8, 10)) });
  }

  return due;
}

/* ------------------------------------------------------------------ */

interface DayTotals {
  date: string;
  calories: number;
  protein: number;
  carbs: number;
  fiber: number;
  fat: number;
  meals: string[];
}

async function buildPayload(env: Env, period: Period, settings: Record<string, any>) {
  const timezone = settings.timezone;
  const range = {
    start: dateRangeUtc(period.start, timezone).start,
    end: dateRangeUtc(period.end, timezone).end,
  };

  const items = await env.DB.prepare(
    `SELECT m.logged_at loggedAt, m.meal_type mealType, m.title, m.source, m.confidence,
            mi.name, mi.grams, mi.calories, mi.protein, mi.carbs, mi.fiber, mi.fat
     FROM meals m JOIN meal_items mi ON mi.meal_id = m.id
     WHERE m.logged_at >= ? AND m.logged_at < ?
     ORDER BY m.logged_at`,
  )
    .bind(range.start, range.end)
    .all();

  // Bucket into local days. meal_items macros are absolute for the portion,
  // not per-100g — the opposite convention from the `foods` table.
  const byDay = new Map<string, DayTotals>();
  const gramsByFood = new Map<string, number>();
  for (const item of (items.results ?? []) as Record<string, any>[]) {
    const date = dateInTimeZone(String(item.loggedAt), timezone);
    const day = byDay.get(date) ?? {
      date,
      calories: 0,
      protein: 0,
      carbs: 0,
      fiber: 0,
      fat: 0,
      meals: [],
    };
    day.calories += Number(item.calories);
    day.protein += Number(item.protein);
    day.carbs += Number(item.carbs);
    day.fiber += Number(item.fiber ?? 0);
    day.fat += Number(item.fat);
    if (!day.meals.includes(String(item.title))) day.meals.push(String(item.title));
    byDay.set(date, day);
    gramsByFood.set(String(item.name), (gramsByFood.get(String(item.name)) ?? 0) + Number(item.grams));
  }

  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const round = (value: number) => Math.round(value * 10) / 10;
  const average = (key: keyof DayTotals) =>
    days.length ? round(days.reduce((sum, day) => sum + (day[key] as number), 0) / days.length) : 0;

  const weights = await env.DB.prepare(
    'SELECT recorded_at recordedAt, weight_kg weightKg FROM weight_entries WHERE recorded_at < ? ORDER BY recorded_at DESC LIMIT 10',
  )
    .bind(range.end)
    .all();

  return {
    period: {
      kind: period.kind,
      key: period.key,
      start: period.start,
      end: period.end,
      daysInPeriod: period.days,
      daysLogged: days.length,
    },
    profile: {
      name: settings.name,
      weightKg: settings.weight_kg,
      heightCm: settings.height_cm,
      age: settings.age,
      sex: settings.sex,
      activity: settings.activity,
      goal: settings.goal,
      timezone,
    },
    targets: {
      calories: settings.calorie_target,
      protein: settings.protein_target,
      carbs: settings.carbs_target,
      fat: settings.fat_target,
      fiber: settings.fiber_target,
    },
    averagesPerLoggedDay: {
      calories: average('calories'),
      protein: average('protein'),
      carbs: average('carbs'),
      fiber: average('fiber'),
      fat: average('fat'),
    },
    dailyTotals: days.map((day) => ({
      ...day,
      calories: round(day.calories),
      protein: round(day.protein),
      carbs: round(day.carbs),
      fiber: round(day.fiber),
      fat: round(day.fat),
    })),
    foodsEaten: [...gramsByFood.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, grams]) => ({ name, totalGrams: round(grams) })),
    // The user's own library, so suggestions land on food they already have.
    foodLibrary: (await listFoods(env)).map((food: Record<string, any>) => ({
      name: food.name,
      category: food.category,
      serving: food.serving_label,
    })),
    recentWeights: weights.results ?? [],
  };
}

/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You are a sports-nutrition analyst reviewing one person's food log.

CRITICAL CONTEXT ABOUT THE DATA:
The log records ONLY calories, protein, carbohydrate, fibre and fat. It contains
NO micronutrient measurements whatsoever. Do NOT attempt to estimate milligram or
IU intakes — with this data that would be false precision.

Instead assess micronutrients the way the user's own reference decided to: as FOOD
RULES rather than daily numbers. Their baseline rule is 2 servings of fruit, 3 of
vegetables, 1 of legumes and 1 of nuts/seeds per day; hitting that covers every
nutrient below except vitamin D. So judge whether the logged food plausibly met
those rules, and name which nutrients are at risk when it did not.

Their stated nutrient targets and the foods that secure them:
- Vitamin D 1,000-2,000 IU  — supplement; very hard to get from food
- Omega-3 (EPA+DHA) 1-2 g   — fatty fish 2-3x/week, or fish/algae oil
- Calcium 1,000 mg          — dairy, fortified alternatives, sardines
- Iron 8 mg                 — red meat, legumes; pair plant sources with vitamin C
- Magnesium 400-420 mg      — nuts, seeds, leafy greens, whole grains
- Zinc 11 mg                — meat, shellfish, seeds
- Potassium 3,400 mg        — potatoes, bananas, beans, dairy
- Sodium 3-5 g              — athletes need MORE, not less; never advise cutting salt

Every micronutrient statement is an inference from food names, not a measurement.
Say so, and carry a confidence. Where the data genuinely cannot support a call,
say it is uncertain rather than guessing confidently.

Days with no logged food mean the user did not log, not that they did not eat.
Distinguish "under target" from "under-logged", and do not scold them for gaps in
logging. Their goal is muscle gain with minimal fat gain, so under-eating is a
bigger problem than over-eating; protein and fibre are the fixed targets while
calories float.

The user lives in Argentina (Buenos Aires). Recommendations should lean on food
that is ordinary and cheap there — carne, huevos, lacteos, legumbres, verduras de
estacion. Prefer foods already in their library where they fit.

Return ONLY a JSON object with this exact shape:
{
  "headline": "one sentence, the single most important thing this period",
  "macroFindings": [
    { "macro": "protein|carbs|fat|fibre|calories",
      "status": "on_target|under|over",
      "detail": "what the numbers actually show, with figures",
      "mattersBecause": "why it matters for muscle gain specifically" }
  ],
  "foodRuleAdherence": {
    "fruit": "met|partial|missed|unknown",
    "vegetables": "met|partial|missed|unknown",
    "legumes": "met|partial|missed|unknown",
    "nutsSeeds": "met|partial|missed|unknown",
    "oilyFish": "met|partial|missed|unknown",
    "note": "what the logged food actually showed"
  },
  "likelyMicronutrientGaps": [
    { "nutrient": "e.g. Omega-3",
      "confidence": "high|medium|low",
      "reasoning": "which logged or absent foods drive this inference",
      "fix": "specific foods and rough amounts that would close it" }
  ],
  "whatWentWell": ["short strings"],
  "actions": ["at most 4, each concrete and doable next week"],
  "dataCaveats": ["anything limiting confidence, e.g. few logged days"]
}`;

async function callModel(env: Env, payload: unknown, model: string): Promise<unknown> {
  const apiKey = await getOpenRouterApiKey(env);
  if (!apiKey) throw new Error('No OpenRouter API key configured');

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': env.APP_URL || 'https://macro.montagnertudor.org',
      'X-OpenRouter-Title': 'Macroflow',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  const body = (await response.json()) as any;
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter returned no content');

  try {
    return JSON.parse(text);
  } catch {
    // Some models fence the JSON despite response_format; salvage it.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Model did not return JSON: ${text.slice(0, 300)}`);
    return JSON.parse(match[0]);
  }
}

/* ------------------------------------------------------------------ */

export async function runScheduledReports(env: Env, now: Date = new Date()): Promise<void> {
  const settings = await getSettings(env);
  const model = settings.report_model || DEFAULT_REPORT_MODEL;

  for (const period of duePeriods(now, settings.timezone)) {
    const key = `report:${period.kind}:${period.key}`;

    // Claim before doing any work — same idiom as checkReminders.
    const claimed = await env.DB.prepare(
      'INSERT OR IGNORE INTO sent_reminders (id, reminder_key, sent_at) VALUES (?, ?, ?)',
    )
      .bind(crypto.randomUUID(), key, now.toISOString())
      .run();
    if (!claimed.meta.changes) continue;

    try {
      const payload = await buildPayload(env, period, settings);
      const report = await callModel(env, payload, model);

      await env.DB.prepare(
        `INSERT INTO reports (id, period_kind, period_key, period_start, period_end,
                              model, payload_json, report_json, days_logged, days_in_period)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          period.kind,
          period.key,
          period.start,
          period.end,
          model,
          JSON.stringify(payload),
          JSON.stringify(report),
          payload.period.daysLogged,
          period.days,
        )
        .run();
    } catch (error) {
      // Release the claim so the next tick retries instead of losing the period.
      await env.DB.prepare('DELETE FROM sent_reminders WHERE reminder_key = ?').bind(key).run();
      console.error(`Report ${key} failed:`, error);
    }
  }
}
