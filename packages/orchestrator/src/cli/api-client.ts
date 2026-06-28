/**
 * HTTP client wrapper for the kici-admin CLI.
 *
 * Communicates with the orchestrator admin API via Bearer token authentication.
 * All methods are thin wrappers around fetch() that handle JSON serialization,
 * error formatting, and URL construction.
 */

import * as fs from 'node:fs';

/** A node in the fleet topology returned by GET /admin/fleet-topology. */
export interface FleetTopologyNodeResponse {
  kind: 'orchestrator' | 'agent';
  id: string;
  role?: 'coordinator' | 'worker';
  hostname?: string;
  labels: Record<string, string>;
  parentId: string | null;
}

/** Response shape for GET /admin/fleet-topology. */
export interface FleetTopologyResponse {
  nodes: FleetTopologyNodeResponse[];
}

/**
 * Universal-git configuration shape carried in `git_config` on
 * generic_webhook_sources. Matches `UniversalGitConfigSchema` in
 * `providers/universal-git/config.ts`. Kept as a loose `Record` here to
 * avoid a cross-package import in the CLI wire type.
 */
export type GenericSourceGitConfigPayload = Record<string, unknown>;

/**
 * Wire shape for a local filesystem source's config (`{ repoBasePath, cloneUrlBase? }`).
 * Matches `LocalSourceConfigSchema` in `providers/local/local-source-config.ts`.
 */
export interface GenericSourceLocalConfigPayload {
  repoBasePath: string;
  cloneUrlBase?: string;
}

/**
 * Response shape for generic webhook sources from the admin API.
 */
export interface GenericSourceResponse {
  id: string;
  customer_id: string;
  name: string;
  routing_key: string;
  verification_method: string;
  verification_config: string;
  event_type_header: string | null;
  event_type_path: string | null;
  idempotency_key_header: string | null;
  idempotency_key_path: string | null;
  dedup_window_seconds: number;
  max_payload_bytes: number;
  allowed_events: string | null;
  strip_headers: string;
  enabled: boolean;
  rate_limit_rpm: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  provider_type?: string;
  /** Universal-git config; raw JSON string or parsed object (pg driver dependent). */
  git_config?: string | GenericSourceGitConfigPayload | null;
}

export class AdminApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /**
   * Make an authenticated HTTP request to the admin API.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      let errorBody: string;
      try {
        const json = JSON.parse(text);
        errorBody = (json as { error?: string }).error ?? text;
      } catch {
        errorBody = text;
      }
      throw new Error(`HTTP ${res.status}: ${errorBody}`);
    }

    // 204 No Content
    if (res.status === 204) {
      return undefined as T;
    }

    return (await res.json()) as T;
  }

  /**
   * Public GET request returning parsed JSON.
   */
  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /**
   * Public POST request returning parsed JSON.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /**
   * Public PATCH request returning parsed JSON.
   */
  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  /**
   * Public PUT request returning parsed JSON.
   */
  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  /**
   * Public DELETE request returning parsed JSON.
   */
  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  /**
   * Public GET request returning raw response text.
   */
  async getText(path: string): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    return res.text();
  }

  // --- Fleet log collection ---

  /** Enumerate the cluster topology for `debug-bundle --fleet --list` / `--pick`. */
  async getFleetTopology(): Promise<FleetTopologyResponse> {
    return this.get<FleetTopologyResponse>('/admin/fleet-topology');
  }

  /**
   * Drive the fleet fan-out and write the assembled ZIP to `outPath`. The
   * response is an octet-stream, so it is read as bytes rather than parsed JSON.
   */
  async downloadFleetBundle(
    body: { selectors: string[]; logWindowHours?: number; timeoutSeconds?: number },
    outPath: string,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/admin/fleet-bundle`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outPath, buf);
  }

  // --- Scoped secret management ---

  async listScopes(orgId: string): Promise<{ scopes: string[] }> {
    return this.request<{ scopes: string[] }>(
      'GET',
      `/api/v1/admin/secrets/scopes?orgId=${encodeURIComponent(orgId)}`,
    );
  }

  async listKeys(orgId: string, scope: string): Promise<{ keys: string[] }> {
    const params = new URLSearchParams({ orgId, scope });
    return this.request<{ keys: string[] }>('GET', `/api/v1/admin/secrets/keys?${params}`);
  }

  async setSecret(orgId: string, scope: string, key: string, value: string): Promise<void> {
    return this.request<void>(
      'PUT',
      `/api/v1/admin/secrets/${encodeURIComponent(orgId)}/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`,
      { value },
    );
  }

  async deleteSecret(orgId: string, scope: string, key: string): Promise<void> {
    return this.request<void>(
      'DELETE',
      `/api/v1/admin/secrets/${encodeURIComponent(orgId)}/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`,
    );
  }

  // --- Environment variable management ---

  async listVariables(
    orgId: string,
    environment: string,
  ): Promise<{
    variables: Array<{
      key: string;
      value: string;
      locked: boolean;
      updated_at: string;
    }>;
  }> {
    const params = new URLSearchParams({ orgId });
    return this.request<{
      variables: Array<{
        key: string;
        value: string;
        locked: boolean;
        updated_at: string;
      }>;
    }>('GET', `/api/v1/admin/environments/${encodeURIComponent(environment)}/variables?${params}`);
  }

  async setVariable(
    orgId: string,
    environment: string,
    key: string,
    value: string,
    locked?: boolean,
  ): Promise<void> {
    const params = new URLSearchParams({ orgId });
    return this.request<void>(
      'PUT',
      `/api/v1/admin/environments/${encodeURIComponent(environment)}/variables/${encodeURIComponent(key)}?${params}`,
      { value, locked },
    );
  }

  async deleteVariable(orgId: string, environment: string, key: string): Promise<void> {
    const params = new URLSearchParams({ orgId });
    return this.request<void>(
      'DELETE',
      `/api/v1/admin/environments/${encodeURIComponent(environment)}/variables/${encodeURIComponent(key)}?${params}`,
    );
  }

  // --- Key rotation ---

  async rotateKey(): Promise<{
    reEncrypted: number;
    reEncryptedConfigs: number;
    skippedConfigs: number;
  }> {
    return this.request<{
      reEncrypted: number;
      reEncryptedConfigs: number;
      skippedConfigs: number;
    }>('POST', '/api/v1/admin/rotate-key');
  }

  // --- Generic webhook source management ---

  async createGenericSource(data: {
    orgId: string;
    name: string;
    verificationMethod?: string;
    verificationConfig?: Record<string, unknown>;
    eventTypeHeader?: string;
    eventTypePath?: string;
    idempotencyKeyHeader?: string;
    idempotencyKeyPath?: string;
    dedupWindowSeconds?: number;
    maxPayloadBytes?: number;
    allowedEvents?: string[];
    stripHeaders?: string[];
    rateLimitRpm?: number;
    providerType?: string;
    gitConfig?: GenericSourceGitConfigPayload;
    localConfig?: GenericSourceLocalConfigPayload;
  }): Promise<{ source: GenericSourceResponse }> {
    return this.request<{ source: GenericSourceResponse }>(
      'POST',
      '/api/v1/admin/generic-sources',
      data,
    );
  }

  async listGenericSources(
    orgId: string,
    includeDeleted?: boolean,
  ): Promise<{
    sources: GenericSourceResponse[];
  }> {
    const params = new URLSearchParams({ orgId });
    if (includeDeleted) params.set('includeDeleted', 'true');
    return this.request<{ sources: GenericSourceResponse[] }>(
      'GET',
      `/api/v1/admin/generic-sources?${params}`,
    );
  }

  async getGenericSource(id: string): Promise<{ source: GenericSourceResponse }> {
    return this.request<{ source: GenericSourceResponse }>(
      'GET',
      `/api/v1/admin/generic-sources/${encodeURIComponent(id)}`,
    );
  }

  async updateGenericSource(
    id: string,
    data: {
      name?: string;
      verificationMethod?: string;
      verificationConfig?: Record<string, unknown>;
      eventTypeHeader?: string;
      eventTypePath?: string;
      idempotencyKeyHeader?: string;
      idempotencyKeyPath?: string;
      dedupWindowSeconds?: number;
      maxPayloadBytes?: number;
      allowedEvents?: string[];
      stripHeaders?: string[];
      rateLimitRpm?: number;
      providerType?: string;
      /** `null` clears the config; omit to leave unchanged. */
      gitConfig?: GenericSourceGitConfigPayload | null;
      /** `null` clears the config; omit to leave unchanged. */
      localConfig?: GenericSourceLocalConfigPayload | null;
    },
  ): Promise<{ source: GenericSourceResponse }> {
    return this.request<{ source: GenericSourceResponse }>(
      'PATCH',
      `/api/v1/admin/generic-sources/${encodeURIComponent(id)}`,
      data,
    );
  }

  async deleteGenericSource(
    id: string,
    hard?: boolean,
  ): Promise<{ deleted: boolean; hard: boolean }> {
    const qs = hard ? '?hard=true' : '';
    return this.request<{ deleted: boolean; hard: boolean }>(
      'DELETE',
      `/api/v1/admin/generic-sources/${encodeURIComponent(id)}${qs}`,
    );
  }

  async enableGenericSource(id: string): Promise<{ enabled: boolean }> {
    return this.request<{ enabled: boolean }>(
      'POST',
      `/api/v1/admin/generic-sources/${encodeURIComponent(id)}/enable`,
    );
  }

  async disableGenericSource(id: string): Promise<{ enabled: boolean }> {
    return this.request<{ enabled: boolean }>(
      'POST',
      `/api/v1/admin/generic-sources/${encodeURIComponent(id)}/disable`,
    );
  }

  // --- Audit ---

  async queryAudit(opts?: {
    contextName?: string;
    routingKey?: string;
    action?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
    /** Phase D opt-in for cold-store read-through. */
    includeArchived?: boolean;
  }): Promise<any[]> {
    const params = new URLSearchParams();
    if (opts?.contextName) params.set('contextName', opts.contextName);
    if (opts?.routingKey) params.set('routingKey', opts.routingKey);
    if (opts?.action) params.set('action', opts.action);
    if (opts?.from) params.set('from', opts.from);
    if (opts?.to) params.set('to', opts.to);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    if (opts?.includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    const res = await this.request<{ entries: any[] }>(
      'GET',
      `/api/v1/admin/audit${qs ? `?${qs}` : ''}`,
    );
    return res.entries;
  }

  // --- Token management ---

  async createToken(data: {
    label: string;
    role: string;
    routingKey?: string;
  }): Promise<{ token: string; id: string }> {
    return this.request<{ token: string; id: string }>('POST', '/api/v1/admin/tokens', data);
  }

  async listTokens(): Promise<any[]> {
    const res = await this.request<{ tokens: any[] }>('GET', '/api/v1/admin/tokens');
    return res.tokens;
  }

  async revokeToken(id: string): Promise<void> {
    return this.request<void>('DELETE', `/api/v1/admin/tokens/${encodeURIComponent(id)}`);
  }

  // --- Agent token management ---

  async createAgentToken(opts: {
    labels?: string[];
    mandatoryLabels?: string[];
  }): Promise<{ id: string; token: string }> {
    return this.request<{ id: string; token: string }>('POST', '/api/v1/agent-tokens', opts);
  }

  async listAgentTokens(opts?: { type?: string }): Promise<{ tokens: any[] }> {
    const qs = opts?.type ? `?type=${encodeURIComponent(opts.type)}` : '';
    return this.request<{ tokens: any[] }>('GET', `/api/v1/agent-tokens${qs}`);
  }

  /**
   * Revoke an agent token.
   *
   * The orchestrator both flips `agent_tokens.revoked_at` AND
   * synchronously closes every in-flight agent WS authenticated by
   * this token. The returned `kicked` count is the number
   * of WS connections that were closed on the wire — surface it to
   * the operator so they know the revocation actually propagated.
   */
  async revokeAgentToken(id: string): Promise<{ kicked: number }> {
    return this.request<{ kicked: number }>(
      'DELETE',
      `/api/v1/agent-tokens/${encodeURIComponent(id)}`,
    );
  }

  // --- Config management ---

  async configSeed(config: object, description?: string): Promise<{ version: number }> {
    return this.request<{ version: number }>('POST', '/admin/config/seed', {
      config,
      description,
    });
  }

  async configGet(path?: string): Promise<{ config: unknown; version: number; source: string }> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.request<{ config: unknown; version: number; source: string }>(
      'GET',
      `/admin/config${qs}`,
    );
  }

  async configSet(
    path: string,
    value: unknown,
    description?: string,
  ): Promise<{ version: number }> {
    return this.request<{ version: number }>('PUT', '/admin/config', {
      path,
      value,
      description,
    });
  }

  async configDelete(path: string, description?: string): Promise<{ version: number }> {
    return this.request<{ version: number }>('DELETE', '/admin/config', {
      path,
      description,
    });
  }

  async configExport(): Promise<{ config: object; version: number }> {
    return this.request<{ config: object; version: number }>('GET', '/admin/config/export');
  }

  async configValidate(config: object, type?: string): Promise<{ valid: boolean; errors?: any[] }> {
    return this.request<{ valid: boolean; errors?: any[] }>('POST', '/admin/config/validate', {
      config,
      type,
    });
  }

  async configDiff(): Promise<{ local: object; shared: object; differences: any[] }> {
    return this.request<{ local: object; shared: object; differences: any[] }>(
      'GET',
      '/admin/config/diff',
    );
  }

  async configHistory(limit?: number): Promise<{ versions: any[] }> {
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    return this.request<{ versions: any[] }>('GET', `/admin/config/history${qs}`);
  }

  async configRollback(version: number): Promise<{ newVersion: number }> {
    return this.request<{ newVersion: number }>('POST', '/admin/config/rollback', { version });
  }

  async configReload(opts?: {
    drain?: boolean;
    target?: string;
  }): Promise<{ success: boolean; version?: number; errors?: string[] }> {
    return this.request<{ success: boolean; version?: number; errors?: string[] }>(
      'POST',
      '/admin/config/reload',
      opts,
    );
  }

  // --- Platform API key management ---

  async createApiKey(opts: {
    label?: string;
    routingKeys?: string[];
  }): Promise<{ id: string; key: string; routingKeys: string[] }> {
    return this.request<{ id: string; key: string; routingKeys: string[] }>(
      'POST',
      '/api/v1/api-keys',
      opts,
    );
  }

  async addRoutingKeyPermission(
    keyId: string,
    pattern: string,
  ): Promise<{ id: string; pattern: string }> {
    return this.request<{ id: string; pattern: string }>(
      'POST',
      `/api/v1/api-keys/${encodeURIComponent(keyId)}/routing-permissions`,
      { pattern },
    );
  }

  // --- Secret backend management ---

  async addBackend(params: {
    name: string;
    backendType: string;
    config: Record<string, unknown>;
    scopeFilter?: string;
    syncIntervalMs?: number;
  }): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', '/api/v1/admin/backends', params);
  }

  async removeBackend(name: string): Promise<{ removed: boolean; scopeCount: number }> {
    return this.request<{ removed: boolean; scopeCount: number }>(
      'DELETE',
      `/api/v1/admin/backends/${encodeURIComponent(name)}`,
    );
  }

  async listBackends(): Promise<{ backends: Record<string, unknown>[] }> {
    return this.request<{ backends: Record<string, unknown>[] }>('GET', '/api/v1/admin/backends');
  }

  async getBackend(name: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/api/v1/admin/backends/${encodeURIComponent(name)}`,
    );
  }

  async testBackend(params: {
    name: string;
    backendType: string;
    config: Record<string, unknown>;
    scopeFilter?: string;
    syncIntervalMs?: number;
  }): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
    return this.request<{ ok: boolean; error?: string; latencyMs: number }>(
      'POST',
      '/api/v1/admin/backends/test',
      params,
    );
  }

  async testNamedBackend(
    name: string,
  ): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
    return this.request<{ ok: boolean; error?: string; latencyMs: number }>(
      'POST',
      `/api/v1/admin/backends/${encodeURIComponent(name)}/test`,
    );
  }

  async syncBackend(name: string): Promise<{ synced: boolean; scopeCount: number }> {
    return this.request<{ synced: boolean; scopeCount: number }>(
      'POST',
      `/api/v1/admin/backends/${encodeURIComponent(name)}/sync`,
    );
  }

  async syncAllBackends(): Promise<{
    results: Array<{ name: string; scopeCount: number; error?: string }>;
  }> {
    return this.request<{
      results: Array<{ name: string; scopeCount: number; error?: string }>;
    }>('POST', '/api/v1/admin/backends/sync');
  }

  // --- Runs ---

  /**
   * List execution runs. `status` accepts either a single status or a
   * comma-separated list (e.g. `success,failed`). `since` is an ISO-8601
   * timestamp; only runs with `created_at` strictly later than this value
   * are returned.
   */
  async listRuns(opts?: {
    status?: string;
    workflowName?: string;
    repo?: string;
    since?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    runs: Array<Record<string, unknown>>;
    total: number;
    limit: number;
    offset: number;
  }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.workflowName) params.set('workflowName', opts.workflowName);
    if (opts?.repo) params.set('repo', opts.repo);
    if (opts?.since) params.set('since', opts.since);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return this.request('GET', `/api/v1/admin/runs${qs ? `?${qs}` : ''}`);
  }

  /**
   * Count matching runs without returning the row list. Wraps the list
   * endpoint with `?count=true`, which skips the row query server-side.
   */
  async countRuns(opts?: {
    status?: string;
    workflowName?: string;
    repo?: string;
    since?: string;
  }): Promise<{
    total: number;
    since: string | null;
    status: string[] | null;
    workflowName: string | null;
    repo: string | null;
  }> {
    const params = new URLSearchParams();
    params.set('count', 'true');
    if (opts?.status) params.set('status', opts.status);
    if (opts?.workflowName) params.set('workflowName', opts.workflowName);
    if (opts?.repo) params.set('repo', opts.repo);
    if (opts?.since) params.set('since', opts.since);
    return this.request('GET', `/api/v1/admin/runs?${params.toString()}`);
  }

  /**
   * Fetch the run header (no jobs, no steps). Use `getRunJobs` for the
   * jobs sub-resource.
   */
  async getRun(runId: string): Promise<{ run: Record<string, unknown> }> {
    return this.request('GET', `/api/v1/admin/runs/${encodeURIComponent(runId)}`);
  }

  /**
   * Fetch the jobs list for a run. When `includeSteps: true`, each job
   * entry embeds a `steps[]` array.
   */
  async getRunJobs(
    runId: string,
    opts?: { includeSteps?: boolean },
  ): Promise<{ jobs: Array<Record<string, unknown>> }> {
    const qs = opts?.includeSteps ? '?includeSteps=true' : '';
    return this.request('GET', `/api/v1/admin/runs/${encodeURIComponent(runId)}/jobs${qs}`);
  }

  /**
   * Fetch the machine-first, provenance-tagged structured run result: typed
   * job DAG, per-step exit codes / durations / statuses, derived failure
   * category. Untrusted fields are envelope-tagged; secret values are never
   * returned (only secret-output key names).
   */
  async getRunStructured(runId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/v1/admin/runs/${encodeURIComponent(runId)}/structured`);
  }

  /**
   * Fetch the scrub status of the run's ephemeral key. Never returns the
   * key material itself — only `{ exists, createdAt }`.
   */
  async getRunEphemeralKey(runId: string): Promise<{ exists: boolean; createdAt: string | null }> {
    return this.request('GET', `/api/v1/admin/runs/${encodeURIComponent(runId)}/ephemeral-key`);
  }

  /**
   * List secret outputs for a run. Values are masked unless `reveal: true`
   * is passed AND the calling token has the `secret.reveal` permission.
   * Every reveal call writes a `secret-outputs.reveal` row to the
   * secret_audit_log table.
   */
  async getRunSecretOutputs(
    runId: string,
    opts?: { outputKey?: string; reveal?: boolean },
  ): Promise<{
    outputs: Array<{
      id: string;
      jobId: string;
      outputKey: string;
      createdAt: string;
      value: string | null;
      masked: boolean;
      revealError?: string;
    }>;
  }> {
    const params = new URLSearchParams();
    if (opts?.outputKey) params.set('outputKey', opts.outputKey);
    if (opts?.reveal) params.set('reveal', 'true');
    const qs = params.toString();
    return this.request(
      'GET',
      `/api/v1/admin/runs/${encodeURIComponent(runId)}/secret-outputs${qs ? `?${qs}` : ''}`,
    );
  }

  // --- Inbound webhook delivery log (event_log) ---

  async listEventLog(opts?: {
    orgId?: string;
    routingKey?: string;
    event?: string;
    action?: string;
    status?: string;
    from?: string;
    to?: string;
    deliveryId?: string;
    limit?: number;
    offset?: number;
    includeArchived?: boolean;
  }): Promise<{
    deliveries: Array<Record<string, unknown>>;
    total: number;
    limit: number;
    offset: number;
  }> {
    const params = new URLSearchParams();
    if (opts?.orgId) params.set('orgId', opts.orgId);
    if (opts?.routingKey) params.set('routingKey', opts.routingKey);
    if (opts?.event) params.set('event', opts.event);
    if (opts?.action) params.set('action', opts.action);
    if (opts?.status) params.set('status', opts.status);
    if (opts?.from) params.set('from', opts.from);
    if (opts?.to) params.set('to', opts.to);
    if (opts?.deliveryId) params.set('deliveryId', opts.deliveryId);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    if (opts?.includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    return this.request('GET', `/api/v1/admin/event-log${qs ? `?${qs}` : ''}`);
  }

  async getEventLog(
    deliveryId: string,
    opts: { orgId: string; includePayload?: boolean; routingKey?: string },
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ orgId: opts.orgId });
    if (opts.includePayload) params.set('includePayload', 'true');
    if (opts.routingKey) params.set('routingKey', opts.routingKey);
    return this.request(
      'GET',
      `/api/v1/admin/event-log/${encodeURIComponent(deliveryId)}?${params}`,
    );
  }

  // --- Access log (read + orchestrator-admin mutation attribution) ---

  async listAccessLog(opts?: {
    orgId?: string;
    actorType?: string;
    actorId?: string;
    action?: string;
    source?: string;
    outcome?: string;
    targetType?: string;
    targetId?: string;
    from?: string;
    to?: string;
    q?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    items: Array<Record<string, unknown>>;
    nextCursor: string | null;
  }> {
    const params = new URLSearchParams();
    if (opts?.orgId) params.set('orgId', opts.orgId);
    if (opts?.actorType) params.set('actorType', opts.actorType);
    if (opts?.actorId) params.set('actorId', opts.actorId);
    if (opts?.action) params.set('action', opts.action);
    if (opts?.source) params.set('source', opts.source);
    if (opts?.outcome) params.set('outcome', opts.outcome);
    if (opts?.targetType) params.set('targetType', opts.targetType);
    if (opts?.targetId) params.set('targetId', opts.targetId);
    if (opts?.from) params.set('from', opts.from);
    if (opts?.to) params.set('to', opts.to);
    if (opts?.q) params.set('q', opts.q);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    return this.request('GET', `/api/v1/admin/access-log${qs ? `?${qs}` : ''}`);
  }

  async getAccessLogEntry(id: string, opts?: { orgId?: string }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (opts?.orgId) params.set('orgId', opts.orgId);
    const qs = params.toString();
    return this.request(
      'GET',
      `/api/v1/admin/access-log/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`,
    );
  }

  // --- Diagnostics ---

  async diagnose(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    checks: Array<{
      name: string;
      status: 'pass' | 'warn' | 'fail';
      message: string;
      details?: Record<string, unknown>;
      durationMs: number;
    }>;
    timestamp: string;
  }> {
    return this.request('GET', '/admin/diagnose');
  }
}
