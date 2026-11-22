import { beforeAll, beforeEach, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { AgentTokenStore } from './token-store.js';

/**
 * Real-Postgres coverage of the agent-token rows a failed scaler spawn and the expiry sweep
 * leave behind. Gated on KICI_TEST_ADMIN_DATABASE_URL, which the shared globalSetup
 * (scripts/db-test-postgres.ts) sets.
 */
describeWithTestDb<Database>(
  'AgentTokenStore (real Postgres)',
  {
    prefix: 'kici_agent_token_store_test',
    provider: createMigrationProvider(),
    timeoutMs: 120_000,
  },
  (getDb) => {
    let db: Kysely<Database>;
    let store: AgentTokenStore;

    beforeAll(() => {
      ({ db } = getDb());
      store = new AgentTokenStore(db);
    });

    beforeEach(async () => {
      await sql`DELETE FROM public.agent_tokens`.execute(db);
    });

    it('revokes every live token a failed spawn minted, and nothing else', async () => {
      const failed = await store.createEphemeral('container-agent-failed', ['linux'], 3_600_000);
      const retried = await store.createEphemeral('container-agent-failed', ['linux'], 3_600_000);
      const healthy = await store.createEphemeral('container-agent-ok', ['linux'], 3_600_000);
      await store.mintBootstrapToken({
        targetAgentId: 'container-agent-failed',
        ttlMs: 600_000,
        labels: ['init'],
      });
      await store.createStatic({ createdBy: 'container-agent-failed' });

      // fails-when: the revoke matches nothing, so both minted tokens still validate
      expect(await store.revokeEphemeralForAgent('container-agent-failed')).toBe(2);
      expect(await store.validate(failed)).toBeNull();
      expect(await store.validate(retried)).toBeNull();
      // breaks-if-wrong: another agent's token, a bootstrap token for the same id and a
      // static token whose creator string matches all stay live
      expect(await store.validate(healthy)).not.toBeNull();
      const live = await store.list();
      expect(live.map((t) => t.agent_type).sort()).toEqual(['ephemeral', 'ephemeral', 'static']);
      expect(live.some((t) => t.created_by === 'bootstrap:container-agent-failed')).toBe(true);

      // Idempotent: a second revoke finds nothing live.
      expect(await store.revokeEphemeralForAgent('container-agent-failed')).toBe(0);
    });

    it('prunes expired ephemeral tokens, revoked or not, and keeps the live ones', async () => {
      await store.createEphemeral('agent-expired', ['linux'], 3_600_000);
      await store.createEphemeral('agent-expired-revoked', ['linux'], 3_600_000);
      await store.createEphemeral('agent-live', ['linux'], 3_600_000);
      await store.revokeEphemeralForAgent('agent-expired-revoked');
      await sql`UPDATE public.agent_tokens SET expires_at = now() - interval '1 minute'
                 WHERE created_by IN ('agent-expired', 'agent-expired-revoked')`.execute(db);

      // fails-when: the sweep skips a revoked row, so a failed spawn's token outlives its TTL
      expect(await store.cleanupExpired()).toBe(2);
      const rows = await db.selectFrom('agent_tokens').select('created_by').execute();
      expect(rows.map((r) => r.created_by)).toEqual(['agent-live']);
    });
  },
);
