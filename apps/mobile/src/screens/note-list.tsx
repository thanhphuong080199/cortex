import {
  NOTE_VIEWS,
  noteFiltersToSql,
  toSqlitePlaceholders,
  type NoteFilters,
} from "@cortex/shared";
import { useQuery } from "@powersync/react-native";
import { Link } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";

import { createInFlightGuard } from "../lib/in-flight";
import { OfflineError, semanticSearch, type SemanticResult } from "../lib/semantic-search";
import { supabase } from "../lib/supabase";

/**
 * Reads the local replica directly -- no service layer, no network (spec §2.1). The narrowing
 * comes from the same `NoteFilters` description the web SSR query and the web realtime refetch
 * use, so the three cannot drift (spec §3, issue-log E5).
 *
 * From `@cortex/shared`, NOT `@cortex/core` as the plan says. Core's barrel reaches `archiver`
 * through the export service and declares no `sideEffects: false`, so importing it here would
 * drag Node builtins into Metro. The Task 14 placement ruling covers this.
 *
 * `useQuery` is reactive: a synced change or a local write re-renders with no refetch call and
 * no subscription bookkeeping.
 *
 * THIS LIST IS THE SCREEN'S ONLY SCROLLING SURFACE, and `header`/`footer` exist to keep it that
 * way. Everything above it -- capture, check-in, media log -- used to be siblings in a plain
 * `View`, where their fixed heights consumed the whole screen and this component's `flex: 1`
 * resolved to nothing. The list still rendered every row; it was simply zero pixels tall, and
 * with no scroll anywhere on the screen there was no way to reach it. From the outside that is
 * indistinguishable from having no notes -- `ListEmptyComponent` is invisible for the same
 * reason -- which is what sent an entire investigation after the sync layer, where all ten rows
 * had in fact arrived correctly.
 *
 * Passing them as `ListHeaderComponent` rather than wrapping the screen in a `ScrollView` is
 * deliberate: a `FlatList` inside a vertical `ScrollView` nests two scroll views, which React
 * Native warns about and which breaks virtualisation.
 */
export function NoteList({
  header,
  footer,
}: {
  // `ReactElement`, not `ReactNode`: FlatList's List*Component props reject bare strings and
  // number children, so the wider type only defers the error to the call site.
  header?: React.ReactElement;
  footer?: React.ReactElement;
} = {}) {
  const [filters, setFilters] = useState<NoteFilters>({ view: "inbox" });

  // Semantic search is a separate, explicit action layered on top of the reactive FTS5 query
  // above -- never a replacement for it. `semanticResults` is additive state; nothing here ever
  // touches `filters` or the local `notes` query, so a failed or offline meaning-search cannot
  // make the always-on local list disappear or look empty.
  const [semanticResults, setSemanticResults] = useState<SemanticResult[] | null>(null);
  const [semanticBusy, setSemanticBusy] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const semanticGuard = useRef(createInFlightGuard()).current;

  async function runSemanticSearch() {
    const q = filters.q;
    if (!q) return;
    await semanticGuard(async () => {
      setSemanticBusy(true);
      setSemanticError(null);
      try {
        const apiUrl = process.env.EXPO_PUBLIC_API_URL;
        if (!apiUrl) throw new Error("no API URL configured");
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error("not signed in");
        const results = await semanticSearch({
          q,
          token: session.access_token,
          apiUrl,
          fetchFn: fetch,
        });
        setSemanticResults(results);
      } catch (err) {
        // OfflineError gets its own message and the PREVIOUS semantic results (if any) are left
        // alone -- silently swapping them for local FTS results, or for nothing, would tell the
        // user their notes are not there, which is false. Any other failure (a 500, a malformed
        // body) is reported the same way: never rendered as an empty match list.
        setSemanticError(
          err instanceof OfflineError
            ? "Semantic search needs a connection — showing local results"
            : err instanceof Error
              ? err.message
              : "Search failed. Try again.",
        );
      } finally {
        setSemanticBusy(false);
      }
    });
  }

  const { sql, params } = useMemo(() => {
    const { where, params: p, join } = noteFiltersToSql(filters);
    return {
      sql: `SELECT n.id, n.title, n.content, n.lifecycle, n.updated_at
            FROM notes n ${join}
            WHERE ${toSqlitePlaceholders(where)}
            ORDER BY n.updated_at DESC LIMIT 200`,
      params: p,
    };
  }, [filters]);

  const { data: notes = [], error } = useQuery<{
    id: string;
    title: string | null;
    content: string;
    lifecycle: string;
    updated_at: string;
  }>(sql, params);

  // An element, not a component: `ListHeaderComponent={() => ...}` would give React a new
  // component type on every render, unmounting the TextInput and losing focus on each keystroke.
  const listHeader = (
    <View style={{ gap: 12 }}>
      {header}
      <TextInput
        placeholder="Search"
        accessibilityLabel="Search notes"
        testID="search-input"
        onChangeText={(q) => {
          // Spread-if rather than assigning undefined: `noteFiltersToSql` emits the FTS clause
          // on any truthy `q`, and a present-but-empty one would match nothing and empty the
          // list the moment the user cleared the box.
          setFilters((f) => {
            const trimmed = q.trim();
            const { q: _dropped, ...rest } = f;
            return trimmed ? { ...rest, q: trimmed } : rest;
          });
          // A stale meaning-search answer sitting under a query the user has since changed
          // would look like a live result for text nobody searched.
          setSemanticResults(null);
          setSemanticError(null);
        }}
        style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
      />
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Pressable
          onPress={() => void runSemanticSearch()}
          disabled={!filters.q || semanticBusy}
          accessibilityRole="button"
          accessibilityState={{ disabled: !filters.q || semanticBusy }}
          testID="semantic-search-button"
          style={{
            paddingVertical: 8,
            paddingHorizontal: 14,
            borderRadius: 8,
            backgroundColor: !filters.q || semanticBusy ? "#eee" : "#222",
          }}
        >
          <Text style={{ color: !filters.q || semanticBusy ? "#999" : "white" }}>
            {semanticBusy ? "Searching by meaning…" : "Search by meaning"}
          </Text>
        </Pressable>
      </View>
      {semanticError ? (
        <Text testID="semantic-search-error" style={{ color: "crimson" }}>
          {semanticError}
        </Text>
      ) : null}
      {semanticResults ? (
        // Its own section, never a swap-in for the FlatList's `data`: the local FTS5 list below
        // stays exactly as it was regardless of what meaning-search returns.
        <View style={{ gap: 8 }}>
          <Text style={{ fontWeight: "600" }}>Matches by meaning</Text>
          {semanticResults.length === 0 ? (
            <Text style={{ opacity: 0.6 }}>No notes matched.</Text>
          ) : (
            semanticResults.map((r) => (
              <Link key={r.noteId} href={`/notes/${r.noteId}`} asChild>
                <Pressable accessibilityRole="link" style={{ paddingVertical: 8 }}>
                  <Text numberOfLines={1}>{r.title ?? "Untitled"}</Text>
                  <Text numberOfLines={2} style={{ opacity: 0.6, fontSize: 12 }}>
                    {r.snippet}
                  </Text>
                </Pressable>
              </Link>
            ))
          )}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {NOTE_VIEWS.map((v) => (
          <Pressable
            key={v}
            onPress={() => setFilters((f) => ({ ...f, view: v }))}
            accessibilityRole="button"
            accessibilityState={{ selected: filters.view === v }}
            style={{
              paddingVertical: 6,
              paddingHorizontal: 12,
              borderRadius: 999,
              backgroundColor: filters.view === v ? "#222" : "#eee",
            }}
          >
            <Text style={{ color: filters.view === v ? "white" : "#222" }}>{v}</Text>
          </Pressable>
        ))}
      </View>
      {error ? (
        // Without this an empty list is indistinguishable from a broken query -- which is
        // exactly how a silently-matching-nothing search index would present.
        <Text style={{ color: "crimson" }}>Could not read notes on this device.</Text>
      ) : null}
    </View>
  );

  return (
    <FlatList
      style={{ flex: 1 }}
      contentContainerStyle={{ gap: 12, padding: 16 }}
      data={notes}
      keyExtractor={(n) => n.id}
      renderItem={({ item }) => (
        <Link href={`/notes/${item.id}`} asChild>
          <Pressable style={{ paddingVertical: 12 }} accessibilityRole="link">
            <Text numberOfLines={2}>{item.title ?? item.content}</Text>
            <Text style={{ opacity: 0.6, fontSize: 12 }}>{item.lifecycle}</Text>
          </Pressable>
        </Link>
      )}
      ListHeaderComponent={listHeader}
      ListFooterComponent={footer}
      ListEmptyComponent={<Text style={{ opacity: 0.6 }}>Nothing here yet.</Text>}
      keyboardShouldPersistTaps="handled"
    />
  );
}
