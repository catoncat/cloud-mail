# Migrations

Applied in filename order by `npm run setup` (`scripts/setup.mjs`), against the
remote D1 database named in `config/domains.json`.

## Rules

1. **Name files `NNNN_description.sql`**, zero-padded, monotonically increasing.
   Anything not matching `^\d+_.*\.sql$` is ignored by the runner.
2. **Every migration must be idempotent.** There is no ledger table tracking what
   has run — `setup` replays the whole directory every time, which is what keeps a
   database created before this directory existed on the same footing as a fresh
   one. Use `IF NOT EXISTS`, `ON CONFLICT`, and predicates that match nothing on a
   second pass.
3. **Never edit an applied migration.** Add the next number instead; someone else's
   database has already run the old file.
4. **Backfills belong in the same file as the constraint they enable.** See
   `0002_message_id_unique.sql`, where the deduplicating `DELETE` has to precede
   `CREATE UNIQUE INDEX` or the index cannot be built on an existing table.

## Applying by hand

```bash
cd apps/intake
npx wrangler d1 execute <database-name> --remote --file migrations/0002_message_id_unique.sql
```
