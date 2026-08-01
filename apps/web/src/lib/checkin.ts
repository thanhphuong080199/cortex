import type { CreateCheckinInput } from "@cortex/shared";

/**
 * Turns widget state into a request payload, or null when there is nothing to log.
 *
 * Null rather than an exception: a stray keystroke in the label field must not fire a
 * request the API would only answer with a 400. Keys are omitted rather than set to
 * null/undefined because createCheckinInput rejects explicit nulls.
 */
export function buildCheckinPayload(
  raw: { mood?: number; energy?: number; label?: string },
): CreateCheckinInput | null {
  if (raw.mood === undefined && raw.energy === undefined) return null;
  const payload: CreateCheckinInput = {};
  if (raw.mood !== undefined) payload.mood = raw.mood;
  if (raw.energy !== undefined) payload.energy = raw.energy;
  const label = raw.label?.trim();
  if (label) payload.label = label;
  return payload;
}
