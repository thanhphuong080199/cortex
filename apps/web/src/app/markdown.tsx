"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * THE one place an assistant reply becomes DOM -- the live streaming bubble and a turn replayed
 * from chat_messages both come through here, so a reply cannot render two ways.
 *
 * Until 2026-08-18 nothing rendered markdown at all: globals.css set `white-space: pre-wrap` on
 * the answer paragraph and the model's `**bold**` reached the user as two literal asterisks.
 *
 * Raw HTML is NOT enabled and must not be. This string is model output, and model output is
 * untrusted -- adding `rehype-raw` here would turn a grounded answer quoting a web page into an
 * injection vector. react-markdown's default is to drop HTML, which is the behaviour we want,
 * so the safety is the absence of a plugin rather than the presence of a sanitiser.
 *
 * Partial markdown is expected. Mid-stream the string is routinely "**Cá h", which renders as
 * those literal characters until the closing pair arrives and then snaps to bold. Accepted:
 * the alternative is buffering the answer until the stream ends, which trades a brief flicker
 * for the loss of streaming.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // The model chose these URLs, out of grounding results nobody vetted. Same hardening
          // provenance.tsx already applies to web sources, for the same reason.
          a: ({ href, children: kids }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">{kids}</a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
