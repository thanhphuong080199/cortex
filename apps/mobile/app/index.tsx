import type { Session } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RADIUS, SPACE, TYPE } from "@/fonts";
import { signInWithGoogle, signOut } from "@/lib/auth";
import { createInFlightGuard } from "@/lib/in-flight";
import { supabase } from "@/lib/supabase";
import { Chat } from "@/screens/chat";
import { themeFor } from "@/theme";

export default function Home() {
  const theme = themeFor(useColorScheme());
  const insets = useSafeAreaInsets();
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
    // Sign-out lives in the chat's own header now (components/chat-header.tsx), which is why the
    // handler is passed down rather than mounted here. `error` still renders below the chat:
    // `signOut` wipes local data BEFORE calling Supabase and re-raises if the wipe did not
    // finish. Fired-and-forgotten, a failed wipe leaves the user signed in with their notes
    // still on the device -- the exact outcome the wipe exists to prevent, presented as a
    // button that did nothing.
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <Chat onSignOut={() => void handleSignOut()} signingOut={loading} />
        {error ? (
          <Text
            style={{
              ...TYPE.small, color: theme.danger,
              paddingHorizontal: SPACE.lg, paddingBottom: SPACE.md,
            }}
          >
            {error}
          </Text>
        ) : null}
      </View>
    );
  }

  /**
   * The door.
   *
   * Was a bare `<Button title="Sign in with Google">` centred on the system's white background
   * -- the first screen a new user ever sees, and the only one with no design applied at all.
   *
   * Bottom-weighted rather than centred: the wordmark and the promise sit above the fold, the
   * control sits where a thumb already is. The line under the wordmark is the entire pitch, and
   * it is the honest one -- this app's whole argument is that it keeps a private copy on the
   * device, so that is what the door says.
   *
   * "Sign in with Google" stays in English on an otherwise Vietnamese screen. It is Google's
   * own attribution string, it is what the consent screen the button opens says, and
   * .maestro/01-first-login-and-sync.yaml asserts it verbatim as the signed-out marker.
   */
  return (
    <View
      style={{
        flex: 1, backgroundColor: theme.bg,
        paddingHorizontal: SPACE.xl,
        paddingTop: insets.top + SPACE.xxl,
        paddingBottom: insets.bottom + SPACE.xxl,
      }}
    >
      {/* `flex-end`, not `center`. Centred, the wordmark sat at 45% of the screen with a void
          between it and the button at the bottom, and the composition read as two unrelated
          halves. Settling it just above the control makes one bottom-weighted group with the
          empty space all in one place, which is where empty space is worth having. */}
      <View style={{ flex: 1, justifyContent: "flex-end", gap: SPACE.md, paddingBottom: SPACE.xxl }}>
        <Text style={{ ...TYPE.wordmark, fontSize: 34, color: theme.text }}>Cortex</Text>
        <Text style={{ ...TYPE.ask, color: theme.muted }}>
          Một ô để viết. Phần còn lại tự lo.
        </Text>
      </View>

      <View style={{ gap: SPACE.md }}>
        <Pressable
          onPress={() => void handleSignIn()}
          disabled={loading}
          accessibilityRole="button"
          style={({ pressed }) => ({
            flexDirection: "row", alignItems: "center", justifyContent: "center",
            gap: SPACE.sm,
            paddingVertical: SPACE.lg - 1,
            borderRadius: RADIUS.pill, backgroundColor: theme.accent,
            opacity: loading ? 0.5 : pressed ? 0.85 : 1,
          })}
        >
          {loading ? <ActivityIndicator size="small" color={theme.accentInk} /> : null}
          <Text style={{ ...TYPE.bodyMedium, color: theme.accentInk }}>Sign in with Google</Text>
        </Pressable>

        <Text style={{ ...TYPE.small, color: theme.muted, textAlign: "center" }}>
          Ghi chú của bạn nằm trên máy, đã mã hoá, và mở bằng vân tay.
        </Text>

        {error ? (
          <Text style={{ ...TYPE.small, color: theme.danger, textAlign: "center" }}>{error}</Text>
        ) : null}
      </View>
    </View>
  );
}
