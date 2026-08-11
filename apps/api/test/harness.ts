// Sign-in harness for the e2e suites. Same pattern as app.e2e.test.ts's getToken,
// lifted out so notes/tags/export suites share it, and returning the user id too.
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createClient } from "@supabase/supabase-js";
import type { AiClient } from "@cortex/core";
import { AI_CLIENT } from "../src/ai-client.provider";
import { AppModule } from "../src/app.module";
import { CoreErrorFilter } from "../src/core-error.filter";

const url = process.env.SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const TEST_PASSWORD = "cortex-test-password-123";

export interface TestUser { id: string; token: string }

export async function makeUser(email: string): Promise<TestUser> {
  const normalized = email.toLowerCase();
  const { error: upsertErr } = await admin.from("allowed_emails").upsert({ email: normalized });
  if (upsertErr) throw upsertErr;
  const created = await admin.auth.admin.createUser({
    email: normalized, password: TEST_PASSWORD, email_confirm: true,
  });
  if (created.error && !created.error.message.includes("already been registered")) throw created.error;
  const client = createClient(url, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: normalized, password: TEST_PASSWORD });
  if (error) throw error;
  return { id: data.user!.id, token: data.session!.access_token };
}

export interface TestAppOverrides {
  /**
   * Replaces AppModule's AI_CLIENT provider before the app boots. Only search.e2e.test.ts
   * passes this (with @cortex/core's createFakeAi -- NO TEST MAY EVER CALL THE REAL GEMINI
   * API). Every other suite gets the untouched provider from ai-client.provider.ts, which is
   * safe to leave in place unoverridden: it never actually constructs a Gemini client or calls
   * parseApiEnv until something calls embed()/generateJson(), and none of those suites' routes
   * do.
   */
  ai?: AiClient;
}

/** Boots the real AppModule with the same global filter main.ts registers. */
export async function bootstrapTestApp(overrides: TestAppOverrides = {}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (overrides.ai) builder.overrideProvider(AI_CLIENT).useValue(overrides.ai);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new CoreErrorFilter());
  await app.init();
  return app;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
