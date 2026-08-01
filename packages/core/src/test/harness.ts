// Self-contained sign-in harness (same pattern as packages/db/src/test/clients.ts,
// plus the access token, because core services take a JWT).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

export const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const TEST_PASSWORD = "cortex-test-password-123";

export interface TestUser { client: SupabaseClient; id: string; token: string }

export async function makeUser(email: string): Promise<TestUser> {
  // allowed_emails has `check (email = lower(email))` (00008_invite_gate.sql) -- lowercase
  // here so a mixed-case fixture email fails loudly at this upsert rather than confusingly
  // at createUser with a "not allowed" error.
  const normalized = email.toLowerCase();
  const { error: upsertErr } = await admin.from("allowed_emails").upsert({ email: normalized });
  if (upsertErr) throw upsertErr;
  const created = await admin.auth.admin.createUser({
    email: normalized, password: TEST_PASSWORD, email_confirm: true,
  });
  if (created.error && !created.error.message.includes("already been registered")) throw created.error;
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email: normalized, password: TEST_PASSWORD });
  if (signIn.error) throw signIn.error;
  return { client, id: signIn.data.user!.id, token: signIn.data.session!.access_token };
}
