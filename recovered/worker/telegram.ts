var telegram_exports = {};
__export(telegram_exports, {
  checkReminders: () => checkReminders,
  handleTelegramUpdate: () => handleTelegramUpdate,
  registerWebhook: () => registerWebhook,
  sendTelegramMessage: () => sendTelegramMessage
});
async function telegramRequest(env, method, body) {
  const settings = await getSettings(env);
  if (!settings.telegram_bot_token) throw new Error("Telegram bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${settings.telegram_bot_token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12e3)
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.description || "Telegram request failed");
  return payload.result;
}
async function sendTelegramMessage(env, text, chatId) {
  const settings = await getSettings(env);
  const target = chatId || settings.telegram_chat_id;
  if (!target) throw new Error("Send /start to your bot first, or add a chat ID");
  return telegramRequest(env, "sendMessage", {
    chat_id: target,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "Open Macroflow", url: env.APP_URL || "https://macro.montagnertudor.org" }]] }
  });
}
async function todaySummary(env) {
  const settings = await getSettings(env);
  const context = getTimeContext(settings.timezone);
  const range = dateRangeUtc(context.today, settings.timezone);
  const totals = await env.DB.prepare(`
    SELECT COALESCE(SUM(mi.calories),0) calories, COALESCE(SUM(mi.protein),0) protein,
           COALESCE(SUM(mi.carbs),0) carbs, COALESCE(SUM(mi.fiber),0) fiber, COALESCE(SUM(mi.fat),0) fat
    FROM meals m JOIN meal_items mi ON mi.meal_id = m.id
    WHERE m.logged_at >= ? AND m.logged_at < ?
  `).bind(range.start, range.end).first();
  const sums = totals ?? { calories: 0, protein: 0, carbs: 0, fiber: 0, fat: 0 };
  return `\u{1F4CA} <b>Today</b>
${Math.round(sums.calories)} / ${Math.round(settings.calorie_target)} kcal
\u{1F969} ${Math.round(sums.protein)}g protein \xB7 \u{1F33E} ${Math.round(sums.carbs)}g carbs \xB7 \u{1F951} ${Math.round(sums.fat)}g fat
\u{1F331} ${Math.round(sums.fiber)} / ${Math.round(settings.fiber_target)}g fibre

${Math.max(0, Math.round(settings.calorie_target - sums.calories))} kcal remaining`;
}
async function logFromTelegram(env, text) {
  const description = text.replace(/^\/log\s*/i, "").trim();
  const analysis = await analyzeTextOnly(env, description);
  if (!analysis.items.length) return "I couldn't match that meal. Try: <code>/log 200g chicken, 150g rice</code>";
  const mealId = crypto.randomUUID();
  const mealType = analysis.mealTypeSuggestion.type;
  const statements = [
    env.DB.prepare("INSERT INTO meals (id, logged_at, meal_type, title, notes, source, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(mealId, (/* @__PURE__ */ new Date()).toISOString(), mealType, analysis.title, description, "telegram", analysis.confidence),
    ...analysis.items.map(
      (item) => env.DB.prepare("INSERT INTO meal_items (id, meal_id, food_id, name, grams, calories, protein, carbs, fiber, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), mealId, item.foodId, item.name, item.grams, item.calories, item.protein, item.carbs, item.fiber, item.fat)
    )
  ];
  await env.DB.batch(statements);
  const calories = analysis.items.reduce((sum, item) => sum + item.calories, 0);
  return `\u2705 Logged <b>${analysis.title}</b> \xB7 ${Math.round(calories)} kcal
Filed as <b>${mealType}</b>. Review the estimate and the category in Macroflow when you can.`;
}
async function handleTelegramUpdate(env, update) {
  const message = update.message;
  if (!message?.text) return;
  const chatId = String(message.chat.id);
  const settings = await getSettings(env);
  if (!settings.telegram_chat_id) {
    await env.DB.prepare("UPDATE settings SET telegram_chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").bind(chatId).run();
  }
  const text = message.text.trim();
  if (/^\/start/i.test(text)) {
    await sendTelegramMessage(env, "\u{1F44B} <b>Macroflow is connected.</b>\n\nUse /today for your totals or /log followed by a meal description.", chatId);
  } else if (/^\/(today|remaining)/i.test(text)) {
    await sendTelegramMessage(env, await todaySummary(env), chatId);
  } else if (/^\/log\b/i.test(text)) {
    await sendTelegramMessage(env, await logFromTelegram(env, text), chatId);
  } else if (/^\/help/i.test(text)) {
    await sendTelegramMessage(env, "<b>Commands</b>\n/today \u2014 daily totals\n/log 200g chicken, 150g rice \u2014 log a meal\n/help \u2014 show this message", chatId);
  }
}
async function checkReminders(env) {
  const settings = await getSettings(env);
  if (!settings.telegram_bot_token || !settings.telegram_chat_id) return;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(/* @__PURE__ */ new Date());
  const read = /* @__PURE__ */ __name((type) => parts.find((part) => part.type === type)?.value ?? "", "read");
  const time3 = `${read("hour")}:${read("minute")}`;
  const date5 = `${read("year")}-${read("month")}-${read("day")}`;
  const reminders = JSON.parse(settings.reminders_json);
  for (const reminder of reminders.filter((item) => item.enabled && item.time === time3)) {
    const key = `${date5}:${reminder.id}:${time3}`;
    const claimed = await env.DB.prepare("INSERT OR IGNORE INTO sent_reminders (id, reminder_key, sent_at) VALUES (?, ?, ?)").bind(crypto.randomUUID(), key, (/* @__PURE__ */ new Date()).toISOString()).run();
    if (!claimed.meta.changes) continue;
    await sendTelegramMessage(env, `\u23F0 <b>${reminder.label} check-in</b>
Take ten seconds to log what you ate. Consistency beats precision.`);
  }
}
async function registerWebhook(env, publicUrl) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  return telegramRequest(env, "setWebhook", {
    url: `${publicUrl.replace(/\/+$/, "")}/api/telegram/webhook`,
    allowed_updates: ["message"],
    ...secret ? { secret_token: secret } : {}
  });
}
var init_telegram = __esm({
  "worker/telegram.ts"() {
    "use strict";
    init_time();
    init_analysis();
    init_db();
    __name(telegramRequest, "telegramRequest");
    __name(sendTelegramMessage, "sendTelegramMessage");
    __name(todaySummary, "todaySummary");
    __name(logFromTelegram, "logFromTelegram");
    __name(handleTelegramUpdate, "handleTelegramUpdate");
    __name(checkReminders, "checkReminders");
    __name(registerWebhook, "registerWebhook");
  }
});
