import { usePowerSync } from "@powersync/react-native";
import { randomUUID } from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import * as WebBrowser from "expo-web-browser";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, useColorScheme, View } from "react-native";

import { captureNote } from "../lib/capture";
import { logCheckinWithId, undoCheckin } from "../lib/checkins";
import { createInFlightGuard } from "../lib/in-flight";
import { offlineAnswer, type OfflineMatch } from "../lib/assistant/offline-answer";
import { declineStatement, saveStatement } from "../lib/assistant/save";
import { streamAssistantTurn, StreamUnavailableError, type BoxEvent } from "../lib/assistant/stream";
import { supabase } from "../lib/supabase";
import { themeFor } from "../theme";
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
 * the local note write succeeds, and updated on every `token` event.
 *
 * The `finally` that governs every exit path does NOT clear `live` to `null` (final whole-branch
 * review finding -- it used to, and that was the bug). It marks the turn `settled: true` instead,
 * keeping the last known text/answer. `chat.tsx` owns the actual retirement, because it's the
 * only place with access to the replicated rows needed to retire on evidence rather than on a
 * timer that has no idea whether the answer actually made it to the table yet.
 */
export function AssistantBox({ onLive }: { onLive: (live: LiveTurn | null) => void }) {
  const theme = themeFor(useColorScheme());
  const db = usePowerSync();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [attached, setAttached] = useState<Extract<BoxEvent, { type: "attached" }> | null>(null);
  const [mood, setMood] = useState<{ checkinId: string; mood: number } | null>(null);
  // NOT cleared by the `finally` that settles the turn: like web, the offer must survive the
  // hand-off into the transcript -- it disappears only when the user acts on it, or when the next
  // submit() starts (the reset block below).
  const [offer, setOffer] = useState<{ statement: string; sourceUrl?: string } | null>(null);
  const [web, setWeb] = useState<Extract<BoxEvent, { type: "web" }> | null>(null);
  const [matches, setMatches] = useState<OfflineMatch[]>([]);
  // The composer's measured height, in dp. 22 is one line at fontSize 15; the cap keeps a pasted
  // page from swallowing the thread. Held here rather than left to `multiline`'s own growth
  // because a TextInput with `flex: 1` inside a row does not auto-size on Android.
  const [inputHeight, setInputHeight] = useState(22);
  const run = useRef(createInFlightGuard()).current;

  async function submit() {
    await run(async () => {
      setBusy(true);
      setSaveFailed(false);
      setStatus(null);
      setAttached(null);
      setMood(null);
      setOffer(null);
      setWeb(null);
      setMatches([]);

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      // Hoisted above the try so `finally` can still see the turn's last known state -- it needs
      // that to mark the turn settled rather than clear it (see the class doc). Stays `null`
      // for the two exit paths that never got as far as calling `onLive` at all (the write
      // failing, or an empty box), so `finally` has nothing to settle for those.
      let turn: LiveTurn | null = null;
      // One try/finally around the whole turn, not two: `busy` must clear on EVERY exit path,
      // including the local-write branch's `if (!wrote) return` and its `catch`. A second,
      // separate try around only the network call left those two exits with no `finally` at
      // all, so an empty-box tap -- or a genuine write failure -- left Send permanently
      // disabled. Same shape the deleted quick-capture.tsx used for its own `if (!wrote) return`.
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
        let answer = "";
        turn = { noteId: id, text: asked, answer, createdAt };
        onLive(turn);

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
              turn = { noteId: id, text: asked, answer, createdAt };
              onLive(turn);
            }
            else if (ev.type === "mood") {
              // Mirrored locally under the server's id so undo has a row to delete before
              // replication catches up. See lib/checkins.ts.
              await logCheckinWithId(db, ev.checkinId, ev.mood).catch(() => {});
              setMood({ checkinId: ev.checkinId, mood: ev.mood });
            }
            else if (ev.type === "offer") {
              setOffer({
                statement: ev.statement,
                ...(ev.sourceUrl !== undefined ? { sourceUrl: ev.sourceUrl } : {}),
              });
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
        // NOT onLive(null). The turn may still be waiting on chat_messages to replicate --
        // clearing here regardless would blank a fully-written answer the instant the stream
        // ends, before its row has necessarily landed. `settled: true` tells chat.tsx it may now
        // start looking for that evidence; chat.tsx (which owns `rows`) decides when retiring is
        // actually safe. See transcript.ts's `LiveTurn.settled` doc and `liveHasReplicated`.
        if (turn) onLive({ ...turn, settled: true });
      }
    });
  }

  return (
    <View style={{ gap: 12, padding: 12 }}>
      {/* One rounded block with the send control inside it, matching web's .chat-composer. The
          old shape was a 96px-tall bordered box with a full-width dark button under it -- three
          hardcoded colours (#ccc, #222, "crimson") that ignored `themeFor` entirely, so the
          whole composer stayed light-mode grey on a dark screen. */}
      <View
        style={{
          flexDirection: "row", alignItems: "flex-end", gap: 8,
          paddingVertical: 6, paddingLeft: 14, paddingRight: 6,
          borderWidth: 1, borderColor: theme.line, borderRadius: 24,
          backgroundColor: theme.panel,
        }}
      >
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Bạn đang nghĩ gì?"
          placeholderTextColor={theme.muted}
          multiline
          accessibilityLabel="Bạn đang nghĩ gì?"
          // testID, not the label: it becomes the Android resource-id, which is unique and
          // stable, unlike an accessibilityLabel a text matcher could collide with. Both this
          // and box-send below are keyed on by .maestro flows -- renaming either breaks the
          // suite while every unit test stays green.
          testID="box-input"
          // Grows with the text, capped. `height` is driven by the measured content rather than
          // a minHeight, so an empty box is one line instead of the three the old 96px forced.
          onContentSizeChange={(e) =>
            setInputHeight(Math.min(Math.max(e.nativeEvent.contentSize.height, 22), 140))}
          style={{
            flex: 1, minWidth: 0, height: inputHeight,
            color: theme.text, fontSize: 15, padding: 0, textAlignVertical: "center",
          }}
        />
        <Pressable
          onPress={() => void submit()}
          accessibilityRole="button"
          accessibilityLabel="Gửi"
          disabled={busy}
          testID="box-send"
          style={{
            width: 34, height: 34, borderRadius: 17,
            alignItems: "center", justifyContent: "center",
            backgroundColor: theme.accent, opacity: busy ? 0.4 : 1,
          }}
        >
          {busy
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={{ color: "#fff", fontSize: 16, lineHeight: 18 }}>↑</Text>}
        </Pressable>
      </View>
      {saveFailed ? (
        <Text style={{ color: theme.danger }}>
          Không lưu được vào máy. Chữ của bạn vẫn còn đây — thử lại nhé.
        </Text>
      ) : null}

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

      {offer ? (
        // One line, two buttons, easy to ignore -- same rule web's .offer follows: an offer that
        // interrupts is a nag. Worded differently from chat.tsx's manual save box, because both
        // can be on screen at once and mean different things (S1.5 §4).
        <View testID="offer" style={{ gap: 8, padding: 12, borderRadius: 8,
                                      borderWidth: 1, borderColor: theme.line }}>
          <Text style={{ color: theme.text }}>{offer.statement}</Text>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <Pressable testID="offer-accept" accessibilityRole="button" onPress={() => {
              const o = offer;
              setOffer(null);
              void (async () => {
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) return;
                await saveStatement({
                  apiUrl: process.env.EXPO_PUBLIC_API_URL!,
                  token: session.access_token,
                  statement: o.statement,
                  ...(o.sourceUrl !== undefined ? { sourceUrl: o.sourceUrl } : {}),
                });
              })();
            }}>
              <Text style={{ color: theme.accent }}>Lưu</Text>
            </Pressable>
            <Pressable testID="offer-decline" accessibilityRole="button" onPress={() => {
              const o = offer;
              // Cleared FIRST, before any await: "declining costs nothing" is a claim about
              // latency too, and the box must be gone the instant it is tapped.
              setOffer(null);
              void (async () => {
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) return;
                await declineStatement({
                  apiUrl: process.env.EXPO_PUBLIC_API_URL!,
                  token: session.access_token, statement: o.statement,
                });
              })();
            }}>
              <Text style={{ color: theme.muted }}>Bỏ qua</Text>
            </Pressable>
          </View>
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
