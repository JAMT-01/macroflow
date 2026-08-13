export type TimeContext = {
  timezone: string;
  now: string;
  today: string;
  localTime: string;
  greeting: "morning" | "afternoon" | "evening";
  dayStartedAt: string;
  dayEndsAt: string;
};

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsAt(instant: Date, timezone: string): ZonedParts {
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
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second)
  };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function offsetAt(instant: Date, timezone: string) {
  const parts = partsAt(instant, timezone);
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return representedAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export function isValidTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function dateInTimeZone(instant: Date | string, timezone: string) {
  const parts = partsAt(typeof instant === "string" ? new Date(instant) : instant, timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function dateTimeInZone(date: string, time: string, timezone: string) {
  const match = `${date}T${time}`.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match || !isValidTimeZone(timezone)) throw new Error("Invalid local date, time, or timezone");
  const [, year, month, day, hour, minute, second = "00"] = match;
  const localAsUtc = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  let guess = localAsUtc;
  for (let index = 0; index < 3; index++) guess = localAsUtc - offsetAt(new Date(guess), timezone);
  return new Date(guess);
}

export function addCalendarDays(date: string, amount: number) {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + amount, 12));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export function dateRangeUtc(date: string, timezone: string) {
  return {
    start: dateTimeInZone(date, "00:00:00", timezone).toISOString(),
    end: dateTimeInZone(addCalendarDays(date, 1), "00:00:00", timezone).toISOString()
  };
}

export function diaryTimestamp(date: string, timezone: string, now = new Date()) {
  const current = partsAt(now, timezone);
  const today = dateInTimeZone(now, timezone);
  const time = date === today ? `${pad(current.hour)}:${pad(current.minute)}:${pad(current.second)}` : "12:00:00";
  return dateTimeInZone(date, time, timezone).toISOString();
}

export function getTimeContext(timezone: string, now = new Date()): TimeContext {
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
