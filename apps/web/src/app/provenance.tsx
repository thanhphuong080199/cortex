"use client";
import { type AnyCitation } from "@cortex/shared";

/**
 * The web half of a turn's provenance, for BOTH the turn that is streaming right now and every
 * turn read back out of chat_messages. One component on purpose: stage C4 §3.1 requires a turn
 * to look the same after a reload as it did while it streamed.
 *
 * There WAS a "Từ notes của bạn" block here listing every matched note. It was removed on
 * 2026-08-18: a matched note is usually the user's own chat message echoed back, so the box
 * repeated what they had just typed, one bubble higher up the same thread.
 *
 * What remains is not a design choice and must not be removed for looking sparse. Google's
 * grounding terms require the returned Search Suggestions entry point to be displayed whenever
 * grounding was used (life-domains spec §6.2); the source list is the other half of that
 * obligation. The `citations` prop still carries note entries -- they feed the PROMPT server-side
 * through renderCitations, which is a separate path from this component and is unaffected.
 */

export function Provenance(
  { citations, entryPoint }: { citations: AnyCitation[]; entryPoint?: string },
) {
  const web = citations.filter((c) => c.type === "web");

  return (
    <>
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
