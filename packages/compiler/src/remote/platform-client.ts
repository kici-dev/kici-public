/**
 * PAT-authenticated `kici run remote` transport through the Platform, which
 * relays each control request over the WS dashboard-proxy to the org's
 * orchestrator, so the orchestrator's HTTP API need not be reachable from the
 * developer machine. The other transport is `DirectRunClient` (`direct-client.ts`).
 *
 * The overlay tarball does NOT flow through here: `initUpload` returns a
 * presigned URL the CLI PUTs to directly.
 */

import { toErrorMessage } from '@kici-dev/core';
import {
  TEST_RUN_LOG_CURSOR_START,
  type CheckMode,
  type HostTargetSelector,
} from '@kici-dev/engine';

export class AuthenticationError extends Error {
  constructor(message = 'Invalid or expired token. Run `kici login` to authenticate.') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AccessDeniedError extends Error {
  constructor(message = 'Access denied') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConnectionError extends Error {
  constructor(
    message: string,
    public endpoint?: string,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/**
 * Thrown when several orchestrator clusters are connected and neither
 * `--orchestrator` nor a per-org default picks one; carries the cluster names.
 */
export class AmbiguousClusterError extends Error {
  constructor(
    public clusters: string[],
    message = 'Multiple orchestrator clusters are connected — pass --orchestrator <name>',
  ) {
    super(message);
    this.name = 'AmbiguousClusterError';
  }
}

/** Thrown when the org has no connected orchestrator cluster. */
export class NoClusterError extends Error {
  constructor(message = 'No orchestrator is connected for this organization.') {
    super(message);
    this.name = 'NoClusterError';
  }
}

export interface PlatformUploadInitInput {
  sha?: string;
  fileCount?: number;
  compressedSize?: number;
}

export interface PlatformUploadInitResponse {
  uploadId: string;
  signedUrl: string;
  publicKey: string;
  expiresIn: number;
}

export interface PlatformTriggerInput {
  fixtureId: string;
  event: {
    type: string;
    action?: string;
    targetBranch: string;
    sourceBranch?: string;
    payload: Record<string, unknown>;
    changedFiles?: string[];
  };
  workflowName?: string;
  uploadId?: string;
  /**
   * Ephemeral X25519 key that encrypted the overlay tarball; the orchestrator
   * pairs it with the upload's stored private key. Distinct from `encryptedSecretsKey`.
   */
  cliPublicKey?: string;
  inlineLockFile?: string;
  fullRepo?: boolean;
  secrets?: Record<string, string>;
  encryptedSecrets?: string;
  encryptedSecretsKey?: string;
  /**
   * Relayed onto the dispatch event; the agent step loop runs in this mode.
   * Omitted means `apply`.
   */
  checkMode?: CheckMode;
  /**
   * `kici run --target`, relayed verbatim; the orchestrator intersects each
   * runsOnAll roster with it.
   */
  target?: HostTargetSelector;
  /**
   * Raw `kici run --input KEY=VALUE` pairs, relayed verbatim; the orchestrator
   * validates, coerces and defaults them authoritatively against the lock descriptor.
   */
  dispatchInputs?: Record<string, string>;
  /**
   * The CLI follows every run in the response's `runs`, so the orchestrator
   * creates one run per matched workflow.
   */
  acceptsMultipleRuns?: boolean;
}

/** One run a trigger created: a matched workflow and the run that executes it. */
interface TriggeredRun {
  runId: string;
  workflowName: string;
  jobIds?: string[];
}

export interface PlatformTriggerResponse {
  /** The first run; the only one from an orchestrator that predates `runs`. */
  runId: string;
  /** One entry per matched workflow; absent from an orchestrator that predates it. */
  runs?: TriggeredRun[];
  status: 'accepted' | 'rejected';
  reason?: string;
  jobIds?: string[];
  /** User-visible warnings on acceptance (e.g. skipped non-test bound contexts). */
  warnings?: string[];
}

export interface PlatformRunStatusResponse {
  runId: string;
  status: string;
  jobs: Array<{
    jobId: string;
    jobName: string;
    status: string;
    exitCode?: number | null;
    errorMessage?: string | null;
    /** Absent or null from an orchestrator that does not report it. */
    durationMs?: number | null;
  }>;
  /** Why the run failed when no job records it (an init failure). */
  failureReason?: string | null;
  done: boolean;
}

export interface PlatformRunLogsResponse {
  lines: string[];
  nextCursor: number;
  /** Opaque per-file cursor; absent from a server that predates it. */
  nextLogCursor?: string;
  /** The job that wrote each line, index for index with `lines`; absent from a server that predates it. */
  lineJobNames?: string[];
  done: boolean;
}

/** Where the next log poll reads from: the numeric cursor, and the per-file cursor when known. */
export interface RunLogPosition {
  cursor: number;
  logCursor?: string;
}

/** The first log poll's position: line 0, asking for the per-file cursor. */
export const FIRST_LOG_POSITION: RunLogPosition = {
  cursor: 0,
  logCursor: TEST_RUN_LOG_CURSOR_START,
};

/**
 * The position after `res`. A response with no per-file cursor comes from a
 * server that predates it, so later polls send the numeric cursor alone.
 */
export function nextLogPosition(res: PlatformRunLogsResponse): RunLogPosition {
  return res.nextLogCursor !== undefined
    ? { cursor: res.nextCursor, logCursor: res.nextLogCursor }
    : { cursor: res.nextCursor };
}

export interface PlatformCancelResponse {
  cancelled: boolean;
}

interface PlatformRunClientConfig {
  /** e.g. `https://api.kici.dev`. */
  platformEndpoint: string;
  /** PAT, sent as the bearer credential. */
  token: string;
}

/**
 * Cluster-targeting query: `orchestrator` (explicit pick) and `defaultCluster`
 * (per-org default). With neither, the Platform sole-selects or returns a 422
 * with the cluster list.
 */
function clusterQuery(orchestrator?: string, defaultCluster?: string): string {
  const params = new URLSearchParams();
  if (orchestrator) params.set('orchestrator', orchestrator);
  if (defaultCluster) params.set('defaultCluster', defaultCluster);
  const q = params.toString();
  return q ? `?${q}` : '';
}

export interface ClusterTarget {
  /** `--orchestrator <name>`. */
  orchestrator?: string;
  /** `config.defaultClusters[orgId]`. */
  defaultCluster?: string;
}

/** Client for the Platform's `/api/v1/orgs/:orgId/test/*` relay routes. */
export class PlatformRunClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: PlatformRunClientConfig) {
    this.baseUrl = config.platformEndpoint.replace(/\/+$/, '');
    this.token = config.token;
  }

  /** POST /test/uploads/init — mint an external presigned upload URL. */
  async initUpload(
    orgId: string,
    target: ClusterTarget,
    body: PlatformUploadInitInput,
  ): Promise<PlatformUploadInitResponse> {
    const path = `/api/v1/orgs/${orgId}/test/uploads/init${clusterQuery(target.orchestrator, target.defaultCluster)}`;
    const response = await this.request(path, { method: 'POST', body: JSON.stringify(body) });
    return (await response.json()) as PlatformUploadInitResponse;
  }

  /** POST /test/trigger */
  async trigger(
    orgId: string,
    target: ClusterTarget,
    body: PlatformTriggerInput,
  ): Promise<PlatformTriggerResponse> {
    const path = `/api/v1/orgs/${orgId}/test/trigger${clusterQuery(target.orchestrator, target.defaultCluster)}`;
    const response = await this.request(path, { method: 'POST', body: JSON.stringify(body) });
    return (await response.json()) as PlatformTriggerResponse;
  }

  /** GET /test/runs/:runId — run-status snapshot. */
  async runStatus(
    orgId: string,
    runId: string,
    target: ClusterTarget = {},
  ): Promise<PlatformRunStatusResponse> {
    const path = `/api/v1/orgs/${orgId}/test/runs/${runId}${clusterQuery(target.orchestrator, target.defaultCluster)}`;
    const response = await this.request(path, { method: 'GET' });
    return (await response.json()) as PlatformRunStatusResponse;
  }

  /** GET /test/runs/:runId/logs — next log chunk from a position. */
  async runLogs(
    orgId: string,
    runId: string,
    position: RunLogPosition,
    target: ClusterTarget = {},
  ): Promise<PlatformRunLogsResponse> {
    const params = new URLSearchParams();
    params.set('cursor', String(position.cursor));
    if (position.logCursor !== undefined) params.set('logCursor', position.logCursor);
    if (target.orchestrator) params.set('orchestrator', target.orchestrator);
    if (target.defaultCluster) params.set('defaultCluster', target.defaultCluster);
    const path = `/api/v1/orgs/${orgId}/test/runs/${runId}/logs?${params.toString()}`;
    const response = await this.request(path, { method: 'GET' });
    return (await response.json()) as PlatformRunLogsResponse;
  }

  /** POST /test/runs/:runId/cancel */
  async cancel(
    orgId: string,
    runId: string,
    target: ClusterTarget = {},
  ): Promise<PlatformCancelResponse> {
    const path = `/api/v1/orgs/${orgId}/test/runs/${runId}/cancel${clusterQuery(target.orchestrator, target.defaultCluster)}`;
    const response = await this.request(path, { method: 'POST', body: JSON.stringify({}) });
    return (await response.json()) as PlatformCancelResponse;
  }

  /**
   * Classifies errors: 401 → AuthenticationError, 403 → AccessDeniedError,
   * 404 → NotFoundError, 422 ambiguous_cluster → AmbiguousClusterError,
   * 422 no_cluster → NoClusterError, network failure → ConnectionError.
   */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(init.headers as Record<string, string>),
        },
      });
    } catch (err) {
      throw new ConnectionError(
        `Failed to connect to the Platform at ${this.baseUrl}: ${toErrorMessage(err)}`,
        this.baseUrl,
      );
    }

    if (response.ok) {
      return response;
    }

    await this.throwForStatus(response);
    // Unreachable: throwForStatus always throws.
    return response;
  }

  /** Map a non-OK Platform response to a typed error. Always throws. */
  private async throwForStatus(response: Response): Promise<never> {
    await throwForAccessStatus(response);
    if (response.status === 422) {
      const body = (await readJson(response)) as {
        error?: string;
        message?: string;
        reason?: string;
        clusters?: string[];
      };
      if (body.error === 'ambiguous_cluster') {
        throw new AmbiguousClusterError(body.clusters ?? [], body.message);
      }
      if (body.error === 'no_cluster') {
        throw new NoClusterError(body.message);
      }
      // A rejected trigger's `reason` holds the actionable fail-closed gate
      // message (e.g. the context "does not allow test runs").
      throw new Error(body.reason ?? body.message ?? body.error ?? 'Request rejected (422)');
    }

    throw new Error(
      `Request failed with status ${response.status}: ${await readError(response, '')}`,
    );
  }
}

/**
 * Throw the typed error for a 401, 403 or 404 response, and return for any
 * other status. `authMessage` replaces the default `kici login` remedy.
 */
export async function throwForAccessStatus(
  response: Response,
  authMessage?: string,
): Promise<void> {
  if (response.status === 401) throw new AuthenticationError(authMessage);
  if (response.status === 403) {
    throw new AccessDeniedError(await readError(response, 'Access denied'));
  }
  if (response.status === 404) {
    throw new NotFoundError(await readError(response, 'Resource not found'));
  }
}

/** Read a JSON body, returning `{}` on any parse failure. */
export async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Read a JSON body's `error`, then `message`, falling back to text then `fallback`. */
export async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: string; message?: string };
    if (body.error) return body.error;
    if (body.message) return body.message;
  } catch {
    // not JSON
  }
  try {
    const text = await response.text();
    if (text) return text;
  } catch {
    // ignore
  }
  return fallback;
}
