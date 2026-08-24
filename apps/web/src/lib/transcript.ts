import { readCitation, type AnyCitation } from "@cortex/shared";
import type { TranscriptTurn } from "@/app/assistant-box";

/**
 * One page of the thread. Matches PAGE_SIZE in page.tsx, which renders the first one -- two
 * different sizes would make "a full page means there is more" mean two different things.
 */
export const PAGE_SIZE = 30;

/**
 * Only the part of a Supabase client this function calls. Declared rather than imported so the
 * test can hand over a stub: a test that spins up a real client would be testing PostgREST.
 */
export interface TranscriptClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        lt(column: string, value: string): {
          order(column: string, opts: { ascending: boolean }): {
            limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
          };
        };
      };
    };
  };
}

/**
 * The page of messages immediately before `before` (an ISO timestamp), oldest first.
 *
 * DESC in the query, reversed on the way out. The index is
 * `chat_messages_user_idx (user_id, created_at desc)` (00027), and only a DESC query makes
 * LIMIT mean "the thirty nearest the cursor" -- an ASC query with a LIMIT returns the thirty
 * oldest messages the user ever wrote, from any year.
 *
 * `lt`, never `lte`: with `lte` the cursor's own message comes back on every page and React
 * renders a duplicate key.
 */
export async function fetchOlderTurns(
  client: TranscriptClient,
  userId: string,
  before: string,
): Promise<{ turns: TranscriptTurn[]; hasMore: boolean }> {
  const { data } = await client
    .from("chat_messages")
    .select("id, role, content, citations, retrieval_meta, created_at")
    // RLS scopes this read regardless. The filter is here for the INDEX:
    // chat_messages_user_idx leads on user_id, and a query without it scans.
    .eq("user_id", userId)
    .lt("created_at", before)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  const rows = (data ?? []) as {
    id: string; role: string; content: string;
    citations: unknown;
    retrieval_meta: { incomplete?: boolean; savedAnswerNoteId?: string } | null;
    created_at: string;
  }[];

  return {
    turns: [...rows].reverse().map((row) => ({
      id: row.id,
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
      createdAt: row.created_at,
      citations: (Array.isArray(row.citations) ? row.citations : [])
        .map(readCitation)
        .filter((c): c is AnyCitation => c !== null),
      incomplete: row.retrieval_meta?.incomplete === true,
      savedAsNote: row.retrieval_meta?.savedAnswerNoteId !== undefined,
    })),
    hasMore: rows.length === PAGE_SIZE,
  };
}
