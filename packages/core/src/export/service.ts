import archiver from "archiver";
import type { SupabaseClient } from "@supabase/supabase-js";
import { stringify as yamlStringify } from "yaml";
import { mapPostgrestError } from "../errors.js";
import { noteFilename } from "./slug.js";

export class ExportService {
  constructor(private client: SupabaseClient, private userId: string) {}

  async buildArchive(out: NodeJS.WritableStream): Promise<void> {
    // RLS bounds every query to the caller; soft-deleted notes excluded (spec §4.3).
    const [notes, tags, noteTags] = await Promise.all([
      this.client.from("notes").select("id, title, content, lifecycle, created_at, updated_at")
        .is("deleted_at", null).order("created_at"),
      this.client.from("tags").select("id, name, color").is("deleted_at", null),
      this.client.from("note_tags").select("note_id, tag_id").is("deleted_at", null),
    ]);
    for (const r of [notes, tags, noteTags]) if (r.error) throw mapPostgrestError(r.error);

    const tagName = new Map(tags.data!.map((t) => [t.id, t.name]));
    const tagsByNote = new Map<string, string[]>();
    for (const nt of noteTags.data!) {
      const list = tagsByNote.get(nt.note_id) ?? [];
      const name = tagName.get(nt.tag_id);
      if (name) list.push(name);
      tagsByNote.set(nt.note_id, list);
    }

    const archive = archiver("zip");
    const done = new Promise<void>((resolve, reject) => {
      out.on("finish", resolve).on("close", resolve).on("error", reject);
      archive.on("error", reject);
    });
    archive.pipe(out);

    archive.append(JSON.stringify({ exported_at: new Date().toISOString(),
      notes: notes.data, tags: tags.data, note_tags: noteTags.data }, null, 2),
      { name: "manifest.json" });
    archive.append(
      "# Cortex export\n\nMarkdown notes with YAML frontmatter (drop into Obsidian/Logseq)." +
      " `manifest.json` is the full structured dump.\n",
      { name: "README.md" });

    for (const note of notes.data!) {
      // yaml package, not string concatenation: titles containing ': ' or quotes
      // silently corrupt hand-rolled YAML (spec §4.3).
      const frontmatter = yamlStringify({
        id: note.id, title: note.title, tags: tagsByNote.get(note.id) ?? [],
        lifecycle: note.lifecycle, created_at: note.created_at, updated_at: note.updated_at,
      }).trimEnd();
      archive.append(`---\n${frontmatter}\n---\n${note.content}`,
        { name: `notes/${noteFilename(note)}` });
    }
    await archive.finalize();
    await done;
  }
}
