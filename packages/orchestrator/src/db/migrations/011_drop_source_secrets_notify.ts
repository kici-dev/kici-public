import { type Kysely, sql } from 'kysely';

/**
 * Drops `source_secrets_change_trigger` and `notify_source_secrets_change()`. Their only
 * LISTEN/NOTIFY consumer, `WebhookSecretManager`, pushed webhook secrets to the Platform; the
 * orchestrator now never sends secret material there (the Platform asks it to verify each
 * webhook, reading `PgSecretStore`), so the NOTIFY traffic has no listener.
 *
 * `down` re-creates both as defined in `001_initial.ts`; they wake no consumer, so the
 * rollback is safe.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS source_secrets_change_trigger ON public.scoped_secrets`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS public.notify_source_secrets_change() CASCADE`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION public.notify_source_secrets_change() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
    DECLARE
      v_routing_key text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        SELECT routing_key INTO v_routing_key
        FROM public.sources
        WHERE id = (substring(OLD.scope from '^__source__/(.+)$'))::uuid;
      ELSE
        SELECT routing_key INTO v_routing_key
        FROM public.sources
        WHERE id = (substring(NEW.scope from '^__source__/(.+)$'))::uuid;
      END IF;

      IF v_routing_key IS NOT NULL THEN
        PERFORM pg_notify('sources_change', v_routing_key);
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      ELSE
        RETURN NEW;
      END IF;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE TRIGGER source_secrets_change_trigger
      AFTER INSERT OR UPDATE ON public.scoped_secrets
      FOR EACH ROW EXECUTE FUNCTION public.notify_source_secrets_change()
  `.execute(db);
}
