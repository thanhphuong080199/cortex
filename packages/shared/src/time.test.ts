import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, dayKey, daySeparatorLabel, formatNoteDate, formatToday, resolveTimeZone } from "./time.js";

describe("resolveTimeZone", () => {
  it("keeps a real IANA zone", () => {
    expect(resolveTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("falls back when the client sent nothing", () => {
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone("")).toBe(DEFAULT_TIME_ZONE);
  });

  // THE ONE THAT PROTECTS THE TURN. `timeZone` arrives from a client and goes straight into
  // Intl.DateTimeFormat, which throws RangeError on an unknown zone. Unvalidated, one bad
  // string kills the whole answer -- and the failure mode is wildly out of proportion to the
  // input: a wrong zone costs a day of accuracy, a throw costs the reply.
  it("falls back on a zone Intl does not know, instead of throwing", () => {
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone("'; drop table notes; --")).toBe(DEFAULT_TIME_ZONE);
  });
});

describe("formatNoteDate", () => {
  // THE TEST THAT JUSTIFIES CARRYING A TIME ZONE AT ALL. 18:00 UTC is 01:00 the NEXT DAY in
  // Ho Chi Minh City. Rendering UTC would misdate every note written after 5pm local -- which
  // is exactly the part of the day people write "mai" in. Off by one day, on the sentences
  // where one day is the entire meaning.
  it("renders an evening note on the local day, not the UTC day", () => {
    expect(formatNoteDate("2026-08-12T18:00:00.000Z", "Asia/Ho_Chi_Minh")).toBe("13-08-2026");
    expect(formatNoteDate("2026-08-12T18:00:00.000Z", "UTC")).toBe("12-08-2026");
  });

  it("renders a plain daytime note", () => {
    expect(formatNoteDate("2026-08-12T03:00:00.000Z", "Asia/Ho_Chi_Minh")).toBe("12-08-2026");
  });

  // Every citation persisted before this plan has no createdAt, and PostgREST spells timestamps
  // two different ways depending on whether they land on a whole second. Anything unreadable
  // renders NO date rather than a wrong one -- a missing date costs the model an inference; a
  // wrong one makes it confidently wrong.
  it("returns null rather than a wrong date for anything it cannot read", () => {
    expect(formatNoteDate("", "Asia/Ho_Chi_Minh")).toBeNull();
    expect(formatNoteDate("not a date", "Asia/Ho_Chi_Minh")).toBeNull();
  });

  it("reads both spellings PostgREST emits", () => {
    expect(formatNoteDate("2026-08-12T03:00:00+00:00", "Asia/Ho_Chi_Minh")).toBe("12-08-2026");
    expect(formatNoteDate("2026-08-12T03:00:00.113Z", "Asia/Ho_Chi_Minh")).toBe("12-08-2026");
  });
});

describe("formatToday", () => {
  // The weekday is not decoration: "thứ 3 tới" is unresolvable without knowing what day it is
  // now, and that is a phrase this corpus's users write constantly.
  it("names the weekday and the date", () => {
    expect(formatToday(new Date("2026-08-16T04:00:00.000Z"), "Asia/Ho_Chi_Minh"))
      .toBe("Chủ Nhật, 16-08-2026");
  });

  it("uses the caller's zone for the day boundary too", () => {
    // 17:30 UTC on the 16th is 00:30 on the 17th in Ho Chi Minh City -- a Monday.
    expect(formatToday(new Date("2026-08-16T17:30:00.000Z"), "Asia/Ho_Chi_Minh"))
      .toBe("Thứ Hai, 17-08-2026");
  });
});

describe("dayKey", () => {
  // THE CASE THE WHOLE FUNCTION EXISTS FOR, and the only one a UTC implementation gets wrong.
  // 2026-08-18T18:30Z is still the 18th in UTC and already the 19th in Ho Chi Minh City (UTC+7).
  // Evening is when this corpus is written, so a UTC key puts the separator a day late every
  // single time.
  it("uses the caller's zone, not UTC", () => {
    expect(dayKey("2026-08-18T18:30:00.000Z", "Asia/Ho_Chi_Minh")).toBe("2026-08-19");
    expect(dayKey("2026-08-18T18:30:00.000Z", "UTC")).toBe("2026-08-18");
  });

  // Two messages either side of local midnight must NOT share a key -- if they did there would
  // be no separator between them, which is the visible bug.
  it("separates two instants that straddle local midnight", () => {
    const before = dayKey("2026-08-18T16:59:00.000Z", "Asia/Ho_Chi_Minh"); // 23:59 local
    const after = dayKey("2026-08-18T17:01:00.000Z", "Asia/Ho_Chi_Minh"); // 00:01 local
    expect(before).not.toBe(after);
  });

  // Sortable, because the caller groups by it. "18/08/2026" would sort August before February.
  it("is zero-padded and year-first so it sorts", () => {
    expect(dayKey("2026-02-03T05:00:00.000Z", "Asia/Ho_Chi_Minh")).toBe("2026-02-03");
  });

  // Persisted rows predate every field this repo has added; a bad timestamp must not throw
  // inside a map() and take the whole transcript down.
  it("returns an empty string for an unparseable date", () => {
    expect(dayKey("not a date", "Asia/Ho_Chi_Minh")).toBe("");
  });
});

describe("daySeparatorLabel", () => {
  const tz = "Asia/Ho_Chi_Minh";
  // 2026-08-22T03:00Z is 10:00 on the 22nd, local.
  const now = new Date("2026-08-22T03:00:00.000Z");

  it("names today and yesterday rather than dating them", () => {
    expect(daySeparatorLabel("2026-08-22T01:00:00.000Z", now, tz)).toBe("Hôm nay");
    expect(daySeparatorLabel("2026-08-21T01:00:00.000Z", now, tz)).toBe("Hôm qua");
  });

  // RELATIVE TO `now`'s OWN LOCAL DAY, not to UTC's. At 03:00Z on the 22nd it is already the
  // 22nd locally; an implementation that takes "today" from the UTC date happens to agree here
  // and disagrees for every evening, so the case below is the one that pins it.
  it("still says today for a message sent this local evening", () => {
    const evening = new Date("2026-08-22T16:00:00.000Z"); // 23:00 local, same local day
    expect(daySeparatorLabel("2026-08-22T15:00:00.000Z", evening, tz)).toBe("Hôm nay");
  });

  it("dates anything older", () => {
    expect(daySeparatorLabel("2026-08-18T01:00:00.000Z", now, tz)).toMatch(/18/);
    expect(daySeparatorLabel("2026-08-18T01:00:00.000Z", now, tz)).not.toMatch(/Hôm/);
  });
});
