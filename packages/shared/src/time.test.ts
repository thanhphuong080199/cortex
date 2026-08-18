import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, formatNoteDate, formatToday, resolveTimeZone } from "./time.js";

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
