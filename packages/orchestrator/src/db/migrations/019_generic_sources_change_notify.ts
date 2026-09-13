import { type Kysely, sql } from 'kysely';

/**
 * Add a Postgres trigger on `generic_webhook_sources` that emits
 * `pg_notify('generic_sources_change', routing_key)` on every INSERT,
 * UPDATE, and DELETE. Soft-deletes (UPDATE that sets `deleted_at`) ride
 * the same UPDATE path — the listener treats a row with `deleted_at IS
 * NOT NULL` (or a row that no longer exists for that routing_key) as a
 * de-registration signal.
 *
 * The consumer is `GenericSourcesChangeListener`
 * (`packages/orchestrator/src/webhook/generic-sources-listener.ts`),
 * which runs in every orchestrator peer, LISTENs on the channel, and
 * mutates the local `ProviderRegistry` in place
 * (`registerProviderBundleForSource` for INSERT/UPDATE; `unregister` for
 * DELETE / soft-delete). Without this round-trip, peers other than the
 * one that handled `kici-admin source add generic` would 404 incoming
 * webhooks until restart.
 *
 * Mirrors the existing GitHub-app `sources` trigger
 * (`notify_sources_change()` + `sources_change_trigger`, defined in
 * `001_initial.ts`).
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
