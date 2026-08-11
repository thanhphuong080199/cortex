import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { noteDomain } from "@cortex/shared";
import {
  NOTE_VIEWS, VIEW_LABELS, applyNoteFilters, noteSelect, parseNoteFilters,
} from "@/lib/note-views";
import { CheckinWidget } from "./checkin-widget";
import { ExportButton } from "./export-button";
import { MediaLogPanel } from "./media-log-panel";
import { NoteList, type NoteRow } from "./note-list";
import { QuickCapture } from "./quick-capture";

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

  return (
    <main className="wrap">
      <div className="topbar">
        <h1>Cortex</h1>
        <span className="spacer" />
        <Link className="btn" href="/search">Search</Link>
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

      <NoteList initialNotes={notes} filters={filters}
                userId={user.id} token={session.access_token} />
    </main>
  );
}
