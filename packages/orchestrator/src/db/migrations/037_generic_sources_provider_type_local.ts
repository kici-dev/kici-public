import { type Kysely, sql } from 'kysely';

/**
 * Replace the `generic_webhook_sources.provider_type` CHECK constraint so it
 * permits `'local'` instead of `'internal'`, and migrate any carried-over
 * `'internal'` rows to `'local'`.
 *
 * The local filesystem (`file://`) provider is `provider_type='local'`; the
 * value used to be `'internal'`. The original CHECK constraint
 * (`generic_webhook_sources_provider_type_check`) allowed only
 * `{'generic','internal'}`, so writing a `'local'` row fails. Universal-git
 * sources keep `provider_type='generic'` (discriminated by `git_config`), so
 * the new allowed set is `{'generic','local'}`.
 *
 * Idempotent: the constraint is dropped IF EXISTS and recreated; the data
 * backfill is a plain UPDATE that is a no-op once no `'internal'` rows remain.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Drop the old constraint FIRST. The existing constraint only permits
  // {'generic','internal'}, so any UPDATE touching a row (even one that already
  // holds 'local' from an out-of-band write) would re-trigger the old check and
  // fail. With the constraint gone, the backfill runs freely.
  await sql`
    ALTER TABLE public.generic_webhook_sources
      DROP CONSTRAINT IF EXISTS generic_webhook_sources_provider_type_check
  `.execute(db);

  // Migrate carried-over rows so the new constraint validates cleanly.
  await sql`
    UPDATE public.generic_webhook_sources
       SET provider_type = 'local'
     WHERE provider_type = 'internal'
  `.execute(db);

  await sql`
    ALTER TABLE public.generic_webhook_sources
      ADD CONSTRAINT generic_webhook_sources_provider_type_check
      CHECK (provider_type = ANY (ARRAY['generic'::text, 'local'::text]))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.generic_webhook_sources
      DROP CONSTRAINT IF EXISTS generic_webhook_sources_provider_type_check
  `.execute(db);

  await sql`
    UPDATE public.generic_webhook_sources
       SET provider_type = 'internal'
     WHERE provider_type = 'local'
  `.execute(db);

  await sql`
    ALTER TABLE public.generic_webhook_sources
      ADD CONSTRAINT generic_webhook_sources_provider_type_check
      CHECK (provider_type = ANY (ARRAY['generic'::text, 'internal'::text]))
  `.execute(db);
}
