import { noteLifecycle, type NoteLifecycle } from "@cortex/shared";
import { usePowerSync, useQuery } from "@powersync/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { recordEditBase } from "../lib/edit-base";
import { setNoteLifecycle, trashNote, updateNoteContent } from "../lib/note-edits";

const SAVE_DEBOUNCE_MS = 800;

interface NoteRow {
  id: string;
  title: string | null;
  content: string;
  lifecycle: string;
  updated_at: string;
  deleted_at: string | null;
}

export function NoteEditor({ id }: { id: string }) {
  const db = usePowerSync();
  const { data: rows = [] } = useQuery<NoteRow>(
    "SELECT id, title, content, lifecycle, updated_at, deleted_at FROM notes WHERE id = ?",
    [id],
  );
  const note = rows[0];

  const [content, setContent] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The `updated_at` of the row whose body was seeded into the box — captured at seed time and
   * never refreshed.
   *
   * Reading `note.updated_at` at save time instead would be wrong in the one case that
   * matters. The content is seeded once and then left alone, so a change arriving from the
   * server mid-session advances `notes.updated_at` while the text on screen still reflects the
   * OLDER body. Recording that newer value as the base tells the server the user edited the
   * current version; its `moved` check finds nothing, no conflict copy is made, and the
   * stale-based edit silently overwrites the newer one — which is exactly the outcome spec
   * §6.2 exists to prevent, arriving through the mechanism meant to prevent it.
   */
  const sessionBase = useRef<string | null>(null);

  // Seed once. Re-seeding on every synced change would clobber what the user is typing.
  useEffect(() => {
    if (note && content === null) {
      setContent(note.content);
      sessionBase.current = note.updated_at;
    }
  }, [note, content]);

  async function save(next: string) {
    const base = sessionBase.current;
    // Unreachable while the input only renders after seeding (below), and deliberately kept:
    // saving with no base is worse than not saving, because the upload then carries no base at
    // all and the server cannot detect a conflict on it.
    if (!base) return;
    // Base first: if the write lands and the base does not, the upload carries no base and the
    // server cannot detect the conflict at all.
    await recordEditBase(db, id, base);
    await updateNoteContent(db, id, next);
  }

  function onChange(next: string) {
    setContent(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void save(next);
    }, SAVE_DEBOUNCE_MS);
  }

  // Deliberately NOT cleared on unmount. The pending timer is the user's last keystrokes; the
  // closure holds `db` and `id`, both still valid after this screen goes away, so letting it
  // fire saves the edit. Cancelling it would discard up to SAVE_DEBOUNCE_MS of typing every
  // time someone navigates back quickly.

  if (!note) return <Text style={{ padding: 16 }}>Note not found on this device.</Text>;

  /**
   * No editable box until the body AND the base are seeded, which happens together in the effect
   * above.
   *
   * Rendering the input first is a silent data-loss window, not just a cosmetic flash of an
   * empty note. A keystroke landing between the first commit and that effect sets `content`, so
   * `content === null` is false forever after and the effect never seeds `sessionBase` -- and
   * `save` then returns early on every keystroke for the rest of the session. The user types a
   * whole note into a box that writes nothing and reports nothing.
   */
  if (content === null) return <Text style={{ padding: 16 }}>Opening…</Text>;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <TextInput
        value={content}
        onChangeText={onChange}
        multiline
        accessibilityLabel="Note content"
        style={{
          minHeight: 240,
          borderWidth: 1,
          borderColor: "#ccc",
          borderRadius: 8,
          padding: 12,
        }}
      />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {noteLifecycle.options.map((l: NoteLifecycle) => (
          <Pressable
            key={l}
            onPress={() => {
              void setNoteLifecycle(db, id, l);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: note.lifecycle === l }}
            style={{
              paddingVertical: 8,
              paddingHorizontal: 14,
              borderRadius: 999,
              backgroundColor: note.lifecycle === l ? "#222" : "#eee",
            }}
          >
            <Text style={{ color: note.lifecycle === l ? "white" : "#222" }}>{l}</Text>
          </Pressable>
        ))}
        {note.deleted_at ? (
          <Text style={{ alignSelf: "center", opacity: 0.6 }}>In trash</Text>
        ) : (
          <Pressable
            onPress={() => {
              void trashNote(db, id);
            }}
            accessibilityRole="button"
            style={{
              paddingVertical: 8,
              paddingHorizontal: 14,
              borderRadius: 999,
              backgroundColor: "#fee",
            }}
          >
            <Text style={{ color: "#900" }}>Trash</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}
