/**
 * Real-Postgres coverage for where a GitHub source's server lives: the
 * `github_url` column, written by the store, and never `config.githubUrl`.
 * During a rolling upgrade an earlier peer's generic config update can still
 * store that key after the migrations ran; it must have no effect. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import type { PgSecretStore } from '../secrets/pg-secret-store.js';
import { SourceStore } from './source-store.js';
import { githubAppConfigOf } from './github-source-config.js';

const noSecrets = { setSecret: async () => undefined } as unknown as PgSecretStore;

describeWithTestDb<Database>(
  'the GitHub server of a stored source',
  { prefix: 'kici_source_server', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;
    let store: SourceStore;

    /** The App config the orchestrator builds from the stored row. */
    const appConfig = async (routingKey: string) =>
      githubAppConfigOf({ ...(await store.getSource(routingKey))!, privateKey: 'k' });

    /** What an earlier peer's generic config merge writes. */
    const plantInConfig = (routingKey: string) =>
      sql`
        UPDATE public.sources
           SET config = config || '{"githubUrl":"https://evil.example"}'::jsonb
         WHERE routing_key = ${routingKey}
      `.execute(db);

    beforeAll(() => {
      ({ db } = getDb());
      store = new SourceStore(db, noSecrets);
    });

    beforeEach(async () => {
      await db.deleteFrom('sources').execute();
    });

    it('reads the server from github_url and ignores a config.githubUrl', async () => {
      await store.addSource({
        provider: 'github',
        name: 'ghes',
        appId: '51',
        privateKey: 'k',
        githubUrl: 'https://ghe.corp.example',
      });
      await store.addSource({ provider: 'github', name: 'dotcom', appId: '52', privateKey: 'k' });
      await plantInConfig('github:51');
      await plantInConfig('github:52');

      // fails-when: the planted config key is honoured as the App's server
      expect(await appConfig('github:52')).toEqual({ appId: '52', privateKey: 'k' });
      // breaks-if-wrong: the server the admin API stored still wins
      expect((await appConfig('github:51')).githubUrl).toBe('https://ghe.corp.example');
    });

    it('stores a github.com source with no server and its config unchanged', async () => {
      await store.addSource({ provider: 'github', name: 'dotcom', appId: '53', privateKey: 'k' });
      const row = await db
        .selectFrom('sources')
        .select(['github_url', sql<string>`config::text`.as('config')])
        .where('routing_key', '=', 'github:53')
        .executeTakeFirstOrThrow();
      // breaks-if-wrong: a github.com source's row matches what it always was
      expect(row).toEqual({ github_url: null, config: '{"appId": "53"}' });
    });

    it('moves the server through its own field and clears it', async () => {
      await store.addSource({ provider: 'github', name: 'app', appId: '54', privateKey: 'k' });
      await store.updateSource('github:54', { githubUrl: 'https://ghe.corp.example' });
      expect((await appConfig('github:54')).githubUrl).toBe('https://ghe.corp.example');
      await store.updateSource('github:54', { githubUrl: null });
      expect(await appConfig('github:54')).toEqual({ appId: '54', privateKey: 'k' });
    });
  },
);
