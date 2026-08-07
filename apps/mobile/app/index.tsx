import type { Session } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Button, Text, View } from "react-native";
import { signInWithGoogle, signOut } from "@/lib/auth";
import { createInFlightGuard } from "@/lib/in-flight";
import { supabase } from "@/lib/supabase";
import { CheckinWidget } from "@/screens/checkin-widget";
import { ExportButton } from "@/screens/export-button";
import { MediaLogForm } from "@/screens/media-log-form";
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

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16 }}>
      {session ? (
        // Everything on this screen is handed to NoteList, which scrolls it. As siblings of the
        // list in a plain View, these fixed-height widgets left it `flex: 1` of nothing -- it
        // rendered every row at zero height, with no scroll anywhere to reach them, and the
        // screen looked exactly as though the user had no notes at all.
        <View style={{ flex: 1, alignSelf: "stretch" }}>
          <NoteList
            header={
              <>
                <QuickCapture />
                <CheckinWidget />
                <MediaLogForm />
              </>
            }
            footer={
              <View style={{ alignItems: "center", gap: 8, padding: 16 }}>
                <ExportButton />
                <Text>Signed in as {session.user.email}</Text>
                <Button title="Sign out" onPress={() => void handleSignOut()} disabled={loading} />
                {error ? <Text style={{ color: "crimson" }}>{error}</Text> : null}
              </View>
            }
          />
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
