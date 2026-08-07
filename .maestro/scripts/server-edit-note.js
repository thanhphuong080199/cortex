// Edits a note on the SERVER while the device watches, standing in for "sửa 1 note trên web".
//
// It goes through the Nest API rather than straight at PostgREST because that is the path
// apps/web takes (apps/web/src/lib/api.ts), so the note passes through the same core services,
// the same validation and the same updated_at handling a real web edit would.
//
// No browser is involved and none is needed: what the device must observe is a row changing in
// Postgres and arriving over the sync stream. Driving Chromium to produce that same PATCH would
// add a second app's worth of flakiness to an assertion about the first app.

var res = http.request(API_URL + "/notes/" + NOTE_ID, {
  method: "PATCH",
  headers: {
    Authorization: "Bearer " + ACCESS_TOKEN,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ content: NEW_CONTENT }),
});

if (!res.ok) {
  throw new Error("PATCH /notes/" + NOTE_ID + " -> " + res.status + " " + res.body);
}
