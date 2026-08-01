import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return (
    <main style={{ padding: 24 }}>
      <h1>Cortex</h1>
      <p>Signed in as {user.email}</p>
      <form action="/auth/signout" method="post"><button>Sign out</button></form>
    </main>
  );
}
