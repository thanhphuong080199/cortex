import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { NOTE_VIEWS, VIEW_LABELS, parseView } from "@/lib/note-views";
import { ExportButton } from "./export-button";
import { NoteList, type NoteRow } from "./note-list";
import { QuickCapture } from "./quick-capture";

export default async function Home(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const view = parseView(one(params.view));
  const q = one(params.q)?.trim() ?? "";
  const tag = one(params.tag) ?? "";

  const supabase = await createClient();
  // getUser() authenticates against the auth server; getSession() supplies the access
  // token the write API needs (getSession alone is not trustworthy server-side).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  // Reads go straight to Supabase under RLS; only writes go through the API (spec §2).
  let query = supabase.from("notes")
    .select(tag ? "*, note_tags!inner(tag_id, deleted_at)" : "*")
    .order("updated_at", { ascending: false });
  query = view === "trash" ? query.not("deleted_at", "is", null) : query.is("deleted_at", null);
  if (view === "active") query = query.in("lifecycle", ["active", "evergreen"]);
  else if (view !== "trash") query = query.eq("lifecycle", view);
  if (q) query = query.textSearch("content_text", q, { type: "websearch", config: "english" });
  if (tag) query = query.eq("note_tags.tag_id", tag).is("note_tags.deleted_at", null);

  const { data, error } = await query;
  if (error) throw error; // rendered by error.tsx

  const notes = (data ?? []) as unknown as NoteRow[];
  const href = (v: string) => {
    const sp = new URLSearchParams();
    sp.set("view", v);
    if (q) sp.set("q", q);
    if (tag) sp.set("tag", tag);
    return `/?${sp.toString()}`;
  };

  return (
    <main className="wrap">
      <div className="topbar">
        <h1>Cortex</h1>
        <span className="spacer" />
        <ExportButton token={session.access_token} />
        <form action="/auth/signout" method="post"><button>Sign out</button></form>
      </div>

      <QuickCapture token={session.access_token} />

      <nav className="views">
        {NOTE_VIEWS.map((v) => (
          <Link key={v} href={href(v)} className={v === view ? "on" : ""}>{VIEW_LABELS[v]}</Link>
        ))}
      </nav>

      <form className="search" action="/" method="get">
        <input type="hidden" name="view" value={view} />
        {tag && <input type="hidden" name="tag" value={tag} />}
        <input type="text" name="q" defaultValue={q} placeholder="Search notes…" aria-label="Search notes" />
        <button type="submit">Search</button>
        {(q || tag) && <Link className="btn" href={`/?view=${view}`}>Clear</Link>}
      </form>

      <NoteList initialNotes={notes} view={view} userId={user.id} token={session.access_token} />
    </main>
  );
}
