/**
 * Typed client for the Platform org-scoped dashboard API (the web UI's
 * endpoints), authenticated with the stored PAT + active org. The only place in
 * the CLI that knows these routes.
 */
import { z } from 'zod';
import {
  runListResponseSchema,
  runListItemSchema,
  diagnosticsInfrastructureResponseSchema,
  diagnosticsSummaryResponseSchema,
  dashboardRunDetailApiResponseSchema,
  dashboardStepLogsApiResponseSchema,
  registrationItemSchema,
  artifactListItemSchema,
  type ArtifactListItem,
  type RunListResponse,
  type RunListItem,
  type DiagnosticsInfrastructureResponse,
  type DiagnosticsSummaryResponse,
  type DashboardRunDetailApiResponse,
  type DashboardStepLogsApiResponse,
  type RegistrationItem,
  RUN_DETAIL_SOURCE_HEADER,
  RUN_DETAIL_FALLBACK_REASON_HEADER,
  RunDetailSource,
  RunDetailFallbackReason,
} from '@kici-dev/engine';
import { loadGlobalConfig, type GlobalConfig } from './config.js';

export type DashboardErrorKind =
  | 'not_logged_in'
  | 'no_active_org'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'cooldown'
  | 'orchestrator_offline'
  | 'http';

/** Raised by every DashboardClient method on a non-2xx response. */
export class DashboardClientError extends Error {
  constructor(
    readonly kind: DashboardErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DashboardClientError';
  }
}

/** A run's detail, and how the Platform served it. */
export interface RunDetailRead {
  detail: DashboardRunDetailApiResponse;
  /** The path that served it; null when the Platform did not say. */
  source: RunDetailSource | null;
  /** Why the stored copy was served; null when it was not, or the reason is not one this CLI knows. */
  fallbackReason: RunDetailFallbackReason | null;
}

export interface RunsListFilters {
  status?: string;
  workflow?: string;
  branch?: string;
  repo?: string;
  trigger?: string;
  /** A source routing key (`generic:<org>:<id>`), or a bare provider prefix (`github`). */
  source?: string;
  since?: string;
  /** Opaque keyset cursor from a prior page's `nextCursor`; absent = first page. */
  cursor?: string;
  /** Only runs whose id starts with these characters. */
  runIdPrefix?: string;
  /** Also page into archived runs. */
  includeArchived?: boolean;
}

const singleRunSchema = z.object({ run: runListItemSchema });
export const webhookActivitySchema = z.object({
  windowMinutes: z.number(),
  received: z.number(),
  delivered: z.number(),
  edgeRejected: z.number(),
  failed: z.number(),
  matched: z.number().optional(),
  unmatched: z.number().optional(),
  lockfileMissing: z.number().optional(),
  orchestratorUnavailable: z.boolean(),
});
export type WebhookActivity = z.infer<typeof webhookActivitySchema>;
const issueReportCreateSchema = z.object({ ref: z.string(), uploadUrl: z.string() });
const issueReportConfirmSchema = z.object({ ref: z.string(), status: z.string() });
const issueReportDeleteSchema = z.object({ ref: z.string(), deleted: z.boolean() });
const issueReportListSchema = z.object({
  reports: z.array(
    z.object({
      ref: z.string(),
      bundleId: z.string(),
      byteSize: z.number(),
      status: z.string(),
      createdAt: z.string(),
      userId: z.string(),
      message: z.string().nullable(),
    }),
  ),
});
export type IssueReportListResponse = z.infer<typeof issueReportListSchema>;

// `alreadyAccepted`: an earlier request for the same re-run started `newRunId`. Absent means not reported.
const rerunResponseSchema = z.object({
  newRunId: z.string(),
  alreadyAccepted: z.boolean().optional(),
});
// An orchestrator predating `alreadyTerminal` omits it: absent means "not reported", not "false".
const cancelResponseSchema = z.object({
  cancelledJobs: z.number().optional(),
  alreadyTerminal: z.boolean().optional(),
});
const cancelByBranchResponseSchema = z.object({ cancelledRuns: z.number().optional() });

const registrationsListSchema = z.object({
  registrations: z.array(registrationItemSchema).default([]),
  registryVersion: z.number(),
  registryUpdatedAt: z.string(),
});

export interface RegistrationsListResult {
  registrations: RegistrationItem[];
  registryVersion: number;
  registryUpdatedAt: string;
}

export interface RegistrationsListFilters {
  triggerType?: string;
  repoIdentifier?: string;
}

/**
 * A secret context for `kici secrets list` / `kici types`. With `includeSecrets`
 * the orchestrator returns the per-env secret key names (never values).
 */
const contextContextSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  allowLocalExecution: z.boolean(),
  secretKeys: z.array(z.string()).default([]),
});

const contextsListSchema = z.object({
  contexts: z.array(contextContextSchema).default([]),
});

export type ContextContext = z.infer<typeof contextContextSchema>;

/**
 * `GET /runs/:runId/artifacts`; the per-artifact shape comes from
 * `@kici-dev/engine` so CLI and server cannot drift.
 */
export interface ArtifactsListResult {
  artifacts: ArtifactListItem[];
  downloadUrlExpiresInSeconds?: number;
}

const artifactsListResultSchema = z.object({
  artifacts: z.array(artifactListItemSchema),
  downloadUrlExpiresInSeconds: z.number().int().positive().optional(),
});

const STATUS_ERROR_MAP: Record<number, [DashboardErrorKind, string]> = {
  401: ['unauthorized', 'Authentication failed. Run `kici login` to re-authenticate.'],
  403: ['forbidden', 'Access denied.'],
  404: ['not_found', 'Not found.'],
  409: ['conflict', 'Already in a terminal state.'],
  429: ['cooldown', 'Rate limited — wait and retry.'],
  503: ['orchestrator_offline', 'Orchestrator offline — try again shortly.'],
  504: ['orchestrator_offline', 'Orchestrator timed out — try again shortly.'],
};

export class DashboardClient {
  private constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly orgId: string,
  ) {}

  static fromConfig(config: GlobalConfig): DashboardClient {
    const token = config.pat;
    const endpoint = config.platformEndpoint;
    if (!token) {
      throw new DashboardClientError('not_logged_in', 'Not logged in. Run `kici login` first.');
    }
    if (!endpoint) {
      throw new DashboardClientError(
        'not_logged_in',
        'No endpoint configured. Run `kici login` first.',
      );
    }
    if (!config.activeOrgId) {
      throw new DashboardClientError(
        'no_active_org',
        'No active organization. Run `kici org use <name>` to set one.',
      );
    }
    return new DashboardClient(endpoint.replace(/\/$/, ''), token, config.activeOrgId);
  }

  static async load(): Promise<DashboardClient> {
    return DashboardClient.fromConfig(await loadGlobalConfig());
  }

  private orgUrl(path: string): string {
    return `${this.endpoint}/api/v1/orgs/${this.orgId}/${path.replace(/^\//, '')}`;
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(this.orgUrl(path), {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((err: unknown) => {
      throw new DashboardClientError('http', `Network error: ${String(err)}`);
    });
    if (!res.ok) return this.throwForStatus(res);
    return res;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const text = await (await this.send(method, path, body)).text();
    return text ? (JSON.parse(text) as unknown) : {};
  }

  private async throwForStatus(res: Response): Promise<never> {
    let detail: string | undefined;
    try {
      detail = ((await res.json()) as { error?: string }).error;
    } catch {
      /* non-JSON body */
    }
    const [kind, fallback] = STATUS_ERROR_MAP[res.status] ?? [
      'http',
      `Request failed (${res.status}).`,
    ];
    throw new DashboardClientError(kind, detail ?? fallback, res.status);
  }

  async getJson(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  async postJson(path: string, body?: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }

  async deleteJson(path: string): Promise<unknown> {
    return this.request('DELETE', path);
  }

  async getDiagnosticsSummary(): Promise<DiagnosticsSummaryResponse> {
    return diagnosticsSummaryResponseSchema.parse(await this.getJson('/diagnostics'));
  }

  async getInfrastructure(): Promise<DiagnosticsInfrastructureResponse> {
    return diagnosticsInfrastructureResponseSchema.parse(
      await this.getJson('/diagnostics/infrastructure'),
    );
  }

  async listRuns(filters: RunsListFilters = {}): Promise<RunListResponse> {
    const qs = new URLSearchParams();
    if (filters.status) qs.set('status', filters.status);
    if (filters.workflow) qs.set('workflow', filters.workflow);
    if (filters.branch) qs.set('branch', filters.branch);
    if (filters.repo) qs.set('repository', filters.repo);
    if (filters.trigger) qs.set('triggerType', filters.trigger);
    // A routing key always holds a colon and is matched exactly as `routingKey`;
    // a bare provider (`github`) is the API's `source` prefix filter.
    if (filters.source)
      qs.set(filters.source.includes(':') ? 'routingKey' : 'source', filters.source);
    if (filters.since) qs.set('since', filters.since);
    if (filters.cursor) qs.set('cursor', filters.cursor);
    if (filters.runIdPrefix) qs.set('runIdPrefix', filters.runIdPrefix);
    if (filters.includeArchived) qs.set('includeArchived', 'true');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return runListResponseSchema.parse(await this.getJson(`/runs${suffix}`));
  }

  async getRun(runId: string): Promise<RunListItem> {
    return singleRunSchema.parse(await this.getJson(`/runs/${runId}`)).run;
  }

  async getWebhookActivity(windowMinutes = 60): Promise<WebhookActivity> {
    return webhookActivitySchema.parse(
      await this.getJson(`/webhook-activity?windowMinutes=${windowMinutes}`),
    );
  }

  async getRunDetail(runId: string): Promise<DashboardRunDetailApiResponse> {
    return (await this.getRunDetailWithSource(runId)).detail;
  }

  /** A run's detail with the headers that say how the Platform served it. */
  async getRunDetailWithSource(runId: string): Promise<RunDetailRead> {
    const res = await this.send('GET', `/runs/${runId}/detail`);
    const text = await res.text();
    const detail = dashboardRunDetailApiResponseSchema.parse(text ? JSON.parse(text) : {});
    const source = RunDetailSource.safeParse(res.headers.get(RUN_DETAIL_SOURCE_HEADER));
    const reason = RunDetailFallbackReason.safeParse(
      res.headers.get(RUN_DETAIL_FALLBACK_REASON_HEADER),
    );
    return {
      detail,
      source: source.success ? source.data : null,
      fallbackReason: reason.success ? reason.data : null,
    };
  }

  async getStepLogs(
    runId: string,
    jobId: string,
    stepIndex: number,
  ): Promise<DashboardStepLogsApiResponse> {
    return dashboardStepLogsApiResponseSchema.parse(
      await this.getJson(`/runs/${runId}/jobs/${jobId}/steps/${stepIndex}/logs`),
    );
  }

  /**
   * Each entry's presigned `downloadUrl` is minted by the customer's orchestrator
   * and relayed by the Platform without re-signing, so artifact bytes never transit it.
   */
  async listArtifacts(runId: string): Promise<ArtifactsListResult> {
    return artifactsListResultSchema.parse(await this.getJson(`/runs/${runId}/artifacts`));
  }

  /**
   * Reserve an issue-report upload slot: a presigned PUT for the bundle bytes
   * (the Platform never proxies them) plus the reference id the customer quotes
   * to support.
   */
  async createIssueReport(body: {
    bundleId: string;
    byteSize: number;
    sha256: string;
    message?: string;
    email?: string;
  }): Promise<{ ref: string; uploadUrl: string }> {
    return issueReportCreateSchema.parse(await this.postJson('/issue-reports', body));
  }

  /** The bytes landed: the Platform verifies and marks the report received. */
  async confirmIssueReport(ref: string): Promise<{ ref: string; status: string }> {
    return issueReportConfirmSchema.parse(
      await this.postJson(`/issue-reports/${encodeURIComponent(ref)}/confirm`),
    );
  }

  async listIssueReports(): Promise<IssueReportListResponse> {
    return issueReportListSchema.parse(await this.getJson('/issue-reports'));
  }

  async withdrawIssueReport(ref: string): Promise<{ ref: string; deleted: boolean }> {
    return issueReportDeleteSchema.parse(
      await this.deleteJson(`/issue-reports/${encodeURIComponent(ref)}`),
    );
  }

  async rerunRun(runId: string): Promise<{ newRunId: string; alreadyAccepted?: boolean }> {
    return rerunResponseSchema.parse(await this.postJson(`/runs/${runId}/rerun`));
  }

  async cancelRun(
    runId: string,
    force: boolean,
  ): Promise<{ cancelledJobs?: number; alreadyTerminal?: boolean }> {
    return cancelResponseSchema.parse(await this.postJson(`/runs/${runId}/cancel`, { force }));
  }

  async cancelByBranch(branch: string): Promise<{ cancelledRuns?: number }> {
    return cancelByBranchResponseSchema.parse(
      await this.postJson('/runs/cancel-by-branch', { branch }),
    );
  }

  /** The org's permanently registered workflows. */
  async listRegistrations(
    filters: RegistrationsListFilters = {},
  ): Promise<RegistrationsListResult> {
    const qs = new URLSearchParams();
    if (filters.triggerType) qs.set('triggerType', filters.triggerType);
    if (filters.repoIdentifier) qs.set('repoIdentifier', filters.repoIdentifier);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return registrationsListSchema.parse(await this.getJson(`/registrations${suffix}`));
  }

  /** `includeSecrets` attaches each context's reachable secret key names (never values). */
  async listContexts(includeSecrets = false): Promise<ContextContext[]> {
    const suffix = includeSecrets ? '?includeSecrets=true' : '';
    return contextsListSchema.parse(await this.getJson(`/contexts${suffix}`)).contexts;
  }
}
