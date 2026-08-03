// The view/domain narrowing itself now lives in @cortex/shared (phase 1b spec §3): the SSR
// query, the Realtime refetch and mobile all consume one description. Issue-log E5 was
// exactly the two web call sites drifting apart. Only presentation stays here.
//
// @cortex/shared, not @cortex/core: note-list.tsx is a "use client" component, and core's
// barrel reaches `archiver` with no `sideEffects: false` to stop a bundler following it.
// Core re-exports the same names for server-side callers.
export {
  NOTE_VIEWS,
  applyNoteFilters,
  matchesFilters,
  noteSelect,
  parseNoteFilters,
  requiresRefetch,
  type NoteFilters,
  type NoteView,
} from "@cortex/shared";

import type { NoteView } from "@cortex/shared";

export const VIEW_LABELS: Record<NoteView, string> = {
  inbox: "Inbox", active: "Active", archived: "Archived", trash: "Trash",
};
