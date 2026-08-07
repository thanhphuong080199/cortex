import { HttpException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { CoreErrorFilter } from "./core-error.filter";

/** Captures what the filter wrote, so status and body can both be asserted. */
function host() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return {
    host: { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost,
    status,
    json,
  };
}

describe("CoreErrorFilter", () => {
  it("maps a CoreError kind to its status", () => {
    for (const [kind, code] of [["not_found", 404], ["conflict", 409], ["validation", 400]] as const) {
      const h = host();
      new CoreErrorFilter().catch({ kind, message: "m" }, h.host);
      expect(h.status).toHaveBeenCalledWith(code);
    }
  });

  /**
   * The case production found. Express middleware throws http-errors, not HttpException, so
   * body-parser's PayloadTooLargeError fell past both branches into the catch-all 500.
   *
   * A 500 is not a cosmetic mislabel here: the sync connector treats 5xx as transient and
   * leaves the batch queued for retry, so a body the server will never accept turned into an
   * infinite upload loop rather than a rejection the client could act on.
   */
  it("uses the status carried by an Express http-error rather than reporting 500", () => {
    const h = host();
    const tooLarge = Object.assign(new Error("request entity too large"), {
      status: 413,
      statusCode: 413,
      type: "entity.too.large",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    new CoreErrorFilter().catch(tooLarge, h.host);

    expect(h.status).toHaveBeenCalledWith(413);
  });

  it("never echoes the message of one, which can name internals", () => {
    const h = host();
    const err = Object.assign(new Error("/app/node_modules/.pnpm/raw-body@3.0.2 blew up"), {
      status: 400,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    new CoreErrorFilter().catch(err, h.host);

    expect(h.json).toHaveBeenCalledWith({ message: "Request rejected" });
  });

  it("still reports 500 for a 5xx http-error, and for anything with no status at all", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A 502 from something we called is our failure to the caller, not their bad request --
    // so it must NOT be passed through as a client error.
    const upstream = host();
    new CoreErrorFilter().catch(Object.assign(new Error("bad gateway"), { status: 502 }), upstream.host);
    expect(upstream.status).toHaveBeenCalledWith(500);

    const bare = host();
    new CoreErrorFilter().catch(new Error("boom"), bare.host);
    expect(bare.status).toHaveBeenCalledWith(500);
  });

  it("leaves a real HttpException alone", () => {
    const h = host();
    new CoreErrorFilter().catch(new HttpException("nope", 401), h.host);
    expect(h.status).toHaveBeenCalledWith(401);
  });
});
