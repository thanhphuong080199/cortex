/**
 * The local full-text index behind `noteFiltersToSql`'s `q` clause.
 *
 * Postgres FTS does not sync -- `content_text` is a generated column on the server and
 * generated columns are not replicated -- so offline search needs its own index in a
 * different engine. `packages/core`'s equivalence suite documents where the two disagree
 * rather than pretending they rank alike.
 *
 * THE SHAPE IS NOT NEGOTIABLE. `noteFiltersToSql` emits
 *
 *     n.id in (select id from notes_fts where notes_fts match ?)
 *
 * so the table must carry the uuid as its own `UNINDEXED` column. An FTS5 `rowid` is an
 * INTEGER and `notes.id` is a TEXT uuid, so a rowid-keyed table compiles, executes, and
 * returns nothing for every search without ever erroring -- which is precisely the bug Task 15
 * caught in the plan's own SQL. This is also the shape PowerSync's own FTS setup uses.
 */
export const NOTES_FTS_TABLE = `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
   USING fts5(id UNINDEXED, content, tokenize='unicode61')`;

/**
 * Triggers hang off `ps_data__notes`, PowerSync's internal storage, NOT off `notes`.
 *
 * `notes` is a view (`-- powersync-auto-generated`) and PowerSync already owns INSTEAD OF
 * triggers on it to route writes into the CRUD queue; adding more there would fight it. The
 * internal table's shape is `(id TEXT PRIMARY KEY NOT NULL, data TEXT)` with every column
 * inside `data` as JSON -- read out of the shipped `libpowersync.so`, not assumed -- so the
 * body comes back through `json_extract`.
 *
 * DROP-then-CREATE rather than `CREATE TRIGGER IF NOT EXISTS`: the triggers live in the
 * user's persistent database, so an `IF NOT EXISTS` would keep whatever definition shipped
 * with the version that first created them, and a later fix here would never reach an
 * existing install.
 */
const TRIGGERS = [
  `DROP TRIGGER IF EXISTS notes_fts_insert`,
  `DROP TRIGGER IF EXISTS notes_fts_update`,
  `DROP TRIGGER IF EXISTS notes_fts_delete`,
  // The DELETE inside the INSERT trigger is what makes this correct under `INSERT OR REPLACE`
  // as well as a plain INSERT. SQLite only fires DELETE triggers for the row a REPLACE evicts
  // when `recursive_triggers` is ON, and it is OFF by default -- `libpowersync.so` never sets
  // it. So a replace would otherwise run this trigger alone, leaving the previous body in the
  // index forever: search keeps finding notes by words they no longer contain, and each edit
  // adds another stale copy. Making the insert path idempotent covers every write pattern
  // instead of betting on which one replication uses.
  `CREATE TRIGGER notes_fts_insert AFTER INSERT ON ps_data__notes BEGIN
     DELETE FROM notes_fts WHERE id = NEW.id;
     INSERT INTO notes_fts(id, content)
     VALUES (NEW.id, json_extract(NEW.data, '$.content'));
   END`,
  `CREATE TRIGGER notes_fts_update AFTER UPDATE ON ps_data__notes BEGIN
     DELETE FROM notes_fts WHERE id = OLD.id;
     INSERT INTO notes_fts(id, content)
     VALUES (NEW.id, json_extract(NEW.data, '$.content'));
   END`,
  `CREATE TRIGGER notes_fts_delete AFTER DELETE ON ps_data__notes BEGIN
     DELETE FROM notes_fts WHERE id = OLD.id;
   END`,
];

/**
 * SOFT-DELETED NOTES ARE INDEXED TOO, deliberately.
 *
 * The `q` clause is ANDed with the view's own narrowing, so `deleted_at` is already decided by
 * the WHERE clause. Excluding trashed rows here -- which the plan's version did -- makes search
 * inside the trash view return nothing at all, because the two conditions then contradict.
 * The index is a text index; deciding which notes are visible is not its job.
 */
const REBUILD = [
  `DELETE FROM notes_fts`,
  `INSERT INTO notes_fts(id, content)
     SELECT id, json_extract(data, '$.content') FROM ps_data__notes`,
];

export interface FtsTarget {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Creates the index and its triggers, then rebuilds it once.
 *
 * Rebuilt at STARTUP, not on every sync status change. The plan repopulated the whole corpus
 * inside a `statusChanged` listener guarded by `if (!status.hasSynced) return` -- but
 * `hasSynced` latches true after the first sync, so every later status change (a connection
 * blip, an upload starting, a checkpoint) would delete and rebuild the entire index, racing
 * every read of it. Once per launch is bounded, and the triggers keep it current in between.
 *
 * The rebuild is not redundant with the triggers: it is what repairs an index that drifted
 * because a previous version's triggers were missing or wrong.
 */
export async function setupNotesFts(db: FtsTarget): Promise<void> {
  await db.execute(NOTES_FTS_TABLE);
  for (const sql of TRIGGERS) await db.execute(sql);
  for (const sql of REBUILD) await db.execute(sql);
}
