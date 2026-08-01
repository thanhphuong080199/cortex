"use client";
import { useEffect } from "react";

// SSR read failures (a dropped Supabase connection, an expired session) land here
// instead of a blank page -- the user gets a retry, not a dead end (spec §6).
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);

  return (
    <main className="wrap">
      <h1>Something went wrong</h1>
      <p className="hint">Your notes are safe — this page just failed to load.</p>
      <button onClick={reset}>Try again</button>
    </main>
  );
}
