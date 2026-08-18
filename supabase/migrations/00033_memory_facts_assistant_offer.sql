-- packages/db's enum-parity test reads memory_facts_category_check out of pg_constraint and
-- asserts it matches @cortex/shared's memoryCategory exactly, IN ORDER, so these two move
-- together or the suite fails. 'assistant_offer' is appended LAST on both sides.
--
-- WHY A NEW CATEGORY RATHER THAN REUSING ONE. Stage C5 §12.1 stores a declined offer as a
-- memory_facts row at status='rejected' so the same offer is not made twice, and never mentions
-- category -- which is `not null`. Every one of the eight existing values is a claim ABOUT THE
-- USER ('preference', 'opinion', 'habit', ...). A declined offer is a claim about the world that
-- the user did not want kept. Filing it as 'opinion' would write a false statement about the
-- person into the most trust-sensitive table in the system.
--
-- IT IS ALSO THE FENCE. Life-domains §6.4 explicitly REJECTED feeding web-search signal into the
-- memory layer: "a dedicated search-signal pipeline would add a weak-evidence source to the most
-- trust-sensitive subsystem." Reusing memory_facts without a fence is that rejected pipeline
-- arriving through a side door. §12.2 names an `evidence` marker as the fence; this category is a
-- stronger one, because a jsonb marker can be forgotten by a query that filters on everything
-- else, while a category is in the same WHERE clause every consumer already writes. Both are
-- written. The nightly memory update -- WHEN IT IS BUILT, it does not exist as of 00033 -- must
-- exclude category = 'assistant_offer'. These rows exist for deduplication and nothing else.
alter table public.memory_facts drop constraint memory_facts_category_check;
alter table public.memory_facts add constraint memory_facts_category_check
  check (category in (
    'identity','preference','interest','project',
    'habit','opinion','skill','relationship','assistant_offer'
  ));
