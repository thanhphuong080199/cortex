import { describe, expect, it } from "vitest";
import { fetchOlderTurns, PAGE_SIZE } from "./transcript";

/** The four chained calls the real query makes, ending in a thenable. */
function stubClient(rows: unknown[], capture?: { lt?: string; limit?: number }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    lt: (_col: string, value: string) => { if (capture) capture.lt = value; return builder; },
    order: () => builder,
    limit: (n: number) => { if (capture) capture.limit = n; return Promise.resolve({ data: rows, error: null }); },
  };
  return { from: () => builder } as never;
}

const row = (id: string, createdAt: string) => ({
  id, role: "user", content: `msg ${id}`, citations: [], retrieval_meta: null,
  created_at: createdAt,
});

const USER = "11111111-1111-1111-1111-111111111111";

describe("fetchOlderTurns", () => {
  // OLDEST FIRST on the way out, newest-first on the way in. The query has to run DESC to use
  // chat_messages_user_idx and to make LIMIT mean "the 30 nearest the cursor"; the transcript
  // renders ascending. Getting this backwards produces a thread that reads bottom-to-top only
  // in the pages loaded by scrolling -- a bug that looks like corrupted data.
  it("returns the page in display order, oldest first", async () => {
    const client = stubClient([
      row("c", "2026-08-20T10:00:00.000Z"),
      row("b", "2026-08-20T09:00:00.000Z"),
      row("a", "2026-08-20T08:00:00.000Z"),
    ]);
    const { turns } = await fetchOlderTurns(client, USER, "2026-08-20T11:00:00.000Z");
    expect(turns.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  // STRICTLY BEFORE the cursor. With `lte`, the message the cursor came from is returned again
  // on every page, and React renders a duplicate key for it.
  it("asks strictly before the cursor", async () => {
    const capture: { lt?: string; limit?: number } = {};
    await fetchOlderTurns(stubClient([], capture), USER, "2026-08-20T11:00:00.000Z");
    expect(capture.lt).toBe("2026-08-20T11:00:00.000Z");
    expect(capture.limit).toBe(PAGE_SIZE);
  });

  // A SHORT page is the end of the thread. Reporting hasMore: true there leaves the user
  // pulling forever against a query that will never return anything again.
  it("reports the end of the thread when the page is short", async () => {
    const { hasMore } = await fetchOlderTurns(
      stubClient([row("a", "2026-08-20T08:00:00.000Z")]), USER, "2026-08-20T11:00:00.000Z");
    expect(hasMore).toBe(false);
  });

  it("reports more when the page is full", async () => {
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) =>
      row(`r${i}`, new Date(Date.UTC(2026, 7, 20, 0, i)).toISOString()));
    const { hasMore } = await fetchOlderTurns(stubClient(rows), USER, "2026-08-20T11:00:00.000Z");
    expect(hasMore).toBe(true);
  });

  // Same rule page.tsx applies to the first page: one unreadable citation must cost that entry,
  // not the message and not the page.
  it("drops an unreadable citation without dropping the turn", async () => {
    const bad = { ...row("a", "2026-08-20T08:00:00.000Z"), citations: [{ nonsense: true }] };
    const { turns } = await fetchOlderTurns(stubClient([bad]), USER, "2026-08-20T11:00:00.000Z");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.citations).toEqual([]);
  });
});
