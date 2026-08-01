import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Editor } from "./editor";
import type { TagRow } from "./tag-chips";

interface NoteTagJoin { deleted_at: string | null; tags: TagRow | null }

export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  // RLS scopes this to the caller, so another user's note returns zero rows and
  // renders the same 404 as a note that does not exist (spec §6).
  const { data: note } = await supabase.from("notes")
    .select("id, title, content, lifecycle")
    .eq("id", id).is("deleted_at", null).maybeSingle();
  if (!note) notFound();

  const { data: links } = await supabase.from("note_tags")
    .select("deleted_at, tags(id, name)")
    .eq("note_id", id).is("deleted_at", null);

  const initialTags = ((links ?? []) as unknown as NoteTagJoin[])
    .map((l) => l.tags)
    .filter((t): t is TagRow => t !== null);

  return (
    <main className="wrap">
      <div className="topbar">
        <Link className="back" href="/">← All notes</Link>
      </div>
      <Editor token={session.access_token} note={note} initialTags={initialTags} />
    </main>
  );
}
