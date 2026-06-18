/**
 * Typed client for the Platform org-scoped dashboard API (the endpoints the
 * web UI uses). Authenticated with the stored PAT + active org. This is the
 * only place in the CLI that knows these routes.
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
  type RunListResponse,
  type RunListItem,
  type DiagnosticsInfrastructureResponse,
  type DiagnosticsSummaryResponse,
  type DashboardRunDetailApiResponse,
  type DashboardStepLogsApiResponse,
  type RegistrationItem,
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

/** Typed error raised by every DashboardClient method on a non-2xx response. */
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

/** Filters accepted by the runs-list endpoint. */
export interface RunsListFilters {
  status?: string;
  workflow?: string;
  branch?: string;
  repo?: string;
  trigger?: string;
  source?: string;
  since?: string;
  page?: number;
}

const singleRunSchema = z.object({ run: runListItemSchema });
const rerunResponseSchema = z.object({ newRunId: z.string() });
const cancelResponseSchema = z.object({ cancelledJobs: z.number().optional() });
const cancelByBranchResponseSchema = z.object({ cancelledRuns: z.number().optional() });

const registrationsListSchema = z.object({
  registrations: z.array(registrationItemSchema).default([]),
  registryVersion: z.number(),
  registryUpdatedAt: z.string(),
});

/** Result of {@link DashboardClient.listRegistrations}. */
export interface RegistrationsListResult {
  registrations: RegistrationItem[];
  registryVersion: number;
  registryUpdatedAt: string;
}

/** Filters accepted by the registrations-list endpoint. */
export interface RegistrationsListFilters {
  triggerType?: string;
  repoIdentifier?: string;
}

/**
 * A secret context (environment) as surfaced to the developer CLI's
 * `secrets list` / `types` commands. The orchestrator returns the per-env
 * secret key names (never values) when `includeSecrets` is requested.
 */
const environmentContextSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  allowLocalExecution: z.boolean(),
  secretKeys: z.array(z.string()).default([]),
});

const environmentsListSchema = z.object({
  environments: z.array(environmentContextSchema).default([]),
});

/** A secret context (environment) returned by {@link DashboardClient.listEnvironments}. */
export type EnvironmentContext = z.infer<typeof environmentContextSchema>;

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
    const token = config.pat ?? config.token;
    const endpoint = config.platformEndpoint ?? config.endpoint;
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

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
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

    if (res.ok) {
      const text = await res.text();
      return text ? (JSON.parse(text) as unknown) : {};
    }
    return this.throwForStatus(res);
  }

  private async throwForStatus(res: Response): Promise<never> {
    let detail: string | undefined;
    try {
      detail = ((await res.json()) as { error?: string }).error;
    } catch {
      /* ignore non-JSON bodies */
    }
    const [kind, fallback] = STATUS_ERROR_MAP[res.status] ?? [
      'http',
      `Request failed (${res.status}).`,
    ];
    throw new DashboardClientError(kind, detail ?? fallback, res.status);
  }

  /** Generic GET helper used by typed methods (and tests). */
  async getJson(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  /** Generic POST helper used by typed methods (and tests). */
  async postJson(path: string, body?: unknown): Promise<unknown> {
    return this.request('POST', path, body);
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
    if (filters.source) qs.set('source', filters.source);
    if (filters.since) qs.set('since', filters.since);
    if (filters.page) qs.set('page', String(filters.page));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return runListResponseSchema.parse(await this.getJson(`/runs${suffix}`));
  }

  async getRun(runId: string): Promise<RunListItem> {
    return singleRunSchema.parse(await this.getJson(`/runs/${runId}`)).run;
  }

  async getRunDetail(runId: string): Promise<DashboardRunDetailApiResponse> {
    return dashboardRunDetailApiResponseSchema.parse(await this.getJson(`/runs/${runId}/detail`));
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

  async rerunRun(runId: string): Promise<{ newRunId: string }> {
    return rerunResponseSchema.parse(await this.postJson(`/runs/${runId}/rerun`));
  }

  async cancelRun(runId: string, force: boolean): Promise<{ cancelledJobs?: number }> {
    return cancelResponseSchema.parse(await this.postJson(`/runs/${runId}/cancel`, { force }));
  }

  async cancelByBranch(branch: string): Promise<{ cancelledRuns?: number }> {
    return cancelByBranchResponseSchema.parse(
      await this.postJson('/runs/cancel-by-branch', { branch }),
    );
  }

  /** List the org's permanently registered workflows (GET /registrations). */
  async listRegistrations(
    filters: RegistrationsListFilters = {},
  ): Promise<RegistrationsListResult> {
    const qs = new URLSearchParams();
    if (filters.triggerType) qs.set('triggerType', filters.triggerType);
    if (filters.repoIdentifier) qs.set('repoIdentifier', filters.repoIdentifier);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return registrationsListSchema.parse(await this.getJson(`/registrations${suffix}`));
  }

  /**
   * List the org's environments as secret contexts (GET /environments).
   *
   * Pass `includeSecrets` to have the orchestrator attach each environment's
   * reachable secret key names (never values). Used by `kici secrets list`
   * and `kici types`.
   */
  async listEnvironments(includeSecrets = false): Promise<EnvironmentContext[]> {
    const suffix = includeSecrets ? '?includeSecrets=true' : '';
    return environmentsListSchema.parse(await this.getJson(`/environments${suffix}`)).environments;
  }
}
