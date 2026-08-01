import { noteDomain } from "@cortex/shared";

export type NoteView = "inbox" | "active" | "archived" | "trash";
export type NoteDomainFilter = (typeof noteDomain.options)[number];

/** Narrows an untrusted `?domain=` param; anything unknown means "no domain filter". */
export function parseDomain(value: string | undefined): NoteDomainFilter | undefined {
  return (noteDomain.options as readonly string[]).includes(value ?? "")
    ? (value as NoteDomainFilter)
    : undefined;
}
export const NOTE_VIEWS: NoteView[] = ["inbox", "active", "archived", "trash"];

export const VIEW_LABELS: Record<NoteView, string> = {
  inbox: "Inbox", active: "Active", archived: "Archived", trash: "Trash",
};

/** Narrows an untrusted `?view=` search param; anything unknown falls back to inbox. */
export function parseView(value: string | undefined): NoteView {
  return (NOTE_VIEWS as string[]).includes(value ?? "") ? (value as NoteView) : "inbox";
}

/**
 * THE view predicate. The SSR query and the Realtime handler both go through this, so a
 * live-patched row can never disagree with what a reload would show.
 *
 * Four views over five lifecycle states: `active` deliberately covers both `active` and
 * `evergreen` -- both are live working notes.
 *
 * `domain` narrows, it never overrides: a trashed health note is still only in trash.
 * `note.domain` is optional in the type because Realtime hands back whatever the row
 * shape is, and an undomained note simply has null there.
 */
export function matchesView(
  note: { lifecycle: string; deleted_at: string | null; domain?: string | null },
  view: NoteView,
  domain?: string,
): boolean {
  if (domain && note.domain !== domain) return false;
  if (view === "trash") return note.deleted_at !== null;
  if (note.deleted_at !== null) return false;
  if (view === "active") return note.lifecycle === "active" || note.lifecycle === "evergreen";
  return note.lifecycle === view;
}
