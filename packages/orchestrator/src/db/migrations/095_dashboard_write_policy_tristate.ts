import { type Kysely, sql } from 'kysely';

/**
 * Migrate stored `org_settings.dashboard_write_policy` JSONB from the legacy
 * boolean shape to the tri-state `permissive | encrypted | disabled` shape:
 *
 *   - `false` (disabled)  → `"disabled"`
 *   - `true`  (permissive) → key dropped (permissive is the absent-key default,
 *     keeping the JSONB minimal — matches setDashboardWritePolicy normalization)
 *   - already-string enum values → left untouched (idempotent re-run)
 *
 * Runtime reads coerce booleans defensively too (so an un-migrated row is never
 * mis-read), but this migration normalizes the at-rest shape so the stored JSONB
 * matches what the tri-state writer produces.
 *
 * Pure SQL rewrite: for each row, rebuild the object keeping only non-`true`
 * entries and mapping `false` → `'disabled'`, leaving existing string values.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE org_settings
       SET dashboard_write_policy = COALESCE(
         (
           SELECT jsonb_object_agg(
                    kv.key,
                    CASE
                      WHEN jsonb_typeof(kv.value) = 'boolean' AND kv.value = 'false'::jsonb
                        THEN '"disabled"'::jsonb
                      ELSE kv.value
                    END
                  )
             FROM jsonb_each(dashboard_write_policy) AS kv
            -- Drop the permissive (true) entries: permissive is the absent-key default.
            WHERE NOT (jsonb_typeof(kv.value) = 'boolean' AND kv.value = 'true'::jsonb)
         ),
         '{}'::jsonb
       )
     WHERE dashboard_write_policy IS NOT NULL
       AND dashboard_write_policy <> '{}'::jsonb
       AND EXISTS (
         SELECT 1 FROM jsonb_each(dashboard_write_policy) AS kv
          WHERE jsonb_typeof(kv.value) = 'boolean'
       )
  `.execute(db);
}

export async function down(): Promise<void> {
  // Irreversible data normalization (the tri-state shape supersedes booleans);
  // runtime reads coerce both shapes, so there is nothing to roll back.
}
