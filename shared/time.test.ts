import { describe, expect, it } from "vitest";
import { addCalendarDays, dateInTimeZone, dateRangeUtc, dateTimeInZone, getTimeContext } from "./time.js";

describe("server-authoritative diary time", () => {
  it("defines today in Buenos Aires even when UTC is already tomorrow", () => {
    const context = getTimeContext("America/Buenos_Aires", new Date("2026-08-14T01:30:00.000Z"));
    expect(context.today).toBe("2026-08-13");
    expect(context.localTime).toBe("22:30");
    expect(context.greeting).toBe("evening");
  });

  it("builds exact UTC boundaries for a configured diary day", () => {
    expect(dateRangeUtc("2026-08-13", "America/Buenos_Aires")).toEqual({
      start: "2026-08-13T03:00:00.000Z",
      end: "2026-08-14T03:00:00.000Z"
    });
  });

  it("handles DST transitions and calendar arithmetic", () => {
    const range = dateRangeUtc("2026-03-08", "America/New_York");
    expect((new Date(range.end).getTime() - new Date(range.start).getTime()) / 3_600_000).toBe(23);
    expect(dateTimeInZone("2026-08-13", "09:15:00", "America/Buenos_Aires").toISOString()).toBe("2026-08-13T12:15:00.000Z");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dateInTimeZone("2026-08-14T01:30:00.000Z", "America/Buenos_Aires")).toBe("2026-08-13");
  });
});
