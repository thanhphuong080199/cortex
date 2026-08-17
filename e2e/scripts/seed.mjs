#!/usr/bin/env node
/**
 * Creates the E2E user, signs it in, and lays down the baseline corpus both suites assert
 * against. Prints one JSON object on stdout; the workflows read it with `jq`.
 *
 * DEPENDENCY-FREE ON PURPOSE. Node 22 has global fetch, and the Supabase auth admin API and
 * the Nest API are both plain HTTP. Reaching for @supabase/supabase-js would mean either a new
 * pnpm workspace entry (pnpm-workspace.yaml only globs apps/* and packages/*) or running this
 * from inside apps/web, which the mobile job has no business doing.
 *
 * WHY A PASSWORD USER WHEN THE PRODUCT IS GOOGLE-ONLY
 *
 * Both apps sign in with signInWithOAuth({provider:"google"}) and nothing else. Google's consent
 * screen cannot be driven from CI. This creates the user through the ADMIN api -- a path no
 * product code has -- and hands the resulting tokens to the tests. The apps' own sign-in code is
 * therefore NOT covered by E2E; that stays a manual check. Everything behind sign-in is covered,
 * which is the whole rest of the product.
 *
 * Usage: node e2e/scripts/seed.mjs [--reset]
 *   --reset  delete the user first, so the run starts from an empty corpus
 */

const SUPABASE_URL = required("SUPABASE_URL");
const SERVICE_ROLE = required("SUPABASE_SERVICE_ROLE_KEY");
const ANON = required("SUPABASE_ANON_KEY");
const API_URL = required("E2E_API_URL");

const EMAIL = process.env.E2E_EMAIL ?? "e2e@cortex.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-password-not-a-secret";

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[seed] missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

async function authFetch(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return res;
}

/**
 * Deletes the user if present, so `--reset` really starts from nothing.
 *
 * PAGINATES. A single-page `?page=1&per_page=200` read looked sufficient until this ran against
 * a local stack that had accumulated 5,000+ auth users over the project's history -- the e2e
 * user sat on page ~27, page 1 never contained it, and `--reset` silently deleted nothing while
 * still reporting success. createUser() then hit its normal 422-reuse path, so every run added a
 * new corpus onto the SAME account (observed: 7 copies of "Zarquon note" and "Edit target" on
 * this stack, which broke edit-persist.spec.ts and search-filter.spec.ts with `getByRole` strict
 * mode violations -- both real duplicate DOM elements, not an auth or Kong-routing failure).
 * Walking every page by email is the only way to find the row regardless of how large the
 * unrelated user table has grown.
 */
async function deleteExistingUser() {
  let page = 1;
  for (;;) {
    const res = await authFetch(`/admin/users?page=${page}&per_page=200`);
    if (!res.ok) throw new Error(`listing users failed (${res.status})`);
    const { users = [] } = await res.json();
    if (users.length === 0) break;
    for (const u of users.filter((u) => u.email === EMAIL)) {
      // Cascades to every row the user owns: notes.user_id and friends are
      // `references auth.users(id) on delete cascade` (00002_content.sql).
      const del = await authFetch(`/admin/users/${u.id}`, { method: "DELETE" });
      if (!del.ok) throw new Error(`deleting user ${u.id} failed (${del.status})`);
      console.error(`[seed] deleted existing user ${u.id}`);
    }
    if (users.length < 200) break;
    page++;
  }
}

/**
 * Puts the E2E address on the invite allow-list.
 *
 * 00008_invite_gate.sql puts a BEFORE INSERT trigger on auth.users that raises
 * "Signup not allowed for <email>" unless the address is in public.allowed_emails. The admin
 * API is not a way around it -- the trigger fires on the insert itself, whoever makes it -- so
 * the user simply cannot be created until this row exists.
 *
 * service_role is the only role with DML on that table (the same migration grants it, and
 * names seeding as the reason), so this goes through PostgREST rather than the auth API.
 * `resolution=merge-duplicates` makes a re-run a no-op instead of a 409.
 *
 * Lowercased because the table has `check (email = lower(email))`; the trigger compares
 * case-insensitively, but the column would reject a mixed-case row outright.
 */
async function allowEmail() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/allowed_emails`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ email: EMAIL.toLowerCase(), note: "E2E test user (e2e/scripts/seed.mjs)" }),
  });
  if (!res.ok) {
    throw new Error(`allow-listing ${EMAIL} failed (${res.status}): ${await res.text()}`);
  }
  console.error(`[seed] allow-listed ${EMAIL}`);
}

async function createUser() {
  // email_confirm: true because the local stack has no SMTP and an unconfirmed user cannot
  // sign in with a password at all.
  const res = await authFetch("/admin/users", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
  });
  if (res.ok) return (await res.json()).id;
  // 422 is "already registered", which is the normal path on a re-run without --reset.
  if (res.status === 422) {
    console.error("[seed] user already exists, reusing it");
    return null;
  }
  throw new Error(`creating user failed (${res.status}): ${await res.text()}`);
}

async function signIn() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`password sign-in failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Service-role PostgREST. Used only for rows no HTTP route can create (chat_messages). */
async function restInsert(table, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert ${table} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function restPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`patch ${table} -> ${res.status}: ${await res.text()}`);
}

async function api(path, method, token, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/**
 * The baseline corpus. Every string here is asserted somewhere, so they are deliberately
 * distinctive -- a search for "zarquon" must match exactly one note and nothing incidental.
 */
async function seedCorpus(token, userId) {
  const notes = {};

  // Three notes so "the list has >= 3" is true and view-switching has something to show.
  notes.searchTarget = await api("/notes", "POST", token, {
    content: "The zarquon protocol is what makes the reconnect deterministic.",
    title: "Zarquon note",
    domain: "learning",
  });
  notes.editTarget = await api("/notes", "POST", token, {
    content: "ORIGINALBODY waiting to be edited from the server side.",
    title: "Edit target",
  });
  notes.purgeTarget = await api("/notes", "POST", token, {
    content: "This note exists so a purge on the server can be watched from the device.",
    title: "Purge target",
  });
  notes.trashTarget = await api("/notes", "POST", token, {
    content: "This note gets trashed while the device is offline.",
    title: "Trash target",
  });
  notes.restoreTarget = await api("/notes", "POST", token, {
    content: "This note gets trashed and then restored while offline.",
    title: "Restore target",
  });
  notes.conflictTarget = await api("/notes", "POST", token, {
    content: "BASEBODY the conflict run starts from.",
    title: "Conflict target",
  });
  // Apostrophe on purpose: FTS5 treats a bare quote as syntax, so "don't" is the query that
  // proves the search input is being escaped rather than interpolated (mục 4 step 4).
  notes.apostrophe = await api("/notes", "POST", token, {
    content: "I don't want the tokenizer to choke on this apostrophe.",
    title: "Apostrophe note",
  });

  // A media item that already exists, so logging it again in DIFFERENT case must find-or-create
  // onto the SAME row rather than making a second one (mục 3).
  await api("/media-log", "POST", token, {
    // `movie`, not `film`: mediaKind is movie|tv|book|game|podcast (packages/shared/src/enums.ts).
    kind: "movie",
    title: "Dune",
    rating: 4,
    impression: "Seeded so the case-insensitivity check has something to collide with.",
  });

  // Stage C4: a conversation for the transcript pane, and a chitchat note that must appear in
  // the pane and NOT in the sidebar list. There is no HTTP route that writes chat_messages --
  // runTurn does, and driving a real turn would need a live model -- so these go in directly.
  //
  // TIME-SENSITIVE BY CONSTRUCTION. The pane shows the CURRENT session, which is a rolling
  // 4-hour idle window (SESSION_IDLE_RESET_MS). These rows are stamped now(), so the transcript
  // assertions hold for four hours after a seed and then stop. If the pane renders empty
  // locally, re-run this script; in CI the seed always runs immediately before the tests.
  const chitchatNote = await api("/notes", "POST", token, {
    content: "haha ok chitchat seeded turn",
    title: "Chitchat seed",
  });
  await restPatch("notes", `id=eq.${chitchatNote.id}`, { source_type: "chitchat" });

  const [chatSession] = await restInsert("chat_sessions", [{ user_id: userId }]);
  // Both rows carry `citations` (even the user one, which never has any) because PostgREST's
  // bulk insert requires every object in the array to have the SAME keys -- "All object keys
  // must match" (PGRST102) otherwise. Observed against the live local stack, not a theoretical
  // concern.
  await restInsert("chat_messages", [
    { user_id: userId, session_id: chatSession.id, role: "user",
      content: "haha ok chitchat seeded turn", citations: [] },
    // citations stays EMPTY on purpose: a seeded turn carrying note citations would render a
    // second "Từ notes của bạn" heading on the home page, and assistant-box.spec.ts's grounding
    // test matches that heading by role and name.
    { user_id: userId, session_id: chatSession.id, role: "assistant",
      content: "Hehe, seeded assistant reply.", citations: [] },
  ]);
  notes.chitchat = chitchatNote;

  return notes;
}

async function main() {
  if (process.argv.includes("--reset")) await deleteExistingUser();
  await allowEmail();
  await createUser();
  const session = await signIn();
  const notes = process.argv.includes("--no-corpus")
    ? {}
    : await seedCorpus(session.access_token, session.user.id);

  // stdout is the machine-readable channel; everything else above went to stderr so `jq` can
  // consume this cleanly.
  process.stdout.write(
    JSON.stringify(
      {
        userId: session.user.id,
        email: EMAIL,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        noteIds: Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, v.id])),
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  console.error("[seed]", err.message);
  process.exit(1);
});
