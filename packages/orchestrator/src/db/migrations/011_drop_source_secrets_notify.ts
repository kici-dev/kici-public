import { type Kysely, sql } from 'kysely';

/**
 * Drop the `source_secrets_change_trigger` and the
 * `notify_source_secrets_change()` plpgsql function.
 *
 * Both were used by the (now removed) `WebhookSecretManager` which
 * subscribed via LISTEN/NOTIFY to detect changes to webhook secret rows in
 * `scoped_secrets` and pushed them to the multi-tenant Platform via the
 * `source.secrets` WS message. After the chunked-relay cutover the
 * orchestrator never pushes secret material to Platform -- Platform asks
 * the orchestrator to verify each inbound webhook on demand and the
 * verifier reads secrets directly from `PgSecretStore` -- so the trigger
 * is dead code and only emits NOTIFY traffic that nobody listens to.
 *
 * `down` re-creates the function + trigger as they were originally defined
 * in `001_initial.ts`. They wake up no consumer until the `WebhookSecretManager`
 * is restored, so this migration is safe to roll back.
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
