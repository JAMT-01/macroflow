import { dateRangeUtc, getTimeContext } from "../shared/time.js";
import { analyzeTextOnly } from "./analysis.js";
import { getSettings, type Env } from "./db.js";

type TelegramUpdate = {
  update_id: number;
  message?: { chat: { id: number }; text?: string; date: number };
};

/**
 * Workers cannot hold a long-poll loop, so Telegram pushes updates to
 * POST /api/telegram/webhook instead. Reminders run from a cron trigger.
 */
async function telegramRequest(env: Env, method: string, body: Record<string, unknown>) {
  const settings = await getSettings(env);
  if (!settings.telegram_bot_token) throw new Error("Telegram bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${settings.telegram_bot_token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000)
  });
  const payload = await response.json() as { ok: boolean; description?: string; result?: unknown };
  if (!payload.ok) throw new Error(payload.description || "Telegram request failed");
  return payload.result;
}

export async function sendTelegramMessage(env: Env, text: string, chatId?: string) {
  const settings = await getSettings(env);
  const target = chatId || settings.telegram_chat_id;
  if (!target) throw new Error("Send /start to your bot first, or add a chat ID");
  return telegramRequest(env, "sendMessage", {
    chat_id: target,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "Open Jamtytrack", url: env.APP_URL || "https://jamtytrack.montagnertudor.org" }]] }
  });
}

async function todaySummary(env: Env) {
  const settings = await getSettings(env);
  const context = getTimeContext(settings.timezone);
  const range = dateRangeUtc(context.today, settings.timezone);
  const totals = await env.DB.prepare(`
    SELECT COALESCE(SUM(mi.calories),0) calories, COALESCE(SUM(mi.protein),0) protein,
           COALESCE(SUM(mi.carbs),0) carbs, COALESCE(SUM(mi.fiber),0) fiber, COALESCE(SUM(mi.fat),0) fat
    FROM meals m JOIN meal_items mi ON mi.meal_id = m.id
    WHERE m.logged_at >= ? AND m.logged_at < ?
  `).bind(range.start, range.end).first<{ calories: number; protein: number; carbs: number; fiber: number; fat: number }>();
  const sums = totals ?? { calories: 0, protein: 0, carbs: 0, fiber: 0, fat: 0 };
  return `📊 <b>Today</b>\n${Math.round(sums.calories)} / ${Math.round(settings.calorie_target)} kcal\n🥩 ${Math.round(sums.protein)}g protein · 🌾 ${Math.round(sums.carbs)}g carbs · 🥑 ${Math.round(sums.fat)}g fat\n🌱 ${Math.round(sums.fiber)} / ${Math.round(settings.fiber_target)}g fibre\n\n${Math.max(0, Math.round(settings.calorie_target - sums.calories))} kcal remaining`;
}

async function logFromTelegram(env: Env, text: string) {
  const description = text.replace(/^\/log\s*/i, "").trim();
  const analysis = await analyzeTextOnly(env, description);
  if (!analysis.items.length) return "I couldn't match that meal. Try: <code>/log 200g chicken, 150g rice</code>";

  const mealId = crypto.randomUUID();
  const mealType = analysis.mealTypeSuggestion.type;
  const statements = [
    env.DB.prepare("INSERT INTO meals (id, logged_at, meal_type, title, notes, source, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(mealId, new Date().toISOString(), mealType, analysis.title, description, "telegram", analysis.confidence),
    ...analysis.items.map((item) =>
      env.DB.prepare("INSERT INTO meal_items (id, meal_id, food_id, name, grams, calories, protein, carbs, fiber, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), mealId, item.foodId, item.name, item.grams, item.calories, item.protein, item.carbs, item.fiber, item.fat)
    )
  ];
  await env.DB.batch(statements);
  const calories = analysis.items.reduce((sum, item) => sum + item.calories, 0);
  return `✅ Logged <b>${analysis.title}</b> · ${Math.round(calories)} kcal\nFiled as <b>${mealType}</b>. Review the estimate and the category in Jamtytrack when you can.`;
}

export async function handleTelegramUpdate(env: Env, update: TelegramUpdate) {
  const message = update.message;
  if (!message?.text) return;
  const chatId = String(message.chat.id);
  const settings = await getSettings(env);
  if (!settings.telegram_chat_id) {
    await env.DB.prepare("UPDATE settings SET telegram_chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").bind(chatId).run();
  }

  const text = message.text.trim();
  if (/^\/start/i.test(text)) {
    await sendTelegramMessage(env, "👋 <b>Jamtytrack is connected.</b>\n\nUse /today for your totals or /log followed by a meal description.", chatId);
  } else if (/^\/(today|remaining)/i.test(text)) {
    await sendTelegramMessage(env, await todaySummary(env), chatId);
  } else if (/^\/log\b/i.test(text)) {
    await sendTelegramMessage(env, await logFromTelegram(env, text), chatId);
  } else if (/^\/help/i.test(text)) {
    await sendTelegramMessage(env, "<b>Commands</b>\n/today — daily totals\n/log 200g chicken, 150g rice — log a meal\n/help — show this message", chatId);
  }
}

/**
 * Runs from the cron trigger. The unique index on reminder_key is what stops a
 * reminder going out twice when two cron invocations overlap the same minute.
 */
export async function checkReminders(env: Env) {
  const settings = await getSettings(env);
  if (!settings.telegram_bot_token || !settings.telegram_chat_id) return;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone, hour: "2-digit", minute: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const time = `${read("hour")}:${read("minute")}`;
  const date = `${read("year")}-${read("month")}-${read("day")}`;

  const reminders = JSON.parse(settings.reminders_json) as Array<{ id: string; label: string; time: string; enabled: boolean }>;
  for (const reminder of reminders.filter((item) => item.enabled && item.time === time)) {
    const key = `${date}:${reminder.id}:${time}`;
    const claimed = await env.DB.prepare("INSERT OR IGNORE INTO sent_reminders (id, reminder_key, sent_at) VALUES (?, ?, ?)")
      .bind(crypto.randomUUID(), key, new Date().toISOString()).run();
    if (!claimed.meta.changes) continue;
    await sendTelegramMessage(env, `⏰ <b>${reminder.label} check-in</b>\nTake ten seconds to log what you ate. Consistency beats precision.`);
  }
}

/**
 * What Telegram believes about our webhook.
 *
 * Worth surfacing because every failure mode here is silent from our side:
 * Telegram retries against a URL we never see, and `last_error_message` is the
 * only place a 403 (wrong secret) or 503 (no secret configured) shows up.
 */
export async function getWebhookInfo(env: Env) {
  const info = await telegramRequest(env, "getWebhookInfo", {}) as {
    url?: string;
    pending_update_count?: number;
    last_error_message?: string;
    last_error_date?: number;
  };
  return {
    url: info.url || "",
    pendingUpdates: info.pending_update_count ?? 0,
    lastError: info.last_error_message || "",
    lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null
  };
}

/** Points Telegram at this Worker. Called once from POST /api/telegram/webhook/register. */
export async function registerWebhook(env: Env, publicUrl: string) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  return telegramRequest(env, "setWebhook", {
    url: `${publicUrl.replace(/\/+$/, "")}/api/telegram/webhook`,
    allowed_updates: ["message"],
    ...(secret ? { secret_token: secret } : {})
  });
}
