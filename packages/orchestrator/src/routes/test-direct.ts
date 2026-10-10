/**
 * Direct `kici run remote` routes: the test-run control plane served over the
 * orchestrator's own HTTP API, for a caller holding an orchestrator admin token.
 *
 * They run the same `test.relay.*` handlers the Platform relay uses, so a run
 * started here is the same run a Platform-routed one is. What differs:
 *
 * - The caller is authenticated here (`resolveCaller`), not asserted by the
 *   Platform, and the run is attributed to the token's service account.
 * - The server chooses the org and routing key. An independent orchestrator
 *   runs tests under its default org; a Platform-connected one uses the org
 *   the Platform assigned it. A routing key in the request body is ignored,
 *   and a routing-key-scoped token is refused, because no key of its own is
 *   ever compared.
 * - Access-log rows record the `admin_http` transport.
 *
 * Mounted in every mode whenever admin auth is configured.
 */
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Kysely } from 'kysely';
import type { z } from 'zod';
import {
  AccessLogSource,
  OrchestratorMode,
  type ActorPrincipal,
  testRelayTriggerRequestSchema,
  testRelayUploadsInitRequestSchema,
} from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { Permission, RbacEnforcer } from '../secrets/rbac.js';
import { DEFAULT_ORG_ID } from '../oidc/orchestrator-mint.js';
import { provisionRemoteSource, remoteRoutingKeyFor } from '../pipeline/remote-source-store.js';
import {
  handleTestCancel,
  handleTestRunLogs,
  handleTestRunStatus,
  handleTestTrigger,
  handleTestUploadsInit,
  type TestRelayHandlerDeps,
} from '../ws/test-relay-handlers.js';
import type { AuthTokenValidator } from './admin-auth.js';
import { createAdminApp } from './admin-env.js';
import { callerActor, resolveCaller, type TokenCaller } from './caller-identity.js';
import { TestUploadStorageUnavailableError } from './uploads.js';

const logger = createLogger({ prefix: 'test-direct' });

type TestDirectEnv = { Variables: { caller: TokenCaller } };
type TestDirectContext = Context<TestDirectEnv>;

/** Upload-init body: the relay request minus the fields the server owns. */
const uploadsInitBodySchema = testRelayUploadsInitRequestSchema.omit({
  type: true,
  requestId: true,
  actor: true,
  routingKey: true,
});

/** Trigger body: the relay request minus the fields the server owns. */
const triggerBodySchema = testRelayTriggerRequestSchema.omit({
  type: true,
  requestId: true,
  actor: true,
  routingKey: true,
});

/** Answer for a Platform-connected orchestrator that has no org yet. */
export const NO_PLATFORM_ORG_MESSAGE =
  'This orchestrator has not received its organization from the KiCI Platform yet, so it cannot choose where to run the test. Retry when the orchestrator is connected.';

const INVALID_JSON_MESSAGE = 'Invalid JSON body';

export interface TestDirectRouteDeps {
  tokenManager: AuthTokenValidator;
  rbac: RbacEnforcer;
  mode: OrchestratorMode;
  /** The org a connected orchestrator learned from the Platform; read per request. */
  platformOrgId: () => string | null | undefined;
  db: Kysely<Database>;
  /** Builds the relay handlers' deps for one request (minus org, routing key and source). */
  relayDeps: () => Omit<TestRelayHandlerDeps, 'orgId' | 'routingKey' | 'accessLogSource'>;
}

/**
 * The org a direct test run belongs to: the default org on an independent
 * orchestrator, the Platform-assigned org otherwise (null until it is known).
 */
export function directOrgId(
  mode: OrchestratorMode,
  platformOrgId: string | null | undefined,
): string | null {
  return mode === OrchestratorMode.enum.independent ? DEFAULT_ORG_ID : (platformOrgId ?? null);
}

/**
 * Build the route deps, or null when admin auth is not configured: without a
 * token store there is no credential to authenticate a developer with.
 */
export function testDirectRouteDeps(
  input: { adminDeps?: { tokenManager: AuthTokenValidator; rbac: RbacEnforcer } },
  rest: Omit<TestDirectRouteDeps, 'tokenManager' | 'rbac'>,
): TestDirectRouteDeps | null {
  if (!input.adminDeps) return null;
  return { tokenManager: input.adminDeps.tokenManager, rbac: input.adminDeps.rbac, ...rest };
}

/** Answer 403 unless the caller's role holds `permission`. */
function denyUnlessPermitted(
  c: TestDirectContext,
  deps: TestDirectRouteDeps,
  permission: Permission,
): Response | null {
  if (deps.rbac.hasPermission(c.get('caller').role, permission)) return null;
  return c.json({ error: `Permission denied: ${permission} required` }, 403);
}

/** Parse a JSON body with `schema`; an empty body counts as `{}`. */
async function readBody<S extends z.ZodTypeAny>(
  c: TestDirectContext,
  schema: S,
): Promise<{ ok: true; body: z.infer<S> } | { ok: false; response: Response }> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim().length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, response: c.json({ error: INVALID_JSON_MESSAGE }, 400) };
    }
  }
  // A ZodError propagates to the app's error handler, which answers 400.
  return { ok: true, body: schema.parse(raw) };
}

/** The relay deps for one request, with the server-chosen org and the HTTP source. */
function handlerDeps(
  deps: TestDirectRouteDeps,
  orgId: string | null,
  routingKey: string | null,
): TestRelayHandlerDeps {
  return {
    ...deps.relayDeps(),
    orgId,
    routingKey,
    accessLogSource: AccessLogSource.enum.admin_http,
  };
}

type EnsureAnchor = (orgId: string) => Promise<void>;

/**
 * Resolve the org and routing key a write route acts under, provisioning the
 * independent-mode anchor first. Null means the org is not known yet.
 */
async function writeTarget(
  deps: TestDirectRouteDeps,
  ensureAnchor: EnsureAnchor,
): Promise<{ orgId: string; routingKey: string } | null> {
  const orgId = directOrgId(deps.mode, deps.platformOrgId());
  if (orgId === null) return null;
  await ensureAnchor(orgId);
  return { orgId, routingKey: remoteRoutingKeyFor(orgId) };
}

async function whoami(c: TestDirectContext, deps: TestDirectRouteDeps): Promise<Response> {
  const caller = c.get('caller');
  return c.json({
    tokenId: caller.tokenId,
    label: caller.label,
    subject: caller.subject,
    role: caller.role,
    mode: deps.mode,
    orgId: directOrgId(deps.mode, deps.platformOrgId()),
    permissions: {
      trigger: deps.rbac.hasPermission(caller.role, 'test_run.trigger'),
      read: deps.rbac.hasPermission(caller.role, 'test_run.read'),
    },
  });
}

/** The envelope every relayed message carries: a fresh request id and the caller. */
function envelope(c: TestDirectContext) {
  return { requestId: randomUUID(), actor: callerActor(c.get('caller')) };
}

/**
 * The shared preamble of a write route: the trigger permission, the body, and
 * the server-chosen org and routing key. A refusal comes back as the response.
 */
async function prepareWrite<S extends z.ZodTypeAny>(
  c: TestDirectContext,
  deps: TestDirectRouteDeps,
  ensureAnchor: EnsureAnchor,
  schema: S,
): Promise<
  | { ok: true; body: z.infer<S>; target: { orgId: string; routingKey: string } }
  | { ok: false; response: Response }
> {
  const denied = denyUnlessPermitted(c, deps, 'test_run.trigger');
  if (denied) return { ok: false, response: denied };
  const parsed = await readBody(c, schema);
  if (!parsed.ok) return parsed;
  const target = await writeTarget(deps, ensureAnchor);
  if (!target) return { ok: false, response: c.json({ error: NO_PLATFORM_ORG_MESSAGE }, 503) };
  return { ok: true, body: parsed.body, target };
}

async function uploadsInit(
  c: TestDirectContext,
  deps: TestDirectRouteDeps,
  ensureAnchor: EnsureAnchor,
): Promise<Response> {
  const write = await prepareWrite(c, deps, ensureAnchor, uploadsInitBodySchema);
  if (!write.ok) return write.response;
  const { orgId, routingKey } = write.target;
  try {
    const payload = await handleTestUploadsInit(
      { type: 'test.relay.uploads.init', ...envelope(c), routingKey, ...write.body },
      handlerDeps(deps, orgId, routingKey),
    );
    return c.json(payload);
  } catch (err) {
    if (err instanceof TestUploadStorageUnavailableError) {
      return c.json({ error: err.message }, 503);
    }
    throw err;
  }
}

async function trigger(
  c: TestDirectContext,
  deps: TestDirectRouteDeps,
  ensureAnchor: EnsureAnchor,
): Promise<Response> {
  const write = await prepareWrite(c, deps, ensureAnchor, triggerBodySchema);
  if (!write.ok) return write.response;
  const { orgId, routingKey } = write.target;
  const payload = await handleTestTrigger(
    { type: 'test.relay.trigger', ...envelope(c), routingKey, ...write.body },
    handlerDeps(deps, orgId, routingKey),
  );
  return c.json(payload, payload.status === 'rejected' ? 422 : 200);
}

/** A cursor query value as a non-negative integer; anything else reads as 0. */
function parseCursor(value: string | undefined): number {
  const n = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * A route on one run (status, logs, cancel): check `permission`, run the
 * handler with the org when known and no routing key, and answer a handler
 * `{ error }` with 404.
 */
async function runRoute(
  c: TestDirectContext,
  deps: TestDirectRouteDeps,
  permission: Permission,
  call: (
    msg: { requestId: string; actor: ActorPrincipal; runId: string },
    handlerDeps: TestRelayHandlerDeps,
  ) => Promise<object>,
): Promise<Response> {
  const denied = denyUnlessPermitted(c, deps, permission);
  if (denied) return denied;
  const payload = await call(
    { ...envelope(c), runId: c.req.param('runId') ?? '' },
    handlerDeps(deps, directOrgId(deps.mode, deps.platformOrgId()), null),
  );
  return 'error' in payload ? c.json(payload, 404) : c.json(payload);
}

/**
 * Build the direct test-run router: the routes under `/api/v1/test`, each
 * behind admin-token authentication that refuses a routing-key-scoped token.
 */
export function createTestDirectRoutes(deps: TestDirectRouteDeps) {
  const app = createAdminApp<TestDirectEnv>(logger);

  // An independent orchestrator has no Platform connection to provision the
  // `remote:<org>` anchor `resolveOrgId` maps a test run back through, so the
  // first write provisions it once per process. A connected orchestrator's
  // anchor is provisioned on connect with its cluster id, which an upsert from
  // here would overwrite with null, so this never runs there.
  let anchorReady: Promise<void> | undefined;
  const ensureAnchor: EnsureAnchor = async (orgId) => {
    if (deps.mode !== OrchestratorMode.enum.independent) return;
    anchorReady ??= provisionRemoteSource(deps.db, { orgId, clusterId: null }).catch(
      (err: unknown) => {
        anchorReady = undefined;
        throw err;
      },
    );
    await anchorReady;
  };

  app.use('/api/v1/test/*', async (c, next) => {
    const outcome = await resolveCaller(
      c,
      { tokenManager: deps.tokenManager, scope: 'test-direct' },
      { requireUnscoped: true },
    );
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    c.set('caller', outcome.caller);
    await next();
  });
  app.get('/api/v1/test/whoami', (c) => whoami(c, deps));
  app.post('/api/v1/test/uploads/init', (c) => uploadsInit(c, deps, ensureAnchor));
  app.post('/api/v1/test/trigger', (c) => trigger(c, deps, ensureAnchor));
  app.get('/api/v1/test/runs/:runId', (c) =>
    runRoute(c, deps, 'test_run.read', (msg, d) =>
      handleTestRunStatus({ type: 'test.relay.run.status', ...msg }, d),
    ),
  );
  app.get('/api/v1/test/runs/:runId/logs', (c) =>
    runRoute(c, deps, 'test_run.read', (msg, d) =>
      handleTestRunLogs(
        { type: 'test.relay.run.logs', ...msg, cursor: parseCursor(c.req.query('cursor')) },
        d,
      ),
    ),
  );
  app.post('/api/v1/test/runs/:runId/cancel', (c) =>
    runRoute(c, deps, 'test_run.trigger', (msg, d) =>
      handleTestCancel({ type: 'test.relay.cancel', ...msg }, d),
    ),
  );
  return app;
}
