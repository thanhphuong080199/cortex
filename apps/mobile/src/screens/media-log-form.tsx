import { mediaKind, mediaStatus, type MediaKind, type MediaStatus } from "@cortex/shared";
import { usePowerSync, useQuery } from "@powersync/react-native";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { logMedia } from "../lib/media-log";

// Both DERIVED, never parallel lists. A hand-written copy of the kinds drifted from
// `mediaKind` during planning ("film"/"series"/"album" are not valid kinds) and the DB check
// constraint would have rejected every log at runtime. The plan then wrote the statuses out by
// hand anyway, directly under that warning -- `mediaStatus` now exists so it cannot.
const KINDS = mediaKind.options;
const STATUSES = mediaStatus.options;

/**
 * Offline media logging (spec §5.3). The write itself lives in `../lib/media-log`, where a test
 * can execute it and run the server's own `domainMetaSchemas.media` over what it builds.
 */
export function MediaLogForm() {
  const db = usePowerSync();
  const [kind, setKind] = useState<MediaKind>(KINDS[0]);
  const [title, setTitle] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [status, setStatus] = useState<MediaStatus>("finished");
  const [impression, setImpression] = useState("");
  const [saving, setSaving] = useState(false);

  // Local autocomplete over the replica -- bounded, ordered and kind-scoped, the same shape
  // B7 imposed on the web version.
  const { data: suggestions = [] } = useQuery<{ title: string }>(
    "SELECT title FROM media_items WHERE kind = ? AND deleted_at IS NULL ORDER BY title LIMIT 200",
    [kind],
  );

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const wrote = await logMedia(db, { kind, title, status, rating, impression });
      if (!wrote) return;
      setTitle("");
      setImpression("");
      setRating(null);
    } finally {
      setSaving(false);
    }
  }

  const matches = suggestions
    .filter((s) => s.title.toLowerCase().startsWith(title.toLowerCase()))
    .slice(0, 5);

  return (
    <View style={{ padding: 16, gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {KINDS.map((k) => (
          <Pressable
            key={k}
            onPress={() => setKind(k)}
            accessibilityRole="button"
            accessibilityState={{ selected: kind === k }}
            style={{
              paddingVertical: 6,
              paddingHorizontal: 12,
              borderRadius: 999,
              backgroundColor: kind === k ? "#222" : "#eee",
            }}
          >
            <Text style={{ color: kind === k ? "white" : "#222" }}>{k}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="Title"
        accessibilityLabel="Media title"
        style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
      />
      {title.length > 1 && matches.length > 0 ? (
        <View>
          {matches.map((s) => (
            <Pressable key={s.title} onPress={() => setTitle(s.title)} accessibilityRole="button">
              <Text style={{ paddingVertical: 6, opacity: 0.8 }}>{s.title}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {/* Radiogroup, not toggle buttons: filled-but-unselected stars contradict aria-pressed,
          and a mis-tap on the current star clears the rating (E7). */}
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: 10 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable
            key={n}
            onPress={() => setRating(n)}
            accessibilityRole="radio"
            accessibilityState={{ checked: rating === n }}
            accessibilityLabel={`${n} of 5 stars`}
            style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ fontSize: 22, opacity: rating !== null && n <= rating ? 1 : 0.3 }}>
              ★
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {STATUSES.map((s) => (
          <Pressable
            key={s}
            onPress={() => setStatus(s)}
            accessibilityRole="button"
            accessibilityState={{ selected: status === s }}
            style={{
              paddingVertical: 6,
              paddingHorizontal: 12,
              borderRadius: 999,
              backgroundColor: status === s ? "#222" : "#eee",
            }}
          >
            <Text style={{ color: status === s ? "white" : "#222" }}>{s}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={impression}
        onChangeText={setImpression}
        placeholder="Impression (optional)"
        multiline
        accessibilityLabel="Impression"
        style={{
          minHeight: 72,
          borderWidth: 1,
          borderColor: "#ccc",
          borderRadius: 8,
          padding: 10,
        }}
      />
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
        <Text style={{ color: "white" }}>Log it</Text>
      </Pressable>
    </View>
  );
}
