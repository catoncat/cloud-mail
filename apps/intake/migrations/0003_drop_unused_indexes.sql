-- Drop two indexes that no query can use.
--
-- Every read touching these columns filters with `code != ''` / `link != ''`, and
-- SQLite does not use an index for an inequality against a constant. The one query
-- that looks like a candidate — /admin/latest-code — is already served by
-- idx_messages_recipient_received, which supplies both the equality on recipient
-- and the received_at ordering.
--
-- So these cost a write on every stored message and buy back nothing. Mail ingestion
-- is the write-heaviest path in the system, which is exactly where that matters.

-- 0001 still creates them. Editing an applied migration is off the table (see
-- migrations/README.md), and on a fresh database this create-then-drop runs against
-- an empty table, so the ordering costs nothing.

DROP INDEX IF EXISTS idx_messages_code;
DROP INDEX IF EXISTS idx_messages_link;
