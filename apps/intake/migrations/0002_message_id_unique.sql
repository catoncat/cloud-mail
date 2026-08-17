-- Make redelivery idempotent.
--
-- Cloudflare retries inbound mail whenever the email handler throws, and the
-- handler used to insert unconditionally. A retried delivery therefore produced a
-- second row carrying the same one-time code, which reads exactly like a second
-- real login attempt.
--
-- Keyed on (recipient, message_id) rather than message_id alone: one message
-- legitimately reaches several recipients, and each of those is a distinct inbox.
-- Rows with an empty message_id are excluded, since a missing header says nothing
-- about identity and must not collapse unrelated mail together.

-- Collapse pre-existing duplicates first, keeping the earliest row of each group,
-- otherwise the unique index below cannot be created on an already-populated
-- database. Idempotent: a deduplicated table matches nothing.
DELETE FROM messages
WHERE message_id != ''
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM messages
    WHERE message_id != ''
    GROUP BY recipient, message_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_recipient_message_id
  ON messages (recipient, message_id)
  WHERE message_id != '';
