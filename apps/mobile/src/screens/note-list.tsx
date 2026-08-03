import {
  NOTE_VIEWS,
  noteFiltersToSql,
  toSqlitePlaceholders,
  type NoteFilters,
} from "@cortex/shared";
import { useQuery } from "@powersync/react-native";
import { Link } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";

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
 */
export function NoteList() {
  const [filters, setFilters] = useState<NoteFilters>({ view: "inbox" });

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

  return (
    <View style={{ flex: 1, gap: 12, padding: 16 }}>
      <TextInput
        placeholder="Search"
        accessibilityLabel="Search notes"
        onChangeText={(q) =>
          // Spread-if rather than assigning undefined: `noteFiltersToSql` emits the FTS clause
          // on any truthy `q`, and a present-but-empty one would match nothing and empty the
          // list the moment the user cleared the box.
          setFilters((f) => {
            const trimmed = q.trim();
            const { q: _dropped, ...rest } = f;
            return trimmed ? { ...rest, q: trimmed } : rest;
          })
        }
        style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
      />
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
      <FlatList
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
        ListEmptyComponent={<Text style={{ opacity: 0.6 }}>Nothing here yet.</Text>}
      />
    </View>
  );
}
