function partsAt(instant, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}
function pad(value) {
  return String(value).padStart(2, "0");
}
function offsetAt(instant, timezone) {
  const parts = partsAt(instant, timezone);
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return representedAsUtc - Math.floor(instant.getTime() / 1e3) * 1e3;
}
function isValidTimeZone(timezone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}
function dateInTimeZone(instant, timezone) {
  const parts = partsAt(typeof instant === "string" ? new Date(instant) : instant, timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}
function dateTimeInZone(date5, time3, timezone) {
  const match2 = `${date5}T${time3}`.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match2 || !isValidTimeZone(timezone)) throw new Error("Invalid local date, time, or timezone");
  const [, year, month, day, hour, minute, second = "00"] = match2;
  const localAsUtc = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  let guess = localAsUtc;
  for (let index = 0; index < 3; index++) guess = localAsUtc - offsetAt(new Date(guess), timezone);
  return new Date(guess);
}
function addCalendarDays(date5, amount) {
  const [year, month, day] = date5.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + amount, 12));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}
function dateRangeUtc(date5, timezone) {
  return {
    start: dateTimeInZone(date5, "00:00:00", timezone).toISOString(),
    end: dateTimeInZone(addCalendarDays(date5, 1), "00:00:00", timezone).toISOString()
  };
}
function diaryTimestamp(date5, timezone, now = /* @__PURE__ */ new Date()) {
  const current = partsAt(now, timezone);
  const today = dateInTimeZone(now, timezone);
  const time3 = date5 === today ? `${pad(current.hour)}:${pad(current.minute)}:${pad(current.second)}` : "12:00:00";
  return dateTimeInZone(date5, time3, timezone).toISOString();
}
function getTimeContext(timezone, now = /* @__PURE__ */ new Date()) {
  const safeTimezone = isValidTimeZone(timezone) ? timezone : "UTC";
  const parts = partsAt(now, safeTimezone);
  const today = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const range = dateRangeUtc(today, safeTimezone);
  return {
    timezone: safeTimezone,
    now: now.toISOString(),
    today,
    localTime: `${pad(parts.hour)}:${pad(parts.minute)}`,
    greeting: parts.hour < 12 ? "morning" : parts.hour < 18 ? "afternoon" : "evening",
    dayStartedAt: range.start,
    dayEndsAt: range.end
  };
}
var init_time = __esm({
  "shared/time.ts"() {
    "use strict";
    __name(partsAt, "partsAt");
    __name(pad, "pad");
    __name(offsetAt, "offsetAt");
    __name(isValidTimeZone, "isValidTimeZone");
    __name(dateInTimeZone, "dateInTimeZone");
    __name(dateTimeInZone, "dateTimeInZone");
    __name(addCalendarDays, "addCalendarDays");
    __name(dateRangeUtc, "dateRangeUtc");
    __name(diaryTimestamp, "diaryTimestamp");
    __name(getTimeContext, "getTimeContext");
  }
});
