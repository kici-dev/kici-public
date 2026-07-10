/**
 * The developer-operations API contract. One row per workflow-developer-core
 * operation, declaring which entrypoints expose it — HTTP (the shared REST API
 * behind both the web UI and the `kici` CLI), MCP (the agent tool surface), and
 * a curated UI flag. The congruence tests assert each entrypoint's real surface
 * matches this registry, so a new route / CLI command / MCP tool that drifts
 * from the contract fails the build.
 *
 * Three row states, one honest ledger:
 *
 * - **Live everywhere it should be** — `entrypoints.mcp: true` with `mcpTool`
 *   set. The registered developer MCP tools land here; their booleans mirror the
 *   actual current surface so every harness passes on landing.
 * - **Planned MCP tool** — `mcpAppropriate: true` but `entrypoints.mcp: false`,
 *   `mcpTool: null`. An agent-appropriate op that exists in HTTP/CLI but is not
 *   yet an MCP tool. The consistency test permits this (`mcp ⟹ mcpAppropriate`,
 *   not the converse), so the row is a visible, testable to-do.
 * - **Never an MCP tool** — `mcpAppropriate: false`, `entrypoints.mcp: false`.
 *   Secret-value writes and destructive deletes: agent safety encoded in data.
 *
 * Browser-safe: data + TypeScript types only, no Node imports, so it lives in
 * the engine barrel importable by the web UI, the CLI, and the Platform.
 */
export type DeveloperOpDomain =
  | 'runs'
  | 'workflows'
  | 'contexts'
  | 'secrets'
  | 'held-runs'
  | 'diagnostics'
  | 'orchestrators'
  | 'sources'
  | 'dlq'
  | 'attestations'
  | 'activity'
  | 'orgs';

export type DeveloperOpKind = 'read' | 'write';

/** Which of the three entrypoints a developer op is (or should be) exposed on. */
export interface DeveloperOpEntrypoints {
  /** The shared Platform REST API (backs both the web UI and the `kici` CLI). */
  http: boolean;
  /** The `kici` CLI command tree. */
  cli: boolean;
  /** The developer MCP tool surface. */
  mcp: boolean;
  /** Curated: the op has a dashboard affordance (not machine-introspectable). */
  ui: boolean;
}

export interface DeveloperOperation {
  /** Stable id, e.g. 'runs.list', 'held-runs.approve'. Unique across the table. */
  id: string;
  domain: DeveloperOpDomain;
  kind: DeveloperOpKind;
  /** Intended entrypoint coverage — the contract the harness enforces. */
  entrypoints: DeveloperOpEntrypoints;
  /** False ⇒ never an MCP tool (secret-value write, destructive delete). */
  mcpAppropriate: boolean;
  /** MCP tool name when `entrypoints.mcp` is true; null otherwise. */
  mcpTool: string | null;
}

/** Build a row, defaulting every unspecified entrypoint to false. */
function op(
  id: string,
  domain: DeveloperOpDomain,
  kind: DeveloperOpKind,
  ep: Partial<DeveloperOpEntrypoints>,
  mcpAppropriate: boolean,
  mcpTool: string | null,
): DeveloperOperation {
  return {
    id,
    domain,
    kind,
    entrypoints: { http: false, cli: false, mcp: false, ui: false, ...ep },
    mcpAppropriate,
    mcpTool,
  };
}

/**
 * The workflow-developer core. Developer plane only — org-membership-scoped,
 * agent-attributed; never orchestrator-admin or tenant control-plane territory.
 */
export const DEVELOPER_OPERATIONS: readonly DeveloperOperation[] = [
  // runs
  op(
    'runs.list',
    'runs',
    'read',
    { http: true, cli: true, mcp: true, ui: true },
    true,
    'list_runs',
  ),
  op('runs.get', 'runs', 'read', { http: true, cli: true, mcp: true, ui: true }, true, 'get_run'),
  op(
    'runs.stepLogs',
    'runs',
    'read',
    { http: true, cli: true, mcp: true, ui: true },
    true,
    'get_step_logs',
  ),
  op(
    'runs.cancel',
    'runs',
    'write',
    { http: true, cli: true, mcp: true, ui: true },
    true,
    'cancel_run',
  ),
  op(
    'runs.cancelByBranch',
    'runs',
    'write',
    { http: true, cli: true, mcp: true, ui: false },
    true,
    'cancel_runs_by_branch',
  ),
  op(
    'runs.rerun',
    'runs',
    'write',
    { http: true, cli: true, mcp: true, ui: true },
    true,
    'rerun_run',
  ),
  // workflows
  op(
    'workflows.list',
    'workflows',
    'read',
    { http: true, cli: true, mcp: true, ui: true },
    true,
    'list_workflows',
  ),
  op(
    'workflows.trigger',
    'workflows',
    'write',
    { http: true, cli: false, mcp: true, ui: true },
    true,
    'trigger_run',
  ),
  // secrets (key names only via mcp; values never cross any entrypoint)
  op(
    'secrets.list',
    'secrets',
    'read',
    { http: true, cli: true, mcp: true, ui: true },
    true,
    'list_secrets',
  ),
  op(
    'secrets.set',
    'secrets',
    'write',
    { http: true, cli: false, mcp: false, ui: true },
    false,
    null,
  ),
  op(
    'secrets.delete',
    'secrets',
    'write',
    { http: true, cli: false, mcp: false, ui: true },
    false,
    null,
  ),
  // contexts (destructive delete is never an agent tool)
  op(
    'contexts.delete',
    'contexts',
    'write',
    { http: true, cli: false, mcp: false, ui: true },
    false,
    null,
  ),
  // held-runs
  op(
    'held-runs.approve',
    'held-runs',
    'write',
    { http: true, cli: true, mcp: true, ui: true },
    true,
    'approve_run',
  ),
  op(
    'held-runs.reject',
    'held-runs',
    'write',
    { http: true, cli: true, mcp: true, ui: true },
    true,
    'reject_run',
  ),
  // diagnostics
  op(
    'diagnostics.get',
    'diagnostics',
    'read',
    { http: true, cli: true, mcp: true, ui: true },
    true,
    'get_diagnostics',
  ),
  // orchestrators
  op(
    'orchestrators.list',
    'orchestrators',
    'read',
    { http: true, cli: true, mcp: true, ui: true },
    true,
    'list_orchestrators',
  ),
  // orgs (per-user discovery tool)
  op(
    'orgs.list',
    'orgs',
    'read',
    { http: true, cli: true, mcp: true, ui: true },
    true,
    'list_orgs',
  ),
] as const;

/** All ops a given entrypoint should expose. */
export function developerOpsForEntrypoint(ep: keyof DeveloperOpEntrypoints): DeveloperOperation[] {
  return DEVELOPER_OPERATIONS.filter((o) => o.entrypoints[ep]);
}
