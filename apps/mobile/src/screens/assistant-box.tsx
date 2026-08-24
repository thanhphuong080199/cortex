import { usePowerSync } from "@powersync/react-native";
import { randomUUID } from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import * as WebBrowser from "expo-web-browser";
import { useRef, useState } from "react";
import {
  ActivityIndicator, Pressable, ScrollView, Text, TextInput, useColorScheme, View,
} from "react-native";

import { MoodStreak } from "../components/mood-streak";
import { RADIUS, SPACE, TYPE } from "../fonts";
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
  // Drives the composer's focus ring. React Native has no `:focus-within`, so the composite
  // control cannot take the ring the way web's `.chat-composer:focus-within` does -- the state
  // has to be tracked by hand and applied to the wrapper, because an outline on the bare
  // TextInput would draw a rectangle inside the pill.
  const [focused, setFocused] = useState(false);
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

  // Whether there is anything to draw above the composer at all. Used to skip the scroller
  // entirely rather than render an empty one: the wrapper below sets `gap`, and a zero-height
  // child still earns its gap, which would put 8dp of nothing above the box on every idle frame.
  const hasReceipts =
    saveFailed || attached !== null || mood !== null || offer !== null ||
    (web !== null && (web.sources.length > 0 || web.queries.length > 0)) ||
    matches.length > 0 || status !== null;

  return (
    // THE RECEIPTS SIT ABOVE THE COMPOSER, NOT BELOW IT (2026-08-24). Every block after the
    // input used to render underneath it, which put "Đã xếp vào: sức khoẻ", the mood streak and
    // the save offer at the very bottom of the screen, below the thing the user was typing in
    // and separated from the reply they belong to by the whole composer. They are the last
    // turn's aftermath, so they belong between the thread and the box.
    //
    // THAT REORDER IS WHY EVERY flex PROPERTY BELOW IS SPELLED OUT. React Native defaults
    // `flexShrink` to 0 (not 1, as CSS does), so this View could not shrink -- and with the
    // composer moved to the BOTTOM of it, a tall turn pushed the COMPOSER off the bottom edge
    // instead of the receipts. That is the 2026-08-23 "keyboard covers the input" bug arriving
    // by a new route, and it is the reason this block is not just a reorder.
    //
    // MEASURED, on a 360x640dp phone with a 300dp keyboard up:
    //   room for thread + this box   340 - 87 (header)        = 253dp
    //   this box, on a turn with attached + mood + offer + a web source + chips + status = 324dp
    //   -> chat.tsx's FlatList (flexShrink: 1) gives up everything it has, 168dp -> 20dp, and
    //      the composer still lands 79dp BELOW the top of the keyboard. Invisible.
    // With the three properties below: receipts 249dp -> 87dp and scrollable, box 324 -> 162,
    // composer fully visible with the thread still showing two messages.
    //
    // It survived review because a big phone hides it: the thread absorbs the overflow on its
    // own until `header + this box` exceeds the space left, which on a 390x844 screen it does
    // not. Small Android phones are where it bites.
    //
    // The rule the three properties encode: the COMPOSER is never allowed to move. Under
    // pressure the receipts give way and start scrolling; the box stays pinned to the bottom.
    <View
      style={{
        flexShrink: 1,
        gap: SPACE.sm, paddingHorizontal: SPACE.lg, paddingBottom: SPACE.md,
      }}
    >
      {hasReceipts ? (
        <ScrollView
          // `flexGrow: 0` so an idle stack sits at its natural height instead of filling the
          // screen (ScrollView's own base style is flexGrow:1/flexShrink:1 -- see RN's
          // ScrollView.js `baseVertical`), `flexShrink: 1` so it is the thing that gives.
          style={{ flexGrow: 0, flexShrink: 1 }}
          contentContainerStyle={{ gap: SPACE.sm }}
          // Without this, the first tap on "Lưu"/"Bỏ qua" while the keyboard is up is swallowed
          // dismissing the keyboard, and the offer needs a second tap.
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {saveFailed ? (
            <Text style={{ ...TYPE.small, color: theme.danger }}>
              Không lưu được vào máy. Chữ của bạn vẫn còn đây — thử lại nhé.
            </Text>
          ) : null}

          {attached ? (
            <Text testID="box-attached" style={{ ...TYPE.small, color: theme.muted }}>
              {attached.mediaTitle
                ? `Đã ghi vào thư viện: ${attached.mediaTitle}`
                : attached.domain
                  ? `Đã xếp vào: ${attached.domain}`
                  : "Chưa xếp vào nhóm nào"}
              {attached.tags.length > 0 ? ` — thẻ ${attached.tags.join(", ")}` : ""}
            </Text>
          ) : null}

          {mood ? (
            <MoodStreak
              mood={mood.mood}
              onUndo={() => {
                const id = mood.checkinId;
                setMood(null);
                void undoCheckin(db, id);
              }}
            />
          ) : null}

          {offer ? (
            // One line, two buttons, easy to ignore -- same rule web's .offer follows: an offer that
            // interrupts is a nag. Worded differently from chat.tsx's manual save box, because both
            // can be on screen at once and mean different things (S1.5 §4) -- and told apart by
            // depth: this is a LIFTED panel sitting on the page, chat.tsx's proposal is a well sunk
            // into the assistant's card.
            <View
              testID="offer"
              style={{
                gap: SPACE.md, padding: SPACE.md,
                borderRadius: RADIUS.lg, backgroundColor: theme.panel, boxShadow: theme.shadow,
              }}
            >
              <Text style={{ ...TYPE.small, color: theme.text }}>{offer.statement}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
                <Pressable
                  testID="offer-accept"
                  accessibilityRole="button"
                  style={({ pressed }) => ({
                    paddingVertical: SPACE.sm - 1, paddingHorizontal: SPACE.lg,
                    borderRadius: RADIUS.pill, backgroundColor: theme.accent,
                    opacity: pressed ? 0.8 : 1,
                  })}
                  onPress={() => {
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
                  }}
                >
                  <Text style={{ ...TYPE.smallMedium, color: theme.accentInk }}>Lưu</Text>
                </Pressable>
                <Pressable
                  testID="offer-decline"
                  accessibilityRole="button"
                  hitSlop={SPACE.sm}
                  style={({ pressed }) => ({
                    paddingVertical: SPACE.sm - 1, paddingHorizontal: SPACE.md,
                    opacity: pressed ? 0.6 : 1,
                  })}
                  onPress={() => {
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
                  }}
                >
                  <Text style={{ ...TYPE.smallMedium, color: theme.muted }}>Bỏ qua</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {/* Note citations have no mobile UI yet -- this screen has never rendered the
              "citations" BoxEvent. The web block below stands alone, but stays visually distinct
              from any future note-citation block per life-domains spec §6.2: the two are never
              merged into one list. */}
          {web && web.sources.length > 0 ? (
            <View style={{ gap: SPACE.xs }} testID="box-web-sources">
              <Text style={{ ...TYPE.micro, color: theme.muted }}>TỪ WEB</Text>
              {web.sources.map((s) => (
                <Text
                  key={s.url}
                  testID="box-web-source"
                  accessibilityRole="link"
                  // `accent`, not the hardcoded #1a73e8 this used to be -- a Google blue on silk was
                  // the single most out-of-place colour in the app, and it was invisible in dark
                  // mode. The underline stays: these leave the app, and that is worth signposting.
                  style={{ ...TYPE.small, color: theme.accent, textDecorationLine: "underline" }}
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
            <View
              style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm }}
              testID="box-web-chips"
            >
              {web.queries.map((q) => (
                <Text
                  key={q}
                  testID="box-web-chip"
                  accessibilityRole="button"
                  style={{
                    ...TYPE.smallMedium, color: theme.accentSoftInk,
                    paddingVertical: SPACE.xs + 2, paddingHorizontal: SPACE.md,
                    borderRadius: RADIUS.pill,
                    // Was a hardcoded #eee, which on the dark scheme rendered near-white chips with
                    // near-black default text -- the one block in this file that never read `theme`.
                    backgroundColor: theme.accentSoft,
                    overflow: "hidden",
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
            <Text
              key={m.id}
              testID="box-offline-match"
              style={{
                ...TYPE.small, color: theme.text,
                // A left rule rather than a card: these are quotes out of the user's own corpus, and
                // the blockquote shape says "your words, from before" without spending an elevation
                // level on it.
                borderLeftWidth: 2, borderLeftColor: theme.line,
                paddingLeft: SPACE.md, paddingVertical: SPACE.xs,
              }}
            >
              {m.snippet}
            </Text>
          ))}

          {status ? (
            <Text testID="box-status" style={{ ...TYPE.small, color: theme.muted }}>{status}</Text>
          ) : null}
        </ScrollView>
      ) : null}

      {/* One rounded block with the send control inside it, matching web's .chat-composer. The
          old shape was a 96px-tall bordered box with a full-width dark button under it -- three
          hardcoded colours (#ccc, #222, "crimson") that ignored `themeFor` entirely, so the
          whole composer stayed light-mode grey on a dark screen. */}
      <View
        style={{
          // NEVER shrinks, and this is the load-bearing half of the rule above: whatever else
          // has to give when the keyboard is up, it is not the box the user is typing in.
          flexShrink: 0,
          flexDirection: "row", alignItems: "flex-end", gap: SPACE.sm,
          paddingVertical: 6, paddingLeft: SPACE.lg, paddingRight: 6,
          borderRadius: RADIUS.xl,
          backgroundColor: theme.panel,
          // The ring is a ring, not a border swap: a 1px line that changes colour on focus moves
          // nothing, and on a soft palette it is genuinely hard to see. This grows a 2px accent
          // outline around the pill while keeping the pill's own geometry identical, because
          // `borderWidth` is constant and only the colour changes -- a width change here would
          // shift every glyph inside by a pixel on focus.
          borderWidth: 2,
          borderColor: focused ? theme.accent : theme.line,
          boxShadow: theme.shadowLift,
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
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          // Grows with the text, capped. `height` is driven by the measured content rather than
          // a minHeight, so an empty box is one line instead of the three the old 96px forced.
          onContentSizeChange={(e) =>
            setInputHeight(Math.min(Math.max(e.nativeEvent.contentSize.height, 22), 140))}
          style={{
            ...TYPE.body,
            flex: 1, minWidth: 0, height: inputHeight,
            color: theme.text, padding: 0, paddingVertical: SPACE.sm,
            textAlignVertical: "center",
          }}
        />
        <Pressable
          onPress={() => void submit()}
          accessibilityRole="button"
          accessibilityLabel="Gửi"
          disabled={busy}
          testID="box-send"
          style={({ pressed }) => ({
            width: 36, height: 36, borderRadius: RADIUS.pill,
            alignItems: "center", justifyContent: "center",
            backgroundColor: theme.accent,
            opacity: busy ? 0.4 : pressed ? 0.8 : 1,
          })}
        >
          {busy
            ? <ActivityIndicator size="small" color={theme.accentInk} />
            : <Text style={{ color: theme.accentInk, fontSize: 17, lineHeight: 20 }}>↑</Text>}
        </Pressable>
      </View>
    </View>
  );
}
