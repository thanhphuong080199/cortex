import { useQuery } from "@powersync/react-native";
import { useColorScheme } from "react-native";
import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native";

import { AssistantBox } from "./assistant-box";
import { ConnectionPill } from "../components/connection-pill";
import { proposeStatement, saveStatement, webUrlOf } from "../lib/assistant/save";
import { supabase } from "../lib/supabase";
import { buildTranscript, liveHasReplicated, type ChatRow, type Item, type LiveTurn } from "../lib/transcript";
import { themeFor } from "../theme";

// How long to keep a SETTLED live turn on screen once no more replication evidence can be
// expected -- the backstop for turns that will never get a matching row at all (an offline
// capture: `turn.ts` never runs, so no `chat_messages` row is ever written for it; see the
// final whole-branch review's Maestro findings). Generous enough that a normal online turn is
// almost always retired by `liveHasReplicated` well before this fires -- this is the fallback
// for the case where evidence can never arrive, not the common path.
const RETIRE_TIMEOUT_MS = 8_000;

/**
 * The whole app. Until 2026-08-22 this screen was a note list with the chat box wedged in as
 * its ListHeaderComponent -- which is why every Maestro flow had to scroll past a header taller
 * than the viewport to reach anything.
 *
 * `inverted`, so the newest message sits at the bottom without measuring anything: FlatList
 * renders an inverted list from the bottom up, which is also what makes "load more when you
 * reach the top" fall out of `onEndReached` rather than needing a scroll listener. The data is
 * therefore passed NEWEST FIRST here, while buildTranscript returns oldest first -- reversed
 * once, at the boundary, with the reason written down.
 */
const PAGE = 50;

export function Chat() {
  const theme = themeFor(useColorScheme());
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [limit, setLimit] = useState(PAGE);

  // Reactive: a replicated row re-renders this by itself, which is what retires the live turn
  // when the server's copies land. DESC to take the NEWEST `limit` rows -- ASC with a LIMIT
  // would pin the screen to the oldest conversation the user ever had.
  const { data: rows = [] } = useQuery<ChatRow>(
    `SELECT id, session_id, role, content, citations, retrieval_meta, created_at
     FROM chat_messages ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );

  // Retire a SETTLED live turn the instant its row(s) replicate -- checked on every reactive
  // `rows` update, which is exactly the signal PowerSync gives us when a new row lands.
  useEffect(() => {
    if (live?.settled && liveHasReplicated(rows, live)) setLive(null);
  }, [rows, live]);

  // The backstop, armed exactly once per settled turn (keyed on noteId + settled, not on `rows`
  // -- re-arming on every row change would let an unrelated replication event keep pushing this
  // out forever). Its cleanup fires when `live` changes for ANY reason, including the effect
  // above clearing it early, which cancels the now-pointless timer.
  useEffect(() => {
    if (!live?.settled) return;
    const t = setTimeout(() => setLive(null), RETIRE_TIMEOUT_MS);
    return () => clearTimeout(t);
    // Deliberately keyed on noteId+settled, not on `live` itself (there is no
    // react-hooks/exhaustive-deps rule configured in this repo's eslint config to silence) --
    // see the comment above for why re-arming on every `live` identity change is wrong here.
  }, [live?.noteId, live?.settled]);

  const items = useMemo(
    () => buildTranscript([...rows].reverse(), live, new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone),
    [rows, live],
  );
  const inverted = useMemo(() => [...items].reverse(), [items]);

  // The manual save, S1.5 §4. Lives in Chat rather than in AssistantBox because this screen owns
  // the replicated rows -- the control sits on every assistant reply, not only on the live turn.
  const [proposal, setProposal] = useState<
    { statement: string; sourceUrl?: string } | null
  >(null);
  const [proposing, setProposing] = useState<string | null>(null);

  async function onSave(id: string, answer: string, question: string | undefined, sourceUrl: string | undefined) {
    setProposal(null);
    setProposing(id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const statement = await proposeStatement({
        apiUrl: process.env.EXPO_PUBLIC_API_URL!,
        token: session.access_token,
        answer,
        ...(question ? { question } : {}),
      });
      setProposal({ statement, ...(sourceUrl !== undefined ? { sourceUrl } : {}) });
    } finally {
      setProposing(null);
    }
  }

  async function onConfirm(p: { statement: string; sourceUrl?: string }) {
    setProposal(null);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    await saveStatement({
      apiUrl: process.env.EXPO_PUBLIC_API_URL!,
      token: session.access_token,
      statement: p.statement,
      ...(p.sourceUrl !== undefined ? { sourceUrl: p.sourceUrl } : {}),
    });
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ConnectionPill />
      <FlatList
        inverted
        data={inverted}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        // Inverted, so "the end" is the TOP of the thread. 0.5 rather than 0.1: the rows are
        // tall and a tighter threshold fires only after the user has already hit the ceiling.
        onEndReachedThreshold={0.5}
        onEndReached={() => setLimit((n) => (rows.length >= n ? n + PAGE : n))}
        ListEmptyComponent={
          <Text style={{ color: theme.muted, textAlign: "center", paddingVertical: 40 }}>
            Bạn đang nghĩ gì?
          </Text>
        }
        renderItem={({ item, index }) => {
          // `inverted` holds items NEWEST FIRST, so the user's question is the NEXT index, not
          // the previous one. Getting this backwards attaches the wrong question to the reply,
          // which the model then answers around.
          const next = inverted[index + 1];
          return (
            <Row
              item={item}
              proposing={proposing === item.id}
              question={next?.kind === "message" && next.role === "user" ? next.content : undefined}
              onSave={onSave}
            />
          );
        }}
      />
      {proposal ? (
        <View testID="save-proposal" style={{
          gap: 8, margin: 12, padding: 12, borderRadius: 8,
          borderWidth: 1, borderStyle: "dashed", borderColor: theme.line,
        }}>
          <Text style={{ color: theme.muted }}>{proposal.statement}</Text>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <Pressable testID="save-confirm" accessibilityRole="button" onPress={() => void onConfirm(proposal)}>
              <Text style={{ color: theme.accent }}>Lưu câu này</Text>
            </Pressable>
            {/* Dismiss writes NOTHING -- specifically not a decline. See save.ts's module doc. */}
            <Pressable testID="save-dismiss" accessibilityRole="button" onPress={() => setProposal(null)}>
              <Text style={{ color: theme.muted }}>Thôi</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      <AssistantBox onLive={setLive} />
    </KeyboardAvoidingView>
  );
}

function Row({ item, proposing, question, onSave }: {
  item: Item;
  proposing: boolean;
  question: string | undefined;
  onSave: (id: string, answer: string, question: string | undefined, sourceUrl: string | undefined) => void;
}) {
  const theme = themeFor(useColorScheme());
  if (item.kind === "separator") {
    return (
      <Text style={{ alignSelf: "center", color: theme.muted, fontSize: 12 }}>{item.label}</Text>
    );
  }
  if (item.role === "user") {
    return (
      <View style={{
        alignSelf: "flex-end", maxWidth: "82%", backgroundColor: theme.accent,
        borderRadius: 16, borderBottomRightRadius: 4, paddingVertical: 10, paddingHorizontal: 14,
      }}>
        <Text style={{ color: "#fff" }}>{item.content}</Text>
      </View>
    );
  }
  // No bubble, full width -- same reasoning as web: a reply may be a list or a table, and both
  // need the width FORMAT_RULE assumes they have.
  return (
    <View style={{ alignSelf: "stretch" }}>
      <Text testID="box-answer" style={{ color: theme.text }}>{item.content}</Text>
      {item.incomplete ? (
        <Text style={{ color: theme.muted, fontStyle: "italic", fontSize: 12 }}>
          Câu trả lời bị gián đoạn.
        </Text>
      ) : null}
      {item.content ? (
        <Pressable
          testID="save-answer"
          accessibilityRole="button"
          disabled={proposing}
          onPress={() => onSave(item.id, item.content, question, webUrlOf(item.citations ?? null))}
        >
          <Text style={{ color: theme.muted, fontSize: 13, textDecorationLine: "underline" }}>
            {proposing ? "Đang rút gọn…" : "Lưu câu trả lời"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
