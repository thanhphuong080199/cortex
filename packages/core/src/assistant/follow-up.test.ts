import { describe, expect, it } from "vitest";
import { detectEntityGap } from "./follow-up.js";

describe("detectEntityGap", () => {
  // The case the whole stage exists for: "hôm nay tôi mới đi xem phim" classifies as media and
  // names no work, so no media_items row can exist and the record is unusable later.
  it("finds a gap when a media note names no work", () => {
    expect(detectEntityGap("media", {})).toEqual({
      domain: "media",
      field: "pending_item.title",
      wants: "which film, series or book it was",
    });
  });

  it("finds none when the work is named", () => {
    expect(detectEntityGap("media", {
      pending_item: { kind: "movie", title: "Interstellar" },
    })).toBeNull();
  });

  // A blank title could never have produced a media_items row either -- pendingMediaItem is
  // z.string().min(1). Keying on `pending_item !== undefined` instead of on the title lets this
  // through, which is why it is asserted separately.
  it("finds a gap when pending_item exists but its title is blank", () => {
    expect(detectEntityGap("media", { pending_item: { kind: "movie", title: "   " } }))
      .toMatchObject({ field: "pending_item.title" });
  });

  // The line between "worth a question" and "an interview". These three domains have no entity
  // table, so nothing is created by answering and there is nothing to ask for.
  it("finds none for domains that have no entity table", () => {
    expect(detectEntityGap("health", {})).toBeNull();
    expect(detectEntityGap("finance", {})).toBeNull();
    expect(detectEntityGap("learning", {})).toBeNull();
    expect(detectEntityGap("life", {})).toBeNull();
    expect(detectEntityGap("reflection", {})).toBeNull();
  });

  // A degraded extraction reaches turn.ts as `domain: null`. It must never produce a question.
  it("finds none when there is no domain at all", () => {
    expect(detectEntityGap(null, {})).toBeNull();
  });

  // A media note whose rating is missing is still a usable record: the entity exists.
  it("does not ask for fields that are merely nice to have", () => {
    expect(detectEntityGap("media", {
      pending_item: { kind: "movie", title: "Interstellar" },
    })).toBeNull();
  });
});
