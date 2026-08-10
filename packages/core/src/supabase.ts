import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Per-request client carrying the caller's JWT. RLS is the enforcement --
// no service-role key on this path (spec §4.1).
export function createUserClient(jwt: string): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
}

/**
 * BYPASSES RLS. The only legitimate callers are the enrichment pipeline and the search RPC,
 * both of which read note_chunks / note_enrichment -- tables with RLS enabled and NO policies,
 * invisible to `authenticated` by design.
 *
 * Every user-facing path keeps createUserClient above, where RLS is the enforcement and the
 * server is not trusted with a service key (spec §8.2). When this client is used on behalf of
 * a user, the user id MUST come from the verified JWT and never from a request body -- with
 * RLS out of the picture, that parameter is the only thing separating two users' corpora.
 */
export function createServiceClient(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(process.env.SUPABASE_URL!, key, { auth: { persistSession: false } });
}
