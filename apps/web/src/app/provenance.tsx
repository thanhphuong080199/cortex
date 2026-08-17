"use client";
import type { AnyCitation } from "@cortex/shared";

/**
 * The notes/web split, for BOTH the turn that is streaming right now and every turn read back
 * out of chat_messages. One component on purpose: stage C4 §3.1 requires a turn to look the
 * same after a reload as it did while it streamed, and two renderers for one concept is how
 * that stops being true without anyone noticing.
 *
 * The two blocks are NEVER merged into one list -- life-domains spec §6.2 requires the visible
 * split between what came from the user's own notes and what came from the open internet.
 */
/**
 * What to call a cited note. A note captured through the chat box has `title = null` -- which
 * is most of them -- and rendering the placeholder gave five identical "Untitled" rows as
 * provenance (observed 2026-08-16). Same fallback order note-list.tsx:16's `preview()` uses for
 * the sidebar, so a note is named the same way wherever it appears. Truncated because a snippet
 * is up to 240 characters (`left(n.content_text, 240)`, 00026) and this is a list item.
 */
const label = (c: { title: string | null; snippet: string }) => {
  const text = c.title?.trim() || c.snippet.split("\n")[0]?.trim() || "";
  if (text === "") return "Untitled";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

export function Provenance(
  { citations, entryPoint }: { citations: AnyCitation[]; entryPoint?: string },
) {
  const notes = citations.filter((c) => c.type === "note");
  const web = citations.filter((c) => c.type === "web");

  return (
    <>
      {notes.length > 0 && (
        <section className="provenance">
          <h3>Từ notes của bạn</h3>
          <ul className="citations">
            {notes.map((c) => <li key={c.noteId}>{label(c)}</li>)}
          </ul>
        </section>
      )}

      {web.length > 0 && (
        <section className="provenance web">
          <h3>Từ web</h3>
          <ul className="citations">
            {web.map((s) => (
              // rel="noopener noreferrer": these are URLs the model chose, not ones we vetted.
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>
              </li>
            ))}
          </ul>

          {entryPoint && (
            // Google's own markup, rendered because Google's terms require the returned Search
            // Suggestions entry point to be displayed when grounding is used (life-domains §6.2).
            // It is HTML+CSS produced by Google for exactly this, which is why it is injected
            // rather than rebuilt. The source is the Gemini API response relayed by our own API,
            // not user input and not a third-party page. Only the LIVE turn passes it: it is not
            // persisted on chat_messages, so a reloaded turn shows sources without the chips.
            <div className="search-suggestions" dangerouslySetInnerHTML={{ __html: entryPoint }} />
          )}
        </section>
      )}
    </>
  );
}
