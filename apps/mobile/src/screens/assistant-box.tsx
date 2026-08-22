import { usePowerSync } from "@powersync/react-native";
import { randomUUID } from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import * as WebBrowser from "expo-web-browser";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { captureNote } from "../lib/capture";
import { logCheckinWithId, undoCheckin } from "../lib/checkins";
import { createInFlightGuard } from "../lib/in-flight";
import { offlineAnswer, type OfflineMatch } from "../lib/assistant/offline-answer";
import { streamAssistantTurn, StreamUnavailableError, type BoxEvent } from "../lib/assistant/stream";
import { supabase } from "../lib/supabase";
import type { LiveTurn } from "../lib/transcript";

/**
 * One box. It replaces quick capture, and in Tasks 7 and 8 the check-in widget and the media
 * log form (spec §1).
 *
 * The order is the whole design: the local INSERT is the deliverable and everything after it is
 * a bonus, so the note is durable before any network exists. A failed local write is the ONLY
 * case where text can be lost, and the only one that keeps the box's contents.
 *
 * Since Task 12 this component runs a turn but does not render its answer -- the transcript in
 * chat.tsx does, from `chat_messages` rows. `onLive` hands the screen the in-flight turn so it
 * can render it before the server's rows have replicated: called with the fresh turn right after
 * the local note write succeeds, updated on every `token` event, and cleared with `null` in the
 * same `finally` that already governs every other exit path. `buildTranscript`'s dedup (keyed on
 * the note's own id) covers the window between that clear and the replicated rows landing --
 * clearing anywhere earlier than the turn's own natural end would just be a second, redundant
 * place for the same bug to hide.
 */
export function AssistantBox({ onLive }: { onLive: (live: LiveTurn | null) => void }) {
  const db = usePowerSync();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [attached, setAttached] = useState<Extract<BoxEvent, { type: "attached" }> | null>(null);
  const [mood, setMood] = useState<{ checkinId: string; mood: number } | null>(null);
  const [web, setWeb] = useState<Extract<BoxEvent, { type: "web" }> | null>(null);
  const [matches, setMatches] = useState<OfflineMatch[]>([]);
  const run = useRef(createInFlightGuard()).current;

  async function submit() {
    await run(async () => {
      setBusy(true);
      setSaveFailed(false);
      setStatus(null);
      setAttached(null);
      setMood(null);
      setWeb(null);
      setMatches([]);

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      // One try/finally around the whole turn, not two: `busy` must clear on EVERY exit path,
      // including the local-write branch's `if (!wrote) return` and its `catch`. A second,
      // separate try around only the network call left those two exits with no `finally` at
      // all, so an empty-box tap -- or a genuine write failure -- left Send permanently
      // disabled. Same shape the deleted quick-capture.tsx used for its own `if (!wrote) return`.
      // `onLive(null)` lives in this same finally for the same reason: one clear, on every exit
      // path, is the only version of this that cannot leave a stale turn on screen.
      try {
        let wrote: boolean;
        try {
          wrote = await captureNote(db, { content: text, domain: null }, id);
        } catch {
          // The one genuine loss. Keep the text and say so -- same copy quick capture used.
          setSaveFailed(true);
          return;
        }
        if (!wrote) return;

        // Cleared here, before any network. Web clears only after POST /notes resolves; this
        // is both faster and strictly safer.
        const asked = text;
        setText("");
        onLive({ noteId: id, text: asked, answer: "", createdAt });
        let answer = "";

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
            else if (ev.type === "web") setWeb(ev);
            else if (ev.type === "token") {
              answer += ev.text;
              onLive({ noteId: id, text: asked, answer, createdAt });
            }
            else if (ev.type === "mood") {
              // Mirrored locally under the server's id so undo has a row to delete before
              // replication catches up. See lib/checkins.ts.
              await logCheckinWithId(db, ev.checkinId, ev.mood).catch(() => {});
              setMood({ checkinId: ev.checkinId, mood: ev.mood });
            }
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
        }
      } finally {
        setBusy(false);
        onLive(null);
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
        // stable, unlike an accessibilityLabel a text matcher could collide with.
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
          {attached.mediaTitle
            ? `Đã ghi vào thư viện: ${attached.mediaTitle}`
            : attached.domain
              ? `Đã xếp vào: ${attached.domain}`
              : "Chưa xếp vào nhóm nào"}
          {attached.tags.length > 0 ? ` — thẻ ${attached.tags.join(", ")}` : ""}
        </Text>
      ) : null}

      {mood ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text testID="box-mood">{`Đã ghi tâm trạng ${mood.mood}/5`}</Text>
          <Pressable
            testID="box-mood-undo"
            accessibilityRole="button"
            onPress={() => {
              const id = mood.checkinId;
              setMood(null);
              void undoCheckin(db, id);
            }}
          >
            <Text style={{ textDecorationLine: "underline" }}>Hoàn tác</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Note citations have no mobile UI yet -- this screen has never rendered the
          "citations" BoxEvent. The web block below stands alone, but stays visually distinct
          from any future note-citation block per life-domains spec §6.2: the two are never
          merged into one list. */}
      {web && web.sources.length > 0 ? (
        <View style={{ gap: 4 }} testID="box-web-sources">
          <Text style={{ fontWeight: "600" }}>Từ web</Text>
          {web.sources.map((s) => (
            <Text
              key={s.url}
              testID="box-web-source"
              style={{ color: "#1a73e8", textDecorationLine: "underline" }}
              onPress={() => void WebBrowser.openBrowserAsync(s.url)}
            >
              {s.title}
            </Text>
          ))}
        </View>
      ) : null}

      {/* Search Suggestions, reconstructed rather than the injected `entryPoint` HTML web
          renders -- this app has no react-native-webview to render HTML+CSS in. See C3 spec
          §7.2: a knowing, recorded trade-off, not an oversight, with a condition to revisit it. */}
      {web && web.queries.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} testID="box-web-chips">
          {web.queries.map((q) => (
            <Text
              key={q}
              testID="box-web-chip"
              style={{
                paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16,
                backgroundColor: "#eee", overflow: "hidden",
              }}
              onPress={() => void WebBrowser.openBrowserAsync(
                `https://www.google.com/search?q=${encodeURIComponent(q)}`,
              )}
            >
              {q}
            </Text>
          ))}
        </View>
      ) : null}

      {matches.map((m) => (
        <Text key={m.id} testID="box-offline-match">{m.snippet}</Text>
      ))}

      {status ? <Text testID="box-status">{status}</Text> : null}
    </View>
  );
}
