import { redirect } from "next/navigation";
import { readCitation, resolveCurrentSession, type AnyCitation } from "@cortex/shared";
import { createClient } from "@/lib/supabase/server";
import { applyNoteFilters, noteSelect, parseNoteFilters } from "@/lib/note-views";
import { AppShell } from "./app-shell";
import { AssistantBox, type TranscriptTurn } from "./assistant-box";
import { Sidebar } from "./sidebar";
import type { NoteRow } from "./note-list";

export default async function Home(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const filters = parseNoteFilters(params);
  const { view, q, tag, domain, saved } = filters;

  const supabase = await createClient();
  // getUser() authenticates against the auth server; getSession() supplies the access
  // token the write API needs (getSession alone is not trustworthy server-side).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  // Reads go straight to Supabase under RLS; only writes go through the API (spec §2).
  // Every narrowing comes from applyNoteFilters, which note-list.tsx's refetch also uses --
  // the two disagreeing is issue-log E5, and they can no longer disagree.
  const { data, error } = await applyNoteFilters(
    supabase.from("notes").select(noteSelect(filters)),
    filters,
  );
  if (error) throw error; // rendered by error.tsx

  const notes = (data ?? []) as unknown as NoteRow[];
  const href = (v: string) => {
    const sp = new URLSearchParams();
    sp.set("view", v);
    if (q) sp.set("q", q);
    if (tag) sp.set("tag", tag);
    if (domain) sp.set("domain", domain);
    if (saved) sp.set("saved", "1");
    return `/?${sp.toString()}`;
  };
  // Clicking the active domain chip clears it, so the filter is its own toggle.
  const domainHref = (d: string) => {
    const sp = new URLSearchParams();
    sp.set("view", view);
    if (q) sp.set("q", q);
    if (tag) sp.set("tag", tag);
    if (d !== domain) sp.set("domain", d);
    if (saved) sp.set("saved", "1");
    return `/?${sp.toString()}`;
  };

  // THE SPLIT. The pane reads chat_messages; the sidebar reads notes. Two TABLES, not two
  // narrowings of one -- so the pane cannot inherit the sidebar's view/q/tag filters, which is
  // what it did until stage C4 (`/?view=archived` rendered an archived-only "conversation").
  // chat_messages also holds the assistant's own replies, which are not notes and never will
  // be, so there is no second narrowing here to drift.
  //
  // RLS is the isolation layer and it is already in place: chat_messages_own (00006) scopes
  // both statements below to this user, which is why the second one can be scoped by session
  // alone -- the same shape turn.ts reads it with.
  const { data: last } = await supabase
    .from("chat_messages").select("session_id, created_at")
    .eq("user_id", user.id).order("created_at", { ascending: false }).limit(1);
  const sessionId = resolveCurrentSession(
    ((last ?? [])[0] as { session_id: string; created_at: string } | undefined) ?? null,
    new Date(),
  );

  // Scrollback across earlier sessions is OUT of stage C4 (§2), and the limit is the visible
  // form of that decision: the pane shows the rolling 4-hour thread, not an unbounded list with
  // no bottom. Reaching older conversations is a search problem and gets its own stage.
  const TRANSCRIPT_LIMIT = 200;
  const { data: messageRows } = sessionId
    ? await supabase
        .from("chat_messages").select("id, role, content, citations, retrieval_meta")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .limit(TRANSCRIPT_LIMIT)
    : { data: [] };

  const turns: TranscriptTurn[] = (messageRows ?? []).map((m) => {
    const row = m as {
      id: string; role: string; content: string;
      citations: unknown; retrieval_meta: { incomplete?: boolean } | null;
    };
    return {
      id: row.id,
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
      // readCitation is the one place a jsonb entry's shape is decided: a pre-C3 entry with no
      // `type` reads as a note, and anything unreadable is DROPPED rather than rendered. One
      // bad entry must not cost the user the rest of the transcript.
      citations: (Array.isArray(row.citations) ? row.citations : [])
        .map(readCitation)
        .filter((c): c is AnyCitation => c !== null),
      incomplete: row.retrieval_meta?.incomplete === true,
    };
  });

  return (
    <AppShell
      sidebar={
        <Sidebar
          token={session.access_token}
          userId={user.id}
          notes={notes}
          filters={filters}
          href={href}
          domainHref={domainHref}
        />
      }
    >
      <AssistantBox token={session.access_token} initialTurns={turns} />
    </AppShell>
  );
}
