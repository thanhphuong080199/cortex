import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { ActivityIndicator, Button, Text, View } from "react-native";
import { signInWithGoogle, signOut } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { NoteList } from "@/screens/note-list";
import { QuickCapture } from "@/screens/quick-capture";

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleSignIn() {
    setLoading(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16 }}>
      {session ? (
        // Capture sits above the note list slot Task 19 fills.
        <View style={{ flex: 1, alignSelf: "stretch" }}>
          <QuickCapture />
          <NoteList />
          <View style={{ alignItems: "center", gap: 8, padding: 16 }}>
            <Text>Signed in as {session.user.email}</Text>
            <Button title="Sign out" onPress={() => void signOut()} />
          </View>
        </View>
      ) : (
        <>
          <Button title="Sign in with Google" onPress={() => void handleSignIn()} disabled={loading} />
          {loading ? <ActivityIndicator /> : null}
          {error ? <Text style={{ color: "crimson" }}>{error}</Text> : null}
        </>
      )}
    </View>
  );
}
