import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { noteDomain } from "@cortex/shared";
import { NOTE_VIEWS, VIEW_LABELS, parseDomain, parseView } from "@/lib/note-views";
import { CheckinWidget } from "./checkin-widget";
import { ExportButton } from "./export-button";
import { MediaLogPanel } from "./media-log-panel";
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
  const domain = parseDomain(one(params.domain));

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
  // The `config` is load-bearing, not cosmetic. With it, PostgREST emits
  //   to_tsvector('english', content_text) @@ websearch_to_tsquery('english', q)
  // which matches notes_fts_idx (verified: Bitmap Index Scan, custom AND generic plans).
  // Drop it and PostgREST emits the bare `content_text @@ ...` form, which resolves to
  // the default-config operator, matches no index, and silently sequential-scans.
  if (q) query = query.textSearch("content_text", q, { type: "websearch", config: "english" });
  if (tag) query = query.eq("note_tags.tag_id", tag).is("note_tags.deleted_at", null);
  // Backed by notes_user_domain_idx. matchesView applies the same narrowing to Realtime
  // rows, so a live-patched note can never disagree with what a reload would show.
  if (domain) query = query.eq("domain", domain);

  const { data, error } = await query;
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

  return (
    <main className="wrap">
      <div className="topbar">
        <h1>Cortex</h1>
        <span className="spacer" />
        <ExportButton token={session.access_token} />
        <form action="/auth/signout" method="post"><button>Sign out</button></form>
      </div>

      {/* Above capture on purpose: a check-in must be reachable without scrolling past a
          textarea, which is the friction that kills mood logging (spec §3). */}
      <CheckinWidget token={session.access_token} />

      <QuickCapture token={session.access_token} />

      <MediaLogPanel token={session.access_token} />

      <nav className="views">
        {NOTE_VIEWS.map((v) => (
          <Link key={v} href={href(v)} className={v === view ? "on" : ""}>{VIEW_LABELS[v]}</Link>
        ))}
      </nav>

      <nav className="domains" aria-label="Filter by domain">
        {noteDomain.options.map((d) => (
          <Link key={d} href={domainHref(d)} className={d === domain ? "on" : ""}
                aria-current={d === domain ? "true" : undefined}>
            {d}
          </Link>
        ))}
      </nav>

      <form className="search" action="/" method="get">
        <input type="hidden" name="view" value={view} />
        {tag && <input type="hidden" name="tag" value={tag} />}
        {domain && <input type="hidden" name="domain" value={domain} />}
        <input type="text" name="q" defaultValue={q} placeholder="Search notes…" aria-label="Search notes" />
        <button type="submit">Search</button>
        {(q || tag || domain) && <Link className="btn" href={`/?view=${view}`}>Clear</Link>}
      </form>

      <NoteList initialNotes={notes} view={view} domain={domain}
                q={q || undefined} tag={tag || undefined}
                userId={user.id} token={session.access_token} />
    </main>
  );
}
