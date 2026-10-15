import { type Kysely, sql } from 'kysely';

/**
 * The whitespace `btrim` strips, matching the `String.prototype.trim` that `canonicalizeLabel`
 * uses. `btrim` defaults to spaces alone, so the set is spelled out: space, tab, newline, form
 * feed, carriage return, vertical tab.
 *
 * Vertical tab is `\x0B` because `\v` is absent from the documented escape table, though
 * `E'\v'` is the same character (PostgreSQL 18.6: `ascii(E'\v')` = 11).
 *
 * Unicode spaces `trim` also strips (U+00A0, U+FEFF, the U+2000 block) are left alone; such a
 * label never matched before this migration either.
 */
const TRIM_CHARS = String.raw`E' \t\n\r\f\x0B'`;

/**
 * Fold `dispatch_queue` label arrays to their canonical (trimmed, lowercase) form.
 *
 * Every other label store folds on read, but `dispatch_queue` compares in SQL (the `@>`
 * prefilter and the `jsonb_array_elements_text` exclude check), filtering rows before any
 * JavaScript sees them. A row enqueued before labels became case-insensitive would never match
 * a folded agent label set again, and is never selected for a read-side fold to rescue.
 *
 * The fold mirrors `canonicalizeLabel` in `@kici-dev/engine` (`btrim(lower(...))` against
 * `raw.trim().toLowerCase()`), so a rewritten row holds the same bytes as labels enqueued today.
 * Lowercasing alone would strand a padded legacy label, because the agent side trims.
 *
 * `runs_on_patterns` / `exclude_patterns` stay untouched: they hold regex SOURCES that
 * lowercasing would corrupt, and fold via the forced `i` flag on read. The GIN index
 * `idx_dispatch_queue_labels_gin` needs no change: only the values move.
 *
 * `COALESCE(jsonb_agg(...), '[]'::jsonb)` is unreachable as written and is defence in depth
 * against the `EXISTS` guard being loosened. `jsonb_agg` over zero rows returns NULL, which would
 * violate `runs_on_labels NOT NULL` and leave the drain nothing to walk on `exclude_labels`; zero
 * rows needs an empty array, which the guard (an element differing from its folded form) never
 * admits. A guard that admits an empty array makes the COALESCE load-bearing.
 *
 * Idempotent: each `UPDATE` selects only rows with a non-canonical element.
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
 * Irreversible by design: the original case is destroyed. As a data migration, `up` changed no
 * schema, so the no-op is the honest `down`.
 *
 * Rolling the orchestrator back is briefly worse than never migrating: an old orchestrator
 * compares agent labels verbatim against canonicalized rows, so a fleet with non-lowercase
 * labels strands those rows until they expire, drain, or are re-enqueued.
 */
export async function down(): Promise<void> {
  // Intentionally empty — see the note above.
}
