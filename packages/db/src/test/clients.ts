import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

export const TEST_PASSWORD = "cortex-test-password-123";

/** Allow-lists the email, creates (or reuses) the user, returns a signed-in client. */
export async function makeUser(email: string): Promise<{ client: SupabaseClient; id: string }> {
  await admin.from("allowed_emails").upsert({ email });          // no-op until Task 6 migration exists
  const created = await admin.auth.admin.createUser({ email, password: TEST_PASSWORD, email_confirm: true });
  if (created.error && !created.error.message.includes("already been registered")) throw created.error;
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (signIn.error) throw signIn.error;
  return { client, id: signIn.data.user!.id };
}
