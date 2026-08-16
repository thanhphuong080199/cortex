// Mục 3 — "log a title already in the library, in different case: ONE media item, TWO notes
// pointing at it".
//
// This has to be checked on the server. The device cannot answer it: find-or-create runs in
// MediaService when the upload is resolved (spec §5.3), and until then the device holds only a
// `pending_item` blob in domain_meta. Asserting on the phone would pass even if the server made
// a duplicate row.
//
// runScript executes on the HOST, not on the device, which is the property that makes this file
// -- and the offline flows later -- possible at all: the emulator's network can be off while
// these requests still reach Supabase.
//
// NOT CURRENTLY INVOKED by any automated flow: media logging depends on a real model call to
// resolve `pending_item`, and e2e-mobile.yml pins GEMINI_API_KEY to a dummy value on purpose
// (no E2E run may reach the real Gemini API), so that extraction can never succeed in CI. See
// the "media dedup: not exercised here" note in 02-online-basics.yaml. This file is left in
// place because it is still correct, for whenever a real key becomes available to some flow.

var REST = SUPABASE_URL + "/rest/v1";

function get(path) {
  var res = http.get(REST + path, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      // The USER's token, so PostgREST applies RLS exactly as apps/web's reads do. A
      // service-role key here would prove the row exists while saying nothing about whether the
      // owner can see it.
      Authorization: "Bearer " + ACCESS_TOKEN,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error("GET " + path + " -> " + res.status + " " + res.body);
  }
  return json(res.body);
}

// The media log was written locally and uploads asynchronously, so poll rather than assume it
// has landed. Each request costs real time, which paces the loop without a sleep primitive
// (Maestro's JS runtime has no setTimeout).
var items = [];
var notes = [];
var attempts = 0;

while (attempts < 40) {
  attempts++;
  // `ilike` rather than `eq`, because the whole point is that "Dune" and "dune" collapsed.
  items = get("/media_items?select=id,title,kind&title=ilike.dune&deleted_at=is.null");
  if (items.length === 1) {
    notes = get(
      "/notes?select=id,content&media_item_id=eq." + items[0].id + "&deleted_at=is.null"
    );
    if (notes.length >= 2) break;
  }
}

if (items.length !== 1) {
  throw new Error(
    "expected exactly 1 media_item titled 'dune' (case-insensitive), found " +
      items.length +
      ": " +
      JSON.stringify(items)
  );
}

if (notes.length !== 2) {
  throw new Error(
    "expected exactly 2 notes pointing at media_item " +
      items[0].id +
      ", found " +
      notes.length +
      ": " +
      JSON.stringify(notes)
  );
}

// The stored title keeps the casing the SEED used, because find-or-create matched an existing
// row rather than inserting the device's spelling.
if (items[0].title !== "Dune") {
  throw new Error("expected the seeded casing 'Dune' to win, got '" + items[0].title + "'");
}

output.mediaItemId = items[0].id;
