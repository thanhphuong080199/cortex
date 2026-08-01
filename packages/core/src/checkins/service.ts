import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateCheckinInput } from "@cortex/shared";
import { mapPostgrestError } from "../errors.js";

export interface Checkin {
  id: string; user_id: string;
  mood: number | null; energy: number | null; label: string | null;
  created_at: string; deleted_at: string | null;
}

// Check-ins are not notes (life-domains spec §2.3): they never touch the notes table,
// the inbox, or FTS. This service is deliberately two methods -- log it, or undo the
// mis-tap. There is no update: a wrong mood is deleted and re-tapped, which is faster
// than any edit affordance would be and keeps the timeseries honest.
export class CheckinService {
  constructor(private client: SupabaseClient, private userId: string) {}

  async create(input: CreateCheckinInput): Promise<Checkin> {
    // Explicit nulls rather than omitted keys: the row shape is then identical whether
    // the user tapped mood, energy, or both.
    const { data, error } = await this.client.from("checkins")
      .insert({
        user_id: this.userId,
        mood: input.mood ?? null,
        energy: input.energy ?? null,
        label: input.label ?? null,
      })
      .select().single();
    if (error) throw mapPostgrestError(error);
    return data as Checkin;
  }

  async softDelete(id: string): Promise<{ id: string }> {
    // `is deleted_at null` makes a repeat delete a not_found rather than a silent no-op,
    // and a foreign id is indistinguishable from a missing one (errors.ts / spec §6).
    const { data, error } = await this.client.from("checkins")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
      .select("id").single();
    if (error) throw mapPostgrestError(error);   // zero rows → PGRST116 → not_found
    return data as { id: string };
  }
}
