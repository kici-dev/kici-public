/**
 * Client for an orchestrator's direct `kici run remote` routes
 * (`/api/v1/test/*`), authenticated with an orchestrator admin token.
 *
 * The transport `kici connect`, `--orchestrator-url` and
 * `KICI_ORCHESTRATOR_TOKEN` select. It speaks the same request and response
 * shapes as the Platform relay (`PlatformRunClient`), so the run loop treats
 * both alike. It also reads the orchestrator admin routes a developer token
 * may use: context secret key names for `kici types`, and held-run listing and
 * decisions on an independent orchestrator.
 */
import { toErrorMessage } from '@kici-dev/core';
import type { ApprovalDecision, HeldRunSummary, OrchestratorMode } from '@kici-dev/engine';
import {
  AuthenticationError,
  ConnectionError,
  NotFoundError,
  readError,
  readJson,
  throwForAccessStatus,
  type PlatformCancelResponse,
  type PlatformRunLogsResponse,
  type PlatformRunStatusResponse,
  type PlatformTriggerInput,
  type PlatformTriggerResponse,
  type PlatformUploadInitInput,
  type PlatformUploadInitResponse,
} from './platform-client.js';
import { normalizeOrchestratorUrl } from './target.js';

/** What `GET /api/v1/test/whoami` says about the caller. */
export interface DirectWhoami {
  tokenId: string;
  label: string;
  subject: string | null;
  role: 'owner' | 'admin' | 'auditor';
  mode: OrchestratorMode;
  /** The org runs land in; null on a connected orchestrator that has none yet. */
  orgId: string | null;
  permissions: { trigger: boolean; read: boolean };
}

/** The orchestrator answers but serves no direct test-run API. */
export class DirectApiUnavailableError extends Error {
  constructor(url: string) {
    super(
      `The orchestrator at ${url} does not serve the test-run API. It needs admin auth ` +
        '(KICI_SECRET_KEY) and a KiCI release that has the /api/v1/test routes.',
    );
    this.name = 'DirectApiUnavailableError';
  }
}

/**
 * The orchestrator cannot list or answer this run's holds for this caller:
 * the token lacks the trust-policy permissions, the routes are not mounted, or
 * the orchestrator leaves held runs to the Platform. The message is the
 * server's own text when it sent one.
 */
export class HoldsUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HoldsUnavailableError';
  }
}

const DIRECT_AUTH_MESSAGE =
  'The orchestrator refused the token: it is invalid, revoked or expired. Ask an operator ' +
  'for a new one (`kici-admin token create <label> --role admin --subject <you>`), then ' +
  'run `kici connect <url>` again.';

/** A context with the secret key names bound to it. */
export interface ContextSecretKeys {
  name: string;
  keys: string[];
}

export class DirectRunClient {
  readonly url: string;
  private readonly token: string;
  /** The server's reason for the most recent refused `decideHold`. */
  lastDecisionError: string | undefined;

  constructor(opts: { url: string; token: string }) {
    this.url = normalizeOrchestratorUrl(opts.url);
    this.token = opts.token;
  }

  /** GET /api/v1/test/whoami — who the token is and what it may do. */
  async whoami(): Promise<DirectWhoami> {
    try {
      return await this.json<DirectWhoami>('/api/v1/test/whoami', { method: 'GET' });
    } catch (err) {
      if (err instanceof NotFoundError) throw new DirectApiUnavailableError(this.url);
      throw err;
    }
  }

  initUpload(body: PlatformUploadInitInput): Promise<PlatformUploadInitResponse> {
    return this.json('/api/v1/test/uploads/init', { method: 'POST', body: JSON.stringify(body) });
  }

  trigger(body: PlatformTriggerInput): Promise<PlatformTriggerResponse> {
    return this.json('/api/v1/test/trigger', { method: 'POST', body: JSON.stringify(body) });
  }

  runStatus(runId: string): Promise<PlatformRunStatusResponse> {
    return this.json(`/api/v1/test/runs/${encodeURIComponent(runId)}`, { method: 'GET' });
  }

  runLogs(runId: string, cursor: number): Promise<PlatformRunLogsResponse> {
    return this.json(
      `/api/v1/test/runs/${encodeURIComponent(runId)}/logs?cursor=${encodeURIComponent(String(cursor))}`,
      { method: 'GET' },
    );
  }

  cancel(runId: string): Promise<PlatformCancelResponse> {
    return this.json(`/api/v1/test/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
  }

  /** The org's contexts with the secret key names bound to each (never values). */
  async listContextSecretKeys(orgId: string): Promise<ContextSecretKeys[]> {
    const data = await this.json<{ contexts?: Array<{ name: string; secret_keys?: string[] }> }>(
      `/api/v1/admin/contexts?orgId=${encodeURIComponent(orgId)}&includeSecrets=true`,
      { method: 'GET' },
    );
    return (data.contexts ?? []).map((c) => ({ name: c.name, keys: c.secret_keys ?? [] }));
  }

  /** This run's pending holds, through the orchestrator's admin held-run route. */
  async listHolds(orgId: string, runId: string): Promise<HeldRunSummary[]> {
    const query = `customerId=${encodeURIComponent(orgId)}&runId=${encodeURIComponent(runId)}`;
    const response = await this.send(`/api/v1/admin/held-runs?${query}`, { method: 'GET' });
    if (response.status === 403 || response.status === 404 || response.status === 409) {
      throw new HoldsUnavailableError(
        await readError(response, `held runs unavailable (${response.status})`),
        response.status,
      );
    }
    const ok = await this.checked(response);
    const data = (await ok.json()) as { heldRuns?: HeldRunSummary[] };
    return data.heldRuns ?? [];
  }

  /**
   * Approve or reject one hold. Resolves false, with the server's reason on
   * `lastDecisionError`, when the orchestrator refuses the decision.
   *
   * `autoApprove` marks a `kici run --approve-all` approval, which the
   * orchestrator audits as `held_run.auto_approve`. It does not bypass the
   * hold's eligibility check.
   */
  async decideHold(
    orgId: string,
    heldRunId: string,
    decision: ApprovalDecision,
    reason?: string,
    autoApprove = false,
  ): Promise<boolean> {
    const response = await this.send('/api/v1/admin/held-runs/decision', {
      method: 'POST',
      body: JSON.stringify({
        customerId: orgId,
        heldRunId,
        decision,
        ...(reason ? { reason } : {}),
        ...(autoApprove ? { autoApprove: true } : {}),
      }),
    });
    if (response.ok) {
      this.lastDecisionError = undefined;
      return true;
    }
    if (response.status === 401) throw new AuthenticationError(DIRECT_AUTH_MESSAGE);
    this.lastDecisionError = await readError(response, `decision refused (${response.status})`);
    return false;
  }

  private async json<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.checked(await this.send(path, init));
    return (await response.json()) as T;
  }

  /** Send one request; a transport failure becomes a `ConnectionError`. */
  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.url}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(init.headers as Record<string, string>),
        },
      });
    } catch (err) {
      throw new ConnectionError(
        `Failed to connect to the orchestrator at ${this.url}: ${toErrorMessage(err)}`,
        this.url,
      );
    }
  }

  /** Pass an OK response through; map every other status to a typed error. */
  private async checked(response: Response): Promise<Response> {
    if (response.ok) return response;
    await throwForAccessStatus(response, DIRECT_AUTH_MESSAGE);
    if (response.status === 422) {
      // A rejected trigger carries the run body; its `reason` is the gate message.
      const body = (await readJson(response)) as { reason?: string; error?: string };
      throw new Error(body.reason ?? body.error ?? 'Request rejected (422)');
    }
    throw new Error(
      `Request to the orchestrator failed with status ${response.status}: ${await readError(response, '')}`,
    );
  }
}
