/**
 * Admin API routes for webhook source management.
 *
 * Provides CRUD endpoints for managing webhook sources (GitHub Apps, etc.)
 * through the admin API. Source secrets (private keys, webhook secrets) are
 * stored via PgSecretStore and never exposed in list/get responses.
 *
 * All routes are mounted under /api/v1/admin/sources and protected by
 * the admin auth middleware in admin.ts.
 */
import { Hono } from 'hono';
import type { SourceStore } from '../sources/source-store.js';
import { validateGitHubSource } from '../sources/source-validator.js';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { enforceRoutingKeyScope, requireUnscopedToken } from '../secrets/routing-key-scope.js';
import type { Role } from '../secrets/rbac.js';
import { fetchGithubAppIdentity } from '../providers/github/manifest.js';
import {
  refreshGithubSourceIdentity,
  type FetchGithubAppIdentity,
  type RefreshResult,
} from '../github-app-name-refresher/github-app-name-refresher.js';

const logger = createLogger({ prefix: 'admin-sources' });

interface SourceRouteDeps {
  sourceStore: SourceStore;
  /**
   * Resolve the public webhook URL for a freshly added source so the CLI can
   * print it. Platform/hybrid mode registers the source with the Platform and
   * reads the URL from the `source.register.ack`; independent mode returns a
   * null URL with an explanatory `webhookNote`. Omitted in deployments with no
   * resolver wired (the route then returns `webhookUrl: null`).
   */
  resolveSourceWebhookUrl?: (params: {
    routingKey: string;
    provider: string;
    sourceId: string;
  }) => Promise<{ webhookUrl: string | null; webhookNote?: string }>;
  /**
   * Resolve the org-scoped GitHub webhook URL for the manifest setup flow
   * BEFORE any App exists. The GitHub webhook URL is org-scoped
   * (`<base>/webhook/<orgId>/github`), not app-scoped, so it can be computed
   * up front and baked into the App manifest. Returns null + a note when the
   * orchestrator cannot yet resolve a public base or its org id.
   */
  resolveGithubWebhookUrl?: () => Promise<{ webhookUrl: string | null; webhookNote?: string }>;
  /**
   * Fetch a GitHub App's authoritative `{ name, slug }` from GitHub. Injectable
   * for tests; defaults to the real `fetchGithubAppIdentity`. Used by the
   * `source refresh` route.
   */
  fetchAppIdentity?: FetchGithubAppIdentity;
}

type AdminSourcesEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

export function createSourceRoutes(deps: SourceRouteDeps): Hono<AdminSourcesEnv> {
  const app = new Hono<AdminSourcesEnv>();

  // POST /api/v1/admin/sources -- add a new source. Creates a fresh
  // routing key on the orchestrator, so it cannot be reached by a
  // routing-key-scoped token (the token has no say in the future routing
  // key the new source will receive).
  app.post('/sources', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      const body = await c.req.json();
      const { provider, name, slug, appId, privateKey, webhookSecret } = body;

      if (!provider || !name || !appId || !privateKey) {
        return c.json({ error: 'Missing required fields: provider, name, appId, privateKey' }, 400);
      }

      // For GitHub sources, GitHub is the source of truth for the stored name +
      // slug: the credential validation already calls `GET /app`, so adopt its
      // authoritative name/slug instead of the CLI-supplied `--name`. The
      // manifest flow passes GitHub's values already; the manual `--app-id`
      // flow passes only the CLI name, which we replace here.
      let storedName = name;
      let storedSlug: string | undefined = slug;
      if (provider === 'github') {
        const validation = await validateGitHubSource(appId, privateKey);
        if (!validation.valid) {
          return c.json({ error: validation.error }, 400);
        }
        if (validation.appName) storedName = validation.appName;
        if (validation.slug) storedSlug = validation.slug;
        logger.info(`GitHub App validated: ${validation.appName} (ID: ${appId})`);
      }

      const source = await deps.sourceStore.addSource({
        provider,
        name: storedName,
        slug: storedSlug,
        appId,
        privateKey,
        webhookSecret,
      });

      // Resolve the public webhook URL to surface in the CLI output. Best
      // effort — a resolver failure (disconnect/timeout) must not fail the add,
      // which already succeeded in the DB.
      let webhookUrl: string | null = null;
      let webhookNote: string | undefined;
      if (deps.resolveSourceWebhookUrl) {
        try {
          const resolved = await deps.resolveSourceWebhookUrl({
            routingKey: source.routing_key,
            provider,
            sourceId: source.id,
          });
          webhookUrl = resolved.webhookUrl;
          webhookNote = resolved.webhookNote;
        } catch (err) {
          logger.warn('Failed to resolve webhook URL for added source', {
            routingKey: source.routing_key,
            error: toErrorMessage(err),
          });
          webhookNote = 'resolve-failed';
        }
      }

      return c.json(
        {
          routingKey: source.routing_key,
          id: source.id,
          name: source.name,
          webhookUrl,
          ...(webhookNote && { webhookNote }),
        },
        201,
      );
    } catch (err) {
      logger.error('Failed to add source', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  // GET /api/v1/admin/sources/github-webhook-url -- manifest pre-flight.
  // Resolves the org-scoped GitHub webhook URL so the manifest setup flow can
  // bake it into the App before the App exists. Registered before the
  // parameterized routes so the static segment wins.
  app.get('/sources/github-webhook-url', async (c) => {
    try {
      if (!deps.resolveGithubWebhookUrl) {
        return c.json({ webhookUrl: null, webhookNote: 'resolver-unavailable' });
      }
      const resolved = await deps.resolveGithubWebhookUrl();
      return c.json({
        webhookUrl: resolved.webhookUrl,
        ...(resolved.webhookNote && { webhookNote: resolved.webhookNote }),
      });
    } catch (err) {
      logger.error('Failed to resolve github webhook url', { error: toErrorMessage(err) });
      return c.json({ webhookUrl: null, webhookNote: 'resolve-failed' });
    }
  });

  // GET /api/v1/admin/sources -- list all sources. Routing-key-scoped
  // tokens see only their own source.
  app.get('/sources', async (c) => {
    try {
      const tokenRoutingKey = c.get('routingKey');
      const all = await deps.sourceStore.listSources();
      const sources = tokenRoutingKey ? all.filter((s) => s.routing_key === tokenRoutingKey) : all;
      return c.json({
        sources: sources.map((s) => ({
          id: s.id,
          provider: s.provider,
          name: s.name,
          routingKey: s.routing_key,
          customerId: s.customer_id,
          config: typeof s.config === 'string' ? JSON.parse(s.config) : s.config,
          createdAt: s.created_at,
          updatedAt: s.updated_at,
        })),
      });
    } catch (err) {
      logger.error('Failed to list sources', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  // PATCH /api/v1/admin/sources/:routingKey -- update a source
  app.patch('/sources/:routingKey', async (c) => {
    try {
      const routingKey = decodeURIComponent(c.req.param('routingKey'));
      const denied = enforceRoutingKeyScope(c, routingKey);
      if (denied) return denied;
      const body = await c.req.json();
      const { name, privateKey, webhookSecret, config, customerId } = body;

      // Check source exists before attempting update
      const existing = await deps.sourceStore.getSource(routingKey);
      if (!existing) return c.json({ error: 'Source not found' }, 404);

      // If updating privateKey, re-validate against the existing appId
      if (privateKey) {
        const parsed = (
          typeof existing.config === 'string' ? JSON.parse(existing.config) : existing.config
        ) as { appId: string };
        const validation = await validateGitHubSource(parsed.appId, privateKey);
        if (!validation.valid) return c.json({ error: validation.error }, 400);
      }

      const source = await deps.sourceStore.updateSource(routingKey, {
        name,
        privateKey,
        webhookSecret,
        config,
        customerId,
      });
      return c.json({ routingKey: source.routing_key, name: source.name });
    } catch (err) {
      logger.error('Failed to update source', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  const fetchAppIdentity = deps.fetchAppIdentity ?? ((creds) => fetchGithubAppIdentity(creds));

  // POST /api/v1/admin/sources/refresh-all -- re-sync every GitHub source's
  // name + slug from GitHub. Registered before the parameterized refresh route
  // so the static `refresh-all` segment wins.
  app.post('/sources/refresh-all', async (c) => {
    try {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      const all = await deps.sourceStore.listSources();
      const githubKeys = all.filter((s) => s.provider === 'github').map((s) => s.routing_key);
      const results: RefreshResult[] = [];
      const errors: Array<{ routingKey: string; error: string }> = [];
      for (const routingKey of githubKeys) {
        try {
          results.push(
            await refreshGithubSourceIdentity(deps.sourceStore, routingKey, fetchAppIdentity),
          );
        } catch (err) {
          errors.push({ routingKey, error: toErrorMessage(err) });
        }
      }
      return c.json({ results, errors });
    } catch (err) {
      logger.error('Failed to refresh all sources', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  // POST /api/v1/admin/sources/:routingKey/refresh -- re-sync one GitHub
  // source's name + slug from GitHub (`GET /app`). The DB write (when drifted)
  // fires the `sources_change` trigger, which re-registers to the Platform.
  app.post('/sources/:routingKey/refresh', async (c) => {
    try {
      const routingKey = decodeURIComponent(c.req.param('routingKey'));
      const denied = enforceRoutingKeyScope(c, routingKey);
      if (denied) return denied;
      const result = await refreshGithubSourceIdentity(
        deps.sourceStore,
        routingKey,
        fetchAppIdentity,
      );
      return c.json(result);
    } catch (err) {
      const message = toErrorMessage(err);
      // A missing or non-GitHub source is a client error, not a 500.
      const status = /not found|not a github source/i.test(message) ? 400 : 500;
      if (status === 500) logger.error('Failed to refresh source', { error: message });
      return c.json({ error: message }, status);
    }
  });

  // GET /api/v1/admin/sources/:routingKey/webhook-secret -- get webhook secret for a source
  app.get('/sources/:routingKey/webhook-secret', async (c) => {
    try {
      const routingKey = decodeURIComponent(c.req.param('routingKey'));
      const denied = enforceRoutingKeyScope(c, routingKey);
      if (denied) return denied;
      const source = await deps.sourceStore.getSourceWithSecrets(routingKey);
      if (!source) return c.json({ error: 'Source not found' }, 404);

      return c.json({
        routingKey: source.routing_key,
        webhookSecret: source.webhookSecret ?? null,
      });
    } catch (err) {
      logger.error('Failed to get webhook secret', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  // DELETE /api/v1/admin/sources/:routingKey -- remove a source
  app.delete('/sources/:routingKey', async (c) => {
    try {
      const routingKey = decodeURIComponent(c.req.param('routingKey'));
      const denied = enforceRoutingKeyScope(c, routingKey);
      if (denied) return denied;
      await deps.sourceStore.removeSource(routingKey);
      return c.json({ ok: true });
    } catch (err) {
      logger.error('Failed to remove source', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  return app;
}
