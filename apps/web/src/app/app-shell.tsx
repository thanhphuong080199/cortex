"use client";
import { useState, type ReactNode } from "react";

/**
 * Owns the sidebar's open/closed state so it can be a slide-over drawer on narrow
 * screens and a permanent column on wide ones (CSS alone decides which, via
 * `.app-shell.sidebar-open` — see globals.css). Lives above both children because
 * `page.tsx` (the server component that renders them) has no state of its own.
 */
export function AppShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`app-shell${open ? " sidebar-open" : ""}`}>
      <button
        type="button"
        className="sidebar-toggle"
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
      >
        ☰
      </button>
      {/* Closes the drawer without a second control to find -- tapping anywhere outside it is
          the expected gesture, and it only exists in the DOM while open so it never eats a
          click on the wide-screen layout where the sidebar has no overlay. */}
      {open && <div className="sidebar-scrim" onClick={() => setOpen(false)} />}
      <aside className="sidebar">{sidebar}</aside>
      <main className="main">{children}</main>
    </div>
  );
}
