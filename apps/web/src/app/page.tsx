import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { applyNoteFilters, noteSelect, parseNoteFilters } from "@/lib/note-views";
import { AppShell } from "./app-shell";
import { AssistantBox } from "./assistant-box";
import { Sidebar } from "./sidebar";
import type { NoteRow } from "./note-list";

export default async function Home(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const filters = parseNoteFilters(params);
  const { view, q, tag, domain } = filters;

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
    return `/?${sp.toString()}`;
  };
  // Clicking the active domain chip clears it, so the filter is its own toggle.
  const domainHref = (d: string) => {
    const sp = new URLSearchParams();
    sp.set("view", view);
    if (q) sp.set("q", q);
    if (tag) sp.set("tag", tag);
    if (d !== domain) sp.set("domain", d);
    return `/?${sp.toString()}`;
  };

  // Chat reads top-to-bottom, oldest first; the note list beside it (in the sidebar) is the
  // same rows in the opposite, most-recent-first order the query already fetched them in.
  const messages = [...notes].reverse().map((n) => ({ id: n.id, content: n.content }));

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
      <AssistantBox token={session.access_token} initialMessages={messages} />
    </AppShell>
  );
}
