/**
 * The fallback when a client sends no time zone or sends one Intl does not recognise.
 *
 * Not UTC, deliberately. Cortex's users write in Vietnamese, and UTC would push every note
 * written after 5pm local onto the following calendar day -- which is precisely the window in
 * which people write "mai". A fallback that is right for the actual corpus beats one that is
 * neutral.
 */
export const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";

/**
 * Narrows an untrusted time-zone string. Anything Intl cannot use becomes the default.
 *
 * The `try` is the whole function. `timeZone` comes off an HTTP body and goes into
 * `Intl.DateTimeFormat`, which throws `RangeError` on an unknown zone -- so an unvalidated
 * value turns one bad client into a dead turn. The asymmetry decides the behaviour: a wrong
 * zone costs a day of accuracy, a throw costs the user their answer.
 */
export function resolveTimeZone(candidate: string | undefined): string {
  if (!candidate) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * `dd-mm-yyyy` in the given zone, or null when the input is not a date.
 *
 * Null rather than a guess: citations persisted before this shipped carry no date at all, and
 * a date rendered from garbage is worse than no date -- the model treats whatever it is given
 * as fact, and the entire purpose of this field is to be the anchor it reasons from.
 *
 * `en-GB` produces `12/08/2026` (day first) in every runtime; the slashes are swapped rather
 * than the parts reassembled by hand, because `formatToParts` and locale-specific ordering are
 * two ways to get this subtly wrong.
 */
export function formatNoteDate(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, day: "2-digit", month: "2-digit", year: "numeric",
  }).format(d).replace(/\//g, "-");
}

/**
 * Today, with its weekday, in Vietnamese: "Chủ Nhật, 16-08-2026".
 *
 * The weekday is load-bearing, not ornament: "thứ 3 tới" and "cuối tuần này" cannot be resolved
 * against a bare date, and both are ordinary in this corpus. Vietnamese because the prompt it
 * goes into is read by a model that is instructed to answer in the user's language, and a
 * date rendered in English inside an otherwise Vietnamese prompt is a nudge toward English
 * output -- LANGUAGE_RULE exists because that nudge is real.
 */
export function formatToday(now: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat("vi-VN", { timeZone, weekday: "long" }).format(now);
  const capitalised = weekday.replace(/(^|\s)(\p{Ll})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase());
  return `${capitalised}, ${formatNoteDate(now.toISOString(), timeZone)}`;
}
