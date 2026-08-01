import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateNoteInput, UpdateNoteInput } from "@cortex/shared";
import { mapPostgrestError } from "../errors.js";

export interface Note {
  id: string; user_id: string; title: string | null; content: string;
  lifecycle: string; source_type: string; pinned: boolean;
  created_at: string; updated_at: string; deleted_at: string | null;
}

// Services take a client + userId and know nothing about HTTP (spec §2.2).
// RLS enforces isolation; the explicit .eq("user_id") is belt-and-suspenders
// and makes zero-row results (→ not_found) deterministic in tests.
export class NoteService {
  constructor(private client: SupabaseClient, private userId: string) {}

  async create(input: CreateNoteInput): Promise<Note> {
    const { data, error } = await this.client.from("notes")
      .insert({ user_id: this.userId, content: input.content, title: input.title ?? null })
      .select().single();
    if (error) throw mapPostgrestError(error);
    return data as Note;
  }

  async update(id: string, input: UpdateNoteInput): Promise<Note> {
    // Patch on `!== undefined`, not truthiness: `title: null` means "clear the title"
    // and `content: ""` is a legitimate empty note.
    const patch: Record<string, unknown> = {};
    if (input.content !== undefined) patch.content = input.content;
    if (input.title !== undefined) patch.title = input.title;
    if (input.lifecycle !== undefined) patch.lifecycle = input.lifecycle;
    const { data, error } = await this.client.from("notes")
      .update(patch)
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
      .select().single();
    if (error) throw mapPostgrestError(error); // zero rows → PGRST116 → not_found
    return data as Note;
  }

  async softDelete(id: string): Promise<{ id: string; deleted_at: string }> {
    const { data, error } = await this.client.from("notes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
      .select("id, deleted_at").single();
    if (error) throw mapPostgrestError(error);
    return data as { id: string; deleted_at: string };
  }

  async restore(id: string): Promise<Note> {
    const { data, error } = await this.client.from("notes")
      .update({ deleted_at: null })
      .eq("id", id).eq("user_id", this.userId).not("deleted_at", "is", null)
      .select().single();
    if (error) throw mapPostgrestError(error);
    return data as Note;
  }

  async purge(id: string): Promise<{ id: string }> {
    // Hard delete allowed ONLY from trash. delete() returns the deleted rows via
    // .select(); zero rows (live note / foreign / missing) → PGRST116 → not_found.
    const { data, error } = await this.client.from("notes")
      .delete()
      .eq("id", id).eq("user_id", this.userId).not("deleted_at", "is", null)
      .select("id").single();
    if (error) throw mapPostgrestError(error);
    return data as { id: string };
  }
}
