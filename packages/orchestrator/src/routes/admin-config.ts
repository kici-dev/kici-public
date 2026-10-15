/**
 * Admin config routes under /admin/config/*:
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
 * All routes require Bearer token auth.
 */

import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { BlankEnv } from 'hono/types';
import { createLogger } from '@kici-dev/shared';
import { AUTH_ERROR } from './admin-auth.js';
import type { SharedConfigStore } from '../config/shared-store.js';
import type { ConfigReloader, ReloadResult } from '../config/reload.js';
import type { LocalConfig } from '../config/types.js';
import { sharedConfigSchema, localConfigSchema, appConfigSchema } from '../config/schema.js';
import { deepSet, deepGetByPath } from '../config/index.js';
import { createAdminApp } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-config' });

/** `result` is null when the target peer is not connected (or unknown). */
export interface PeerReloadForwardResult {
  result: ReloadResult | null;
}

export interface ConfigRouteDeps {
  sharedStore: SharedConfigStore;
  configReloader: ConfigReloader;
  localConfigPath?: string;
  loadLocalConfig: () => Promise<LocalConfig>;
  /** Bearer token; undefined makes every route return 503. */
  adminToken?: string;
  /**
   * Forward a reload to a peer over the cluster peer connection; `null` when the
   * peer is unknown / not connected. Omitted → `target` requests return 501.
   */
  forwardReloadToPeer?: (
    targetInstanceId: string,
    opts: { drain?: boolean; timeoutMs?: number },
  ) => Promise<ReloadResult | null>;
}

/** Mounted at /admin/config. */
export function createConfigAdminRoutes(deps: ConfigRouteDeps): Hono {
  const app = createAdminApp<BlankEnv>(logger);

  app.use('*', async (c, next) => {
    // A local, because a `deps.adminToken` property access does not narrow across the guard.
    const expectedToken = deps.adminToken;
    if (!expectedToken) {
      return c.json({ error: 'Admin config API not configured (no admin token)' }, 503);
    }
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: AUTH_ERROR.missing }, 401);
    }
    const token = authHeader.slice(7);
    if (!constantTimeEqual(token, expectedToken)) {
      // constantTimeEqual is no prefix-timing oracle and cannot throw. This
      // static-token check does no DB lookup, so — unlike routes/admin-auth.ts —
      // its auth outcome has no lookup-failure 503.
      //
      // The body names the wanted credential: these routes take the
      // orchestrator secret key, every other admin route the DB-backed bootstrap
      // admin token, and telling them apart by one word ('Invalid token' vs
      // 'Invalid or expired token') is not legible. The token is never echoed.
      return c.json(
        {
          error:
            'Invalid token. These endpoints authenticate with the orchestrator secret key ' +
            '(KICI_SECRET_KEY), not the bootstrap admin token used by the other admin routes.',
        },
        401,
      );
    }
    await next();
  });

  app.post('/seed', async (c) => {
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
  });

  app.get('/', async (c) => {
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

    const redacted = redactSensitiveInResponse(config as Record<string, unknown>, pathFilter);

    return c.json({ config: redacted, version, source: 'merged' }, 200);
  });

  app.put('/', async (c) => {
    const body = await c.req.json();
    const { path, value, description } = body as {
      path: string;
      value: unknown;
      description?: string;
    };

    if (!path || typeof path !== 'string') {
      return c.json({ error: 'path field is required and must be a string' }, 400);
    }

    // Saved as a new version of the shared config.
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
  });

  app.delete('/', async (c) => {
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
  });

  app.get('/export', async (c) => {
    const redacted = await deps.sharedStore.exportRedacted();
    const version = await deps.sharedStore.getCurrentVersion();

    if (!redacted) {
      return c.json({ config: {}, version: 0 }, 200);
    }

    return c.json({ config: redacted, version }, 200);
  });

  app.post('/validate', async (c) => {
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
  });

  app.get('/diff', async (c) => {
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
  });

  app.get('/history', async (c) => {
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : 20;

    const versions = await deps.sharedStore.listHistory(limit);

    return c.json({ versions }, 200);
  });

  app.post('/rollback', async (c) => {
    const body = await c.req.json();
    const { version } = body as { version: number };

    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      return c.json({ error: 'version must be a positive integer' }, 400);
    }

    const newVersion = await deps.sharedStore.rollback(version, 'api:rollback');

    logger.info('Config rolled back via admin API', { targetVersion: version, newVersion });

    return c.json({ newVersion }, 200);
  });

  app.post('/reload', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { drain, target } = body as { drain?: boolean; target?: string };

    if (target) {
      if (!deps.forwardReloadToPeer) {
        // Single-orchestrator deployment (no cluster).
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

    const result = await deps.configReloader.executeReload({
      source: 'http',
      drain,
    });

    return c.json(result, result.success ? 200 : 500);
  });

  return app;
}

/**
 * Constant-time token compare. timingSafeEqual throws on unequal lengths, so
 * Buffer BYTE lengths are checked first (a multi-byte string can match the
 * character count yet differ in bytes). The length check leaks length; that is
 * accepted, matching the raw-token comparison in providers/generic/verification.ts.
 */
function constantTimeEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/** Remove the leaf key at the end of a dot-separated path. */
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
 * Returns an array of { path, local, shared } objects.
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
 * Heuristic: values of keys containing 'key', 'secret', 'token' or 'password'
 * become '***REDACTED***'.
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
