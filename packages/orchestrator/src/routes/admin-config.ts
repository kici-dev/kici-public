/**
 * Admin REST API routes for config management.
 *
 * Provides endpoints under /admin/config/* for:
 * - seed: bulk import shared config from JSON body
 * - get: current effective config (merged local + shared + env)
 * - set: update single field in shared config
 * - delete: remove field from shared config
 * - export: dump shared config (redacted)
 * - validate: validate config against schema (no DB mutation)
 * - diff: compare local YAML vs shared DB config
 * - history: version history
 * - rollback: rollback to specific version
 * - reload: trigger config reload
 *
 * All routes protected by Bearer token auth (reuses admin middleware pattern).
 */

import { Hono } from 'hono';
import { createLogger } from '@kici-dev/shared';
import type { SharedConfigStore } from '../config/shared-store.js';
import type { ConfigReloader, ReloadResult } from '../config/reload.js';
import type { LocalConfig } from '../config/types.js';
import { sharedConfigSchema, localConfigSchema, appConfigSchema } from '../config/schema.js';
import { deepSet, deepGetByPath } from '../config/index.js';
import { handleAdminError } from './admin-errors.js';

const logger = createLogger({ prefix: 'admin-config' });

/**
 * Result of forwarding a reload request to a peer orchestrator.
 *
 * - `result` carries the ReloadResult from the target peer when delivery succeeded.
 * - `result === null` means the target peer is not connected (or unknown).
 */
export interface PeerReloadForwardResult {
  result: ReloadResult | null;
}

/**
 * Dependencies for config admin routes.
 */
export interface ConfigRouteDeps {
  sharedStore: SharedConfigStore;
  configReloader: ConfigReloader;
  localConfigPath?: string;
  loadLocalConfig: () => Promise<LocalConfig>;
  /** Admin token for Bearer auth. If undefined, routes return 503. */
  adminToken?: string;
  /**
   * Forward a config reload request to a specific peer instance via the
   * cluster peer connection. Returns the peer's ReloadResult, or `null` if
   * the target peer is unknown / not connected. When omitted, per-instance
   * targeting is unavailable and `target` requests return 501.
   */
  forwardReloadToPeer?: (
    targetInstanceId: string,
    opts: { drain?: boolean; timeoutMs?: number },
  ) => Promise<ReloadResult | null>;
}

/**
 * Create admin config routes.
 * Returns a Hono app to be mounted at /admin/config.
 */
export function createConfigAdminRoutes(deps: ConfigRouteDeps): Hono {
  const app = new Hono();

  // ── Bearer token auth middleware ──────────────────────────────
  app.use('*', async (c, next) => {
    if (!deps.adminToken) {
      return c.json({ error: 'Admin config API not configured (no admin token)' }, 503);
    }
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization' }, 401);
    }
    const token = authHeader.slice(7);
    if (token !== deps.adminToken) {
      return c.json({ error: 'Invalid token' }, 401);
    }
    await next();
  });

  // ── 1. POST /seed -- Bulk import shared config ────────────────
  app.post('/seed', async (c) => {
    try {
      const body = await c.req.json();
      const { config, description } = body as { config: unknown; description?: string };

      if (!config || typeof config !== 'object') {
        return c.json({ error: 'config field is required and must be an object' }, 400);
      }

      const version = await deps.sharedStore.save(
        config as Record<string, unknown>,
        'api:seed',
        description ?? 'Seeded via admin API',
      );

      logger.info('Config seeded via admin API', { version });

      return c.json({ version }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── 2. GET / -- Get current effective config (merged) ─────────
  app.get('/', async (c) => {
    try {
      const pathFilter = c.req.query('path');
      const currentConfig = deps.configReloader.getCurrentConfig();
      const version = deps.configReloader.getCurrentVersion();

      let config: unknown = currentConfig;

      if (pathFilter) {
        config = deepGetByPath(
          currentConfig as unknown as Record<string, unknown>,
          pathFilter.split('.'),
        );
        if (config === undefined) {
          return c.json({ error: `Path "${pathFilter}" not found in config` }, 404);
        }
      }

      // Redact sensitive values in the response
      const redacted = redactSensitiveInResponse(config as Record<string, unknown>, pathFilter);

      return c.json({ config: redacted, version, source: 'merged' }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── 3. PUT / -- Update single field in shared config ──────────
  app.put('/', async (c) => {
    try {
      const body = await c.req.json();
      const { path, value, description } = body as {
        path: string;
        value: unknown;
        description?: string;
      };

      if (!path || typeof path !== 'string') {
        return c.json({ error: 'path field is required and must be a string' }, 400);
      }

      // Get latest shared config, deep-set the value, save as new version
      const latest = await deps.sharedStore.getLatest();
      const currentConfig = latest ? (latest.config as Record<string, unknown>) : {};

      const updatedConfig = structuredClone(currentConfig);
      deepSet(updatedConfig, path, value);

      const version = await deps.sharedStore.save(
        updatedConfig,
        'api:set',
        description ?? `Set ${path}`,
      );

      logger.info('Config field updated via admin API', { path, version });

      return c.json({ version }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── 4. DELETE / -- Remove field from shared config ────────────
  app.delete('/', async (c) => {
    try {
      const body = await c.req.json();
      const { path, description } = body as { path: string; description?: string };

      if (!path || typeof path !== 'string') {
        return c.json({ error: 'path field is required and must be a string' }, 400);
      }

      const latest = await deps.sharedStore.getLatest();
      if (!latest) {
        return c.json({ error: 'No shared config exists' }, 404);
      }

      const updatedConfig = structuredClone(latest.config as Record<string, unknown>);
      deepDeletePath(updatedConfig, path);

      const version = await deps.sharedStore.save(
        updatedConfig,
        'api:delete',
        description ?? `Deleted ${path}`,
      );

      logger.info('Config field deleted via admin API', { path, version });

      return c.json({ version }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── 5. GET /export -- Dump shared config (redacted) ───────────
  app.get('/export', async (c) => {
    try {
      const redacted = await deps.sharedStore.exportRedacted();
      const version = await deps.sharedStore.getCurrentVersion();

      if (!redacted) {
        return c.json({ config: {}, version: 0 }, 200);
      }

      return c.json({ config: redacted, version }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── 6. POST /validate -- Validate config against schema ───────
  app.post('/validate', async (c) => {
    try {
      const body = await c.req.json();
      const { config, type } = body as {
        config: unknown;
        type?: 'local' | 'shared' | 'full';
      };

      if (!config || typeof config !== 'object') {
        return c.json({ error: 'config field is required and must be an object' }, 400);
      }

      const schemaType = type ?? 'shared';
      let schema;
      switch (schemaType) {
        case 'local':
          schema = localConfigSchema;
          break;
        case 'shared':
          schema = sharedConfigSchema;
          break;
        case 'full':
          schema = appConfigSchema;
          break;
        default:
          return c.json(
            { error: `Invalid type "${schemaType}". Must be local, shared, or full` },
            400,
          );
      }

      const result = schema.safeParse(config);

      if (result.success) {
        return c.json({ valid: true }, 200);
      }

      return c.json(
        {
          valid: false,
          errors: result.error.issues.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
            code: e.code,
          })),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── 7. GET /diff -- Compare local YAML vs shared DB config ────
  app.get('/diff', async (c) => {
    try {
      let localConfig: Record<string, unknown> = {};
      try {
        const loaded = await deps.loadLocalConfig();
        localConfig = loaded as unknown as Record<string, unknown>;
      } catch {
        // No local config available
      }

      const sharedResult = await deps.sharedStore.getLatest();
      const sharedConfig = sharedResult
        ? (sharedResult.config as unknown as Record<string, unknown>)
        : {};

      const differences = computeDiff(localConfig, sharedConfig);

      return c.json({ local: localConfig, shared: sharedConfig, differences }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── 8. GET /history -- Version history ────────────────────────
  app.get('/history', async (c) => {
    try {
      const limitStr = c.req.query('limit');
      const limit = limitStr ? parseInt(limitStr, 10) : 20;

      const versions = await deps.sharedStore.listHistory(limit);

      return c.json({ versions }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── 9. POST /rollback -- Rollback to specific version ─────────
  app.post('/rollback', async (c) => {
    try {
      const body = await c.req.json();
      const { version } = body as { version: number };

      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        return c.json({ error: 'version must be a positive integer' }, 400);
      }

      const newVersion = await deps.sharedStore.rollback(version, 'api:rollback');

      logger.info('Config rolled back via admin API', { targetVersion: version, newVersion });

      return c.json({ newVersion }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── 10. POST /reload -- Trigger config reload ─────────────────
  app.post('/reload', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const { drain, target } = body as { drain?: boolean; target?: string };

      if (target) {
        // Forward to a specific peer instance via the cluster peer connection.
        if (!deps.forwardReloadToPeer) {
          // Single-orchestrator deployment (no cluster) — targeting unavailable.
          return c.json(
            { error: 'Per-instance targeting is unavailable: cluster peer routing not configured' },
            501,
          );
        }

        const result = await deps.forwardReloadToPeer(target, { drain });
        if (result === null) {
          return c.json({ error: `Target instance "${target}" not connected` }, 404);
        }

        logger.info('Config reload forwarded to peer', {
          target,
          success: result.success,
          version: result.version,
        });

        return c.json(result, result.success ? 200 : 500);
      }

      // Execute reload locally
      const result = await deps.configReloader.executeReload({
        source: 'http',
        drain,
      });

      return c.json(result, result.success ? 200 : 500);
    } catch (err) {
      return handleError(c, err);
    }
  });

  return app;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Deep-delete a path from an object.
 * Removes the leaf key at the end of the dot-separated path.
 */
function deepDeletePath(obj: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (
      current[segment] === null ||
      current[segment] === undefined ||
      typeof current[segment] !== 'object'
    ) {
      return; // Path doesn't exist, nothing to delete
    }
    current = current[segment] as Record<string, unknown>;
  }

  delete current[segments[segments.length - 1]];
}

/**
 * Compute differences between two config objects.
 * Returns an array of { path, localValue, sharedValue } objects.
 */
function computeDiff(
  local: Record<string, unknown>,
  shared: Record<string, unknown>,
): Array<{ path: string; local: unknown; shared: unknown }> {
  const diffs: Array<{ path: string; local: unknown; shared: unknown }> = [];

  function walk(localObj: unknown, sharedObj: unknown, prefix: string): void {
    const localIsObj =
      localObj !== null && typeof localObj === 'object' && !Array.isArray(localObj);
    const sharedIsObj =
      sharedObj !== null && typeof sharedObj === 'object' && !Array.isArray(sharedObj);

    if (localIsObj && sharedIsObj) {
      const allKeys = new Set([
        ...Object.keys(localObj as Record<string, unknown>),
        ...Object.keys(sharedObj as Record<string, unknown>),
      ]);
      for (const key of allKeys) {
        const childPath = prefix ? `${prefix}.${key}` : key;
        walk(
          (localObj as Record<string, unknown>)[key],
          (sharedObj as Record<string, unknown>)[key],
          childPath,
        );
      }
    } else {
      if (JSON.stringify(localObj) !== JSON.stringify(sharedObj)) {
        diffs.push({
          path: prefix,
          local: localObj,
          shared: sharedObj,
        });
      }
    }
  }

  walk(local, shared, '');
  return diffs;
}

/**
 * Redact sensitive-looking values from a response object.
 * Simple heuristic: keys containing 'key', 'secret', 'token', 'password'
 * get their values replaced with '***REDACTED***'.
 */
function redactSensitiveInResponse(config: unknown, _pathFilter?: string): unknown {
  if (config === null || config === undefined) return config;
  if (typeof config !== 'object') return config;

  if (Array.isArray(config)) {
    return config.map((item) => redactSensitiveInResponse(item));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (
      (lowerKey.includes('key') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('password') ||
        lowerKey.includes('psk')) &&
      typeof value === 'string'
    ) {
      result[key] = '***REDACTED***';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitiveInResponse(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function handleError(c: any, err: unknown) {
  return handleAdminError(c, err, logger);
}
