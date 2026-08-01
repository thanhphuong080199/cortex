import { INestApplication } from "@nestjs/common";
import AdmZip from "adm-zip";
import request from "supertest";
import type { Response as SuperAgentResponse } from "superagent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { auth, bootstrapTestApp, makeUser, type TestUser } from "./harness";

let app: INestApplication;
let alice: TestUser;

beforeAll(async () => {
  app = await bootstrapTestApp();
  alice = await makeUser("api-export-alice@test.local");
  const note = await request(app.getHttpServer()).post("/notes")
    .set(auth(alice.token)).send({ content: "# Exported\nbody", title: "Export: via http" });
  const tag = await request(app.getHttpServer()).post("/tags")
    .set(auth(alice.token)).send({ name: "http-export" });
  await request(app.getHttpServer()).post(`/notes/${note.body.id}/tags`)
    .set(auth(alice.token)).send({ tagId: tag.body.id });
});
afterAll(async () => { await app.close(); });

// supertest parses bodies as text by default, which corrupts binary zip payloads.
// The response is a readable stream at runtime, but superagent's Response type does
// not declare that, hence the cast.
const asBuffer = (res: SuperAgentResponse, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  const stream = res as unknown as NodeJS.ReadableStream;
  stream.on("data", (c: Buffer) => chunks.push(c));
  stream.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("GET /export", () => {
  it("returns a zip whose frontmatter parses", async () => {
    const res = await request(app.getHttpServer()).get("/export")
      .set(auth(alice.token))
      .buffer(true).parse(asBuffer)
      .expect(200)
      .expect("content-type", /application\/zip/);
    const zip = new AdmZip(res.body as Buffer);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("manifest.json");
    expect(names).toContain("README.md");
    const noteEntry = zip.getEntries().find((e) => e.entryName.startsWith("notes/"))!;
    const fm = noteEntry.getData().toString("utf8").match(/^---\n([\s\S]*?)\n---\n/);
    expect(fm).not.toBeNull();
    expect(() => parseYaml(fm![1]!)).not.toThrow();
  });

  it("sets a dated attachment filename", async () => {
    const res = await request(app.getHttpServer()).get("/export")
      .set(auth(alice.token)).buffer(true).parse(asBuffer).expect(200);
    expect(res.headers["content-disposition"])
      .toMatch(/attachment; filename="cortex-export-\d{4}-\d{2}-\d{2}\.zip"/);
  });

  it("without token is 401", async () => {
    await request(app.getHttpServer()).get("/export").expect(401);
  });
});
