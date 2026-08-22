// Post-reconnect assertions the device cannot make about itself: exact row counts, and whether
// created_at kept the capture time.
//
// Runs on the HOST against PostgREST, with the USER's token so RLS applies exactly as the app's
// own reads do. A service-role key here would prove rows exist while saying nothing about
// whether their owner can see them.
//
// Retired on 2026-08-22 alongside 04a's trash/restore/conflict sections: the trashed-note and
// conflict-copy assertions that used to live here counted server state 04a no longer creates
// (no offline trash, no offline restore, no device-side edit to conflict with -- see 04a's own
// retirement comment). What's left are the two properties 04a still stages: the offline capture
// uploading, and the double-tapped Send collapsing to one note.

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

output.capturedNoteId = captured[0].id;
