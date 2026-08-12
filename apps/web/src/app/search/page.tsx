import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SearchClient } from "./search-client";

export default async function SearchPage() {
  const supabase = await createClient();
  // Same pattern as notes/[id]/page.tsx: getUser() authenticates against the auth server,
  // getSession() supplies the access token the write/read API needs.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  return (
    <main className="wrap">
      <div className="topbar">
        <Link className="back" href="/">← All notes</Link>
      </div>
      <h1>Search</h1>
      <SearchClient token={session.access_token} />
    </main>
  );
}
