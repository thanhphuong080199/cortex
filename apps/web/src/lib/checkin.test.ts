import { describe, expect, it } from "vitest";
import { createCheckinInput } from "@cortex/shared";
import { buildCheckinPayload } from "./checkin";

describe("buildCheckinPayload", () => {
  it("makes a mood tap alone a valid payload -- that is the whole gesture", () => {
    expect(buildCheckinPayload({ mood: 4 })).toEqual({ mood: 4 });
  });

  it("carries energy and mood together", () => {
    expect(buildCheckinPayload({ mood: 2, energy: 5 })).toEqual({ mood: 2, energy: 5 });
  });

  it("trims the label and drops it when blank", () => {
    expect(buildCheckinPayload({ mood: 2, label: "  tired  " })).toEqual({ mood: 2, label: "tired" });
    expect(buildCheckinPayload({ mood: 2, label: "   " })).toEqual({ mood: 2 });
  });

  it("returns null when neither mood nor energy was picked", () => {
    // The widget uses null to mean "nothing to send", so a stray label keystroke never
    // fires a request that the API would only reject with a 400.
    expect(buildCheckinPayload({ label: "words" })).toBeNull();
    expect(buildCheckinPayload({})).toBeNull();
  });

  it("omits undefined keys rather than sending them as null", () => {
    // `{mood: 4, energy: undefined}` would serialise to `{"mood":4}` anyway, but an
    // explicit null would fail the DTO -- assert the object shape, not just the JSON.
    expect(Object.keys(buildCheckinPayload({ mood: 4 })!)).toEqual(["mood"]);
  });

  it("produces payloads the shared DTO accepts", () => {
    // The API validates with this exact schema, so anything the builder emits must pass.
    for (const raw of [{ mood: 1 }, { energy: 5 }, { mood: 3, energy: 3, label: "ok" }]) {
      expect(createCheckinInput.safeParse(buildCheckinPayload(raw)).success).toBe(true);
    }
  });
});
