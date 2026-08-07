import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import { IS_E2E_BUILD } from "@/lib/e2e";
import { supabase } from "@/lib/supabase";

/**
 * Installs a Supabase session handed over a deep link, so a Maestro flow can reach the signed-in
 * app without driving Google's consent screen:
 *
 *   cortex://e2e-session?access_token=…&refresh_token=…
 *
 * INERT IN ANY REAL BUILD. `IS_E2E_BUILD` is a build-time constant (see lib/e2e.ts), so in a
 * bundle built without EXPO_PUBLIC_E2E=1 the effect below is dead code and this route renders a
 * refusal. The route file still ships, which is fine: a route that does nothing is not a
 * vulnerability, and deleting it conditionally is not something expo-router's filesystem
 * routing can express.
 *
 * WHY A DEEP LINK RATHER THAN BAKING TOKENS INTO THE BUILD
 *
 * A Supabase access token lives an hour by default. The APK is built 20-40 minutes before the
 * flows run (op-sqlite compiles SQLCipher and FTS5 from source), and the mobile workflow caches
 * that APK across runs when only JS changed -- so a token compiled into the bundle would be
 * expired, or from an entirely different seeded user, by the time a flow used it. Minting the
 * token at test time and passing it in is the only version of this that survives the cache.
 */
export default function E2ESession() {
  const params = useLocalSearchParams<{ access_token?: string; refresh_token?: string }>();
  const [state, setState] = useState<"working" | "ready" | "failed">("working");
  const [detail, setDetail] = useState<string>("");

  useEffect(() => {
    if (!IS_E2E_BUILD) return;

    const access_token = params.access_token;
    const refresh_token = params.refresh_token;
    if (!access_token || !refresh_token) {
      setState("failed");
      setDetail("missing access_token or refresh_token");
      return;
    }

    void (async () => {
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error) {
        setState("failed");
        setDetail(error.message);
        return;
      }
      // The marker the flows wait on. Asserting this rather than the home screen separates "the
      // session was installed" from "the home screen rendered", which are different failures --
      // and the second one is a real bug class here (a list of zero-height rows looked exactly
      // like a corpus that never synced, and cost an entire investigation).
      setState("ready");
      // `replace`, not `push`: leaving this route on the stack means a back press returns to it
      // and re-installs the session mid-flow.
      router.replace("/");
    })();
  }, [params.access_token, params.refresh_token]);

  if (!IS_E2E_BUILD) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text>This route is disabled in this build.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 }}>
      <Text>
        {state === "working"
          ? "E2E session installing"
          : state === "ready"
            ? "E2E session ready"
            : "E2E session failed"}
      </Text>
      {detail ? <Text style={{ opacity: 0.7 }}>{detail}</Text> : null}
    </View>
  );
}
