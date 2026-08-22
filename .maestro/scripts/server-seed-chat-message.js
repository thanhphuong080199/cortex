// Seeds a chat_sessions row and a chat_messages row directly, standing in for a server-written
// turn arriving while the device watches -- the mobile counterpart of "sửa 1 note trên web" now
// that chat_messages, not notes, is what the screen renders (S1 §1, §4).
//
// There is no Nest API route for chat_messages: runTurn() writes it, and driving a real turn
// would need a live model call, which no E2E run is allowed to make (see
// e2e/scripts/seed.mjs's own comment on the identical gap). So this goes straight at PostgREST,
// the same target scripts/assert-offline-results.js reads from.
//
// Auth follows scripts/server-edit-note.js exactly where it can: the TEST USER's own token, not
// service role -- chat_sessions_own / chat_messages_own (00006_synthesis_chat.sql) grant
// authenticated full CRUD on rows it owns, so nothing here needs a wider credential. The one
// thing server-edit-note.js's PATCH never had to do is resolve a user id; GET /me
// (apps/api/src/me.controller.ts) is the one place this token resolves to one, reached the same
// way server-edit-note.js reaches the API -- API_URL + "Bearer " + ACCESS_TOKEN.

var meRes = http.get(API_URL + "/me", {
  headers: { Authorization: "Bearer " + ACCESS_TOKEN },
});
if (!meRes.ok) {
  throw new Error("GET /me -> " + meRes.status + " " + meRes.body);
}
var userId = json(meRes.body).id;

var REST = SUPABASE_URL + "/rest/v1";
var restHeaders = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: "Bearer " + ACCESS_TOKEN,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

var sessionRes = http.request(REST + "/chat_sessions", {
  method: "POST",
  headers: restHeaders,
  body: JSON.stringify({ user_id: userId }),
});
if (!sessionRes.ok) {
  throw new Error("POST /chat_sessions -> " + sessionRes.status + " " + sessionRes.body);
}
var session = json(sessionRes.body)[0];

// citations included (even though this is a `user` row, which never has any): PostgREST's
// insert requires no such thing for a single-object body, but the shape matches
// e2e/scripts/seed.mjs's own chat_messages inserts so the two seeding paths stay in step.
var messageRes = http.request(REST + "/chat_messages", {
  method: "POST",
  headers: restHeaders,
  body: JSON.stringify({
    user_id: userId,
    session_id: session.id,
    role: "user",
    content: CONTENT,
    citations: [],
  }),
});
if (!messageRes.ok) {
  throw new Error("POST /chat_messages -> " + messageRes.status + " " + messageRes.body);
}
