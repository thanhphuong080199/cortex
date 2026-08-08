# Phase 1b Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the fourteen ledgered minors left from phase 1b, reconcile the docs that now
state things that are false, filter the `checkins` sync rule, and move both E2E suites behind
the merge with the APK build chained after them.

**Architecture:** Three independent PRs off `chore/phase-1b-closeout`, split by whether they
carry a deploy. PR 1 is code and docs only. PR 2 is one line of YAML plus the isolation test
that proves it, isolated because sync rules deploy to PowerSync Cloud from outside this repo
and no CI gate can catch a bad one. PR 3 converts three workflows to `workflow_call` and adds
one orchestrator.

**Tech Stack:** TypeScript, pnpm + Turborepo, NestJS (`apps/api`), Expo/React Native
(`apps/mobile`), Next.js (`apps/web`), Supabase Postgres + PostgREST, PowerSync, vitest,
Maestro, Playwright, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-07-cleanup-batch-and-post-merge-e2e-design.md`

## Global Constraints

- **Branch:** all work happens on `chore/phase-1b-closeout`, which already exists and holds
  the spec commit `cf0a4b5`. Never commit to `main`.
- **The full gate is `pnpm turbo run typecheck lint test --force`.** Read the `Cached:` line
  in the output before reporting a result — `26/26 successful` can be 23 replays, and a run
  with replays did not run.
- **Package tests always go through turbo:** `pnpm turbo run test --filter=<pkg>`. Never
  `pnpm --filter <pkg> test`, which bypasses the dependency graph and tests whatever stale
  `dist/` is lying around.
- **`@cortex/db`, `@cortex/api` and `@cortex/core` tests need the local Supabase stack**
  (`npx supabase start`). If a mass authentication failure appears immediately after a
  `supabase db reset` — `AuthRetryableFetchError`, dozens of suites failing at once — it is
  stale Docker DNS in Kong, not a code regression: `docker restart supabase_kong_phase-0-foundations`.
- **The Supabase CLI is a devDependency:** `npx supabase`, never a bare `supabase`.
- **No new test suite is added by this plan**, so no new `ci.yml` step is needed. If you find
  yourself creating a new package-level suite anyway, add its named step to `ci.yml` in the
  same task — the `checks` job filters `test` per package, so an unnamed suite runs nowhere
  but your machine.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Three tasks carry a test that would pass with the bug present if written naively** —
  Tasks 4, 5 and 7. Each requires the test to be observed FAILING before the fix, and the
  commit message must say so. This is not ceremony: round 2 finding #2 was exactly this
  defect shipping unnoticed.

---

# PR 1 — the fourteen

## Task 1: A media link must not attach to a trashed note, and its meta must be validated

**Files:**
- Modify: `packages/core/src/media/service.ts:140-143`
- Test: `packages/core/src/media/resolve-link.test.ts`

**Interfaces:**
- Consumes: `MediaService.resolveNoteMediaLink(noteId: string, meta: Record<string, unknown>): Promise<MediaItem | null>`, `NoteService.softDelete(id: string)`, the `makeUser` / `createUserClient` harness already imported by this test file.
- Produces: no signature change. `resolveNoteMediaLink` gains two failure modes — `not_found` for a trashed note, `validation` for meta the domain rejects.

- [ ] **Step 1: Write the two failing tests**

Append inside the existing `describe("MediaService.resolveNoteMediaLink", ...)` block in
`packages/core/src/media/resolve-link.test.ts`:

```ts
  /**
   * `NoteService.update`, `getById` and `softDelete` all carry `.is("deleted_at", null)`;
   * this update did not, so a note the user had already trashed could still be stamped with
   * a media_item_id -- and the item it just created stayed behind as an orphan, because the
   * compensation below only runs when the update matches zero rows.
   */
  it("refuses to link a media item to a trashed note", async () => {
    const title = `Stalker ${Date.now()}`;
    const note = await offlineMediaNote({ kind: "movie", title });
    await notes.softDelete(note.id);

    await expect(media.resolveNoteMediaLink(note.id, {
      status: "finished", pending_item: { kind: "movie", title },
    })).rejects.toMatchObject({ kind: "not_found" });

    // The compensation path must have fired: the item created moments ago is gone.
    const { data } = await createUserClient(alice.token).from("media_items")
      .select("id").eq("user_id", alice.id).eq("title", title);
    expect(data).toEqual([]);
  });

  /**
   * `cleaned` went straight into the jsonb column. Every other write path runs
   * validateDomainMeta first, so this was the one route by which a device could store meta
   * that domainMetaSchemas.media rejects -- which phase 2 then has to read back.
   */
  it("rejects meta the media domain's schema does not accept", async () => {
    const title = `Stalker meta ${Date.now()}`;
    const note = await offlineMediaNote({ kind: "movie", title });

    await expect(media.resolveNoteMediaLink(note.id, {
      status: "not-a-real-status",
      pending_item: { kind: "movie", title },
    })).rejects.toMatchObject({ kind: "validation" });
  });
```

- [ ] **Step 2: Run them and confirm both fail**

```bash
pnpm turbo run test --filter=@cortex/core -- resolve-link
```

Expected: `refuses to link a media item to a trashed note` fails because the call **resolves**
instead of rejecting. `rejects meta the media domain's schema does not accept` fails the same
way. If either passes here, stop — the test is not connected to the behaviour.

- [ ] **Step 3: Add the `deleted_at` guard and the validation**

In `packages/core/src/media/service.ts`, replace lines 137-143 with:

```ts
    // pending_item is scaffolding, not data: leaving it behind would make the note
    // re-resolve on every subsequent upload.
    const { pending_item: _resolved, ...cleaned } = meta;

    // Every other write path validates before storing (NoteService.create/createWithId/
    // update). This one did not, so the sync router was a route by which a device could
    // put meta into the column that domainMetaSchemas.media rejects -- and phase 2 is what
    // has to read it back. Validated against "media" specifically: resolveNoteMediaLink is
    // only ever reached for a media note, since pending_item is a member of that schema
    // alone.
    const check = validateDomainMeta("media", cleaned);
    if (!check.success) {
      if (created) {
        await this.client.from("media_items").delete()
          .eq("id", item.id).eq("user_id", this.userId)
          .then(() => undefined, () => undefined);
      }
      throw {
        kind: "validation",
        message: "domain_meta does not fit domain \"media\"",
        cause: check.error,
      } as const;
    }

    const { data, error } = await this.client.from("notes")
      .update({ media_item_id: item.id, domain_meta: cleaned })
      // `.is("deleted_at", null)` matches NoteService.update/getById/softDelete. Without it a
      // trashed note still matched, so a link attached to a note the user had thrown away.
      // With it the row count is zero and the compensation below fires, which is the already
      // -tested behaviour for "this note cannot receive the link".
      .eq("id", noteId).eq("user_id", this.userId).is("deleted_at", null)
      .select("id").maybeSingle();
```

Add `validateDomainMeta` to the existing `@cortex/shared` import on line 2:

```ts
import { pendingMediaItem, validateDomainMeta, type LogMediaInput } from "@cortex/shared";
```

- [ ] **Step 4: Run them and confirm both pass**

```bash
pnpm turbo run test --filter=@cortex/core -- resolve-link
```

Expected: PASS, and every pre-existing test in the file still passes — in particular
"deletes the item it just created when the note cannot be updated" and "leaves a pre-existing
item alone when the note cannot be updated", which exercise the same compensation branch.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/media/service.ts packages/core/src/media/resolve-link.test.ts
git commit -F - <<'EOF'
fix(core): a media link could attach to a trashed note, with its meta unvalidated

resolveNoteMediaLink's notes update carried only .eq("id") and .eq("user_id"), unlike
NoteService.update/getById/softDelete which all also filter deleted_at -- so a note the user
had already trashed still matched, and the media_items row created moments earlier stayed
behind because the compensation only fires on a zero-row update.

The same statement wrote the client's domain_meta straight into jsonb. Every other write path
runs validateDomainMeta first; this was the one route by which a device could store meta the
media schema rejects, and phase 2 is what has to read it back.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 2: A conflict copy must keep the note's domain, meta and media item

**Files:**
- Modify: `packages/core/src/notes/service.ts:196-217`
- Test: `packages/core/src/notes/conflict-copy.test.ts`

**Interfaces:**
- Consumes: `NoteService.updateWithConflictCopy(id, input, baseContent, opId)`, `NoteService.getById(id)`.
- Produces: no signature change. The `conflictCopy` in the return value now carries `domain`, `domain_meta` and `media_item_id` copied from the server row.

- [ ] **Step 1: Write the failing test**

Append inside `describe("NoteService.updateWithConflictCopy", ...)` in
`packages/core/src/notes/conflict-copy.test.ts`. The file's service is named `svc`, not
`notes` (`conflict-copy.test.ts:7,11`):

```ts
  /**
   * The copy is the phone's text, and it is the only place that text exists. Built from
   * content and title alone it lands with domain null -- so it does not appear under the
   * domain filter the user would look in, and a media log's copy loses the item it was
   * about. Everything except the body is carried over, exactly as the surviving note's
   * metadata is.
   */
  it("carries domain, domain_meta and media_item_id onto the conflict copy", async () => {
    const note = await svc.create({
      content: "server body",
      domain: "media",
      domainMeta: { status: "finished", rating: 4 },
    });

    const { conflictCopy } = await svc.updateWithConflictCopy(
      note.id,
      { content: "phone body" },
      "the body the phone started from",
      "op-domain-carry",
    );

    expect(conflictCopy).not.toBeNull();
    const stored = await svc.getById(conflictCopy!.id);
    expect(stored.content).toBe("phone body");
    expect(stored.domain).toBe("media");
    expect(stored.domain_meta).toMatchObject({ status: "finished", rating: 4 });
  });
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm turbo run test --filter=@cortex/core -- conflict-copy
```

Expected: FAIL on `expect(stored.domain).toBe("media")` — received `null`.

- [ ] **Step 3: Widen the read and pass the columns through**

In `packages/core/src/notes/service.ts`, change the select on line 197 from
`.select("content, title")` to:

```ts
      .select("content, title, domain, domain_meta, media_item_id")
```

and replace the `createWithId` call on lines 214-217 with:

```ts
    const conflictCopy = await this.createWithId(conflictCopyId(this.userId, id, opId), {
      content: input.content,
      title: current.title ?? undefined,
      // Everything except the body. A copy with a null domain does not appear under the
      // domain filter the user would go looking in, and a media log's copy loses the item it
      // was about. `current` is the SERVER row, whose meta already satisfies its own domain,
      // so createWithId's validateDomainMeta cannot reject what it just read back.
      domain: (current.domain ?? undefined) as CreateNoteInput["domain"],
      domainMeta: (current.domain_meta ?? {}) as Record<string, unknown>,
      ...(current.media_item_id ? { mediaItemId: current.media_item_id as string } : {}),
    });
```

`CreateNoteInput` is already imported on line 3, so no import change is needed. The cast is
there because the widened `.select(...)` string leaves PostgREST's inferred row type as
`string | null` for `domain`, not the `NoteDomain` union.

- [ ] **Step 4: Run it and confirm it passes**

```bash
pnpm turbo run test --filter=@cortex/core -- conflict-copy
```

Expected: PASS, with every existing conflict-copy test still green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/notes/service.ts packages/core/src/notes/conflict-copy.test.ts
git commit -F - <<'EOF'
fix(core): a conflict copy lost the note's domain, meta and media item

The copy was built from content and title alone, so it landed with domain null -- invisible
under the domain filter the user would look in, and a media log's copy lost the item it was
about. The copy is the phone's text and the only place that text exists, so it should carry
everything except the body, mirroring what the surviving note keeps.

`current` is the server row, whose meta already satisfies its own domain, so createWithId's
validateDomainMeta cannot reject what was just read back.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 3: Trash and restore need the guards the server already has

**Files:**
- Modify: `apps/mobile/src/lib/note-edits.ts:31,33`
- Test: `apps/mobile/src/lib/edit-base.test.ts`

**Interfaces:**
- Consumes: `trashNote(target, id)` and `restoreNote(target, id)` — both take a `NoteEditTarget`, which `edit-base.test.ts` builds with its `target(db)` helper (`edit-base.test.ts:27-34`), never the raw `Database`.
- Produces: `TRASH_NOTE_SQL` and `RESTORE_NOTE_SQL` become no-ops against a row already in the target state.

- [ ] **Step 1: Write the two failing tests**

Append inside `describe("the editor's local mutations", ...)` in
`apps/mobile/src/lib/edit-base.test.ts`. The file's own names: `db` is the `Database.Database`
from `beforeEach`, `target(db)` wraps it as a `NoteEditTarget`, the fixture note's id is the
literal `'n1'`, `note()` reads it back, and `T0 = "2026-08-02T10:00:00.000Z"` is the timestamp
`beforeEach` inserts it with.

```ts
  /**
   * Every local UPDATE becomes a PowerSync PATCH. Re-trashing an already-trashed note
   * therefore costs a server round trip for a change that changes nothing -- and it re-stamps
   * updated_at, reordering the row against genuine edits. `NoteService.softDelete` carries
   * `.is("deleted_at", null)` for the same reason; the device statement did not.
   *
   * The already-trashed state is SEEDED with fixed timestamps rather than produced by calling
   * trashNote twice. NOW_ISO is `strftime('%Y-%m-%dT%H:%M:%fZ','now')` (sql.ts:24) --
   * millisecond resolution -- so two calls inside one test can land on the same millisecond and
   * the assertion would then hold whether or not the guard exists. Seeding T0 makes the two
   * outcomes impossible to confuse.
   */
  it("does not re-stamp a note that is already trashed", async () => {
    db.prepare("UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = 'n1'").run(T0, T0);

    await trashNote(target(db), "n1");

    expect(note().deleted_at).toBe(T0);
    expect(note().updated_at).toBe(T0);
  });

  it("does not re-stamp a note that is already live", async () => {
    // The fixture note is live already: beforeEach inserts it with deleted_at NULL and
    // updated_at = T0.
    await restoreNote(target(db), "n1");

    expect(note().updated_at).toBe(T0);
  });
```

- [ ] **Step 2: Run them and confirm both fail**

```bash
pnpm turbo run test --filter=@cortex/mobile -- edit-base
```

Expected: both FAIL. The unguarded statements stamp the current time, so `updated_at` is a
2026-08-07-or-later `strftime` value rather than `T0`, and the first test's `deleted_at`
moves off `T0` as well. Neither can pass vacuously — the expected value is a constant the
statement under test can never produce.

- [ ] **Step 3: Add the guards**

In `apps/mobile/src/lib/note-edits.ts`, replace lines 26-33 with:

```ts
/**
 * Soft delete, never a real one: the row has to survive so the deletion replicates and so the
 * trash view has something to show. `deleted_at` and `updated_at` are stamped together — a
 * delete that does not move `updated_at` is a change the server cannot order against others.
 *
 * The `IS NULL` / `IS NOT NULL` guards make each statement a no-op against a row already in
 * the target state, matching `NoteService.softDelete` and `NoteService.restore`. Without them
 * a repeat tap re-stamps both columns, and since PowerSync emits every local UPDATE as a
 * PATCH, that is a server round trip for nothing plus an `updated_at` that reorders the row
 * against edits that really happened.
 */
export const TRASH_NOTE_SQL = `UPDATE notes SET deleted_at = ${NOW_ISO}, updated_at = ${NOW_ISO} WHERE id = ? AND deleted_at IS NULL`;

export const RESTORE_NOTE_SQL = `UPDATE notes SET deleted_at = NULL, updated_at = ${NOW_ISO} WHERE id = ? AND deleted_at IS NOT NULL`;
```

- [ ] **Step 4: Run them and confirm both pass**

```bash
pnpm turbo run test --filter=@cortex/mobile -- edit-base
```

Expected: PASS. The existing "restores a trashed note by clearing deleted_at" test must also
still pass — it restores a note that IS trashed, so the new guard does not exclude it.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/note-edits.ts apps/mobile/src/lib/edit-base.test.ts
git commit -F - <<'EOF'
fix(mobile): re-trashing an already-trashed note emitted a PATCH for nothing

PowerSync turns every local UPDATE into a PATCH, so a repeat tap re-stamped deleted_at and
updated_at and shipped both to the server -- a round trip for a change that changed nothing,
and a fresh updated_at that reorders the row against edits that really happened.

Guards on both statements, matching NoteService.softDelete and NoteService.restore, which have
carried them all along. RESTORE_NOTE_SQL had the mirror-image gap.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 4: The edit base belongs only to ops that change the body

> **This is one of the three tests that passes with the bug present if written naively.** A
> test that queues ONE op cannot fail: with a single op there is no wrong op to attach the
> base to. Two ops for the same note must be queued before the upload.

**Files:**
- Modify: `apps/mobile/src/lib/connector.ts:30-41`
- Test: `apps/mobile/src/lib/connector.test.ts`

**Interfaces:**
- Consumes: `crudEntryToSyncOp(entry: CrudEntry, baseContent?: string): SyncOp`, and the `database(crud, opts)` helper already defined in `connector.test.ts:110-125`.
- Produces: `crudEntryToSyncOp` attaches `base_content` only when `entry.opData` has a `content` key. Signature unchanged.

- [ ] **Step 1: Write the failing tests**

Add to the `describe("crudEntryToSyncOp", ...)` block:

```ts
  /**
   * The connector keys bases by note id and hands the same one to every op for that note. A
   * lifecycle change is a notes PATCH too, so it collected the body's base -- and the server
   * reads a base as "this edit was based on that revision", manufacturing a conflict copy for
   * a change that never touched the body.
   */
  it("never attaches a base to a PATCH that does not change the body", () => {
    const op = crudEntryToSyncOp(
      { clientId: 9, op: "PATCH", table: "notes", id, opData: { lifecycle: "archived" } } as never,
      base,
    );
    expect(op.base_content).toBeUndefined();
    expect(Object.hasOwn(op, "base_content")).toBe(false);
  });

  it("still attaches a base when the body changes alongside other columns", () => {
    const op = crudEntryToSyncOp(
      { clientId: 10, op: "PATCH", table: "notes", id, opData: { content: "x", lifecycle: "active" } } as never,
      base,
    );
    expect(op.base_content).toBe(base);
  });
```

And to `describe("ApiConnector.uploadData", ...)`, the end-to-end case that is the actual
bug — two ops, one note, one upload:

```ts
  /**
   * The shape the unit tests above cannot reach: a body edit and a lifecycle change both
   * queued for ONE note before an upload. The base is read once, keyed by note id, and handed
   * to every op with that id -- so the archive op arrived at the server carrying the body's
   * base. A test with a single queued op passes whether or not that is fixed.
   */
  it("gives the base only to the op that changed the body, when both are queued", async () => {
    const db = database([
      { clientId: 1, op: "PATCH", table: "notes", id: noteId, opData: { content: "x" } },
      { clientId: 2, op: "PATCH", table: "notes", id: noteId, opData: { lifecycle: "archived" } },
    ]);
    getOptional.mockResolvedValue({ base_content: "the body this edit started from" });

    await new ApiConnector().uploadData(db);

    const body = JSON.parse((fetchMock.mock.calls[0] as never[])[1]!["body"] as string);
    expect(body.ops[0].base_content).toBe("the body this edit started from");
    expect(Object.hasOwn(body.ops[1], "base_content")).toBe(false);
  });
```

- [ ] **Step 2: Run them and CONFIRM THEY FAIL**

```bash
pnpm turbo run test --filter=@cortex/mobile -- connector
```

Expected: `never attaches a base to a PATCH that does not change the body` FAILS
(`base_content` is the base, not undefined), and `gives the base only to the op that changed
the body` FAILS on `Object.hasOwn(body.ops[1], "base_content")` being `true`.

**Do not proceed if either passes.** Record the failure output; it goes in the commit message.

- [ ] **Step 3: Narrow the guard**

In `apps/mobile/src/lib/connector.ts`, replace lines 30-40 with:

```ts
  // Only note bodies get conflict-copy treatment (spec §6.1); a base on any other table
  // would be meaningless and the server ignores it, so do not send one. The `op` half of this
  // guard matters as much as the `table` half: a base on a PUT would tell the server a
  // full-row overwrite was based on a revision, manufacturing a conflict copy for a create.
  //
  // The `content` half matters for the same reason at one remove. `uploadData` keys bases by
  // NOTE ID, so every queued PATCH for that note is offered the same one -- and a lifecycle
  // change is a notes PATCH. Attached to it, the server compares a base against a body the op
  // never touched and manufactures a conflict copy for an archive.
  //
  // `!== undefined`, NOT truthiness: the base is a body now, and "" is a real one -- a note
  // edited down to nothing and then edited again. Dropped, it would reach the server as "no
  // base at all" and apply unconditionally, which is the last-write-wins this exists to stop.
  const changesBody = entry.opData !== undefined && "content" in entry.opData;
  if (baseContent !== undefined && entry.table === "notes" && entry.op === "PATCH" && changesBody) {
    op.base_content = baseContent;
  }
```

- [ ] **Step 4: Run them and confirm they pass**

```bash
pnpm turbo run test --filter=@cortex/mobile -- connector
```

Expected: PASS. `attaches an EMPTY base body rather than dropping it` must still pass — its
`opData` is `{ content: "x" }`, so `"content" in opData` holds and the empty-string base still
attaches.

- [ ] **Step 5: Commit, recording the red run**

```bash
git add apps/mobile/src/lib/connector.ts apps/mobile/src/lib/connector.test.ts
git commit -F - <<'EOF'
fix(mobile): an archive op carried the body's edit base and could fork the note

uploadData keys bases by note id and offers the same one to every queued PATCH for that note.
A lifecycle change is a notes PATCH, so it collected the body's base -- and the server reads a
base as "this edit was based on that revision", manufacturing a conflict copy for a change
that never touched the body. It needs both ops queued before one upload, which is why it
survived: every existing test queues one.

Confirmed red before the fix. The single-op cases pass either way -- with one op there is no
wrong op to attach the base to -- so the load-bearing test queues a body edit and a lifecycle
change together and asserts only the first carries base_content.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 5: A duplicate DELETE is the desired end state, not a failure

> **Second of the three.** The FIRST delete succeeds whether or not the bug is present. The
> test must issue the SECOND one.

**Files:**
- Modify: `apps/api/src/sync/router.ts:102-125`
- Test: `apps/api/test/sync-upload.e2e.test.ts`

**Interfaces:**
- Consumes: the file's own `post(token, body)` helper (`sync-upload.e2e.test.ts:20-21`), its `uuid()` (line 11) and the `alice` fixture. There is no `applySyncOps` helper in the test file — every case posts a batch over HTTP and asserts on `res.body.applied` / `res.body.failed`.
- Produces: the router reports an already-tombstoned DELETE in `applied`, not `failed`. The result shape does not change.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/sync-upload.e2e.test.ts`, beside the existing
`accepts the DELETE that mobile's undo actually sends` (line 487), which is the first half of
this same story:

```ts
  /**
   * `failed` is the ONLY surface that reveals a genuinely lost op -- the batch completes
   * either way, so an op reported there has left the device's queue for good. Filling it with
   * harmless replays is what makes a real loss easy to miss.
   *
   * PowerSync resends a batch whenever the response is lost, so a second DELETE for a row it
   * already tombstoned is ordinary traffic, not a client bug. The row is in exactly the state
   * the op asked for.
   *
   * checkins because that is the table mobile's undo really deletes; the notes DELETE branch
   * routes through the same softDelete and the same `is deleted_at null` guard.
   *
   * The FIRST delete succeeds with or without this fix; only the second one discriminates.
   */
  it("reports an already-tombstoned DELETE as applied, not failed", async () => {
    const id = uuid();
    await post(alice.token, {
      ops: [{ op_id: "1", op: "PUT", table: "checkins", id, data: { mood: 2 } }],
    }).expect(201);

    const first = await post(alice.token, {
      ops: [{ op_id: "2", op: "DELETE", table: "checkins", id }],
    }).expect(201);
    expect(first.body.applied).toEqual(["2"]);

    // The replay. Same op, same row, response lost the first time round.
    const second = await post(alice.token, {
      ops: [{ op_id: "3", op: "DELETE", table: "checkins", id }],
    }).expect(201);
    expect(second.body.failed).toEqual([]);
    expect(second.body.applied).toEqual(["3"]);
  });
```

- [ ] **Step 2: Run it and CONFIRM IT FAILS**

```bash
pnpm turbo run test --filter=@cortex/api -- sync-upload
```

Expected: FAIL on `expect(second.body.failed).toEqual([])` — it contains
`{ op_id: "3", kind: "not_found" }`.

**Do not proceed if it passes.**

- [ ] **Step 3: Treat not_found on a DELETE as applied**

In `apps/api/src/sync/router.ts`, replace the catch on lines 123-125 with:

```ts
    } catch (err) {
      const error = asCoreError(err);
      // A DELETE for a row that is already tombstoned asked for a state the row is already
      // in. Every softDelete path guards on `is deleted_at null` so the second one matches
      // zero rows and surfaces as not_found -- correct for an HTTP caller, wrong here.
      // PowerSync resends a batch whenever the response is lost, so a replayed DELETE is
      // ordinary traffic, and `failed` is the only surface that reveals a genuinely lost op.
      // Filling it with benign replays is what makes a real loss easy to miss.
      if (op.op === "DELETE" && error.kind === "not_found") {
        result.applied.push(op.op_id);
        continue;
      }
      result.failed.push({ op_id: op.op_id, ...error });
    }
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
pnpm turbo run test --filter=@cortex/api -- sync-upload
```

Expected: PASS, with nothing else in the file to update. Both existing `not_found` assertions
(`reports a single failed op without aborting the rest`, line 168, and the tags PATCH guard,
line 250) are on **PATCH** ops, which this change does not touch. If a DELETE-side `not_found`
assertion turns up anyway, it now reports `applied` — the same correct answer for the same
reason (the row is not there) — so update its expectation and its comment in this commit
rather than leaving a contradiction behind.

- [ ] **Step 5: Commit, recording the red run**

```bash
git add apps/api/src/sync/router.ts apps/api/test/sync-upload.e2e.test.ts
git commit -F - <<'EOF'
fix(api): benign duplicate DELETEs polluted the only loss-detection surface

Every softDelete path guards on `is deleted_at null`, so a second DELETE for the same row
matches nothing and surfaces as not_found -- right for an HTTP caller, wrong for sync.
PowerSync resends a batch whenever the response is lost, so a replayed DELETE is ordinary
traffic and the row is already in the state the op asked for.

`failed` is the only thing that reveals a genuinely lost op, because the batch completes
either way. Filling it with harmless replays is what makes a real loss easy to miss.

Confirmed red before the fix. The first DELETE succeeds with or without the change, so the
test issues the second one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 6: A malformed `pending_item` must be a signal, not silence

**Files:**
- Modify: `packages/core/src/media/service.ts:129-130`
- Test: `packages/core/src/media/resolve-link.test.ts`

**Interfaces:**
- Consumes: `resolveNoteMediaLink`, `pendingMediaItem` from `@cortex/shared`.
- Produces: `resolveNoteMediaLink` returns `null` only when `pending_item` is **absent**; a present-but-malformed one throws `{ kind: "validation" }`, which `applyNoteOp` already routes into `media_unresolved`.

- [ ] **Step 1: Write the failing test**

```ts
  /**
   * Absent and malformed both returned null, so a client that serialises this field wrongly
   * produced silent no-op linking with nothing anywhere to notice it by. `media_unresolved`
   * exists for precisely this class of outcome -- the note is written, the linking is not,
   * and a resend cannot help.
   */
  it("distinguishes a malformed pending_item from an absent one", async () => {
    const note = await offlineMediaNote({ kind: "movie", title: `Malformed ${Date.now()}` });

    await expect(media.resolveNoteMediaLink(note.id, {
      status: "finished",
      pending_item: { kind: "not-a-kind", title: "" },
    })).rejects.toMatchObject({ kind: "validation" });

    // Absent stays null -- an ordinary note is not an error.
    expect(await media.resolveNoteMediaLink(note.id, { status: "finished" })).toBeNull();
  });
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm turbo run test --filter=@cortex/core -- resolve-link
```

Expected: FAIL — the call resolves to `null` instead of rejecting.

- [ ] **Step 3: Split the two cases**

In `packages/core/src/media/service.ts`, replace lines 129-130 with:

```ts
    // Absent is not an error: an ordinary note has no pending_item and this method is called
    // for every note op that carries domain_meta.
    if (meta.pending_item === undefined || meta.pending_item === null) return null;

    // Present but malformed IS an error. Returning null for both meant a client that
    // serialises this field wrongly produced silent no-op linking, with the note written and
    // nothing anywhere reporting that its media item was never reached. applyNoteOp routes a
    // throw from here into `media_unresolved`, which exists for exactly this: durable write,
    // failed resolution, resend cannot help.
    const parsed = pendingMediaItem.safeParse(meta.pending_item);
    if (!parsed.success) {
      throw {
        kind: "validation",
        message: "pending_item is present but does not parse",
        cause: parsed.error,
      } as const;
    }
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
pnpm turbo run test --filter=@cortex/core -- resolve-link
```

Expected: PASS, and `returns null when the meta has no pending_item` (line 29 of the test
file) still passes — it passes `{}`, so `meta.pending_item` is `undefined`.

- [ ] **Step 5: Run the api suite too, because the router's branch changes shape**

```bash
pnpm turbo run test --filter=@cortex/api -- sync-upload
```

Expected: PASS. `applyNoteOp` wraps `resolveNoteMediaLink` in a try/catch that pushes to
`media_unresolved`, so a new throw is already handled — confirm no test asserted the old
silent-null behaviour end to end.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/media/service.ts packages/core/src/media/resolve-link.test.ts
git commit -F - <<'EOF'
fix(core): a malformed pending_item was indistinguishable from an absent one

Both returned null, so a client that serialises the field wrongly produced silent no-op
linking: the note written, the media item never reached, and nothing anywhere reporting it.
Absent still returns null -- an ordinary note has no pending_item -- while present-but-
malformed throws validation, which applyNoteOp already routes into media_unresolved. That
channel exists for exactly this shape: durable write, failed resolution, resend cannot help.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 7: The device schema must match the columns Postgres requires

> **Third of the three.** The obvious test here is the api one — post a `note_tags` row the way
> a device would and watch it apply. It passes with the bug present, because the test hands
> `source` over explicitly while the whole defect is that a real device could not have. The
> test that discriminates is the column assertion over `AppSchema`, and it belongs in
> `packages/sync`, not in the api suite. Both are written; only the first must go red.

**Files:**
- Modify: `packages/sync/src/schema.ts:38-41,49-53`
- Test: `packages/sync/src/schema.test.ts` (the discriminating half)
- Test: `apps/api/test/sync-upload.e2e.test.ts` (the contract half)

**Interfaces:**
- Consumes: `AppSchema` from `./schema.js`, already imported by `schema.test.ts:3`, whose existing cases use exactly `AppSchema.tables`, `.name`, `.columns`, `.localOnly`. On the api side, the file's own `post(token, body)` and `uuid()` helpers.
- Produces: `note_tags` in the local schema gains `source`, `status`, `confidence`. No API surface changes.

- [ ] **Step 1a: Write the discriminating test, in the package that owns the schema**

Add to the `describe("AppSchema", ...)` block in `packages/sync/src/schema.test.ts`. It
already imports `AppSchema` and its `carries updated_at on notes` case is this exact shape,
so no new import and no new accessor:

```ts
  /**
   * The assertion that pins the local schema to the database. `note_tags.source` is
   * `text not null` with no default (00003_organization.sql:20) and AppSchema did not declare
   * the column at all. PowerSync's local schema is a VIEW, so an omitted column is invisible
   * on the device rather than an error -- the device sends a row without `source` and Postgres
   * answers 23502, with nothing on the device able to explain it. Phase 2's auto-tag
   * accept/reject is the first client writer of this table.
   */
  it("declares every column note_tags requires", () => {
    const noteTags = AppSchema.tables.find((t) => t.name === "note_tags")!;
    expect(noteTags.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["note_id", "tag_id", "source", "status"]),
    );
  });
```

- [ ] **Step 1b: Write the contract test, where a real op reaches Postgres**

Add to `apps/api/test/sync-upload.e2e.test.ts`, using the file's own `post` and `uuid`:

```ts
  /**
   * The device-shaped write the schema change exists to make possible. `source` and `status`
   * are present here because the local schema now declares them; before it did, a real device
   * could not have produced this row at all.
   *
   * This one does NOT discriminate on its own -- it sends `source` explicitly, so it passes
   * either way. It is the contract half; `declares every column note_tags requires` in
   * packages/sync/src/schema.test.ts is the half that fails without the fix.
   */
  it("accepts a note_tags PUT shaped the way the device schema declares it", async () => {
    const noteId = uuid();
    const tagId = uuid();
    await post(alice.token, {
      ops: [
        { op_id: "1", op: "PUT", table: "notes", id: noteId, data: { content: "tagged" } },
        { op_id: "2", op: "PUT", table: "tags", id: tagId, data: { name: `nt-${tagId}` } },
      ],
    }).expect(201);

    const res = await post(alice.token, {
      ops: [{
        op_id: "3", op: "PUT", table: "note_tags", id: uuid(),
        data: {
          note_id: noteId, tag_id: tagId,
          // `source` has a check constraint of ('user','ai') and NO default; `status` defaults
          // to 'accepted' but the device sends it too, because the column is declared.
          source: "user", status: "accepted", confidence: null,
        },
      }],
    }).expect(201);

    expect(res.body.failed).toEqual([]);
    expect(res.body.applied).toEqual(["3"]);
  });
```

- [ ] **Step 2: Run them and CONFIRM THE SCHEMA TEST FAILS**

```bash
pnpm turbo run test --filter=@cortex/sync
pnpm turbo run test --filter=@cortex/api -- sync-upload
```

Expected: `declares every column note_tags requires` FAILS — `source` and `status` are absent
from the column list. The api test PASSES already, because it sends `source` explicitly; that
is expected and is why it is not the load-bearing one.

**Do not proceed until the schema test has been observed failing.**

- [ ] **Step 3: Declare the missing columns**

In `packages/sync/src/schema.ts`, replace lines 38-41 with:

```ts
/**
 * `source`, `status` and `confidence` are declared even though nothing writes them yet.
 *
 * PowerSync's local schema is a VIEW, so an omitted column is invisible on the device rather
 * than an error -- and `note_tags.source` is `text NOT NULL` with no default
 * (00003_organization.sql:20). A device-originated row without it is a 23502 from Postgres
 * that nothing on the device can explain. Phase 2's auto-tag accept/reject is the first
 * client writer of this table, so the trap is disarmed before the phase that springs it.
 */
const note_tags = new Table({
  note_id: column.text, tag_id: column.text,
  source: column.text, status: column.text, confidence: column.real,
  created_at: column.text, deleted_at: column.text,
});
```

and replace lines 49-53 with:

```ts
const media_items = new Table({
  kind: column.text, title: column.text, year: column.integer,
  creator: column.text,
  // jsonb arrives as a JSON string, same as notes.domain_meta above. Postgres declares this
  // `jsonb not null default '{}'` (00013_life_domains.sql:20), so a device write must send a
  // serialised object -- there is no readDomainMeta equivalent for this column, and a client
  // that sends a bare string would land the JSON string rather than the object.
  external_meta: column.text,
  created_at: column.text, deleted_at: column.text,
});
```

- [ ] **Step 4: Run them and confirm they pass**

```bash
pnpm turbo run test --filter=@cortex/sync
pnpm turbo run test --filter=@cortex/api -- sync-upload
```

Expected: PASS. `packages/sync/src/schema.test.ts` asserts the table SET matches
`SYNC_TABLES`; adding columns does not change the set, so it stays green.

- [ ] **Step 5: Commit, recording the red run**

```bash
git add packages/sync/src/schema.ts packages/sync/src/schema.test.ts \
        apps/api/test/sync-upload.e2e.test.ts
git commit -F - <<'EOF'
fix(sync): the device schema omitted three note_tags columns, one of them NOT NULL

note_tags.source is `text not null` with no default (00003:20) and AppSchema did not declare
it. PowerSync's local schema is a view, so the omission is invisible on the device rather than
an error -- the first client-originated row would be a 23502 with nothing on the device able
to explain it. Phase 2's auto-tag accept/reject is the first client writer of this table.

Also documents media_items.external_meta as the jsonb-arrives-as-a-string case that
notes.domain_meta already carries a comment for; there is no readDomainMeta equivalent for it.

Confirmed red before the fix, in packages/sync/src/schema.test.ts. The obvious test -- post a
note_tags row and watch it apply -- passes with the bug present, because the test supplies
`source` explicitly while the defect is that a real device could not have. It is kept as the
contract half: it proves the columns now declared are ones Postgres actually accepts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 8: Export must not leave a corrupt archive, and must check sharing first

**Files:**
- Modify: `apps/mobile/src/lib/export.ts:32-55`
- Test: `apps/mobile/src/lib/export.test.ts`

**Interfaces:**
- Consumes: `exportArchive(deps: ExportDeps): Promise<void>`, the `deps` fixture (`export.test.ts:42`), and the `order` / `deleted` / `cacheHas` / `downloadFileAsync` / `isAvailableAsync` mocks defined at `export.test.ts:3-38`.
- Produces: no signature change. `isAvailableAsync` is now consulted before the network call, and a download failure removes its partial file.

- [ ] **Step 1a: Write the new failing test**

Add to `describe("exportArchive", ...)`:

```ts
  /**
   * `File.downloadFileAsync` streams into the file, so a mid-flight failure leaves a partial
   * zip in cache. Line 38's same-day clear means the NEXT export recovers -- but in between,
   * the share sheet would hand another app a truncated archive indistinguishable from a
   * complete one.
   *
   * `cacheHas` is deliberately NOT seeded. Seeding it would make the pre-download same-day
   * clear fire, push the path into `deleted`, and the assertion below would then hold with or
   * without the cleanup -- the mock's `delete()` records the path regardless of who called it.
   */
  it("removes the partial file when the download fails", async () => {
    downloadFileAsync.mockRejectedValueOnce(new Error("connection reset"));

    await expect(exportArchive(deps)).rejects.toThrow("connection reset");

    expect(deleted).toEqual([`/cache/${exportFilename()}`]);
  });
```

- [ ] **Step 1b: Strengthen the existing sharing test rather than duplicating it**

`reports when the file cannot be shared rather than claiming success` (`export.test.ts:133`)
already drives `isAvailableAsync` false and asserts the rejection. What it does not assert is
the ordering, which is the whole of this change. Add the one line, and extend its comment:

```ts
  it("reports when the file cannot be shared rather than claiming success", async () => {
    isAvailableAsync.mockResolvedValueOnce(false);

    // The archive is real but sitting in a cache directory the user cannot reach, so a silent
    // success would be a lie about where their data went.
    await expect(exportArchive(deps)).rejects.toThrow("sharing is not available");
    // And nothing was downloaded to get here. isAvailableAsync is a cheap local call while the
    // transfer is several megabytes; checked afterwards, a device with no share sheet paid for
    // the whole thing before being told the feature cannot work on it.
    expect(downloadFileAsync).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them and confirm both fail**

```bash
pnpm turbo run test --filter=@cortex/mobile -- export
```

Expected: `removes the partial file when the download fails` FAILS with `deleted` as `[]` —
nothing cleans up. `reports when the file cannot be shared` FAILS on the new line, because
`downloadFileAsync` was called before the check. Both are red on the assertion that is new,
which is the point: the second test passed for years without proving the ordering.

- [ ] **Step 3: Reorder and add the cleanup**

In `apps/mobile/src/lib/export.ts`, replace the body of `exportArchive` (lines 32-55) with:

```ts
export async function exportArchive(deps: ExportDeps): Promise<void> {
  if (!deps.token) throw new ExportError("not signed in");
  if (!deps.apiUrl) throw new ExportError("no API URL configured");

  // BEFORE the download, not after. This is a cheap local call and the transfer is several
  // megabytes; checked afterwards, a device with no share sheet pays for the whole thing
  // before being told the feature cannot work on it.
  if (!(await isAvailableAsync())) {
    throw new ExportError("sharing is not available on this device");
  }

  const destination = new File(Paths.cache, exportFilename());
  // A previous export of the same day would otherwise make the download fail outright.
  if (destination.exists) destination.delete();

  let file: { uri: string };
  try {
    file = await File.downloadFileAsync(
      `${deps.apiUrl}/export`,
      new Directory(Paths.cache),
      { headers: { Authorization: `Bearer ${deps.token}` }, idempotent: true },
    );
  } catch (err) {
    // downloadFileAsync STREAMS into the file, so a mid-flight failure leaves a partial zip
    // behind. The same-day clear above means the next attempt recovers -- but until then the
    // share sheet would hand another app a truncated archive indistinguishable from a
    // complete export.
    //
    // Unconditional, not `if (destination.exists)`: delete() on a file that is not there throws
    // and this catch already absorbs that, so the existence check would buy nothing but a stat
    // call. Best-effort either way -- a cleanup failure must never replace the download error,
    // which is the one the caller has to see.
    try { destination.delete(); } catch { /* keep the original error */ }
    throw err;
  }

  await shareAsync(file.uri, {
    mimeType: "application/zip",
    dialogTitle: "Export all notes",
  });
}
```

- [ ] **Step 4: Run them and confirm they pass**

```bash
pnpm turbo run test --filter=@cortex/mobile -- export
```

Expected: PASS, all of them. The existing ordering test is
`clears a same-day export before downloading over it` (line 106), which asserts `delete`
precedes `download` in the `order` array — `isAvailableAsync` is an `expo-sharing` mock and
never pushes to `order`, so moving it above the download cannot disturb that sequence. Confirm
rather than assume.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/export.ts apps/mobile/src/lib/export.test.ts
git commit -F - <<'EOF'
fix(mobile): a failed export left a truncated zip, and checked sharing too late

downloadFileAsync streams into the file, so a mid-flight failure left a partial archive in
cache. The same-day clear means the next attempt recovers, but until then the share sheet
would hand another app a truncated zip indistinguishable from a complete export.

isAvailableAsync moves above the download. It is a cheap local call and the transfer is
several megabytes; checked afterwards, a device with no share sheet paid for the whole thing
before being told the feature cannot work on it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 9: Comments that are false, and one memoization

These carry no behavioural test. Three are comment-only; the fourth is a memoization with no
observable behaviour change. Saying so is more honest than manufacturing an assertion that
proves nothing — which is the exact failure round 2 finding #2 recorded.

**Files:**
- Modify: `apps/mobile/src/lib/checkins.ts:5-14`
- Modify: `apps/mobile/src/lib/connector.ts:142-144`
- Modify: `apps/mobile/src/lib/connector.test.ts:353-357`
- Modify: `packages/shared/src/dto/sync.ts:26-27`
- Modify: `apps/web/src/app/note-list.tsx:3,23,27-41`

- [ ] **Step 1: Correct the `checkins.ts` comment, which instructs a regression**

Replace lines 5-14 of `apps/mobile/src/lib/checkins.ts`:

```ts
/**
 * Mood check-ins (life-domains spec §2.3). Inserts and deletes only -- a wrong mood is undone
 * and re-tapped, never edited -- and both work offline unchanged, because neither needs a
 * server-side decision.
 *
 * `updated_at` is deliberately not written HERE, but the column is real: 00014_phase1c_
 * hardening.sql:19-21 added it to public.checkins with a moddatetime trigger, explicitly so
 * PowerSync can order rows. `packages/sync/src/schema.ts` declares it correctly and must keep
 * it. (An earlier note in this file claimed the column did not exist, cited 00013, and
 * concluded the local schema should lose it -- following that would have broken sync
 * ordering.) It stays unwritten by the device because the server owns it, exactly as with
 * notes.updated_at.
 */
```

- [ ] **Step 2: Correct the two comments citing a resolved bug**

In `apps/mobile/src/lib/connector.ts`, replace lines 142-144:

```ts
    // Pairs with the `[powersync]` status line in powersync.ts. Kept permanently: this is the
    // only place an upload announces itself, so without it a device log shows sync status
    // transitions with nothing to correlate them against. (It was added to investigate a
    // download stream that appeared stalled; that turned out to be the zero-height list and
    // the awaited connect(), both fixed, and 03-server-to-device.yaml now covers the
    // direction in CI. The log stays because correlation is useful regardless.)
```

In `apps/mobile/src/lib/connector.test.ts`, replace the docblock at lines 353-357:

```ts
  /**
   * The `[powersync] upload complete` line is the only signal an upload leaves, and the status
   * line in powersync.ts is the only signal the download side leaves. Correlating them is how
   * a sync problem gets localised to a direction at all, so the log is asserted rather than
   * left to drift.
   */
```

- [ ] **Step 3: Correct the `dto/sync.ts` comment**

Replace lines 26-27 of `packages/shared/src/dto/sync.ts`:

```ts
  // Zod v4 top-level form, matching tags.ts. (media.ts uses z.iso.date(), a different
  // top-level constructor for a different type -- not this one.) The chained
  // z.string().uuid() still works but is deprecated and would leave two styles in one package.
```

- [ ] **Step 4: Stabilise `refetch`'s dependency**

`NoteFilters` is exactly `{ view: NoteView; q?: string; tag?: string; domain?: string }`
(`packages/shared/src/notes/filters.ts:24-29`), and line 23 already destructures all four. In
`apps/web/src/app/note-list.tsx`, change the import on line 3 to add `useMemo`:

```ts
import { useCallback, useEffect, useMemo, useState } from "react";
```

then after line 23 add:

```ts
  // `filters` is an object prop, so `useCallback([filters])` rebuilds refetch on every render
  // where the parent recreated it -- which re-registers the Realtime effect below for a value
  // that did not change. NoteFilters is exactly these four fields
  // (packages/shared/src/notes/filters.ts:24-29), so this is the same object by value with a
  // stable identity.
  const stableFilters = useMemo(() => ({ view, q, tag, domain }), [view, q, tag, domain]);
```

and in `refetch` (lines 27-41) replace both uses of `filters` with `stableFilters`, and the
dependency array `[filters]` with `[stableFilters]`.

- [ ] **Step 5: Run the affected suites**

```bash
pnpm turbo run test --filter=@cortex/mobile
pnpm turbo run test --filter=@cortex/shared
pnpm turbo run test --filter=@cortex/web
pnpm turbo run typecheck lint
```

Expected: all PASS. Nothing here changes behaviour, so a failure means the edit was wrong, not
that an expectation needs updating.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/lib/checkins.ts apps/mobile/src/lib/connector.ts \
        apps/mobile/src/lib/connector.test.ts packages/shared/src/dto/sync.ts \
        apps/web/src/app/note-list.tsx
git commit -F - <<'EOF'
docs(mobile,shared,web): comments that had become false, and one stable dependency

checkins.ts claimed public.checkins has no updated_at column, cited 00013, and concluded the
local schema should lose it. 00014:19-21 added the column with a moddatetime trigger for
PowerSync ordering, and schema.ts declares it correctly -- acting on that comment would have
broken sync ordering. This is the ledger entry the handoff marks WRONG, tracked down to where
it had leaked into code.

Two comments cited the STILL OPEN download-stream question as though it were live. It is not:
the cause was the zero-height list and the awaited connect(), and 03-server-to-device.yaml
covers the direction in CI. The logs stay; only the justification changes.

dto/sync.ts claimed z.uuid() matched tags.ts AND media.ts; media.ts uses z.iso.date().

note-list.tsx's refetch keyed useCallback on an object prop, rebuilding on every render where
the parent recreated it. NoteFilters is four scalar fields, so a useMemo over them is the same
value with a stable identity.

No behavioural change, hence no new test: an assertion here would prove only that the comment
says what it says.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 10: The docs stop saying things that are false

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-phase-1b-HANDOFF.md` (new header; lines 85-103, 243-321)
- Modify: `docs/superpowers/specs/2026-07-31-cortex-second-brain-design.md` (lines 11, 77, 113-114, 158, 250, 374, 514, 536, 566, and a new amendment line near 548)

- [ ] **Step 1: Add the status header to the handoff document**

Insert immediately after line 1 (`# Phase 1b — handoff, 2026-08-03 (updated 2026-08-04)`):

```markdown
> ## STATUS as of 2026-08-07 — phase 1b is closed. One item remains open.
>
> Read this block before the 1200 lines below; most of what they describe as open is not.
>
> - **All nine round-2 findings are fixed.** #1 and #2 in `ab4c4ea`, #3/#5/#7/#8/#9 in
>   `03b5676`, #4 in `7b030a4`, #6 in `5e0352e`. The section headed "None of these is fixed"
>   is a record of what was found, not a to-do list.
> - **Server-to-device sync runs.** The "STILL OPEN" section below is history: the causes were
>   the zero-height note list and the awaited `connect()`, both fixed, and
>   `.maestro/03-server-to-device.yaml` now exercises the direction on every merge to `main`.
> - **Fourteen of the ledgered minors are cleared** — see
>   `docs/superpowers/plans/2026-08-07-phase-1b-closeout.md`. Each entry below that this
>   cleared is marked `[CLEARED]`.
> - **One ledger entry was WRONG and is marked so**, not actioned: `packages/sync` declaring
>   `updated_at` on `checkins` is correct, because `00014:19-21` added the column.
> - **Two items are deliberately unchanged**, with reasons recorded: web's `matchesFilters`
>   pass, and `updateWithConflictCopy`'s TOCTOU.
>
> **STILL OPEN — exactly one thing.** A sync op the server rejects inside a 200 is logged
> (`connector.ts:139-141`) but still lost: the batch completes either way, so the op leaves
> the device's queue while its row stays in local SQLite. Retrying cannot help — these are
> validation failures. The fix is a policy choice (dead-letter table? surface to the user?
> mark the row?) and needs its own design before phase 2 relies on this path.
```

- [ ] **Step 2: Correct the two stale sections in place**

Change the heading on line 85 from `### STILL OPEN — server-to-device sync does not run` to:

```markdown
### RESOLVED 2026-08-06 — server-to-device sync does not run (as of 2026-08-04)
```

and add immediately beneath it:

```markdown
> Resolved. The client-side fault was the zero-height list (`ec537dc`) and the awaited
> `connect()` — both fixed, and `.maestro/03-server-to-device.yaml` covers the direction in
> CI. Kept verbatim below because the reasoning about where to instrument is still the right
> method for the next stalled stream.
```

Change the heading on line 243 from `### Round 2 — open findings, ranked. None of these is fixed.` to:

```markdown
### Round 2 — findings as first ranked. ALL NINE ARE NOW FIXED; see the status header.
```

- [ ] **Step 3: Mark the cleared and expired ledger entries**

In the "Minor, all recorded rather than fixed" paragraph (lines 300-309) and the "Deferred
minors" list (lines 1121-1160), prefix each entry this batch cleared with `**[CLEARED]**` and
name its commit. Mark the `CheckinService.createWithId` / `deleted_at` entry:

```markdown
- **[EXPIRED — no longer true]** `CheckinService.createWithId`'s 23505 fallback read does not
  filter `deleted_at`, unlike `NoteService.createWithId`'s. Round 2 finding #9 changed
  `NoteService` to stop filtering, for its own reasons; the two now agree and there is nothing
  to reconcile.
```

and the wrong one:

```markdown
- **[WRONG — DO NOT ACTION]** `packages/sync` declares `updated_at` on `checkins`;
  `public.checkins` has no such column (migration 00013). **This is false.**
  `00014_phase1c_hardening.sql:19-21` added the column with a `moddatetime` trigger,
  explicitly for PowerSync ordering. `schema.ts:57` is correct and removing the column would
  be the regression. The claim had also leaked into `apps/mobile/src/lib/checkins.ts`; both
  are corrected.
```

- [ ] **Step 4: Remove Voyage from the parent spec**

In `docs/superpowers/specs/2026-07-31-cortex-second-brain-design.md`, at each of lines 11, 77,
113-114, 158, 250, 374, 514, 536 and 566, replace the Voyage reference with the Gemini
equivalent: `voyage-3.5` → `gemini-embedding-001`, `vector(1024)` → `vector(1536)`,
`Voyage AI` → `Gemini`, and in the `packages/ai` line, `(Claude, Voyage, Whisper)` →
`(Gemini)`. Line 77's row records a corrected assumption about Anthropic having no embeddings
API; keep the correction, and update only its resolution column to name Gemini at 1536 dims.

Then add, immediately after the existing amendment block ending near line 552:

```markdown
**Amendment 2026-08-07 — the AI provider is Gemini, everywhere.** The switch from
Claude + Voyage + Groq to Gemini alone was decided in
`docs/superpowers/specs/2026-08-01-life-domains-web-search-design.md` §1, which supersedes
§4's model table. It has been true in code since `00012_embedding_dims_gemini.sql`:
`packages/shared/src/enums.ts` exports `EMBEDDING_DIM = 1536` and
`EMBEDDING_MODEL = "gemini-embedding-001"`, and `packages/db/src/test/embedding-dims.test.ts`
pins the constant to the width the columns actually declare. The body above has been corrected
in place; the completed phase-0 and phase-1c plan documents keep their original text, because
they are execution records and `00012`'s own comment is the account of the change.
```

- [ ] **Step 5: Verify no Voyage reference survives outside the historical records**

```bash
grep -rn -i voyage docs/ packages/ apps/ supabase/ --exclude-dir=node_modules
```

Expected: hits ONLY in `docs/superpowers/plans/2026-07-31-phase-0-foundations.md`,
`docs/superpowers/plans/2026-08-01-phase-1c-life-domain-capture.md`,
`docs/superpowers/specs/2026-08-01-life-domains-web-search-design.md` (which records the
switch), `supabase/migrations/00012_embedding_dims_gemini.sql`,
`packages/db/src/test/embedding-dims.test.ts`, and the new amendment. All are deliberate.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-08-03-phase-1b-HANDOFF.md \
        docs/superpowers/specs/2026-07-31-cortex-second-brain-design.md
git commit -F - <<'EOF'
docs: close the phase-1b ledger, and stop the parent spec saying Voyage

The handoff gets a status header, because a 1200-line document with no summary made two
sections actively misleading: "Round 2 -- None of these is fixed" (all nine are) and "STILL
OPEN -- server-to-device sync does not run" (it does, and CI proves it every merge). Both are
corrected in place and kept, since the reasoning in them is still the right method. Cleared
entries are marked with their commit, one entry is marked WRONG, and one has expired on its
own.

The parent spec still named Voyage in nine places. The provider switch was decided in the
life-domains spec and has been true in code since 00012. Corrected in place with an amendment
naming the deciding document. The completed plan documents keep their 1024/voyage-3.5 text --
they are execution records, and 00012's comment is the account of the change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Task 11: The full gate, then open PR 1

- [ ] **Step 1: Run the whole gate with no cache**

```bash
pnpm turbo run typecheck lint test --force
```

- [ ] **Step 2: Read the `Cached:` line**

Expected: every task successful AND `Cached: 0 cached`. A run with replays did not run. If
the local Supabase stack is down, `db-tests`-covered packages will replay rather than execute
— start it (`npx supabase start`) and rerun.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin chore/phase-1b-closeout
gh pr create --base main --title "Phase 1b closeout: fourteen ledgered minors, and the docs that had gone stale" --body "$(cat <<'EOF'
Clears fourteen of the minors ledgered during phase 1b, and reconciles two documents that had
started stating things that are false.

Plan: `docs/superpowers/plans/2026-08-07-phase-1b-closeout.md`
Spec: `docs/superpowers/specs/2026-08-07-cleanup-batch-and-post-merge-e2e-design.md`

No deploy. The `checkins` sync-rule filter and the CI change are separate PRs, because only
those carry deploy risk.

Three fixes needed a test that would have passed with the bug present if written the obvious
way — the base attached to the wrong op, the duplicate DELETE, and the note_tags columns. Each
was observed red first, and each commit message says so.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 2 — the `checkins` sync rule

## Task 12: An undone check-in must not come back

**Files:**
- Modify: `packages/sync/src/sync-rules.yaml:36`
- Test: `packages/db/src/test/sync-rules-isolation.test.ts`

**Interfaces:**
- Consumes: `extractDataQueries(yamlText)` (`sync-rules-isolation.test.ts:52`), `admin` and `makeUser` from `./clients.js`.
- Produces: the `checkins` stream query gains `AND deleted_at IS NULL`. No code consumes the rules file at runtime; PowerSync Cloud does, after a deploy.

- [ ] **Step 1: Branch from `main`, not from PR 1**

```bash
git checkout main
git pull
git checkout -b fix/checkins-sync-rule-deleted-at
```

This PR must be reviewable and revertable on its own, since it is the one that carries a
deploy.

- [ ] **Step 2: Write the failing test**

Add to `packages/db/src/test/sync-rules-isolation.test.ts`:

```ts
/**
 * Undo is a local hard DELETE (apps/mobile/src/lib/checkins.ts:40) against a server-side SOFT
 * delete (CheckinService.softDelete). Without a deleted_at filter the tombstoned row still
 * satisfies the stream query, replicates back down, and the check-in the user undid returns to
 * the device. Latent only because nothing reads checkins locally yet -- phase 2's mood charts
 * are the first reader.
 *
 * `notes` deliberately has NO such filter: the device renders a trash view and needs the
 * tombstones. The asymmetry is intentional, which is why this asserts on checkins by name
 * rather than over every query.
 */
it("excludes soft-deleted check-ins from the sync stream", () => {
  const checkins = extractDataQueries(rules).find((q) => q.table === "checkins");
  expect(checkins).toBeDefined();
  expect(checkins!.query).toMatch(/deleted_at\s+is\s+null/i);
});

/**
 * The half that would otherwise make the above a spelling test. An assertion that reads back
 * rows its own setup seeded is correct by construction and cannot fail -- round 2 finding #2
 * was exactly that defect. This one seeds BOTH states and asserts the query's own predicate
 * selects between them.
 */
it("keeps live check-ins while excluding tombstoned ones", async () => {
  // Its OWN user, not the file's shared `alice`: this seeds and counts rows in one table, and
  // `alice` is the fixture every scoping test in this file leans on. makeUser returns
  // `{ client, id }` (clients.ts:12).
  const user = await makeUser("db-syncrules-checkins@test.local");
  await admin.from("checkins").delete().eq("user_id", user.id);

  const { data: seeded } = await admin.from("checkins").insert([
    { user_id: user.id, mood: 4 },
    { user_id: user.id, mood: 1, deleted_at: new Date().toISOString() },
  ]).select("id, mood, deleted_at");
  expect(seeded).toHaveLength(2);

  // The predicate the stream query carries, applied to real rows in both states.
  const { data: replicated } = await admin.from("checkins")
    .select("id, mood").eq("user_id", user.id).is("deleted_at", null);

  expect(replicated).toHaveLength(1);
  expect(replicated![0]!.mood).toBe(4);
});
```

- [ ] **Step 3: Run and confirm the first test fails**

```bash
pnpm turbo run test --filter=@cortex/db -- sync-rules-isolation
```

Expected: `excludes soft-deleted check-ins from the sync stream` FAILS — the query is
`SELECT * FROM checkins WHERE user_id = auth.user_id()` with no filter. The second test passes
already; it exists to prove the predicate discriminates, which is what stops the first one
from being a test of spelling.

- [ ] **Step 4: Filter the rule**

In `packages/sync/src/sync-rules.yaml`, replace line 36 with:

```yaml
      # `deleted_at is null` on checkins ONLY, and the asymmetry with notes is deliberate.
      #
      # Undo is a local hard DELETE (apps/mobile/src/lib/checkins.ts) against a server-side
      # SOFT delete. Unfiltered, the tombstone replicates back down and the check-in the user
      # undid reappears on the device. notes must NOT gain this filter: the device renders a
      # trash view and needs the tombstones to render it.
      - SELECT * FROM checkins    WHERE user_id = auth.user_id() AND deleted_at IS NULL
```

- [ ] **Step 5: Run and confirm both pass**

```bash
pnpm turbo run test --filter=@cortex/db -- sync-rules-isolation
```

Expected: PASS. The table-set equality assertion in the same file must stay green — the
predicate changed, the table set did not.

- [ ] **Step 6: Full gate, then commit**

```bash
pnpm turbo run typecheck lint test --force
git add packages/sync/src/sync-rules.yaml packages/db/src/test/sync-rules-isolation.test.ts
git commit -F - <<'EOF'
fix(sync): an undone check-in came back on the next download

Undo is a local hard DELETE against a server-side soft delete, and the checkins stream query
had no deleted_at filter -- so the tombstone replicated back down and the row the user undid
returned to the device. Latent only because nothing reads checkins locally yet; phase 2's mood
charts are the first reader.

notes deliberately keeps NO such filter: the device renders a trash view and needs the
tombstones. Commented in the file, because the next reader will otherwise "fix" the
inconsistency.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 7: Open the PR, naming the deploy step**

```bash
git push -u origin fix/checkins-sync-rule-deleted-at
gh pr create --base main --title "fix(sync): filter soft-deleted check-ins out of the sync stream" --body "$(cat <<'EOF'
One line of YAML plus the test that proves it.

**This PR is not finished when it merges.** Sync rules are deployed to PowerSync Cloud from
outside this repo (`docs/deploy.md`), so no CI gate can catch a bad one — the same shape of
gap that let `00012` pass locally and fail only against the hosted project. After merge:

1. Deploy the updated sync rules to the PowerSync Cloud instance.
2. Confirm against the hosted instance that a soft-deleted check-in no longer replicates.

Kept separate from the cleanup batch so that a failed deploy implicates one line rather than
fifteen.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 8: After merge — deploy and verify**

Deploy the sync rules to PowerSync Cloud, then confirm on the hosted instance that a check-in
with `deleted_at` set does not appear in the user's bucket. The automated test covers the
local stack and CI only; this step is the one that proves the change took effect where it
matters.

---

# PR 3 — E2E after merge, APK behind it

## Task 13: Convert the three workflows and add the orchestrator

**Files:**
- Modify: `.github/workflows/e2e-web.yml:5-8` (trigger block only)
- Modify: `.github/workflows/e2e-mobile.yml:9-22` (trigger block only)
- Modify: `.github/workflows/android-apk.yml:4-16` (trigger block only)
- Create: `.github/workflows/post-merge.yml`
- Modify: `docs/ci.md`

**Interfaces:**
- Consumes: the three existing `jobs.*` blocks unchanged — only their `on:` triggers change.
- Produces: `post-merge.yml` with jobs `changes`, `e2e-web`, `e2e-mobile`, `apk`. `changes` outputs two booleans, `mobile` and `apk`.

- [ ] **Step 1: Branch from `main`**

```bash
git checkout main
git pull
git checkout -b ci/e2e-after-merge
```

- [ ] **Step 2: Confirm the required check before changing anything**

```bash
gh api repos/:owner/:repo/branches/main/protection --jq '.required_status_checks.contexts'
```

Expected: `["CI gate"]` and nothing else. **If either E2E workflow appears in that list, STOP**
— removing its `pull_request` trigger would leave every PR waiting forever on a check that
never reports, which is the failure mode `docs/ci.md` documents. Protection would have to be
updated first.

- [ ] **Step 3: Convert `e2e-web.yml`'s trigger**

Replace lines 3-8 of `.github/workflows/e2e-web.yml`:

```yaml
# Runs AFTER the merge, not on the pull request. Called by post-merge.yml, which chains the
# APK build behind this and the mobile suite.
#
# This suite is not the slow one -- it lands in about three minutes, against the mobile
# suite's thirty. It moved anyway, so there is ONE answer to "where does E2E run" rather than
# one per suite. `workflow_dispatch` keeps it runnable by hand against any branch.
on:
  workflow_call:
  workflow_dispatch:
```

- [ ] **Step 4: Convert `e2e-mobile.yml`'s trigger**

Replace lines 3-22 of `.github/workflows/e2e-mobile.yml`:

```yaml
# Runs AFTER the merge, not on the pull request. Called by post-merge.yml.
#
# A debug APK compiles op-sqlite's SQLCipher and FTS5 from source, and an emulator has to boot
# on top of that -- ~30 minutes. Hanging that off every PR was most of an hour added to each
# round trip on a single-developer project.
#
# THE PATH FILTER MOVED to post-merge.yml's `changes` job. `on.push.paths` is workflow-scoped
# and cannot gate one job among several, and this workflow no longer owns its own trigger.
# Whatever paths gate it now live there -- do not add a `paths:` here expecting it to apply.
on:
  workflow_call:
  workflow_dispatch:
```

- [ ] **Step 5: Convert `android-apk.yml`'s trigger**

Replace lines 3-16 of `.github/workflows/android-apk.yml`:

```yaml
# Called by post-merge.yml AFTER both E2E suites pass, and runnable by hand from the Actions
# tab against any branch.
#
# `workflow_dispatch` is load-bearing and must stay: building an APK from an arbitrary branch
# is how a device gets tested before its code is merged. Folding this job's body into
# post-merge.yml would have destroyed that, because a manual run would then drag thirty
# minutes of E2E along with it.
#
# The `push` trigger and its path filter are GONE -- post-merge.yml owns both now, so that
# "build the APK only if the suites passed" can be expressed with `needs:` rather than
# inferred.
on:
  workflow_call:
  workflow_dispatch:
```

- [ ] **Step 6: Create the orchestrator**

Create `.github/workflows/post-merge.yml`:

```yaml
name: Post-merge

# Everything slow, after the merge rather than on the pull request.
#
# A PR is gated by `CI gate` alone (ci.yml) -- build, typecheck, lint, unit and db tests, about
# three minutes. The E2E suites and the APK build run here instead, because the mobile suite
# alone is ~30 minutes and that is most of an hour on every round trip.
#
# THE TRADE, recorded so it is a decision rather than an accident: `main` is now where E2E
# breakage is discovered, and where it gets fixed. The phase-1b branch spent eleven fix(e2e)
# commits converging the Maestro suite; under this arrangement all eleven would have landed on
# main.
on:
  push:
    branches: [main]

concurrency:
  group: post-merge-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # The path filters that used to live in each workflow's `on.push.paths`. They had to move:
  # path filtering is workflow-scoped, so it cannot gate one job among several, and gating the
  # APK on the suites requires them to be jobs in one workflow.
  changes:
    name: what changed
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      mobile: ${{ steps.filter.outputs.mobile }}
      apk: ${{ steps.filter.outputs.apk }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            mobile:
              - 'apps/mobile/**'
              - 'apps/api/**'
              - 'packages/shared/**'
              - 'packages/sync/**'
              - 'packages/core/**'
              - 'supabase/migrations/**'
              - 'e2e/**'
              - '.maestro/**'
              - 'pnpm-lock.yaml'
              - '.github/workflows/e2e-mobile.yml'
              - '.github/workflows/post-merge.yml'
            apk:
              - 'apps/mobile/**'
              - 'packages/shared/**'
              - 'packages/sync/**'
              - 'pnpm-lock.yaml'
              - '.github/workflows/android-apk.yml'
              - '.github/workflows/post-merge.yml'

  # Unfiltered, as it was before: it finishes in about three minutes, and a change to
  # packages/shared or packages/core can break the web app without touching apps/web at all.
  e2e-web:
    name: E2E Web
    uses: ./.github/workflows/e2e-web.yml

  e2e-mobile:
    name: E2E Mobile
    needs: changes
    if: needs.changes.outputs.mobile == 'true'
    uses: ./.github/workflows/e2e-mobile.yml

  # `always()` PLUS an explicit assertion on each result is mandatory, not defensive.
  #
  # Without `always()`, a SKIPPED dependency skips this job too -- so a docs-only push, which
  # correctly skips e2e-mobile, would silently stop building APKs forever. With `always()` and
  # no result checks, the opposite: a FAILING suite would still ship an APK. Both halves are
  # required, and `CI gate` in ci.yml already uses this exact idiom.
  #
  # `|| result == 'skipped'` on e2e-mobile covers one real case: the APK's path set is a subset
  # of the mobile suite's EXCEPT for android-apk.yml itself. Editing that file alone must build
  # an APK while legitimately skipping the suite.
  #
  # Gating on e2e-web is a deliberate reading of "if everything passes, build the APK". The
  # coupling is arguable -- a web regression says nothing about an Android artifact -- and
  # undoing it is deleting one line.
  apk:
    name: Android APK
    needs: [changes, e2e-web, e2e-mobile]
    if: >-
      always()
      && needs.changes.outputs.apk == 'true'
      && needs.e2e-web.result == 'success'
      && (needs.e2e-mobile.result == 'success' || needs.e2e-mobile.result == 'skipped')
    uses: ./.github/workflows/android-apk.yml
```

- [ ] **Step 7: Lint the workflows before pushing**

```bash
npx --yes actionlint@latest
```

Expected: no errors. `actionlint` is the only pre-merge check available here — a `push`-
triggered workflow cannot be exercised until it is on `main`.

- [ ] **Step 8: Confirm no `secrets:` passing is needed**

```bash
grep -rn "secrets\." .github/workflows/
```

Expected: no matches. The three called workflows read only `vars.*`, and repository variables
are visible to reusable workflows without being passed. If this grep ever returns a hit, the
caller needs `secrets: inherit` and this comment needs updating.

- [ ] **Step 9: Document the new shape**

Add to `docs/ci.md`:

```markdown
## Where each check runs (from 2026-08-07)

| Trigger | Workflow | Job name | Required? |
| --- | --- | --- | --- |
| pull request | `ci.yml` | `CI gate` | **yes — the only one** |
| push to `main` | `post-merge.yml` | `E2E Web`, `E2E Mobile`, `Android APK` | no |
| manual | `e2e-web.yml`, `e2e-mobile.yml`, `android-apk.yml` | — | no |

E2E moved behind the merge because the mobile suite is ~30 minutes and that is most of an hour
on every PR round trip. The cost is that `main` is now where E2E breakage is found and fixed.

**`post-merge.yml` is the only workflow with a trigger.** The other three are `workflow_call`
plus `workflow_dispatch`. Do not add a `paths:` filter to them expecting it to apply — path
filtering is workflow-scoped, so all of it lives in `post-merge.yml`'s `changes` job.

**The APK gate needs `always()` AND per-result assertions.** Without `always()` a skipped
dependency skips the APK job, so a docs-only push would silently stop producing APKs. Without
the result checks, `always()` alone would ship an APK from a commit whose suites failed. `CI
gate` uses the same idiom for the same reason.

**`workflow_dispatch` on `android-apk.yml` is load-bearing.** It is how an APK gets built from
a branch before merge; a manual run of `post-merge.yml` would drag 30 minutes of E2E with it.
```

- [ ] **Step 10: Commit and open the PR**

```bash
git add .github/workflows/post-merge.yml .github/workflows/e2e-web.yml \
        .github/workflows/e2e-mobile.yml .github/workflows/android-apk.yml docs/ci.md
git commit -F - <<'EOF'
ci: run E2E after the merge, and build the APK only if it passed

The mobile suite is ~30 minutes, which is most of an hour added to every PR round trip on a
single-developer project. Both E2E suites move to push-on-main, and the APK build chains
behind them with `needs:` so "if everything passes, build the APK" is expressed rather than
inferred.

The three workflows become workflow_call + workflow_dispatch; post-merge.yml is the only one
with a trigger. Path filters move into its `changes` job, because `on.push.paths` is
workflow-scoped and cannot gate one job among several. android-apk.yml keeps
workflow_dispatch: building from an arbitrary branch is how a device gets tested before merge,
and folding the job body into the orchestrator would have dragged E2E into every manual run.

Branch protection requires only `CI gate`, checked before writing this -- neither E2E workflow
is a required check, so dropping their pull_request trigger cannot strand a PR on a check that
never reports.

The trade is recorded in the workflow and in docs/ci.md: main is now where E2E breakage is
found and fixed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
git push -u origin ci/e2e-after-merge
gh pr create --base main --title "ci: run E2E after the merge, with the APK build gated behind it" --body "$(cat <<'EOF'
Moves both E2E suites from `pull_request` to `push` on `main`, and chains the APK build behind
them.

**This cannot be fully verified before it merges** — its trigger is `push` to `main`, so the
first real evidence is the run that fires on merge. `actionlint` covers the syntax. Watch the
first post-merge run rather than assuming it.

Verified before writing: branch protection requires only `CI gate`, so removing the E2E
workflows from `pull_request` does not strand PRs on a check that never reports.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 11: After merge — watch the first run**

```bash
gh run list --branch main --limit 5
```

Expected: `Post-merge` appears and its `E2E Web` job runs. Because this PR touches
`.github/workflows/post-merge.yml`, both `changes` outputs are true, so `E2E Mobile` and
`Android APK` should also run — which makes the merge itself the end-to-end test of the whole
chain, including the `needs` gating. Confirm the APK job started only after both suites
reported success.

---

## Definition of Done

- [ ] Fourteen items fixed; Tasks 4, 5 and 7 each observed red before the fix, and each commit
      message says so
- [ ] `pnpm turbo run typecheck lint test --force` green with `0 cached`
- [ ] `checkins` sync rule filtered, isolation test red-then-green, deployed to PowerSync Cloud
      and confirmed against the hosted instance
- [ ] E2E runs on push to `main`; the APK builds only after both suites pass;
      `workflow_dispatch` still builds an APK from an arbitrary branch
- [ ] `CI gate` still the only required check, and still passing on PRs
- [ ] Handoff document has a status header and no stale claims; no Voyage reference survives
      outside the historical records
- [ ] Exactly one item remains open and is named: the policy for ops the server rejects inside
      a 200
