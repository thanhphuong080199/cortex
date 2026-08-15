import { usePowerSync } from "@powersync/react-native";
import { randomUUID } from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { captureNote } from "../lib/capture";
import { createInFlightGuard } from "../lib/in-flight";
import { offlineAnswer, type OfflineMatch } from "../lib/assistant/offline-answer";
import { streamAssistantTurn, StreamUnavailableError, type BoxEvent } from "../lib/assistant/stream";
import { supabase } from "../lib/supabase";

/**
 * One box. It replaces quick capture, and in Tasks 7 and 8 the check-in widget and the media
 * log form (spec §1).
 *
 * The order is the whole design: the local INSERT is the deliverable and everything after it is
 * a bonus, so the note is durable before any network exists. A failed local write is the ONLY
 * case where text can be lost, and the only one that keeps the box's contents.
 */
export function AssistantBox() {
  const db = usePowerSync();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [attached, setAttached] = useState<Extract<BoxEvent, { type: "attached" }> | null>(null);
  const [answer, setAnswer] = useState("");
  const [matches, setMatches] = useState<OfflineMatch[]>([]);
  const run = useRef(createInFlightGuard()).current;

  async function submit() {
    await run(async () => {
      setBusy(true);
      setSaveFailed(false);
      setStatus(null);
      setAttached(null);
      setAnswer("");
      setMatches([]);

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      try {
        const wrote = await captureNote(db, { content: text, domain: null }, id);
        if (!wrote) return;
      } catch {
        // The one genuine loss. Keep the text and say so -- same copy quick capture used.
        setSaveFailed(true);
        return;
      }
      // Cleared here, before any network. Web clears only after POST /notes resolves; this is
      // both faster and strictly safer.
      const asked = text;
      setText("");

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new StreamUnavailableError("not signed in");
        for await (const ev of streamAssistantTurn({
          noteId: id, content: asked, createdAt,
          token: session.access_token,
          apiUrl: process.env.EXPO_PUBLIC_API_URL!,
          fetchFn: expoFetch as unknown as typeof fetch,
        })) {
          if (ev.type === "attached") setAttached(ev);
          else if (ev.type === "token") setAnswer((a) => a + ev.text);
          else if (ev.type === "declined") setStatus("Đã lưu. Chưa trả lời được (đã chạm giới hạn chi tiêu).");
          else if (ev.type === "error") setStatus("Đã lưu. Chưa trả lời được.");
        }
      } catch {
        // Offline, a dead stream, a 502 -- all the same from here, and all better answered
        // from the local index than with an error message.
        const hits = await offlineAnswer(db, asked).catch(() => []);
        setMatches(hits);
        setStatus(
          hits.length > 0
            ? `Không có mạng — ${hits.length} ghi chú của bạn khớp với câu này.`
            : "Đã lưu.",
        );
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <View style={{ gap: 12, padding: 16 }}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Bạn đang nghĩ gì?"
        multiline
        accessibilityLabel="Bạn đang nghĩ gì?"
        // testID, not the label: it becomes the Android resource-id, which is unique and
        // stable. This screen has a second TextInput (the note-list search box) whose
        // contentDescription is close enough to collide with a text matcher.
        testID="box-input"
        style={{ minHeight: 96, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 }}
      />
      {saveFailed ? (
        <Text style={{ color: "crimson" }}>
          Không lưu được vào máy. Chữ của bạn vẫn còn đây — thử lại nhé.
        </Text>
      ) : null}
      <Pressable
        onPress={() => void submit()}
        accessibilityRole="button"
        disabled={busy}
        testID="box-send"
        style={{ padding: 14, borderRadius: 8, backgroundColor: "#222", alignItems: "center",
                 opacity: busy ? 0.6 : 1 }}
      >
        <Text style={{ color: "white" }}>Gửi</Text>
      </Pressable>

      {busy ? <ActivityIndicator /> : null}

      {attached ? (
        <Text testID="box-attached">
          {attached.domain ? `Đã xếp vào: ${attached.domain}` : "Chưa xếp vào nhóm nào"}
          {attached.tags.length > 0 ? ` — thẻ ${attached.tags.join(", ")}` : ""}
        </Text>
      ) : null}

      {answer ? <Text testID="box-answer">{answer}</Text> : null}

      {matches.map((m) => (
        <Text key={m.id} testID="box-offline-match">{m.snippet}</Text>
      ))}

      {status ? <Text testID="box-status">{status}</Text> : null}
    </View>
  );
}
