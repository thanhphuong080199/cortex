// Post-reconnect assertions the device cannot make about itself: exact row counts, the shape of
// the conflict copy, and whether created_at kept the capture time.
//
// Runs on the HOST against PostgREST, with the USER's token so RLS applies exactly as the app's
// own reads do. A service-role key here would prove rows exist while saying nothing about
// whether their owner can see them.

var REST = SUPABASE_URL + "/rest/v1";

function get(path) {
  var res = http.get(REST + path, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + ACCESS_TOKEN,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error("GET " + path + " -> " + res.status + " " + res.body);
  return json(res.body);
}

// The upload queue drains asynchronously after the radios return, so poll rather than assume.
// Each HTTP call costs real time, which paces the loop -- Maestro's JS runtime has no
// setTimeout and no sleep.
function eventually(fn, label) {
  for (var i = 0; i < 60; i++) {
    var v = fn();
    if (v !== null) return v;
  }
  throw new Error("timed out waiting for: " + label);
}

function q(s) {
  return encodeURIComponent(s);
}

/* ---- 1. the offline capture uploaded, exactly once ---- */
var captured = eventually(function () {
  var r = get("/notes?select=id,created_at&content=eq." + q(CAPTURE_MARKER) + "&deleted_at=is.null");
  return r.length === 1 ? r : null;
}, "the offline capture to upload exactly once");

/* ---- 5. the double-tapped Send produced ONE note ---- */
// Waited for rather than read once: an extra note from a lost in-flight race would arrive a
// moment later, and reading too early would call that a pass.
var dbl = eventually(function () {
  var r = get("/notes?select=id&content=eq." + q(DOUBLE_TAP_MARKER) + "&deleted_at=is.null");
  return r.length >= 1 ? r : null;
}, "the double-tapped capture to upload");
if (dbl.length !== 1) {
  throw new Error(
    "double-tapped Save produced " + dbl.length + " notes; the in-flight guard did not hold"
  );
}

/* ---- 7. the conflict copy ---- */
var original = get("/notes?select=id,content,lifecycle&id=eq." + NOTE_CONFLICT_TARGET);
if (original.length !== 1) {
  throw new Error("the original conflict note is gone from the server entirely");
}
if (original[0].content.indexOf("SERVERBODY") !== 0) {
  throw new Error(
    "the original note must keep the WEB body; it holds: " + original[0].content
  );
}

var copies = eventually(function () {
  var r = get("/notes?select=id,content,lifecycle&content=like.DEVICEBODY*&deleted_at=is.null");
  return r.length >= 1 ? r : null;
}, "the conflict copy carrying the device body");

if (copies.length !== 1) {
  throw new Error("expected exactly 1 conflict copy, found " + copies.length);
}
if (copies[0].id === NOTE_CONFLICT_TARGET) {
  // The failure this whole run exists to catch: the device's edit applied on top of the
  // server's instead of forking, i.e. silent last-write-wins.
  throw new Error("the device body overwrote the original rather than making a copy");
}
if (copies[0].lifecycle !== "inbox") {
  throw new Error("the conflict copy must land in inbox, got: " + copies[0].lifecycle);
}

/* ---- 2. the offline trash stuck ---- */
var trashed = eventually(function () {
  var r = get("/notes?select=id,deleted_at&id=eq." + NOTE_TRASH_TARGET);
  return r.length === 1 && r[0].deleted_at !== null ? r : null;
}, "the offline trash to reach the server and stay");

/* ---- 3. the offline trash-then-restore netted out to "not trashed" ---- */
// Two ops on one row, queued in order. A server that applied them out of order, or that kept
// only the first, would leave this note in the trash -- and on the device it would silently
// vanish from every view except `trash`, which is indistinguishable from it never having been
// restored at all.
eventually(function () {
  var r = get("/notes?select=id,deleted_at&id=eq." + NOTE_RESTORE_TARGET);
  if (r.length !== 1) throw new Error("the restored note is gone from the server entirely");
  return r[0].deleted_at === null ? r : null;
}, "the offline restore to win over the offline trash on the same row");

/* ---- 8. undo left nothing behind ---- */
// 02 logged a mood through the assistant box and undid it. A check-in surviving here means undo
// produced no local delete, or produced one PowerSync never uploaded -- the failure the local
// mirror in lib/checkins.ts exists to prevent.
var checkins = get("/checkins?select=id&mood=eq.2&deleted_at=is.null");
if (checkins.length !== 0) {
  throw new Error("undo left " + checkins.length + " check-in(s) on the server");
}

/* ---- mục 5. created_at is the CAPTURE time, not the upload time ---- */
// The note was captured minutes before the radios came back. If created_at were stamped when
// the server received it, it would be seconds old rather than minutes.
var ageMs = Date.now() - Date.parse(captured[0].created_at);
if (ageMs < 20000) {
  throw new Error(
    "created_at looks like the reconnect time (" +
      ageMs +
      "ms ago), not the capture time -- an offline note is being re-stamped on upload"
  );
}

output.conflictCopyId = copies[0].id;
output.capturedNoteId = captured[0].id;
