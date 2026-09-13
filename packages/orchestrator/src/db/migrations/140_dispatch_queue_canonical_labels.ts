import { type Kysely, sql } from 'kysely';

/**
 * The whitespace `btrim` strips, chosen to match `String.prototype.trim`, which
 * `canonicalizeLabel` uses. `btrim` defaults to spaces alone, so the set is
 * spelled out: space, tab, newline, form feed, carriage return, vertical tab.
 *
 * Vertical tab is written `\x0B` for explicitness, not out of necessity: `E'\v'`
 * is the same character, verified on PostgreSQL 18.6 (`ascii(E'\v')` = 11). The
 * hex form is preferred only because `\v` is absent from the escape table in the
 * documentation, so a reader cannot confirm it there.
 *
 * Exotic Unicode spaces that `trim` also strips (U+00A0, U+FEFF, the U+2000
 * block) are out of reach here and are left alone. Such a label never matched
 * anything before this migration either, so leaving it is not a regression.
 */
const TRIM_CHARS = String.raw`E' \t\n\r\f\x0B'`;

/**
 * Fold `dispatch_queue` label arrays to their canonical (trimmed, lowercase)
 * form.
 *
 * Label matching folds case, and every other label store folds on read.
 * `dispatch_queue` cannot: its comparison happens in SQL — the `@>` containment
 * prefilter and the `jsonb_array_elements_text` exclude check — so the SQL
 * filters rows before any JavaScript sees them. A row enqueued before labels
 * became case-insensitive carries whatever case the workflow author wrote, so
 * it would never again match a folded agent label set, and no read-side fold
 * could rescue it because the row is never selected in the first place. This
 * migration is what makes those rows reachable.
 *
 * The fold mirrors `canonicalizeLabel` in `@kici-dev/engine` —
 * `btrim(lower(...))` against `raw.trim().toLowerCase()` — so a row this
 * migration rewrites holds the same bytes as the same labels enqueued today.
 * Lowercasing alone would strand a padded legacy label the same way a
 * mixed-case one is stranded, because the agent side trims.
 *
 * `runs_on_patterns` / `exclude_patterns` are deliberately untouched: they hold
 * regex SOURCES, which cannot be lowercased without corrupting the pattern.
 * Those fold via the forced `i` flag applied when they are read.
 *
 * The GIN index `idx_dispatch_queue_labels_gin` needs no change — the query
 * shape is identical, only the values move.
 *
 * `COALESCE(jsonb_agg(...), '[]'::jsonb)` is defence in depth against the
 * `EXISTS` guard below being loosened, and is unreachable as the statement
 * stands. `jsonb_agg` over zero rows does return NULL, and a NULL would violate
 * `runs_on_labels NOT NULL` and leave the drain's `jsonb_array_elements_text`
 * with nothing to walk on `exclude_labels` — but zero rows requires an empty
 * array, and an empty array can never satisfy a guard that demands an element
 * differing from its own folded form. Removing the guard, or replacing it with
 * one that admits an empty array, makes the COALESCE load-bearing immediately,
 * so it stays.
 *
 * Idempotent: each `UPDATE` selects only rows holding an element that is not
 * already its own canonical form, so a re-run touches nothing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const trim = sql.raw(TRIM_CHARS);

  await sql`
    UPDATE public.dispatch_queue
       SET runs_on_labels = (
             SELECT COALESCE(jsonb_agg(btrim(lower(elem.value), ${trim})), '[]'::jsonb)
               FROM jsonb_array_elements_text(runs_on_labels) AS elem(value)
           )
     WHERE runs_on_labels IS NOT NULL
       AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(runs_on_labels) AS elem(value)
              WHERE elem.value <> btrim(lower(elem.value), ${trim})
           )
  `.execute(db);

  await sql`
    UPDATE public.dispatch_queue
       SET exclude_labels = (
             SELECT COALESCE(jsonb_agg(btrim(lower(elem.value), ${trim})), '[]'::jsonb)
               FROM jsonb_array_elements_text(exclude_labels) AS elem(value)
           )
     WHERE exclude_labels IS NOT NULL
       AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(exclude_labels) AS elem(value)
              WHERE elem.value <> btrim(lower(elem.value), ${trim})
           )
  `.execute(db);
}

/**
 * Irreversible by design: the original case is destroyed, so there is nothing
 * to restore. This is a data migration, not a schema change, so `down` leaves
 * the schema exactly as `up` found it and the no-op is the honest outcome
 * rather than a missing implementation.
 *
 * Rolling the orchestrator back is briefly worse than never having migrated:
 * an old orchestrator compares an agent's labels verbatim against rows this
 * migration canonicalized, so a fleet whose configured labels are not already
 * lowercase strands those rows until they expire, drain, or are re-enqueued.
 */
export async function down(): Promise<void> {
  // Intentionally empty — see the note above.
}
