import {
  attachTagInput, createCheckinInput, createNoteInput, createTagInput, logMediaInput, searchInput, updateNoteInput,
  type AttachTagInput, type CreateCheckinInput, type CreateNoteInput, type CreateTagInput,
  type LogMediaInput, type SearchInput, type SearchResult, type UpdateNoteInput,
} from "@cortex/shared";
import type { ZodType } from "zod";

// Re-exported, not redeclared: SearchResult lives in @cortex/shared beside searchInput, so the
// server's response type and this client's expectation are one declaration rather than two that
// typecheck independently while disagreeing. The re-export keeps `import type { SearchResult }
// from "@/lib/api"` working for search-form.tsx -- api.ts is where this app's callers already
// look for the shapes these methods return.
export type { SearchResult };

export class ApiError extends Error {
  constructor(public status: number, public issues?: unknown) { super(`API ${status}`); }
}

async function send(path: string, method: string, token: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const parsed = await res.json().catch(() => undefined) as { issues?: unknown } | undefined;
    throw new ApiError(res.status, parsed?.issues);
  }
  return res.json();
}

// The same zod schemas the API validates with (packages/shared/src/dto), applied before
// the request leaves the browser -- a bad payload fails instantly instead of round-tripping.
// status 0 marks a local failure, distinguishing it from any HTTP status.
function validated<T>(schema: ZodType<T>, value: T): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiError(0, r.error.issues);
  return r.data;
}

// Every method is async so that a local validation failure REJECTS rather than throwing
// synchronously -- otherwise `api.createNote(...).catch(...)` would miss it entirely and
// the throw would escape the caller's promise chain.
export const api = {
  createNote: async (token: string, input: CreateNoteInput) =>
    send("/notes", "POST", token, validated(createNoteInput, input)) as Promise<{ id: string }>,
  updateNote: async (token: string, id: string, input: UpdateNoteInput) =>
    send(`/notes/${id}`, "PATCH", token, validated(updateNoteInput, input)),
  deleteNote: async (token: string, id: string) => send(`/notes/${id}`, "DELETE", token),
  restoreNote: async (token: string, id: string) => send(`/notes/${id}/restore`, "POST", token),
  purgeNote: async (token: string, id: string) => send(`/notes/${id}/purge`, "DELETE", token),
  createTag: async (token: string, input: CreateTagInput) =>
    send("/tags", "POST", token, validated(createTagInput, input)),
  attachTag: async (token: string, noteId: string, input: AttachTagInput) =>
    send(`/notes/${noteId}/tags`, "POST", token, validated(attachTagInput, input)),
  detachTag: async (token: string, noteId: string, tagId: string) =>
    send(`/notes/${noteId}/tags/${tagId}`, "DELETE", token),
  createCheckin: async (token: string, input: CreateCheckinInput) =>
    send("/checkins", "POST", token, validated(createCheckinInput, input)) as Promise<{ id: string }>,
  deleteCheckin: async (token: string, id: string) => send(`/checkins/${id}`, "DELETE", token),
  logMedia: async (token: string, input: LogMediaInput) =>
    send("/media-log", "POST", token, validated(logMediaInput, input)),
  search: async (token: string, input: SearchInput) =>
    (await send("/search", "POST", token, validated(searchInput, input)) as { results: SearchResult[] }).results,
};
