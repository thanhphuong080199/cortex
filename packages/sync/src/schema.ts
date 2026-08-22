import { column, Schema, Table } from "@powersync/common";

/**
 * Imported from @powersync/common, the platform-neutral core package, not
 * @powersync/react-native: this package only declares a schema, it never opens a
 * database, and @powersync/react-native pulls in React Native's native modules, which
 * fail to load under plain Node (the schema test's environment) with a syntax error, not
 * a schema error. @powersync/common ships a dedicated "node" export condition and
 * re-exports the same column/Schema/Table primitives, so nothing here changes for the
 * mobile app, which still imports @powersync/react-native at the app layer to get a
 * concrete PowerSyncDatabase.
 *
 * The client-side mirror of the synced Postgres tables (phase 1b spec §4).
 *
 * PowerSync's local schema is a VIEW over its internal storage, so a column missing here
 * is simply invisible on the device -- it is not an error. Adding a column later is
 * cheap; the tables listed are the contract, and they must stay identical to
 * SYNCED_TABLES in @cortex/shared, which the API's upload allow-list also reads.
 */
const notes = new Table({
  title: column.text,
  content: column.text,
  source_type: column.text,
  lifecycle: column.text,
  domain: column.text,
  domain_meta: column.text,      // jsonb arrives as a JSON string
  media_item_id: column.text,
  pinned: column.integer,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const tags = new Table({
  name: column.text, created_at: column.text, deleted_at: column.text,
});

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

const links = new Table({
  from_note_id: column.text, to_note_id: column.text,
  kind: column.text, status: column.text, similarity: column.real,
  rationale: column.text, created_at: column.text, deleted_at: column.text,
});

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

const checkins = new Table({
  mood: column.integer, energy: column.integer, label: column.text,
  created_at: column.text, updated_at: column.text, deleted_at: column.text,
});

/**
 * Read-only on the device. `citations` and `retrieval_meta` are jsonb and arrive as JSON
 * STRINGS, the same way `notes.domain_meta` does -- whatever renders them parses them.
 *
 * `user_id` is omitted for the same reason every other table here omits it: the bucket is
 * already one user's, so the column would be a constant on every row.
 */
const chat_messages = new Table({
  session_id: column.text,
  role: column.text,
  content: column.text,
  citations: column.text,
  retrieval_meta: column.text,
  created_at: column.text,
});

/**
 * Local-only: the note BODY each in-progress local edit was based on. It is the input to the
 * server's conflict-copy check (spec §6.2) and is meaningless anywhere but this device, so it
 * must never sync -- hence localOnly, which also keeps it out of the upload queue entirely.
 *
 * It held `base_updated_at` until that was found to fire a conflict copy on every edit:
 * `notes.updated_at` is server-owned, so the value here was either a device clock the server
 * had never seen, or PowerSync's `...Z` spelling of a timestamp PostgREST returns as
 * `...+00:00`. A body needs neither a shared clock nor a shared serialiser.
 */
const note_edit_base = new Table(
  { note_id: column.text, base_content: column.text },
  { localOnly: true },
);

export const AppSchema = new Schema({
  notes, tags, note_tags, links, media_items, checkins, chat_messages, note_edit_base,
});
