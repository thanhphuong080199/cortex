// Sign-in harness for the e2e suites. Same pattern as app.e2e.test.ts's getToken,
// lifted out so notes/tags/export suites share it, and returning the user id too.
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createClient } from "@supabase/supabase-js";
import { createFakeAi, type AiClient } from "@cortex/core";
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
   * Overrides AppModule's AI_CLIENT provider before the app boots. Pass @cortex/core's
   * createFakeAi (optionally scripted) from a suite that needs specific embed/generateJson
   * behaviour; otherwise omit it entirely.
   */
  ai?: AiClient;
}

/**
 * Boots the real AppModule with the same global filter main.ts registers.
 *
 * AI_CLIENT is ALWAYS overridden with a fake here -- unconditionally, not only when `overrides.ai`
 * is supplied -- so that "no harness-booted test can reach the real Gemini API" is enforced by
 * construction rather than by every future suite remembering to opt in. Before this, a suite that
 * called plain bootstrapTestApp() and then issued a POST /search would silently get the real,
 * lazily-constructed Gemini client (ai-client.provider.ts) and make a live, billable call with
 * whatever GEMINI_API_KEY happens to be in the environment -- nothing today does that, but
 * nothing prevented a future suite from doing it by accident either. Search.e2e.test.ts, which
 * cares about specific embed() output, still passes its own `ai` via `overrides.ai`.
 */
export async function bootstrapTestApp(overrides: TestAppOverrides = {}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  builder.overrideProvider(AI_CLIENT).useValue(overrides.ai ?? createFakeAi());
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new CoreErrorFilter());
  await app.init();
  return app;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
