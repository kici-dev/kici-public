import { type Kysely, sql } from 'kysely';

/**
 * Add a trigger on `generic_webhook_sources` that emits
 * `pg_notify('generic_sources_change', routing_key)` on every INSERT, UPDATE
 * and DELETE. A soft-delete (UPDATE setting `deleted_at`) rides the UPDATE
 * path; the listener reads `deleted_at IS NOT NULL` or a missing row as
 * de-registration.
 *
 * `GenericSourcesChangeListener`
 * (`packages/orchestrator/src/webhook/generic-sources-listener.ts`) LISTENs in
 * every peer and updates its local `ProviderRegistry`
 * (`registerProviderBundleForSource` / `unregister`). Without it, peers other
 * than the one that ran `kici-admin source add generic` 404 the webhooks until
 * restart.
 *
 * Mirrors the GitHub-app `sources` trigger (`notify_sources_change()` +
 * `sources_change_trigger` in `001_initial.ts`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION public.notify_generic_sources_change() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('generic_sources_change', OLD.routing_key);
      ELSE
        PERFORM pg_notify('generic_sources_change', NEW.routing_key);
      END IF;
      RETURN NULL;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE TRIGGER generic_sources_change_trigger
      AFTER INSERT OR UPDATE OR DELETE ON public.generic_webhook_sources
      FOR EACH ROW EXECUTE FUNCTION public.notify_generic_sources_change()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS generic_sources_change_trigger ON public.generic_webhook_sources`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS public.notify_generic_sources_change()`.execute(db);
}
