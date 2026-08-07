import { makeRedirectUri } from "expo-auth-session";
import * as QueryParams from "expo-auth-session/build/QueryParams";
import * as WebBrowser from "expo-web-browser";
import { getPowerSync } from "./powersync";
import { supabase } from "./supabase";
import { wipeLocalData } from "./wipe";

WebBrowser.maybeCompleteAuthSession();

const redirectTo = makeRedirectUri({ scheme: "cortex" });

export async function signInWithGoogle(): Promise<void> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  // The user closing the browser sheet themselves is a deliberate choice, not
  // a failure — return quietly so the caller can reset to an idle (not error) state.
  if (result.type === "cancel" || result.type === "dismiss") return;
  if (result.type !== "success") {
    throw new Error(`Sign-in did not complete (${result.type}).`);
  }

  const { params, errorCode } = QueryParams.getQueryParams(result.url);
  if (errorCode) throw new Error(errorCode);
  const { access_token, refresh_token } = params;
  if (!access_token || !refresh_token) {
    throw new Error("Sign-in did not return a session. Please try again.");
  }

  const { error: sessionError } = await supabase.auth.setSession({ access_token, refresh_token });
  if (sessionError) throw sessionError;
}

export async function signOut(): Promise<void> {
  // Wipe BEFORE the Supabase sign-out: disconnectAndClear needs the connector's token to
  // shut the stream down cleanly, and a wipe that fails must not leave the user
  // "signed out" with their whole corpus still on the device.
  //
  // `getPowerSync()` is null when the user signs out before the database finished opening —
  // `wipeLocalData` handles that, and the key still has to go either way.
  await wipeLocalData(getPowerSync());
  await supabase.auth.signOut();
}
