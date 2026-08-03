import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

// The native module stores bytes, not JS strings: Hermes converts a JS string to UTF-8 on
// the way into a native module, and a lone surrogate has no UTF-8 encoding, so it comes back
// as U+FFFD. Model that boundary here — a mock that keeps JS strings verbatim would hide
// exactly the corruption chunking has to avoid.
const asStoredBytes = (value: string) => new TextDecoder().decode(new TextEncoder().encode(value));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => {
    store.set(k, asStoredBytes(v));
  }),
  deleteItemAsync: vi.fn(async (k: string) => {
    store.delete(k);
  }),
}));

const { secureStorageAdapter, SECURE_CHUNK_SIZE } = await import("./secure-storage.js");

const byteLength = (value: string) => new TextEncoder().encode(value).length;

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

  // F1 + F2: the cap is in UTF-8 bytes, and slicing at a UTF-16 index splits surrogate pairs.
  it("round-trips multi-byte text with every chunk inside the byte budget", async () => {
    // Precomposed Vietnamese diacritics in U+1EA0-U+1EF9 are three UTF-8 bytes each, so a
    // chunk measured in UTF-16 code units is up to 3x its documented size.
    const vietnamese = "Đặng Thị Phượng nghiên cứu trí tuệ nhân tạo tại Hà Nội. ";
    const value = vietnamese.repeat(120);
    await secureStorageAdapter.setItem("session", value);

    expect(await secureStorageAdapter.getItem("session")).toBe(value);
    for (const [k, v] of store) {
      if (k.endsWith("__chunks")) continue;
      expect(byteLength(v)).toBeLessThanOrEqual(SECURE_CHUNK_SIZE);
    }
  });

  it("round-trips an astral character that lands on a chunk boundary", async () => {
    // Walk the emoji across the boundary region: whichever index the chunker cuts at, one of
    // these values puts the surrogate pair astride it.
    for (let offset = -4; offset <= 4; offset++) {
      store.clear();
      const head = "a".repeat(SECURE_CHUNK_SIZE + offset);
      const value = `${head}\u{1F600}${"b".repeat(64)}`;
      await secureStorageAdapter.setItem("session", value);
      expect(await secureStorageAdapter.getItem("session")).toBe(value);
    }
  });

  // F3: a crash between the chunk writes and the count write leaves chunks the count key
  // never covers, so they become unreachable AND undeletable — a stale slice of session
  // material that sign-out can never clear.
  it("sweeps orphaned chunks the count key does not cover", async () => {
    await secureStorageAdapter.setItem("session", "small");
    // Chunks left behind by an earlier, larger write that crashed before its count key landed.
    store.set("session__1", "orphaned tail");
    store.set("session__4", "orphaned tail");

    await secureStorageAdapter.removeItem("session");

    expect([...store.keys()]).toEqual([]);
  });

  // F5: auth-js runs lockless by default, so two operations on the session key can interleave.
  it("serialises overlapping writes instead of splicing them together", async () => {
    const a = "a".repeat(SECURE_CHUNK_SIZE * 3);
    const b = "b".repeat(SECURE_CHUNK_SIZE);

    await Promise.all([
      secureStorageAdapter.setItem("session", a),
      secureStorageAdapter.setItem("session", b),
    ]);

    // Whichever write wins, the value read back must be one of them entire — never a splice.
    expect(await secureStorageAdapter.getItem("session")).toBe(b);
  });

  it("does not let a write in flight survive a sign-out", async () => {
    const writing = secureStorageAdapter.setItem("session", "s".repeat(SECURE_CHUNK_SIZE * 2));
    const removing = secureStorageAdapter.removeItem("session");
    await Promise.all([writing, removing]);

    expect(await secureStorageAdapter.getItem("session")).toBeNull();
    expect([...store.keys()]).toEqual([]);
  });

  it("keeps serialising a key after an operation on it fails", async () => {
    const SecureStore = await import("expo-secure-store");
    const setItemAsync = vi.mocked(SecureStore.setItemAsync);
    setItemAsync.mockRejectedValueOnce(new Error("keystore unavailable"));

    await expect(secureStorageAdapter.setItem("session", "boom")).rejects.toThrow(
      "keystore unavailable",
    );
    await secureStorageAdapter.setItem("session", "after");

    expect(await secureStorageAdapter.getItem("session")).toBe("after");
  });

  // F7: `setItem(key, "")` used to read back as null.
  it("round-trips an empty string as an empty string", async () => {
    await secureStorageAdapter.setItem("session", "");
    expect(await secureStorageAdapter.getItem("session")).toBe("");
  });
});
