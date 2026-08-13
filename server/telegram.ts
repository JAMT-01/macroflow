import { randomUUID } from "node:crypto";
import { db, getSettings } from "./db.js";
import { analyzeDescription } from "./analysis.js";
import { dateRangeUtc, getTimeContext } from "./time.js";

type TelegramUpdate = {
  update_id: number;
  message?: { chat: { id: number }; text?: string; date: number };
};

let lastUpdateId = 0;
let polling = false;

async function telegramRequest(method: string, body: Record<string, unknown>) {
  const token = getSettings().telegram_bot_token;
  if (!token) throw new Error("Telegram bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000)
  });
  const payload = await response.json() as { ok: boolean; description?: string; result?: unknown };
  if (!payload.ok) throw new Error(payload.description || "Telegram request failed");
  return payload.result;
}

export async function sendTelegramMessage(text: string, chatId?: string) {
  const settings = getSettings();
  const target = chatId || settings.telegram_chat_id;
  if (!target) throw new Error("Send /start to your bot first, or add a chat ID");
  return telegramRequest("sendMessage", {
    chat_id: target,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "Open Macroflow", url: process.env.APP_URL || "http://localhost:5173" }]] }
  });
}

function todaySummary() {
  const settings = getSettings();
  const context = getTimeContext(settings.timezone);
  const range = dateRangeUtc(context.today, settings.timezone);
  const totals = db.prepare(`
    SELECT COALESCE(SUM(mi.calories),0) calories, COALESCE(SUM(mi.protein),0) protein,
           COALESCE(SUM(mi.carbs),0) carbs, COALESCE(SUM(mi.fat),0) fat
    FROM meals m JOIN meal_items mi ON mi.meal_id = m.id
    WHERE m.logged_at >= ? AND m.logged_at < ?
  `).get(range.start, range.end) as { calories: number; protein: number; carbs: number; fat: number };
  return `📊 <b>Today</b>\n${Math.round(totals.calories)} / ${Math.round(settings.calorie_target)} kcal\n🥩 ${Math.round(totals.protein)}g protein · 🌾 ${Math.round(totals.carbs)}g carbs · 🥑 ${Math.round(totals.fat)}g fat\n\n${Math.max(0, Math.round(settings.calorie_target - totals.calories))} kcal remaining`;
}

function logFromTelegram(text: string) {
  const description = text.replace(/^\/log\s*/i, "").trim();
  const analysis = analyzeDescription(description);
  if (!analysis.items.length) return { ok: false, text: "I couldn't match that meal. Try: <code>/log 200g chicken, 150g rice</code>" };
  const mealId = randomUUID();
  const mealType = analysis.mealTypeSuggestion.type;
  db.prepare("INSERT INTO meals (id, logged_at, meal_type, title, notes, source, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(mealId, new Date().toISOString(), mealType, analysis.title, description, "telegram", analysis.confidence);
  const insert = db.prepare("INSERT INTO meal_items (id, meal_id, food_id, name, grams, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of analysis.items) insert.run(randomUUID(), mealId, item.foodId, item.name, item.grams, item.calories, item.protein, item.carbs, item.fat);
  const calories = analysis.items.reduce((sum, item) => sum + item.calories, 0);
  return { ok: true, text: `✅ Logged <b>${analysis.title}</b> · ${Math.round(calories)} kcal\nFiled as <b>${mealType}</b>. Review the estimate and the category in Macroflow when you can.` };
}

async function handleUpdate(update: TelegramUpdate) {
  const message = update.message;
  if (!message?.text) return;
  const chatId = String(message.chat.id);
  const current = getSettings();
  if (!current.telegram_chat_id) db.prepare("UPDATE settings SET telegram_chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").run(chatId);
  const text = message.text.trim();
  if (/^\/start/i.test(text)) {
    await sendTelegramMessage("👋 <b>Macroflow is connected.</b>\n\nUse /today for your totals or /log followed by a meal description.", chatId);
  } else if (/^\/(today|remaining)/i.test(text)) {
    await sendTelegramMessage(todaySummary(), chatId);
  } else if (/^\/log\b/i.test(text)) {
    await sendTelegramMessage(logFromTelegram(text).text, chatId);
  } else if (/^\/help/i.test(text)) {
    await sendTelegramMessage("<b>Commands</b>\n/today — daily totals\n/log 200g chicken, 150g rice — log a meal\n/help — show this message", chatId);
  }
}

async function pollTelegram() {
  const settings = getSettings();
  if (!settings.telegram_bot_token || polling) return;
  polling = true;
  try {
    const result = await telegramRequest("getUpdates", { offset: lastUpdateId + 1, timeout: 0, allowed_updates: ["message"] }) as TelegramUpdate[];
    for (const update of result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);
      await handleUpdate(update);
    }
  } catch (error) {
    if (process.env.NODE_ENV !== "test") console.warn("Telegram polling:", error instanceof Error ? error.message : error);
  } finally {
    polling = false;
  }
}

async function checkReminders() {
  const settings = getSettings();
  if (!settings.telegram_bot_token || !settings.telegram_chat_id) return;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone, hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const time = `${read("hour")}:${read("minute")}`;
  const date = `${read("year")}-${read("month")}-${read("day")}`;
  const reminders = JSON.parse(settings.reminders_json) as Array<{ id: string; label: string; time: string; enabled: boolean }>;
  for (const reminder of reminders.filter((item) => item.enabled && item.time === time)) {
    const key = `${date}:${reminder.id}:${time}`;
    const sent = db.prepare("SELECT id FROM sent_reminders WHERE reminder_key = ?").get(key);
    if (sent) continue;
    await sendTelegramMessage(`⏰ <b>${reminder.label} check-in</b>\nTake ten seconds to log what you ate. Consistency beats precision.`);
    db.prepare("INSERT INTO sent_reminders (id, reminder_key, sent_at) VALUES (?, ?, ?)").run(randomUUID(), key, new Date().toISOString());
  }
}

export function startTelegramService() {
  setInterval(() => void pollTelegram(), 5_000).unref();
  setInterval(() => void checkReminders(), 30_000).unref();
  void pollTelegram();
  void checkReminders();
}
