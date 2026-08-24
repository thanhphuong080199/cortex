import { useQuery } from "@powersync/react-native";
import { useColorScheme } from "react-native";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Keyboard, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AssistantBox } from "./assistant-box";
import { ChatHeader } from "../components/chat-header";
import { RADIUS, SPACE, TYPE } from "../fonts";
import { composerInset } from "../lib/composer-inset";
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
 * Whether `id` is a real `chat_messages.id` (a Postgres `gen_random_uuid()`) rather than one of
 * transcript.ts's own placeholders for the still-streaming turn -- `live-${noteId}` and
 * `live-answer-${noteId}`. Only a real id can be sent as `forMessageId`: the server would
 * otherwise try to mark a row that does not exist, harmlessly but pointlessly.
 */
const isRealMessageId = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

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

/**
 * `composerInset` (lib/composer-inset.ts, where the arithmetic and its reasoning live) wired to
 * the live keyboard. Here rather than beside the pure function because this file already imports
 * react-native and that file deliberately does not -- the same split theme.ts uses.
 *
 * NOT `KeyboardAvoidingView`, which this replaces. That component needs a
 * `keyboardVerticalOffset` equal to the height of everything above it -- expo-router's Stack
 * header plus the top inset -- and that is only readable through `@react-navigation/elements`,
 * which is not a direct dependency of this app; importing it would be a phantom dependency
 * pnpm's strict layout can drop at any install. The keyboard's own frame needs no such
 * correction: `endCoordinates.height` is measured from the bottom of the window, which is the
 * edge being padded.
 *
 * `keyboardWillShow` on iOS, so the composer moves WITH the keyboard rather than after it;
 * `keyboardDidShow` on Android, which has no `will` events.
 */
function useComposerInset(): number {
  const insets = useSafeAreaInsets();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const show = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hide = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const shown = Keyboard.addListener(show, (e) => setKeyboardHeight(e.endCoordinates.height));
    const hidden = Keyboard.addListener(hide, () => setKeyboardHeight(0));
    return () => { shown.remove(); hidden.remove(); };
  }, []);

  return composerInset({ keyboardHeight, safeAreaBottom: insets.bottom });
}

/**
 * `onSignOut`/`signingOut` are threaded down from index.tsx rather than handled here, because
 * signing out wipes the local corpus and index.tsx owns both the session and the error surface
 * that a failed wipe has to land on. They arrive here only because the control they drive now
 * lives in this screen's own header (components/chat-header.tsx) instead of in expo-router's.
 */
export function Chat({ onSignOut, signingOut }: { onSignOut: () => void; signingOut: boolean }) {
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
  //
  // `forId` was added 2026-08-23. The proposal used to render between the list and the composer,
  // detached from the reply it came from, so saving an older answer put a box at the bottom of
  // the screen with nothing tying the two together -- the same defect the web box had, reported
  // together with it.
  const [proposal, setProposal] = useState<
    { forId: string; statement: string; sourceUrl?: string } | null
  >(null);
  const [proposing, setProposing] = useState<string | null>(null);
  // Which replies have been kept THIS SESSION -- the optimistic half. The durable half is
  // `item.savedAsNote`, read straight off `retrieval_meta.savedAnswerNoteId` (transcript.ts),
  // which PowerSync replicates down like any other write once save-answer.ts marks the source
  // message. `saved` alone used to be the whole story, and forgot every save on app restart
  // (reported 2026-08-24, same defect web had) -- this Set now only needs to cover the gap
  // between "saved" and "PowerSync has synced that write back down".
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
  const bottomInset = useComposerInset();

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
      setProposal({ forId: id, statement, ...(sourceUrl !== undefined ? { sourceUrl } : {}) });
    } finally {
      setProposing(null);
    }
  }

  async function onConfirm(p: { forId: string; statement: string; sourceUrl?: string }) {
    setProposal(null);
    // Optimistic, and a NEW Set rather than a mutation: `prev.add(...)` returns the same
    // reference, React bails out of the re-render, and the label never changes on screen.
    setSaved((prev) => new Set(prev).add(p.forId));
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    await saveStatement({
      apiUrl: process.env.EXPO_PUBLIC_API_URL!,
      token: session.access_token,
      statement: p.statement,
      ...(p.sourceUrl !== undefined ? { sourceUrl: p.sourceUrl } : {}),
      // Only when `forId` is a real chat_messages id -- `live-...`/`live-answer-...` (the
      // still-streaming turn, see transcript.ts) have none yet. The save still succeeds; it just
      // cannot be marked durably until a replicated row exists to mark.
      ...(isRealMessageId(p.forId) ? { forMessageId: p.forId } : {}),
    });
  }

  return (
    // The inset goes on the ROOT of the screen, not on the composer itself, and that placement
    // is what keeps the last message visible: padding here shrinks the flex box the FlatList
    // fills, so the thread gets shorter as the keyboard comes up instead of scrolling under it.
    //
    // This replaces a KeyboardAvoidingView that was passed `behavior={undefined}` on Android --
    // which is that component doing nothing at all, and is why the keyboard drew straight over
    // the input (reported 2026-08-23). See lib/composer-inset.ts for why the replacement reads
    // the keyboard frame directly rather than fixing the behavior prop.
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingBottom: bottomInset }}>
      <ChatHeader onSignOut={onSignOut} busy={signingOut} />
      <FlatList
        inverted
        data={inverted}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{
          paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.sm,
          gap: SPACE.md,
        }}
        // The thread is the one place the keyboard should be dismissable by touch: tapping a
        // message you are reading should not require aiming at the 8px of gutter beside it.
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        // Inverted, so "the end" is the TOP of the thread. 0.5 rather than 0.1: the rows are
        // tall and a tighter threshold fires only after the user has already hit the ceiling.
        onEndReachedThreshold={0.5}
        onEndReached={() => setLimit((n) => (rows.length >= n ? n + PAGE : n))}
        ListEmptyComponent={<EmptyThread />}
        renderItem={({ item, index }) => {
          // `inverted` holds items NEWEST FIRST, so the user's question is the NEXT index, not
          // the previous one. Getting this backwards attaches the wrong question to the reply,
          // which the model then answers around.
          const next = inverted[index + 1];
          return (
            <Row
              item={item}
              proposing={proposing === item.id}
              // The durable half (item.savedAsNote, from retrieval_meta) or the optimistic half
              // (saved, set the instant this session's own onConfirm fires) -- either is enough.
              saved={saved.has(item.id) || (item.kind === "message" && item.savedAsNote)}
              // Rendered inside the row it names, not below the list. See `proposal`'s
              // declaration for what that fixed.
              proposal={proposal?.forId === item.id ? proposal : null}
              onConfirm={onConfirm}
              onDismiss={() => setProposal(null)}
              question={next?.kind === "message" && next.role === "user" ? next.content : undefined}
              onSave={onSave}
            />
          );
        }}
      />
      <AssistantBox onLive={setLive} />
    </View>
  );
}

/**
 * What the app says when it has nothing to show yet -- which, for a new user, is the entire
 * product. Set in Fraunces italic, the one face reserved for a question the app is waiting on
 * (fonts.ts). No illustration, no feature tour, no example prompts: this is a page for writing
 * one true sentence on, and anything else here is furniture in the way.
 *
 * COUNTER-FLIPPED. The list is `inverted`, which React Native implements as `scaleY: -1` on the
 * whole content container -- and `ListEmptyComponent` renders inside it, so it inherits the flip.
 * Before this, the empty state rendered upside down (the old one-line version had the same bug,
 * unnoticed because a mirrored line of small grey text just reads as a rendering glitch).
 */
function EmptyThread() {
  const theme = themeFor(useColorScheme());
  return (
    <View
      style={{
        // Not centred in the viewport, and that is the list doing it rather than this style: an
        // inverted FlatList anchors short content to the BOTTOM, so the question lands just
        // above the composer instead of floating in the middle of an empty screen. The question
        // and the box that answers it end up next to each other, which is the point.
        alignItems: "center", paddingHorizontal: SPACE.xl, paddingVertical: 40,
        gap: SPACE.md, transform: [{ scaleY: -1 }],
      }}
    >
      <Text style={{ ...TYPE.ask, color: theme.text, textAlign: "center" }}>
        Bạn đang nghĩ gì?
      </Text>
      <Text style={{ ...TYPE.small, color: theme.muted, textAlign: "center" }}>
        Viết ra một câu. Cortex tự xếp nó vào đúng chỗ.
      </Text>
    </View>
  );
}

function Row({ item, proposing, saved, proposal, onConfirm, onDismiss, question, onSave }: {
  item: Item;
  proposing: boolean;
  saved: boolean;
  proposal: { forId: string; statement: string; sourceUrl?: string } | null;
  onConfirm: (p: { forId: string; statement: string; sourceUrl?: string }) => void;
  onDismiss: () => void;
  question: string | undefined;
  onSave: (id: string, answer: string, question: string | undefined, sourceUrl: string | undefined) => void;
}) {
  const theme = themeFor(useColorScheme());

  if (item.kind === "separator") {
    // A chip on the recessed tone rather than bare text. The thread has no other structural
    // break, so the one it does have should read as a deliberate marker and not as a stray line.
    return (
      <View
        style={{
          alignSelf: "center", marginVertical: SPACE.xs,
          paddingVertical: SPACE.xs, paddingHorizontal: SPACE.md,
          borderRadius: RADIUS.pill, backgroundColor: theme.sunken,
        }}
      >
        <Text style={{ ...TYPE.micro, color: theme.muted }}>{item.label}</Text>
      </View>
    );
  }

  if (item.role === "user") {
    // Dried rose with dark ink on it, NOT the accent with white on it -- see theme.ts's note on
    // `bubbleInk`. The user's own sentence is the softest thing on the screen on purpose.
    //
    // The one square corner (bottom right) is the only place in this design a radius is broken,
    // which is what makes it read as "this one came from you" rather than as decoration.
    return (
      <View
        style={{
          alignSelf: "flex-end", maxWidth: "86%", backgroundColor: theme.bubble,
          borderRadius: RADIUS.xl, borderBottomRightRadius: RADIUS.sm,
          paddingVertical: SPACE.md - 2, paddingHorizontal: SPACE.lg,
        }}
      >
        <Text style={{ ...TYPE.body, color: theme.bubbleInk }}>{item.content}</Text>
      </View>
    );
  }

  // The assistant's card. Full width and lifted off the page -- same reasoning as web for the
  // width (a reply may be a list or a table, and both need the width FORMAT_RULE assumes they
  // have), plus the elevation that makes it the one thing on screen carrying new information.
  return (
    <View
      style={{
        alignSelf: "stretch", gap: SPACE.sm,
        backgroundColor: theme.panel, borderRadius: RADIUS.xl,
        borderBottomLeftRadius: RADIUS.sm,
        paddingVertical: SPACE.md, paddingHorizontal: SPACE.lg,
        boxShadow: theme.shadow,
      }}
    >
      <Text testID="box-answer" style={{ ...TYPE.body, color: theme.text }}>{item.content}</Text>

      {item.incomplete ? (
        <Text style={{ ...TYPE.small, color: theme.muted, fontStyle: "italic" }}>
          Câu trả lời bị gián đoạn.
        </Text>
      ) : null}

      {item.content && saved ? (
        // Replaces the control rather than sitting beside it: a live "Lưu câu trả lời" next to
        // "đã lưu" is the same nag with a label attached. A sage wash, because this is the one
        // moment the app can say something went right.
        <View
          testID="saved-answer"
          style={{
            alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: SPACE.xs + 2,
            paddingVertical: SPACE.xs, paddingHorizontal: SPACE.md - 2,
            borderRadius: RADIUS.pill, backgroundColor: theme.accentSoft,
          }}
        >
          <Text style={{ ...TYPE.micro, color: theme.accentSoftInk }}>✓ Đã lưu vào notes</Text>
        </View>
      ) : item.content ? (
        // No underline. It is a quiet secondary action on a card, and an underlined grey string
        // under every single reply is the visual noise this design is trying to remove.
        <Pressable
          testID="save-answer"
          accessibilityRole="button"
          disabled={proposing}
          hitSlop={SPACE.sm}
          onPress={() => onSave(item.id, item.content, question, webUrlOf(item.citations ?? null))}
          style={({ pressed }) => ({ alignSelf: "flex-start", opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={{ ...TYPE.smallMedium, color: theme.accent }}>
            {proposing ? "Đang rút gọn…" : "Lưu câu trả lời"}
          </Text>
        </Pressable>
      ) : null}

      {proposal ? (
        // Recessed INTO the card rather than floating on top of it: this is a follow-up about
        // the reply above, not a new message. The dashed border is gone -- `sunken` already says
        // "provisional", and the offer box in assistant-box.tsx stays visually distinct because
        // it is a lifted panel on `bg` while this is a well inside a card (S1.5 §4 needs the two
        // tellable apart, and depth does that better than two flavours of border).
        <View
          testID="save-proposal"
          style={{
            gap: SPACE.md, marginTop: SPACE.xs,
            padding: SPACE.md, borderRadius: RADIUS.lg, backgroundColor: theme.sunken,
          }}
        >
          <Text style={{ ...TYPE.small, color: theme.text }}>{proposal.statement}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
            <Pressable
              testID="save-confirm"
              accessibilityRole="button"
              onPress={() => onConfirm(proposal)}
              style={({ pressed }) => ({
                paddingVertical: SPACE.sm - 1, paddingHorizontal: SPACE.lg,
                borderRadius: RADIUS.pill, backgroundColor: theme.accent,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Text style={{ ...TYPE.smallMedium, color: theme.accentInk }}>Lưu câu này</Text>
            </Pressable>
            {/* Dismiss writes NOTHING -- specifically not a decline. See save.ts's module doc. */}
            <Pressable
              testID="save-dismiss"
              accessibilityRole="button"
              hitSlop={SPACE.sm}
              onPress={onDismiss}
              style={({ pressed }) => ({
                paddingVertical: SPACE.sm - 1, paddingHorizontal: SPACE.md,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ ...TYPE.smallMedium, color: theme.muted }}>Thôi</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
