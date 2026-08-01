"use client";
import { useId, useState } from "react";
import { api } from "@/lib/api";
import { buildCheckinPayload } from "@/lib/checkin";

// 1..5. The valence word goes into the accessible name: the emoji is the only visual
// carrier of meaning and aria-label suppresses it, so "Mood 2 of 5" alone would leave a
// screen-reader user picking blind.
const MOODS = [
  { face: "😞", word: "very bad" },
  { face: "😕", word: "bad" },
  { face: "😐", word: "neutral" },
  { face: "🙂", word: "good" },
  { face: "😄", word: "very good" },
];

/**
 * Two taps maximum, and one is the common case (spec §3): tapping a face logs the mood
 * immediately -- no confirm step, no blank page. Energy and a one-word label live behind
 * a "more" toggle so they never slow the default gesture down.
 *
 * The safety net is undo, not a confirmation dialog: a mis-tap is cheap to erase and
 * asking first would double the cost of every correct tap.
 */
export function CheckinWidget({ token }: { token: string }) {
  const [lastId, setLastId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [energy, setEnergy] = useState<number | undefined>();
  const [label, setLabel] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const energyLabelId = useId();

  function toggleMore() {
    // Collapsing discards the hidden state: a face tapped after "less" must log ONLY the
    // mood, not an energy/label the user believes they dismissed and can no longer see.
    if (expanded) {
      setEnergy(undefined);
      setLabel("");
    }
    setExpanded(!expanded);
  }

  async function log(mood?: number) {
    if (busy) return;
    const payload = buildCheckinPayload({ mood, energy, label });
    if (!payload) return;                     // nothing picked -- not an error, just a no-op
    setBusy(true);
    setError(false);
    try {
      const created = await api.createCheckin(token, payload);
      setLastId(created.id);
      setEnergy(undefined);
      setLabel("");
      setExpanded(false);
    } catch {
      // Input state is kept so tapping again just works -- but the PREVIOUS check-in's
      // undo affordance must go: "logged ✓ undo" next to "couldn't log" reads as undoing
      // the failure, and would actually delete the earlier good check-in.
      setLastId(null);
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!lastId || busy) return;
    const id = lastId;
    setLastId(null);                          // optimistic: undo must feel instant
    setError(false);
    setBusy(true);
    try {
      await api.deleteCheckin(token, id);
    } catch {
      setLastId(id);                          // put the affordance back so it can be retried
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="checkin" aria-label="Mood check-in">
      <div className="moods" role="group" aria-label="Mood">
        {MOODS.map(({ face, word }, i) => (
          <button key={face} type="button" disabled={busy}
                  aria-label={`Mood ${i + 1} of 5 — ${word}`} onClick={() => void log(i + 1)}>
            {face}
          </button>
        ))}
        <button type="button" className="more" aria-expanded={expanded} onClick={toggleMore}>
          {expanded ? "less" : "more"}
        </button>
      </div>

      {expanded && (
        <div className="checkin-more">
          <span id={energyLabelId}>Energy</span>
          <div role="group" aria-labelledby={energyLabelId}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" aria-pressed={energy === n}
                      onClick={() => setEnergy(energy === n ? undefined : n)}>
                {n}
              </button>
            ))}
          </div>
          <input type="text" value={label} maxLength={100} placeholder="one word…"
                 aria-label="Check-in label" onChange={(e) => setLabel(e.target.value)} />
          {/* Energy alone is a valid check-in, so this can log without any mood. */}
          <button type="button" disabled={busy || energy === undefined} onClick={() => void log()}>
            Log
          </button>
        </div>
      )}

      {lastId && (
        <span className="hint">
          {/* role="status" wraps only the text: some screen readers re-announce an entire
              live region on update, and the undo button doesn't belong in that. */}
          <span role="status">logged ✓</span>{" "}
          <button type="button" disabled={busy} onClick={() => void undo()}>undo</button>
        </span>
      )}
      {error && <span role="alert" className="error">couldn&apos;t log — tap again</span>}
    </div>
  );
}
