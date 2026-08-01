"use client";
import { useState } from "react";
import { MediaLogForm } from "./media-log-form";

/** Holds the open/closed state so page.tsx can stay a server component. */
export function MediaLogPanel({ token }: { token: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="media-panel">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Cancel" : "Log media"}
      </button>
      {open && <MediaLogForm token={token} onDone={() => setOpen(false)} />}
    </div>
  );
}
