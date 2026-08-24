import { redirect } from "next/navigation";
import { readCitation, type AnyCitation } from "@cortex/shared";
import { createClient } from "@/lib/supabase/server";
import { AssistantBox, type TranscriptTurn } from "./assistant-box";

/**
 * The first page of the thread, newest last.
 *
 * ONE table, and no session boundary. Until 2026-08-22 this file also read `notes` for a
 * sidebar, and scoped the transcript to `resolveCurrentSession` -- so a conversation from this
 * morning was simply gone by the afternoon, and finding it again was the note browser's job.
 * The browser is gone (S1 §1), so the thread has to be continuous (§3). `resolveCurrentSession`
 * still governs how far back the MODEL's prompt reaches, in turn.ts, which is a different
 * question and is deliberately left alone.
 *
 * 30, matching PAGE_SIZE in lib/transcript.ts. Ordered DESC in the query because that is the
 * direction the index runs (`chat_messages_user_idx (user_id, created_at desc)`, 00027), then
 * reversed for display -- an ASC query with a LIMIT would take the OLDEST thirty messages the
 * user ever sent.
 */
const PAGE_SIZE = 30;

export default async function Home() {
  const supabase = await createClient();
  // getUser() authenticates against the auth server; getSession() supplies the access token the
  // write API needs (getSession alone is not trustworthy server-side).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  // RLS (chat_messages_own, 00006) is the isolation layer, which is why this needs no user
  // filter beyond the one it already has for the index's leading column.
  const { data: messageRows } = await supabase
    .from("chat_messages").select("id, role, content, citations, retrieval_meta, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  const rows = messageRows ?? [];
  const turns: TranscriptTurn[] = [...rows].reverse().map((m) => {
    const row = m as {
      id: string; role: string; content: string;
      citations: unknown;
      retrieval_meta: { incomplete?: boolean; savedAnswerNoteId?: string } | null;
      created_at: string;
    };
    return {
      id: row.id,
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
      createdAt: row.created_at,
      // readCitation is the one place a jsonb entry's shape is decided: a pre-C3 entry with no
      // `type` reads as a note, and anything unreadable is DROPPED rather than rendered. One
      // bad entry must not cost the user the rest of the transcript.
      citations: (Array.isArray(row.citations) ? row.citations : [])
        .map(readCitation)
        .filter((c): c is AnyCitation => c !== null),
      incomplete: row.retrieval_meta?.incomplete === true,
      // Seeds `saved` in AssistantBox so a reply already kept does not offer "Lưu câu trả lời"
      // again after a reload -- reported 2026-08-24, see save-answer.ts's markMessageSaved.
      savedAsNote: row.retrieval_meta?.savedAnswerNoteId !== undefined,
    };
  });

  return (
    <AssistantBox
      token={session.access_token}
      // Task 5's pagination query needs it, and the index leads on it.
      userId={user.id}
      initialTurns={turns}
      // A full page means there is probably more behind it. A short page is proof there is not,
      // and saves the client a round trip that would return zero rows.
      hasMore={rows.length === PAGE_SIZE}
    />
  );
}
