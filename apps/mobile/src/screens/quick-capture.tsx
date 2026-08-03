import { noteDomain, type NoteDomain } from "@cortex/shared";
import { usePowerSync } from "@powersync/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { captureNote } from "../lib/capture";

/**
 * Capture is one local INSERT and nothing else (spec §5.2). There is no "pending" indicator
 * because PowerSync's upload queue IS the pending state, so this works identically in
 * airplane mode.
 *
 * The write itself lives in `../lib/capture` rather than here. Anything importing a React
 * Native component dies under the suite's `environment: "node"` with a Rollup Flow parse
 * error, so logic left in this file is logic that cannot be tested at all -- and the
 * statement is where the consequences are.
 */
export function QuickCapture() {
  const db = usePowerSync();
  const [content, setContent] = useState("");
  const [domain, setDomain] = useState<NoteDomain | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  async function save() {
    // Guard against the double-tap, not just the empty note: two INSERTs are two notes, and
    // the second is invisible until it has synced.
    if (saving) return;
    setSaving(true);
    setError(false);
    try {
      const wrote = await captureNote(db, { content, domain });
      if (!wrote) return;
      setContent("");
      setDomain(null);
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1500);
    } catch {
      // The local write failing is the one case where the note is genuinely gone. Keep the
      // text in the box so the user still has it, and say so.
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ gap: 12, padding: 16 }}>
      <TextInput
        value={content}
        onChangeText={setContent}
        placeholder="Capture a thought"
        multiline
        accessibilityLabel="Note content"
        style={{ minHeight: 96, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 }}
      />
      <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
        {noteDomain.options.map((d) => (
          <Pressable
            key={d}
            onPress={() => setDomain(domain === d ? null : d)}
            accessibilityRole="button"
            accessibilityState={{ selected: domain === d }}
            style={{
              paddingVertical: 8,
              paddingHorizontal: 14,
              borderRadius: 999,
              backgroundColor: domain === d ? "#222" : "#eee",
            }}
          >
            <Text style={{ color: domain === d ? "white" : "#222" }}>{d}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {error ? (
        <Text style={{ color: "crimson" }}>
          Could not save to this device. Your text is still here — try again.
        </Text>
      ) : null}
      <Pressable
        onPress={() => {
          void save();
        }}
        accessibilityRole="button"
        disabled={saving}
        style={{
          padding: 14,
          borderRadius: 8,
          backgroundColor: "#222",
          alignItems: "center",
          opacity: saving ? 0.6 : 1,
        }}
      >
        <Text style={{ color: "white" }}>{saved ? "Saved ✓" : "Save"}</Text>
      </Pressable>
    </View>
  );
}
