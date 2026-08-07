import { useLocalSearchParams } from "expo-router";

import { NoteEditor } from "../../src/screens/note-editor";

export default function NoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <NoteEditor id={id} />;
}
