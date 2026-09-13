/**
 * The `POST /api/v1/admin/generic-sources` organization guard.
 *
 * A generic source mints the routing key `generic:<orgId>:<id>`, and the
 * Platform refuses to register a key whose organization segment is not the
 * one the orchestrator authenticated as. A source created under a mismatched
 * `--org` would therefore register, be rejected, and never deliver — and its
 * published webhook URL, which the Platform composes from the Platform
 * organization id, would 404. The create handler refuses the mismatch up
 * front and names the correct value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RbacEnforcer } from '../secrets/rbac.js';
import { createAdminEventRoutes } from './admin-events.js';

const PLATFORM_ORG = 'org_platform001';
const TOKEN = 'unit-test-token';

function unscopedTokenManager() {
  return {
    validate: vi.fn().mockResolvedValue({
      id: 'admin-1',
      role: 'owner',
      routingKey: null,
      label: 'unit',
    }),
  } as never;
}

function buildApp(getPlatformOrgId?: () => string | undefined) {
  const created = {
    id: 'src-1',
    routing_key: `generic:${PLATFORM_ORG}:src-1`,
    customer_id: PLATFORM_ORG,
    name: 's1',
    enabled: true,
    git_config: null,
    provider_type: 'generic',
  };
  const sourceManager = { create: vi.fn().mockResolvedValue(created) };
  const app = createAdminEventRoutes({
    sourceManager: sourceManager as never,
    trustStore: {} as never,
    tokenManager: unscopedTokenManager(),
    rbac: new RbacEnforcer(),
    providerRegistry: { register: vi.fn(), unregister: vi.fn() } as never,
    config: {} as never,
    secretResolver: null,
    getPlatformOrgId,
  });
  return { app, sourceManager };
}

function post(app: ReturnType<typeof createAdminEventRoutes>, orgId: string) {
  return app.fetch(
    new Request('http://localhost/api/v1/admin/generic-sources', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId, name: 's1' }),
    }),
  );
}

describe('POST /generic-sources — Platform organization guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses an orgId that is not the authenticated Platform organization', async () => {
    const { app, sourceManager } = buildApp(() => PLATFORM_ORG);
    const res = await post(app, 'org_someoneelse');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // Both values and the corrective action are named, since the operator
    // cannot otherwise tell which of the two ids is the right one.
    expect(body.error).toContain('org_someoneelse');
    expect(body.error).toContain(PLATFORM_ORG);
    expect(body.error).toContain(`--org ${PLATFORM_ORG}`);
    // Refusal, not a silent rewrite: re-keying changes the public webhook URL.
    expect(sourceManager.create).not.toHaveBeenCalled();
  });

  it('accepts the matching organization', async () => {
    // Positive control — the guard is not refusing everything.
    const { app, sourceManager } = buildApp(() => PLATFORM_ORG);
    const res = await post(app, PLATFORM_ORG);

    expect(res.status).toBe(201);
    expect(sourceManager.create).toHaveBeenCalledOnce();
  });

  it('does not gate when the orchestrator has no Platform organization', async () => {
    // Independent mode, or before the first successful auth: there is no
    // canonical value to compare against, so the operator's choice stands.
    const { app, sourceManager } = buildApp(() => undefined);
    const res = await post(app, 'org_anything');

    expect(res.status).toBe(201);
    expect(sourceManager.create).toHaveBeenCalledOnce();
  });

  it('does not gate when no accessor is wired at all', async () => {
    const { app, sourceManager } = buildApp(undefined);
    const res = await post(app, 'org_anything');

    expect(res.status).toBe(201);
    expect(sourceManager.create).toHaveBeenCalledOnce();
  });
});
