import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  }),
  deleteItemAsync: vi.fn(async (k: string) => {
    store.delete(k);
  }),
}));

const { secureStorageAdapter, SECURE_CHUNK_SIZE } = await import("./secure-storage.js");

beforeEach(() => store.clear());

describe("secureStorageAdapter", () => {
  it("round-trips a short value", async () => {
    await secureStorageAdapter.setItem("session", "abc");
    expect(await secureStorageAdapter.getItem("session")).toBe("abc");
  });

  it("round-trips a value larger than one SecureStore entry", async () => {
    const big = "x".repeat(SECURE_CHUNK_SIZE * 3 + 17);
    await secureStorageAdapter.setItem("session", big);
    expect(await secureStorageAdapter.getItem("session")).toBe(big);
  });

  it("returns null for a missing key", async () => {
    expect(await secureStorageAdapter.getItem("nope")).toBeNull();
  });

  it("removes every chunk, leaving nothing behind", async () => {
    await secureStorageAdapter.setItem("session", "y".repeat(SECURE_CHUNK_SIZE * 2));
    await secureStorageAdapter.removeItem("session");
    expect(await secureStorageAdapter.getItem("session")).toBeNull();
    expect([...store.keys()]).toEqual([]);
  });

  it("shrinks cleanly when a long value is replaced by a short one", async () => {
    await secureStorageAdapter.setItem("session", "z".repeat(SECURE_CHUNK_SIZE * 3));
    await secureStorageAdapter.setItem("session", "small");
    expect(await secureStorageAdapter.getItem("session")).toBe("small");
    // A stale chunk 2 left behind would corrupt the next read.
    expect([...store.keys()].length).toBe(2); // the count key + one chunk
  });
});
