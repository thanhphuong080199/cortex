import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Per-request client carrying the caller's JWT. RLS is the enforcement --
// no service-role key on this path (spec §4.1).
export function createUserClient(jwt: string): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
}
