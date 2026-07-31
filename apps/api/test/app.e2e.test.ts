import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createClient } from "@supabase/supabase-js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";

const url = process.env.SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function getToken(email: string): Promise<{ token: string; userId: string }> {
  const password = "cortex-test-password-123";
  await admin.from("allowed_emails").upsert({ email });
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error && !created.error.message.includes("already been registered")) throw created.error;
  const client = createClient(url, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { token: data.session!.access_token, userId: data.user!.id };
}

describe("api skeleton", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it("GET /health is public", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /me without token → 401", async () => {
    const res = await request(app.getHttpServer()).get("/me");
    expect(res.status).toBe(401);
  });

  it("GET /me with garbage token → 401", async () => {
    const res = await request(app.getHttpServer()).get("/me").set("Authorization", "Bearer nonsense");
    expect(res.status).toBe(401);
  });

  it("GET /me with a well-formed but wrong-signature token → 401", async () => {
    const { token } = await getToken("api-e2e-tampered@test.local");
    const [header, payload] = token.split(".");
    const tamperedSignature = Buffer.from("not-the-real-signature").toString("base64url");
    const tampered = `${header}.${payload}.${tamperedSignature}`;
    const res = await request(app.getHttpServer()).get("/me").set("Authorization", `Bearer ${tampered}`);
    expect(res.status).toBe(401);
  });

  it("GET /me with a real Supabase JWT → id + email", async () => {
    const { token, userId } = await getToken("api-e2e@test.local");
    const res = await request(app.getHttpServer()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: userId, email: "api-e2e@test.local" });
  });
});
