// The filter description itself lives in @cortex/shared, not here: its consumers are a
// "use client" React component and a React Native app, and this package's barrel reaches
// `archiver` (export/service.ts) with no `sideEffects: false` to stop a bundler following
// it. See packages/shared/src/notes/filters.ts.
//
// Re-exported explicitly rather than `export *` so core's public surface stays a list
// someone can read, and so adding an export to shared cannot silently widen it.
export {
  NOTE_VIEWS,
  applyNoteFilters,
  matchesFilters,
  noteFiltersToSql,
  noteSelect,
  parseNoteFilters,
  requiresRefetch,
  toSqlitePlaceholders,
  type NoteFilters,
  type NoteView,
} from "@cortex/shared";
