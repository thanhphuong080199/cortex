/**
 * The one timestamp expression every local write uses.
 *
 * SQLite's `datetime('now')` returns `2026-08-03 10:00:00` — space-separated, second
 * precision, no zone — and three separate things break on it:
 *
 *   - Sorting. Rows replication delivers carry ISO with a `T`, and `ORDER BY` on a TEXT column
 *     is a byte comparison in which a space (0x20) sorts below `T` (0x54). Within one day every
 *     locally written row sorts beneath every synced one whatever its real time.
 *   - The conflict base. `syncOp.base_updated_at` is `z.iso.datetime()`, which rejects both the
 *     space form and a numeric offset. An editor that stamps `updated_at` the wrong way poisons
 *     the base the NEXT editing session reads out of that same column, and the upload is
 *     rejected server-side rather than merely mis-sorted.
 *   - Round-tripping. `Date.parse` treats the space form as local time, so anything computing
 *     from it drifts by the device's offset.
 *
 * `%f` is seconds with milliseconds (`05.123`), giving `2026-08-03T10:00:00.123Z`.
 *
 * It lives here rather than being repeated per statement for the same reason `NoteFilters` does
 * (issue-log E5): a format that has to agree across files, maintained by hand in each, is a
 * format that eventually disagrees — and this one disagrees silently.
 */
export const NOW_ISO = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
