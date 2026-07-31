"use client";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  async function signIn() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${location.origin}/auth/callback` },
    });
  }
  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <button onClick={signIn}>Sign in with Google</button>
    </main>
  );
}
