/**
 * `%`, `_` and `\` are LIKE metacharacters. Unescaped, a tag named "a_c" would match an
 * existing "abc", and a media title of "50% Off" would match anything at all -- so a
 * find-or-create built on `ilike` would return the WRONG row and silently attach new
 * data to someone else's entity.
 *
 * Shared by TagService and MediaService, which run the same find-or-create shape against
 * a `lower(name)` / `lower(title)` unique index.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
