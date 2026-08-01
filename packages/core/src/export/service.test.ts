import AdmZip from "adm-zip";
import { PassThrough } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createUserClient } from "../supabase.js";
import { makeUser } from "../test/harness.js";
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
    zip = await collectZip(new ExportService(client, alice.id));
  });

  it("contains manifest, README, and one note file", () => {
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("manifest.json");
    expect(names).toContain("README.md");
    expect(names.filter((n) => n.startsWith("notes/"))).toHaveLength(1); // trashed excluded
  });

  it("note file has parseable YAML frontmatter with tags", () => {
    const entry = zip.getEntries().find((e) => e.entryName.startsWith("notes/"))!;
    const text = entry.getData().toString("utf8");
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fm).not.toBeNull();
    const meta = parseYaml(fm![1]!);
    expect(meta.title).toBe("Export: me?"); // the ': ' case hand-rolled YAML corrupts
    expect(meta.tags).toEqual(["exported"]);
    expect(text.endsWith("# Body\ncontent here")).toBe(true);
  });

  it("manifest lists notes, tags, note_tags", () => {
    const manifest = JSON.parse(zip.readAsText("manifest.json"));
    expect(manifest.notes).toHaveLength(1);
    expect(manifest.tags.length).toBeGreaterThanOrEqual(1);
    expect(manifest.note_tags).toHaveLength(1);
  });
});
