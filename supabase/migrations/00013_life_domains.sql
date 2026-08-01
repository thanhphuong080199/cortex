-- Life-domains spec §2: typed notes + the three structured tables that earn their
-- existence because a note genuinely cannot do the job -- entity identity
-- (media_items), a high-frequency two-word timeseries (checkins), and scheduled card
-- review (flashcards). Everything else about a domain log stays a note, so FTS,
-- embeddings, tagging, linking, digests, export and RLS all apply with no duplication.
--
-- media_items is created BEFORE the notes alter: notes.media_item_id references it.

-- ============ media_items (synced, client-writable) ============
-- The media *item* is an entity; the *log* is a note (the Letterboxd model). A rewatch
-- is a second note against the same item, not a second item.
create table public.media_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null constraint media_items_kind_check
    check (kind in ('movie','tv','book','game','podcast')),
  title text not null,
  year int,
  creator text,
  external_meta jsonb not null default '{}',   -- room for TMDB/OpenLibrary ids later
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- Partial on deleted_at so a soft-deleted item never blocks re-logging the same title,
-- matching tags_user_name_uidx (00003) and note_tags' partial unique (00011).
create unique index media_items_user_kind_title_uidx
  on public.media_items (user_id, kind, lower(title)) where deleted_at is null;

alter table public.media_items enable row level security;
create policy media_items_own on public.media_items
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ============ notes: domain columns ============
-- `domain` is nullable on purpose -- undomained notes are normal notes. Set by the user
-- at capture (one-tap chip) or suggested by phase-2 enrichment through the same
-- suggested-first + feedback_events trust dial as tags.
alter table public.notes
  add column domain text constraint notes_domain_check
    check (domain in ('media','health','life','learning','finance','reflection')),
  add column domain_meta jsonb not null default '{}',
  -- set null, not cascade: losing the media item must not delete the log note, which
  -- holds the impression -- the part that links to ideas.
  add column media_item_id uuid references public.media_items(id) on delete set null;
create index notes_user_domain_idx on public.notes (user_id, domain) where domain is not null;

-- ============ checkins (synced, client-writable) ============
-- Deliberately NOT notes (the Daylio lesson): a two-word mood logged several times a day
-- would flood the inbox, FTS and the embedding pipeline with noise. This is a timeseries
-- the phase-7 synthesis layer reads.
create table public.checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mood smallint check (mood between 1 and 5),
  energy smallint check (energy between 1 and 5),
  label text,                                   -- the optional 1-2 words
  created_at timestamptz not null default now(),
  -- tombstone: synced tables need one (parent spec §6), and a mis-tap must be erasable.
  deleted_at timestamptz,
  constraint checkins_mood_or_energy check (mood is not null or energy is not null)
);
create index checkins_user_created_idx on public.checkins (user_id, created_at desc);

alter table public.checkins enable row level security;
create policy checkins_own on public.checkins
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ============ flashcards (synced, client-writable) ============
-- Table only in phase 1c. Extraction is phase 2 and the review UI is phase 6; scheduling
-- reuses the SM-2-lite *functions* shared with review_queue, not its table.
create table public.flashcards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid references public.notes(id) on delete cascade,
  front text not null,
  back text not null,
  source text not null default 'ai' check (source in ('user','ai')),
  status text not null default 'suggested' constraint flashcards_status_check
    check (status in ('suggested','active','suspended')),
  due_at timestamptz,
  interval_days real not null default 1,
  ease real not null default 2.0,
  lapses int not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index flashcards_user_due_idx on public.flashcards (user_id, due_at)
  where status = 'active' and deleted_at is null;

alter table public.flashcards enable row level security;
create policy flashcards_own on public.flashcards
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ============ grants ============
-- 00009 revoked the pg_default_acl grants and changed the default privileges template,
-- so tables created here start with NO grants at all -- these are load-bearing, not
-- belt-and-braces. Spec §5 names RLS the primary protection for health/mood/finance
-- rows; the grant is what lets `authenticated` reach RLS in the first place.
grant select, insert, update, delete on public.media_items to authenticated;
grant select, insert, update, delete on public.checkins to authenticated;
grant select, insert, update, delete on public.flashcards to authenticated;

grant select, insert, update, delete on public.media_items to service_role;
grant select, insert, update, delete on public.checkins to service_role;
grant select, insert, update, delete on public.flashcards to service_role;

-- ============ realtime ============
-- Supabase ships supabase_realtime empty; without this no postgres_changes event is ever
-- broadcast and live UI silently degrades to "refresh to see changes" (same reason as 00010).
alter publication supabase_realtime add table public.media_items;
alter publication supabase_realtime add table public.checkins;
alter publication supabase_realtime add table public.flashcards;
