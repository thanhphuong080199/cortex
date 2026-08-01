// Filenames are slug + short id: the id suffix keeps two notes with the same title
// from colliding inside notes/ without having to track seen names.
export function noteFilename(note: { id: string; title: string | null; content: string }): string {
  const base = (note.title ?? note.content.split("\n")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "note"}-${note.id.slice(0, 8)}.md`;
}
