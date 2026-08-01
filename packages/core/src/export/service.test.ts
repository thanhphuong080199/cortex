import AdmZip from "adm-zip";
import { PassThrough } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
import { CheckinService } from "../checkins/service.js";
import { MediaService } from "../media/service.js";
import { NoteService } from "../notes/service.js";
import { TagService } from "../organize/service.js";
import { ExportService } from "./service.js";

async function collectZip(svc: ExportService): Promise<AdmZip> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  await svc.buildArchive(out);
  return new AdmZip(Buffer.concat(chunks));
}

describe("ExportService", () => {
  let zip: AdmZip;
  let mediaNoteId: string;
  beforeAll(async () => {
    // Unique per run, unlike the fixed-email fixtures elsewhere: these assertions cover
    // the user's ENTIRE export, so a reused account accumulates notes across runs and
    // turns "exactly one note file" into a false failure on the second run.
    const alice = await makeUser(`core-export-${crypto.randomUUID()}@test.local`);
    const client = createUserClient(alice.token);
    const notes = new NoteService(client, alice.id);
    const tags = new TagService(client, alice.id);
    const note = await notes.create({ content: "# Body\ncontent here", title: "Export: me?" });
    const tag = await tags.findOrCreate({ name: "exported" });
    await tags.attach(note.id, tag.id);
    const trashed = await notes.create({ content: "should not appear" });
    await notes.softDelete(trashed.id);

    // Life-domain rows (spec §2.3: all three tables are included in /export).
    const media = new MediaService(client, alice.id);
    const logged = await media.logMedia({ kind: "movie", title: "Arrival", rating: 5, impression: "wow" });
    mediaNoteId = logged.note.id;
    await new CheckinService(client, alice.id).create({ mood: 4, label: "good" });
    const deletedCheckin = await new CheckinService(client, alice.id).create({ mood: 1 });
    await new CheckinService(client, alice.id).softDelete(deletedCheckin.id);
    await client.from("flashcards")
      .insert({ user_id: alice.id, note_id: logged.note.id, front: "hola", back: "hello" });

    zip = await collectZip(new ExportService(client, alice.id));
  });

  it("contains manifest, README, and one note file per live note", () => {
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("manifest.json");
    expect(names).toContain("README.md");
    // The original note plus the media log note; the trashed one is excluded.
    expect(names.filter((n) => n.startsWith("notes/"))).toHaveLength(2);
  });

  it("note file has parseable YAML frontmatter with tags", () => {
    // Selected by content, not by position: there is more than one note file now.
    const text = zip.getEntries()
      .filter((e) => e.entryName.startsWith("notes/"))
      .map((e) => e.getData().toString("utf8"))
      .find((t) => t.includes("Export: me?"))!;
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fm).not.toBeNull();
    const meta = parseYaml(fm![1]!);
    expect(meta.title).toBe("Export: me?"); // the ': ' case hand-rolled YAML corrupts
    expect(meta.tags).toEqual(["exported"]);
    expect(text.endsWith("# Body\ncontent here")).toBe(true);
  });

  it("manifest lists notes, tags, note_tags", () => {
    const manifest = JSON.parse(zip.readAsText("manifest.json"));
    expect(manifest.notes).toHaveLength(2);
    expect(manifest.tags.length).toBeGreaterThanOrEqual(1);
    expect(manifest.note_tags).toHaveLength(1);
  });

  it("manifest carries the life-domain tables, live rows only", () => {
    const manifest = JSON.parse(zip.readAsText("manifest.json"));
    expect(manifest.media_items).toHaveLength(1);
    expect(manifest.media_items[0].title).toBe("Arrival");
    expect(manifest.checkins).toHaveLength(1);      // the soft-deleted one is excluded
    expect(manifest.checkins[0].mood).toBe(4);
    expect(manifest.flashcards).toHaveLength(1);
    expect(manifest.flashcards[0].front).toBe("hola");
  });

  it("a domained note's frontmatter carries its domain, and an undomained one does not", () => {
    const files = zip.getEntries()
      .filter((e) => e.entryName.startsWith("notes/"))
      .map((e) => e.getData().toString("utf8"));

    const mediaNote = files.find((t) => t.includes("Arrival"))!;
    const fm = parseYaml(mediaNote.match(/^---\n([\s\S]*?)\n---\n/)![1]!);
    expect(fm.domain).toBe("media");
    expect(fm.id).toBe(mediaNoteId);

    // Absent, not `domain: null` -- the frontmatter is meant to read cleanly in Obsidian.
    const plainNote = files.find((t) => t.includes("Export: me?"))!;
    expect(parseYaml(plainNote.match(/^---\n([\s\S]*?)\n---\n/)![1]!).domain).toBeUndefined();
  });
});
