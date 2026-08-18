import Link from "next/link";
import { noteDomain } from "@cortex/shared";
import { NOTE_VIEWS, VIEW_LABELS, type NoteFilters } from "@/lib/note-views";
import { CheckinWidget } from "./checkin-widget";
import { ExportButton } from "./export-button";
import { MediaLogPanel } from "./media-log-panel";
import { NoteList, type NoteRow } from "./note-list";

/**
 * Everything that isn't the chat itself: mood check-in, media logging, the note browser
 * and its filters, search, export, sign-out. All of it is an accelerator over what the
 * chat box already does by talking to the assistant -- this panel exists for the times a
 * tap is faster than a sentence, or the user wants to browse/manage past captures rather
 * than converse. AppShell hides it off-canvas on narrow screens.
 */
export function Sidebar({ token, userId, notes, filters, href, domainHref }: {
  token: string;
  userId: string;
  notes: NoteRow[];
  filters: NoteFilters;
  href: (view: string) => string;
  domainHref: (domain: string) => string;
}) {
  const { view, q, tag, domain, saved } = filters;

  return (
    <>
      <div className="topbar">
        <h1>Cortex</h1>
        <span className="spacer" />
        <Link className="btn" href="/search">Search</Link>
        <ExportButton token={token} />
      </div>

      {/* Above capture on purpose: a check-in must be reachable without scrolling past a
          textarea, which is the friction that kills mood logging (spec §3). */}
      <CheckinWidget token={token} />

      <MediaLogPanel token={token} />

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
        {saved && <input type="hidden" name="saved" value="1" />}
        <input type="text" name="q" defaultValue={q} placeholder="Search notes…" aria-label="Search notes" />
        <button type="submit">Search</button>
        {(q || tag || domain) && <Link className="btn" href={`/?view=${view}`}>Clear</Link>}
      </form>

      <NoteList initialNotes={notes} filters={filters} userId={userId} token={token} />

      <form className="sidebar-signout" action="/auth/signout" method="post">
        <button>Sign out</button>
      </form>
    </>
  );
}
