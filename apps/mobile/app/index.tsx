import type { Session } from "@supabase/supabase-js";
import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Button, Pressable, Text, View } from "react-native";
import { signInWithGoogle, signOut } from "@/lib/auth";
import { createInFlightGuard } from "@/lib/in-flight";
import { supabase } from "@/lib/supabase";
import { Chat } from "@/screens/chat";

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const run = useRef(createInFlightGuard()).current;

  async function handleSignIn() {
    await run(async () => {
      setLoading(true);
      setError(null);
      try {
        await signInWithGoogle();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
      } finally {
        setLoading(false);
      }
    });
  }

  /**
   * Sign-out reports its failures, because Task 13 made `signOut` wipe local data BEFORE
   * calling supabase, and re-raise if the wipe did not finish. Fired-and-forgotten, a failed
   * wipe left the user signed in with no explanation and their notes still on the device --
   * the one outcome the wipe exists to prevent, presented as a button that did nothing.
   */
  async function handleSignOut() {
    await run(async () => {
      setLoading(true);
      setError(null);
      try {
        await signOut();
      } catch (err) {
        setError(
          err instanceof Error
            ? `Could not finish signing out: ${err.message}`
            : "Could not finish signing out. This device may still hold your notes.",
        );
      } finally {
        setLoading(false);
      }
    });
  }

  if (session) {
    // Sign-out lives in the header now -- the only chrome left, matching web's `⋮`. `error`
    // still renders below the chat: `signOut` wipes local data BEFORE calling Supabase and
    // re-raises if the wipe did not finish. Fired-and-forgotten, a failed wipe leaves the user
    // signed in with their notes still on the device -- the exact outcome the wipe exists to
    // prevent, presented as a button that did nothing.
    return (
      <>
        <Stack.Screen
          options={{
            headerTitle: "Cortex",
            headerRight: () => (
              <Pressable
                onPress={() => void handleSignOut()}
                disabled={loading}
                accessibilityRole="button"
                testID="sign-out"
                style={{ paddingHorizontal: 12, opacity: loading ? 0.5 : 1 }}
              >
                <Text>Đăng xuất</Text>
              </Pressable>
            ),
          }}
        />
        <Chat />
        {error ? <Text style={{ color: "crimson", padding: 12 }}>{error}</Text> : null}
      </>
    );
  }

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16 }}>
      <Button title="Sign in with Google" onPress={() => void handleSignIn()} disabled={loading} />
      {loading ? <ActivityIndicator /> : null}
      {error ? <Text style={{ color: "crimson" }}>{error}</Text> : null}
    </View>
  );
}
