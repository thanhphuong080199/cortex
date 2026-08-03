import "react-native-url-polyfill/auto";
import { createClient } from "@supabase/supabase-js";
import { secureStorageAdapter } from "./secure-storage";

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      // Keystore-backed, not AsyncStorage: the refresh token is long-lived and
      // AsyncStorage is included in Android Auto Backup (spec §7.2).
      storage: secureStorageAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);
