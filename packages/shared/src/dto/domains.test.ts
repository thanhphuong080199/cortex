import { describe, expect, it } from "vitest";
import { noteDomain } from "../enums.js";
import { domainMetaSchemas, validateDomainMeta } from "./domains.js";

describe("validateDomainMeta", () => {
  it("covers every domain in the enum", () => {
    // Without this, adding a domain value to the enum silently leaves it with no meta
    // schema and validateDomainMeta throws on undefined at runtime.
    expect(Object.keys(domainMetaSchemas).sort()).toEqual([...noteDomain.options].sort());
  });

  it("media meta accepts a 1-5 rating and rejects 6", () => {
    expect(validateDomainMeta("media", { rating: 5 }).success).toBe(true);
    expect(validateDomainMeta("media", { rating: 6 }).success).toBe(false);
  });

  it("health meta accepts the fields enrichment extracts", () => {
    expect(validateDomainMeta("health", { activity_type: "run", duration_min: 30 }).success).toBe(true);
    expect(validateDomainMeta("health", { intensity: 9 }).success).toBe(false);
  });

  it("every domain accepts an empty object (structure is extracted, never required)", () => {
    // Spec §2.1: freeform text is the source of truth; capture must never demand meta.
    for (const domain of noteDomain.options) {
      expect(validateDomainMeta(domain, {}).success, domain).toBe(true);
    }
  });

  it("rejects unknown keys so typos do not silently persist", () => {
    expect(validateDomainMeta("media", { ratng: 5 }).success).toBe(false);
    expect(validateDomainMeta("reflection", { anything: 1 }).success).toBe(false);
  });

  it("finance meta takes an amount, currency and decision type", () => {
    expect(validateDomainMeta("finance", {
      amount: 42.5, currency: "USD", decision_type: "purchase",
    }).success).toBe(true);
    expect(validateDomainMeta("finance", { currency: "dollars" }).success).toBe(false);
  });
});
