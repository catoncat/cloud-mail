/**
 * What a message listing is allowed to return.
 *
 * Kept in its own module so the rule can be tested: this projection is the whole
 * difference between a listing that fits the free plan's 10ms CPU budget and one
 * that gets killed mid-flight. It has been undone twice by "just select the row",
 * each time costing a day of CPU-exceeded errors, so the bound is pinned by
 * tests/projection.test.ts rather than by a comment alone.
 */

/**
 * Bytes of body a listing may carry per message.
 *
 * Text parts are small (99% of stored mail is under 4 KB); the HTML part is what
 * used to dominate a listing at ~15 KB per message, and it is only needed when a
 * message has no text part at all.
 */
export const LISTING_BODY_BYTES = 8000;

/**
 * The columns a listing may return.
 *
 * Bodies are bounded on purpose: the full projection measured 1.5 MB per 100 rows
 * (2.4 MB during the 2026-11-08 flood), which is 20-30 ms of CPU and over the free
 * plan's 10 ms budget. Bounded, the same 100 rows are ~90 KB.
 *
 * `html_body` rides along only for messages that have no text part, because that is
 * the only case where `stripHtml` needs it; 98% of stored mail carries a text part.
 * `raw` is never part of a listing.
 */
export function listingProjection(): string {
  return [
    "id",
    "recipient",
    "domain",
    "local_part",
    "sender",
    "subject",
    "received_at",
    "raw_size",
    "raw_truncated",
    `substr(text_body, 1, ${LISTING_BODY_BYTES}) AS text_body`,
    `CASE WHEN trim(text_body) = '' THEN substr(html_body, 1, ${LISTING_BODY_BYTES}) ELSE '' END AS html_body`,
    "code",
    "link",
    "message_id",
    `(length(text_body) > ${LISTING_BODY_BYTES} OR (trim(text_body) = '' AND length(html_body) > ${LISTING_BODY_BYTES})) AS body_truncated`,
  ].join(", ");
}
