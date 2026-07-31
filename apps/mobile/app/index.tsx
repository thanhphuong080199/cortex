import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Button, Text, View } from "react-native";
import { signInWithGoogle, signOut } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16 }}>
      {session ? (
        <>
          <Text>Signed in as {session.user.email}</Text>
          <Button title="Sign out" onPress={() => void signOut()} />
        </>
      ) : (
        <Button title="Sign in with Google" onPress={() => void signInWithGoogle()} />
      )}
    </View>
  );
}
