/**
 * Exact case-insensitive lookup pattern for PostgREST, for the find-or-create shape
 * TagService and MediaService run against a `lower(name)` / `lower(title)` unique index.
 *
 * History, because this bug keeps coming back wearing new hats:
 *
 * 1. A bare `.ilike(value)` makes `%` and `_` wildcards -- "D%" matched an existing
 *    "Dune" and silently attached new data to someone else's entity (issue log A3).
 * 2. Escaping `\ % _` for LIKE is STILL not enough over PostgREST, which maps `*` to
 *    `%` inside like/ilike operands before Postgres ever sees them -- so "M*A*S*H"
 *    became the pattern `M%A%S%H`, an unbounded wildcard scan.
 *
 * So the lookup no longer uses like/ilike at all: `imatch` (Postgres `~*`) with the
 * value regex-escaped and anchored is exact, case-insensitive, and has no PostgREST
 * rewriting applied to it. The client-side lower() comparison in the callers remains
 * the final authority either way.
 */
export function anchoredIRegex(value: string): string {
  return "^" + value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
}
