import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

export const TEST_PASSWORD = "cortex-test-password-123";

/** Allow-lists the email, creates (or reuses) the user, returns a signed-in client. */
export async function makeUser(email: string): Promise<{ client: SupabaseClient; id: string }> {
  // allowed_emails has `check (email = lower(email))` (00008_invite_gate.sql) -- lowercase
  // here so a mixed-case fixture email fails loudly at this upsert (a clear constraint
  // violation) rather than silently at createUser/signIn with a confusing "not allowed"
  // error that gives no hint the email casing was the actual problem.
  const normalizedEmail = email.toLowerCase();
  const { error: upsertErr } = await admin.from("allowed_emails").upsert({ email: normalizedEmail });
  if (upsertErr) throw upsertErr;
  const created = await admin.auth.admin.createUser({ email, password: TEST_PASSWORD, email_confirm: true });
  if (created.error && !created.error.message.includes("already been registered")) throw created.error;
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (signIn.error) throw signIn.error;
  return { client, id: signIn.data.user!.id };
}
