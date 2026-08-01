import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("typed api client", () => {
  it("sends bearer token and JSON body", async () => {
    const spy = vi.fn().mockResolvedValue(okJson({ id: "1" }, 201));
    vi.stubGlobal("fetch", spy);
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.test");
    await api.createNote("tok", { content: "hi" });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.test/notes");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body).content).toBe("hi");
  });

  it("rejects invalid input locally without calling fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(api.createNote("tok", { content: "x".repeat(100_001) }))
      .rejects.toBeInstanceOf(ApiError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an empty note patch locally", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(api.updateNote("tok", crypto.randomUUID(), {}))
      .rejects.toBeInstanceOf(ApiError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws ApiError with status on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ message: "Not found" }, 404)));
    await expect(api.updateNote("tok", crypto.randomUUID(), { content: "x" }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("sends no body on DELETE and still returns parsed JSON", async () => {
    const spy = vi.fn().mockResolvedValue(okJson({ ok: true }));
    vi.stubGlobal("fetch", spy);
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.test");
    const id = crypto.randomUUID();
    await api.deleteNote("tok", id);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(`https://api.test/notes/${id}`);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("surfaces server validation issues on the error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      okJson({ message: "validation failed", issues: [{ path: "content", message: "required" }] }, 400),
    ));
    await expect(api.createNote("tok", { content: "ok" }))
      .rejects.toMatchObject({ status: 400, issues: [{ path: "content", message: "required" }] });
  });
});
