import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

import type { ApprovalRequirement, ApproverClause, InitFailure } from '@kici-dev/engine';

/**
 * PostgreSQL-only database types.
 * Column names use snake_case matching the actual database column names.
 */
export interface Database {
  dispatch_queue: DispatchQueueTable;
  dedup_cache: DedupCacheTable;
  ip_allocations: IpAllocationTable;
  execution_runs: ExecutionRunTable;
  execution_jobs: ExecutionJobTable;
  execution_steps: ExecutionStepTable;
  raft_state: RaftStateTable;
  secret_audit_log: SecretAuditLogTable;
  environments: EnvironmentsTable;
  scoped_secrets: ScopedSecretsTable;
  environment_bindings: EnvironmentBindingsTable;
  environment_variables: EnvironmentVariablesTable;
  environment_source_overrides: EnvironmentSourceOverridesTable;
  held_runs: HeldRunsTable;
  held_run_approvals: HeldRunApprovalsTable;
  admin_tokens: AdminTokenTable;
  agent_tokens: AgentTokenTable;
  config_versions: ConfigVersionTable;
  kici_events: KiciEventTable;
  generic_webhook_sources: GenericWebhookSourceTable;
  cross_repo_trust: CrossRepoTrustTable;
  test_uploads: TestUploadsTable;
  workflow_registrations: WorkflowRegistrationsTable;
  registry_versions: RegistryVersionsTable;
  cron_last_fired: CronLastFiredTable;
  run_ephemeral_keys: RunEphemeralKeysTable;
  run_secret_outputs: RunSecretOutputsTable;
  concurrency_groups: ConcurrencyGroupsTable;
  sources: SourcesTable;
  cluster_meta: ClusterMetaTable;
  join_tokens: JoinTokenTable;
  org_settings: OrgSettingsTable;
  execution_job_needs: ExecutionJobNeedsTable;
  pending_job_contexts: PendingJobContextsTable;
  pending_workflow_contexts: PendingWorkflowContextsTable;
  event_log: EventLogTable;
  access_log: AccessLogTable;
  cold_store_chunk_counts: ColdStoreChunkCountsTable;
  cold_store_chunks: ColdStoreChunksTable;
  check_run_tracking: CheckRunTrackingTable;
  scaler_spawning_agents: ScalerSpawningAgentsTable;
  scaler_agent_jobs: ScalerAgentJobsTable;
  scaler_reservations: ScalerReservationsTable;
  attestations: AttestationsTable;
  remote_sources: RemoteSourcesTable;
  host_roster: HostRosterTable;
}

/**
 * Cluster metadata table
 * Key-value store for cluster-wide configuration (e.g. cluster_id).
 */
export interface ClusterMetaTable {
  /** Key identifier (primary key) */
  key: string;
  /** Value */
  value: string;
  /** When this entry was created */
  created_at: Generated<Date>;
}

// Convenience types for cluster_meta
export type ClusterMeta = Selectable<ClusterMetaTable>;
export type NewClusterMeta = Insertable<ClusterMetaTable>;

/**
 * Join tokens table
 * Stores hashed join tokens for zero-knowledge cluster bootstrap.
 * Tokens are one-time use (consumed_at set after validation).
 */
export interface JoinTokenTable {
  /** UUID primary key */
  id: Generated<string>;
  /** SHA-256 hash of the token secret (for lookup) */
  token_hash: string;
  /** Routing info embedded in the token (orgId, routingKey, expiry) */
  routing_info: string;
  /** Who created this token */
  created_by: string;
  /** When this token was created */
  created_at: Generated<Date>;
  /** When this token expires */
  expires_at: Date;
  /** When this token was consumed (null = unused) */
  consumed_at: Date | null;
  /** Who consumed this token (null = unused) — the coordinator that processed the claim */
  consumed_by: string | null;
  /**
   * The instanceId of the joining peer that consumed this token (null = unused).
   * Distinct from `consumed_by` (the coordinator). Lets the same peer instance
   * reuse the token until `expires_at` to self-heal after a transient outage.
   */
  consumed_by_instance: string | null;
}

// Convenience types for join_tokens
export type JoinToken = Selectable<JoinTokenTable>;
export type NewJoinToken = Insertable<JoinTokenTable>;

/**
 * Dispatch queue table
 * Holds jobs waiting to be dispatched to agents.
 */
export interface DispatchQueueTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Unique run identifier for this execution */
  run_id: string;
  /** Workflow name from lock file */
  workflow_name: string;
  /** Job name within the workflow */
  job_name: string;
  /** JSONB array of runs-on labels for agent matching.
   *  Insert: JSON.stringify(labels), Select: auto-parsed by pg driver. */
  runs_on_labels: string;
  /** JSON-encoded Record of the full job configuration */
  job_config: string;
  /** Repository clone URL */
  repo_url: string;
  /** Git ref (branch/tag) */
  ref: string;
  /** Git commit SHA */
  sha: string;
  /** Job status: pending | dispatched | expired | failed */
  status: Generated<string>;
  /** When this job was queued */
  created_at: Generated<Date>;
  /** When this job expires (null = wait indefinitely) */
  expires_at: Date | null;
  /** Webhook delivery ID for tracing */
  delivery_id: string;

  /** Provider type (e.g., "github", "gitlab") */
  provider: Generated<string>;
  /** JSON-encoded provider-specific context (e.g., {"installationId": 42}) */
  provider_context: Generated<string>;
  /** Pre-packed `.kici/` source tarball URL (from cache). Nullable. */
  source_tar_url: string | null;
  /** SHA-256 hash of the source tarball bytes for integrity verification. Nullable. */
  source_tar_hash: string | null;
  /** Pre-built dependency tarball URL (from dep cache). Nullable. */
  deps_url: string | null;
  /** SHA-256 hash of the dependency tarball. Nullable. */
  deps_hash: string | null;
  /** Request trace ID for cross-tier correlation. Nullable for background ops. */
  request_id: string | null;
  /** JSONB array of exclusion labels. Default '[]'. */
  exclude_labels: Generated<string>;
  /** Regex matchers (LabelMatcher[]) the job requires; JS post-filter on top of runs_on_labels. Default '[]'. */
  runs_on_patterns: Generated<string>;
  /** Regex matchers (LabelMatcher[]) that disqualify an agent; JS post-filter. Default '[]'. */
  exclude_patterns: Generated<string>;
  /** Routing key (e.g. "github:12345") so dispatch can pick the right
   *  per-app provider bundle in multi-app setups. Required (NOT NULL). */
  routing_key: string;
  /**
   * For jobs in `status='recovering'`, the moment the recovery grace
   * period elapses. Populated when an agent disconnects with this job
   * in-flight; cleared when the agent reconnects + claims the job, OR
   * when the leader-gated sweep transitions the row to `failed`.
   * NULL for all other statuses.
   */
  recovery_deadline: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * Companion to `recovery_deadline`: the agent id that owned the job
   * before disconnect. Used to validate that a reconnecting agent is
   * the rightful claimant. NULL for non-recovering rows.
   */
  recovery_agent_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Most recent scaler spawn-failure detail for this queued job (e.g.
   * "agent process error: spawn node ENOENT"). Written on a `scaler.failed`
   * event bound to the job; read by the queue-timeout reaper to surface the
   * real provisioning cause; cleared on dispatch. NULL when none recorded.
   */
  last_provisioning_error: ColumnType<string | null, string | null | undefined, string | null>;
  /** Times this job was returned to pending for re-dispatch (job.reject / pre-start agent loss). */
  dispatch_attempts: Generated<number>;
  /**
   * Deadline by which the dispatched job's agent must answer the
   * job.dispatch (job.ack / job.reject / job.status running). Stamped when
   * the dispatch is sent, cleared on any answer; `dispatched` rows past the
   * deadline are requeued by the owning coord's timer or the leader sweep.
   */
  ack_deadline: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /** Agent the dispatch was sent to (for ack-timeout disconnect + logging). */
  ack_agent_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * For a runsOnAll host-fanout child: the agent this job is pinned to. The
   * dispatcher routes it only to that agent and the queue drain never hands it
   * to another. NULL for normal label-routed jobs.
   */
  pinned_agent_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/**
 * Deduplication cache table
 * Tracks recently processed webhook delivery IDs to prevent reprocessing.
 */
export interface DedupCacheTable {
  /** Webhook delivery ID (primary key) */
  delivery_id: string;
  /** When this delivery was first received */
  received_at: Generated<Date>;
  /** When this cache entry expires (24h TTL) */
  expires_at: Date;
}

// Convenience types for dispatch_queue
export type DispatchQueueItem = Selectable<DispatchQueueTable>;
export type NewDispatchQueueItem = Insertable<DispatchQueueTable>;
export type DispatchQueueItemUpdate = Updateable<DispatchQueueTable>;

/**
 * IP allocation table for Firecracker VM networking.
 * Tracks assigned IPs from the CIDR pool. DB-backed to survive restarts.
 */
export interface IpAllocationTable {
  /** Allocated IP address (primary key), e.g. "10.0.0.5" */
  ip: string;
  /** Firecracker VM ID (= agentId) */
  vm_id: string;
  /** Which scaler backend owns this allocation */
  scaler_name: string;
  /** TAP device name on the host */
  tap_device: string;
  /** Guest MAC address */
  mac_address: string;
  /** When this IP was allocated */
  allocated_at: Generated<Date>;
}

/**
 * Execution run table
 * Top-level workflow runs (one per webhook trigger).
 * Stores status, timing, and trigger decision metadata.
 */
export interface ExecutionRunTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Unique run identifier matching runId in protocol messages */
  run_id: string;
  /** Routing key (e.g. github:appId) for Platform StaleOrchDetector when sharing DB */
  routing_key: string | null;
  /** Workflow name from lock file */
  workflow_name: string;
  /** Run status: running | success | failed | cancelled */
  status: Generated<string>;
  /** Provider type (e.g. "github", "gitlab") */
  provider: string;
  /** Repository identifier (e.g. "owner/repo") */
  repo_identifier: string;
  /** Git ref (branch/tag) */
  ref: string;
  /** Git commit SHA */
  sha: string;
  /** Webhook delivery ID for tracing */
  delivery_id: string | null;
  /** Serialized WorkflowDecision (trigger decision trace) */
  trigger_decision: string | null;
  /** When the run started */
  started_at: Generated<Date>;
  /** When the run completed */
  completed_at: Date | null;
  /** Total execution duration in milliseconds */
  duration_ms: number | null;
  /**
   * Total raw log bytes accumulated across all jobs of this run. Sum of the
   * agent-side `LogStreamer.getTotalBytes()` reported on terminal
   * `step.status` for every step in every job. Default 0 for pre-migration
   * rows. Powers the operator-side `kici_org_log_bytes` capacity-planning
   * gauge on the Platform. Postgres BIGINT — pg returns string; cast at
   * read sites.
   */
  log_bytes: Generated<number>;
  /** Provider-specific context (e.g. {"installationId": 42}) */
  provider_context: Generated<string>;
  /** Whether this is a CLI-initiated test run */
  is_test_run: Generated<boolean>;
  /** Fixture ID for test runs (null for real webhook runs) */
  fixture_id: string | null;
  /** Parent run ID for re-run lineage (null for original runs). */
  parent_run_id: string | null;
  /** Root ancestor run ID for re-run lineage (null for original runs). Always points to the first run in the chain. */
  original_run_id: string | null;
  /** User identity that triggered this re-run (null for webhook-triggered). Format: "user:email" or "key:name". */
  triggered_by: string | null;
  /** User identity that cancelled this run (null for non-cancelled). */
  cancelled_by: string | null;
  /** Environment name for this run (null if no environment applies) */
  environment: string | null;
  /** Trust tier of the contributor for PR runs (null for non-PR events) */
  trust_tier: string | null;
  /** Lock file source: 'head' or 'base' (null for non-PR events) */
  lock_file_source: string | null;
  /** Username of the contributor (null for non-PR events) */
  contributor_username: string | null;
  /** Human-readable reason why the run failed (null for non-failed runs). */
  failure_reason: string | null;
  /**
   * Structured init-phase failure detail (shape: `InitFailure` from
   * `@kici-dev/engine`). Non-null means the run never executed a step
   * because something failed during the init phase (lock-file fetch,
   * provider context, agent spawn). NULL for normal runs.
   */
  init_failure: ColumnType<InitFailure | null, unknown, unknown>;
  /**
   * Whole-run wall-clock timeout in ms from the workflow lock; null when
   * unset. Read by the WorkflowDeadlineDetector. INTEGER in Postgres, matching
   * the other `*_ms` columns, so pg returns a plain number.
   */
  workflow_timeout_ms: ColumnType<number | null, number | null | undefined, number | null>;
  /** When this record was created */
  created_at: Generated<Date>;
  /**
   * Run mode for idempotent steps (`apply` | `check` | `check-fail-on-drift`,
   * the `CheckMode` enum). NULL means a legacy/apply run. A non-apply value
   * labels the run a check-mode preview in the dashboard.
   */
  check_mode: string | null;
  /**
   * Set inside the cold-store archive transaction before the row is
   * DELETEd. Survivors carry NULL. Exists so a future
   * "promote-chunk-back-into-PG" path (Phase F) can restore rows with
   * their original archive pointer.
   */
  archived_at: Date | null;
  /** S3 object key of the chunk that carried this row; see `archived_at`. */
  archive_object_key: string | null;
}

/**
 * Execution job table
 * Individual jobs within a run (including matrix expansions).
 */
export interface ExecutionJobTable {
  /** UUID primary key */
  id: Generated<string>;
  /** References execution_runs.run_id */
  run_id: string;
  /** Job identifier from dispatch */
  job_id: string;
  /** Job name (e.g. "test", "test[node-18]") */
  job_name: string;
  /** Job status: pending | running | success | failed | cancelled | skipped */
  status: Generated<string>;
  /** Matrix values JSON (e.g. {"node": "18"}) */
  matrix_values: string | null;
  /** Agent ID that ran this job */
  agent_id: string | null;
  /** When the job started */
  started_at: Date | null;
  /** When the job completed */
  completed_at: Date | null;
  /** Job execution duration in milliseconds */
  duration_ms: number | null;
  /**
   * Total raw log bytes accumulated across all steps of this job. Sum of the
   * agent-side `LogStreamer.getTotalBytes()` reported on terminal
   * `step.status` for every step. Default 0 for pre-migration rows.
   * Postgres BIGINT — pg returns string; cast at read sites.
   */
  log_bytes: Generated<number>;
  /** Error info if failed */
  error_message: string | null;
  /**
   * Structured init-phase failure detail (shape: `InitFailure` from
   * `@kici-dev/engine`). Non-null means the job never executed a step
   * because something failed during init (lock-file fetch, provider
   * context, agent spawn). NULL for normal runs.
   */
  init_failure: ColumnType<InitFailure | null, unknown, unknown>;
  /** Labels used for agent routing (e.g. ["kici:os:linux", "kici:arch:x64"]). JSONB. */
  runs_on_labels: string | null;
  /** Last heartbeat received from agent (for stale run detection) */
  last_heartbeat_at: Date | null;
  /** JSON array of secret context names dispatched with this job */
  dispatched_contexts: Generated<string>;
  /** Aggregated step outputs JSONB (step-keyed map of outputs). Populated on job success. */
  outputs: string | null;
  /** Whether all upstream needs edges are satisfied (dispatch gate). */
  needs_satisfied: Generated<boolean>;
  /** Timestamp when needs_satisfied first flipped to true. */
  ready_at: Date | null;
  /** Dynamic group membership tag (NULL for static jobs). */
  group_name: string | null;
  /** Base (logical) job name for a fan-out child. NULL for non-fanned jobs. */
  base_job_name: string | null;
  /** Fan-out kind for a child: 'matrix' | 'host'. NULL for non-fanned jobs. */
  variant_kind: string | null;
  /** Fan-out label for a child: matrix suffix or hostname. NULL for non-fanned jobs. */
  variant_label: string | null;
  /**
   * Wave gate: a fan-out child beyond the job's `maxParallel` window is held
   * (`true`) instead of dispatched. Cleared by the wave-scheduler when a sibling
   * reaches terminal and an in-flight slot frees up. NULL/false for any job not
   * held by a rolling wave.
   */
  wave_gated: Generated<boolean>;
  /** The fan-out base's `maxParallel` wave width, stamped on every child. NULL = no bounded wave. */
  wave_max_parallel: number | null;
  /** The fan-out base's `failFast` policy, stamped on every child. NULL = no bounded wave. */
  wave_fail_fast: boolean | null;
  /** Instance id of the worker peer this job was rerouted to, or null if local. */
  rerouted_to_peer: string | null;
  /** When this record was created */
  created_at: Generated<Date>;
  /**
   * Denormalized routing_key copied from execution_runs at insert time.
   * Used by cold-store as the partition tenant. NULLable for safety —
   * if an insert site doesn't populate it, the cold-store adapter
   * skips the row.
   */
  routing_key: string | null;
  /** Cold-store archive marker — see ExecutionRunTable.archived_at. */
  archived_at: Date | null;
  /** S3 object key of the chunk that carried this row. */
  archive_object_key: string | null;
}

/**
 * Execution step table
 * Individual steps within a job.
 */
export interface ExecutionStepTable {
  /** UUID primary key */
  id: Generated<string>;
  /** References execution_runs.run_id */
  run_id: string;
  /** Job identifier */
  job_id: string;
  /** Step index within the job (0-based) */
  step_index: number;
  /** Step name */
  step_name: string;
  /** Step status: pending | running | success | failed | skipped */
  status: Generated<string>;
  /** When the step started */
  started_at: Date | null;
  /** When the step completed */
  completed_at: Date | null;
  /** Step execution duration in milliseconds */
  duration_ms: number | null;
  /** Process exit code */
  exit_code: number | null;
  /** Error info if failed */
  error_message: string | null;
  /** Path in storage backend (e.g. "executions/{runId}/job-test/step-0.log") */
  log_path: string | null;
  /** Step type: 'step' for regular steps, 'hook:onCancel', 'hook:cleanup', etc. for hooks */
  step_type: Generated<string>;
  /** JSON array of secret context names accessed by this step. NULL = tracking not available (old runs). */
  secrets_accessed: string | null;
  /**
   * Idempotent per-step outcome (`CheckStepOutcome`: skipped | applied |
   * declined | dry-run | no_check). NULL when the step ran without a check
   * mode. Orthogonal to `status`.
   */
  check_outcome: string | null;
  /** Human-readable drift summary (`summarize(drift)`). NULL when no drift. */
  drift_summary: string | null;
  /** Structured drift value returned by `check()` (JSONB). NULL when no drift. */
  drift: ColumnType<unknown | null, unknown, unknown>;
  /** When this record was created */
  created_at: Generated<Date>;
  /**
   * Denormalized routing_key copied from execution_runs at insert time.
   * Used by cold-store as the partition tenant. NULLable for safety.
   */
  routing_key: string | null;
  /** Cold-store archive marker — see ExecutionRunTable.archived_at. */
  archived_at: Date | null;
  /** S3 object key of the chunk that carried this row. */
  archive_object_key: string | null;
}

// Convenience types for execution_runs
export type ExecutionRun = Selectable<ExecutionRunTable>;
export type NewExecutionRun = Insertable<ExecutionRunTable>;
export type ExecutionRunUpdate = Updateable<ExecutionRunTable>;

// Convenience types for execution_jobs
export type ExecutionJob = Selectable<ExecutionJobTable>;
export type NewExecutionJob = Insertable<ExecutionJobTable>;
export type ExecutionJobUpdate = Updateable<ExecutionJobTable>;

// Convenience types for execution_steps
export type ExecutionStep = Selectable<ExecutionStepTable>;
export type NewExecutionStep = Insertable<ExecutionStepTable>;
export type ExecutionStepUpdate = Updateable<ExecutionStepTable>;

/**
 * Execution job needs edge table.
 * One row per concrete dependency edge within a run.
 * Static-to-static edges inserted at run start; group edges after resolution.
 */
export interface ExecutionJobNeedsTable {
  /** References execution_runs.run_id */
  run_id: string;
  /** Downstream job name (the job that depends on the upstream) */
  job_name: string;
  /** Upstream job name (the job that must complete first) */
  upstream_name: string;
  /** Per-edge failure policy: 'skip' (default) or 'run' */
  if_failed: Generated<string>;
}

// Convenience types for execution_job_needs
export type ExecutionJobNeeds = Selectable<ExecutionJobNeedsTable>;
export type NewExecutionJobNeeds = Insertable<ExecutionJobNeedsTable>;

/**
 * Raft consensus state table
 * Persistent state for Raft leader election across orchestrator cluster.
 * Single row per cluster (default cluster_id = 'default').
 */
export interface RaftStateTable {
  /** Cluster identifier (primary key). Default 'default'. */
  cluster_id: Generated<string>;
  /** Current Raft term */
  current_term: Generated<number>;
  /** Instance ID this node voted for in the current term */
  voted_for: string | null;
  /** Current known leader instance ID */
  leader_id: string | null;
  /** When this state was last updated */
  updated_at: Generated<Date>;
}

// Convenience types for raft_state
export type RaftState = Selectable<RaftStateTable>;
export type RaftStateUpdate = Updateable<RaftStateTable>;

/**
 * Environments table
 * Named deployment environments with concurrency, branch restrictions, and approval rules.
 * Scoped to an organization.
 */
export interface EnvironmentsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Organization ID */
  org_id: string;
  /** Environment name (unique within org) */
  name: string;
  /** Environment type: 'fixed' | 'dynamic' */
  type: Generated<string>;
  /** Glob pattern for dynamic environments (null for fixed) */
  glob_pattern: string | null;
  /** JSONB array of branch restriction patterns */
  branch_restrictions: Generated<string>;
  /** JSONB array of trigger type filters */
  trigger_type_filters: Generated<string>;
  /** JSONB array of repo patterns */
  repo_patterns: Generated<string>;
  /** Max concurrent runs (null = unlimited) */
  concurrency_limit: number | null;
  /** Strategy when concurrency exceeded: 'queue' | 'cancel-pending' */
  concurrency_strategy: Generated<string>;
  /** Timeout for queued runs in milliseconds */
  concurrency_timeout_ms: Generated<number>;
  /** JSONB array of required reviewer identities (null = no approval required) */
  required_reviewers: string | null;
  /** Seconds to wait before deploying (null = no wait timer) */
  wait_timer_seconds: number | null;
  /** Seconds before a held run expires */
  hold_expiry_seconds: Generated<number>;
  /** Minimum trust tier required for CI execution (null = no trust requirement) */
  minimum_trust: string | null;
  /** Whether this environment allows local (no-remote) executions. Default false. */
  allow_local_execution: Generated<boolean>;
  /** Whether this environment is active */
  enabled: Generated<boolean>;
  /** When this environment was created */
  created_at: Generated<Date>;
  /** When this environment was last updated */
  updated_at: Generated<Date>;
  /** Who created this environment */
  created_by: string | null;
}

// Convenience types for environments
export type Environment = Selectable<EnvironmentsTable>;
export type NewEnvironment = Insertable<EnvironmentsTable>;
export type EnvironmentUpdate = Updateable<EnvironmentsTable>;

/**
 * Scoped secrets table
 * Encrypted key-value pairs scoped to org + scope (e.g. environment name, repo pattern).
 */
export interface ScopedSecretsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Organization ID */
  org_id: string;
  /** Scope identifier (e.g. environment name, repo pattern) */
  scope: string;
  /** Secret key name */
  key: string;
  /** Encrypted secret value */
  encrypted_value: string;
  /** Backend type for secret storage (e.g. 'pg', 'vault') */
  backend_type: Generated<string>;
  /** Version of the encryption key used */
  key_version: Generated<number>;
  /** When this secret was created */
  created_at: Generated<Date>;
  /** When this secret was last updated */
  updated_at: Generated<Date>;
}

// Convenience types for scoped_secrets
export type ScopedSecret = Selectable<ScopedSecretsTable>;
export type NewScopedSecret = Insertable<ScopedSecretsTable>;
export type ScopedSecretUpdate = Updateable<ScopedSecretsTable>;

/**
 * Environment bindings table
 * Links environments to scope patterns (e.g. workflow names, repo identifiers).
 */
export interface EnvironmentBindingsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Organization ID */
  org_id: string;
  /** Environment ID (FK to environments.id, cascade delete) */
  environment_id: string;
  /** Scope pattern for matching (e.g. workflow name glob, repo pattern) */
  scope_pattern: string;
  /** When this binding was created */
  created_at: Generated<Date>;
}

// Convenience types for environment_bindings
export type EnvironmentBinding = Selectable<EnvironmentBindingsTable>;
export type NewEnvironmentBinding = Insertable<EnvironmentBindingsTable>;

/**
 * Environment variables table
 * Non-secret key-value pairs attached to an environment.
 */
export interface EnvironmentVariablesTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Organization ID */
  org_id: string;
  /** Environment ID (FK to environments.id, cascade delete) */
  environment_id: string;
  /** Variable key name */
  key: string;
  /** Variable value */
  value: string;
  /** Whether this variable is locked (cannot be overridden by workflow) */
  locked: Generated<boolean>;
  /** When this variable was created */
  created_at: Generated<Date>;
  /** When this variable was last updated */
  updated_at: Generated<Date>;
}

// Convenience types for environment_variables
export type EnvironmentVariable = Selectable<EnvironmentVariablesTable>;
export type NewEnvironmentVariable = Insertable<EnvironmentVariablesTable>;
export type EnvironmentVariableUpdate = Updateable<EnvironmentVariablesTable>;

/**
 * Environment source overrides table
 * Per-source (routing key) variable overrides within an environment.
 */
export interface EnvironmentSourceOverridesTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Organization ID */
  org_id: string;
  /** Environment ID (FK to environments.id, cascade delete) */
  environment_id: string;
  /** Routing key for the source */
  routing_key: string;
  /** Override key name */
  key: string;
  /** Override value */
  value: string;
  /** When this override was created */
  created_at: Generated<Date>;
  /** When this override was last updated */
  updated_at: Generated<Date>;
}

// Convenience types for environment_source_overrides
export type EnvironmentSourceOverride = Selectable<EnvironmentSourceOverridesTable>;
export type NewEnvironmentSourceOverride = Insertable<EnvironmentSourceOverridesTable>;
export type EnvironmentSourceOverrideUpdate = Updateable<EnvironmentSourceOverridesTable>;

/**
 * Held runs table
 * Tracks runs waiting for approval, wait timer, or concurrency slot.
 */
export interface HeldRunsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Organization ID */
  org_id: string;
  /** Run ID (references execution_runs) */
  run_id: string;
  /** Job ID within the run */
  job_id: string;
  /** Environment ID (FK to environments.id); null once the environment is deleted */
  environment_id: string | null;
  /** Hold type: 'approval' | 'wait_timer' | 'concurrency' */
  hold_type: string;
  /** Hold status: 'pending' | 'approved' | 'rejected' | 'expired' | 'released' */
  status: Generated<string>;
  /** Queue type: 'environment' | 'security' */
  queue_type: Generated<string>;
  /** Reason for hold or resolution */
  reason: string | null;
  /** Who approved/rejected this hold */
  approved_by: string | null;
  /** When this hold was created */
  created_at: Generated<Date>;
  /** When this hold expires */
  expires_at: Date;
  /** When this hold was resolved */
  resolved_at: Date | null;
  /**
   * Hold granularity: 'workflow' | 'job' | 'step' (engine `HoldScope`).
   * Existing environment holds are job-scoped, hence the 'job' default.
   */
  hold_scope: Generated<string>;
  /** Step index within the job for step-scoped holds; null otherwise. */
  step_index: number | null;
  /**
   * What created the hold: 'environment' (mandatory env policy) | 'explicit'
   * (SDK `requireApproval`). Engine `TriggerSource`.
   */
  trigger_source: Generated<string>;
  /**
   * Normalized `ApprovalRequirement` (clauses + expiresAt + reason) the hold
   * must satisfy. Null for legacy rows that predate the approval model.
   */
  approval_requirement: ColumnType<
    ApprovalRequirement | null,
    ApprovalRequirement | string | null | undefined,
    ApprovalRequirement | string | null
  >;
}

// Convenience types for held_runs
export type HeldRun = Selectable<HeldRunsTable>;
export type NewHeldRun = Insertable<HeldRunsTable>;
export type HeldRunUpdate = Updateable<HeldRunsTable>;

/**
 * One approver's recorded decision on a held element. Multiple rows accumulate
 * until the hold's `ApprovalRequirement` clauses are all satisfied (approve) or
 * any single reject lands.
 */
export interface HeldRunApprovalsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** FK to held_runs.id (ON DELETE CASCADE) */
  held_run_id: string;
  /** The approver's user id (Keycloak sub) */
  approver_user_id: string;
  /** 'approve' | 'reject' (engine `ApprovalDecision`) */
  decision: string;
  /** Which requirement clauses this decision satisfied (for attribution). */
  clauses_satisfied: ColumnType<
    ApproverClause[] | null,
    ApproverClause[] | string | null | undefined,
    ApproverClause[] | string | null
  >;
  /** When the decision was recorded */
  created_at: Generated<Date>;
}

export type HeldRunApproval = Selectable<HeldRunApprovalsTable>;
export type NewHeldRunApproval = Insertable<HeldRunApprovalsTable>;
export type HeldRunApprovalUpdate = Updateable<HeldRunApprovalsTable>;

/**
 * Secret audit log table
 * Immutable log of secret access and denial events.
 */
export interface SecretAuditLogTable {
  /** UUID primary key */
  id: Generated<string>;
  /** When the event occurred */
  timestamp: Generated<Date>;
  /** The action performed (e.g., 'getSecrets', 'setSecret') */
  action: string;
  /** The context name involved */
  context_name: string;
  /** Routing key scope */
  routing_key: string | null;
  /** Secret keys involved (JSON array) */
  secret_keys: string | null;
  /** Whether the operation was allowed or denied */
  outcome: string;
  /** CI run ID if applicable */
  run_id: string | null;
  /** Job ID if applicable */
  job_id: string | null;
  /** User ID if applicable */
  user_id: string | null;
  /** User role if applicable */
  role: string | null;
  /** Additional metadata (JSON) */
  metadata: string | null;
  /**
   * Set inside the archive transaction before the row is DELETEd.
   * Survivors carry NULL. See cold-storage Phase D notes.
   */
  archived_at: Date | null;
  /** S3 object key of the chunk that carried this row; see `archived_at`. */
  archive_object_key: string | null;
}

// Convenience types for secret_audit_log
export type SecretAuditLogRow = Selectable<SecretAuditLogTable>;
export type NewSecretAuditLogRow = Insertable<SecretAuditLogTable>;

/**
 * Access log table.
 * One row per read or orchestrator-admin mutation attributable to an
 * ActorPrincipal (user / api_key / service_account / platform_operator /
 * system). TTL-pruned via expires_at by the cleanup job.
 */
export interface AccessLogTable {
  id: Generated<string>;
  org_id: string | null;
  routing_key: string | null;
  actor_type: string;
  actor_id: string;
  actor_meta: ColumnType<Record<string, unknown> | null, unknown, unknown>;
  action: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  source: string;
  outcome: string;
  error_message: string | null;
  created_at: Generated<Date>;
  /**
   * Set inside the archive transaction before the row is DELETEd.
   * Survivors carry NULL. See cold-storage Phase D notes.
   * Phase D removed the previous `expires_at`-based TTL — rows older
   * than 30 days are archived to S3 instead of hard-deleted.
   */
  archived_at: Date | null;
  /** S3 object key of the chunk that carried this row; see `archived_at`. */
  archive_object_key: string | null;
}

export type AccessLogRow = Selectable<AccessLogTable>;
export type NewAccessLogRow = Insertable<AccessLogTable>;

/**
 * Admin tokens table
 * Hashed tokens for admin API authentication with role-based access.
 */
export interface AdminTokenTable {
  /** UUID primary key */
  id: Generated<string>;
  /** SHA-256 hash of the token */
  token_hash: string;
  /** Human-readable label */
  label: string;
  /** Role (e.g. 'admin', 'reader') */
  role: string;
  /** Routing key scope (null = all) */
  routing_key: string | null;
  /** When this token was created */
  created_at: Generated<Date>;
  /** When this token expires (null = never) */
  expires_at: Date | null;
  /** When this token was last used */
  last_used_at: Date | null;
  /** Whether this token has been revoked */
  revoked: Generated<boolean>;
}

// Convenience types for admin_tokens
export type AdminTokenRow = Selectable<AdminTokenTable>;
export type NewAdminTokenRow = Insertable<AdminTokenTable>;

/**
 * Agent tokens table
 * Hashed tokens for agent authentication (PSK-based).
 * Supports static (long-lived, CLI-created) and ephemeral (scaler-issued, TTL-bound) tokens.
 */
export interface AgentTokenTable {
  /** UUID primary key */
  id: Generated<string>;
  /** SHA-256 hash of the token */
  token_hash: string;
  /** Token prefix for identification (e.g. "kat_a1b2c3d4") */
  token_prefix: string;
  /** JSON-encoded string[] of agent labels (null = any) */
  labels: string | null;
  /** Token type: 'ephemeral' (scaler-issued) or 'static' (CLI-created) */
  agent_type: string;
  /** When this token was created */
  created_at: Generated<Date>;
  /** When this token was last used for authentication */
  last_seen_at: Date | null;
  /** Who/what created this token (e.g. "cli:admin", "scaler:container-linux-x64") */
  created_by: string | null;
  /** When this token was revoked (null = active) */
  revoked_at: Date | null;
  /** When this token expires (null = never, static tokens) */
  expires_at: Date | null;
}

// Convenience types for agent_tokens
export type AgentTokenRow = Selectable<AgentTokenTable>;
export type NewAgentTokenRow = Insertable<AgentTokenTable>;

/**
 * Config versions table
 * Stores versioned JSONB config snapshots with audit trail.
 * Each config change creates a new version with auto-incrementing version number.
 * Sensitive fields are encrypted and tracked via encrypted_paths array.
 */
export interface ConfigVersionTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Auto-incrementing version number (SERIAL) */
  version: Generated<number>;
  /** Full config snapshot as JSONB */
  config: string;
  /** When this version was created */
  created_at: Generated<Date>;
  /** Who created this version (e.g. "cli:seed", "api:set", "api:rollback") */
  created_by: string;
  /** Human-readable description of the change */
  description: string | null;
  /** JSONB paths that contain encrypted values */
  encrypted_paths: Generated<string[]>;
  /**
   * Master-key generation used to encrypt this row's sensitive fields.
   * Bumped atomically by `kici-admin rotate-key`; decrypt path accepts
   * both the current and the previous generation during a grace window.
   */
  key_version: Generated<number>;
}

// Convenience types for config_versions
export type ConfigVersionRow = Selectable<ConfigVersionTable>;
export type NewConfigVersionRow = Insertable<ConfigVersionTable>;

/**
 * Internal events table (kici_events)
 * Persists internal events (system + custom) for routing, circuit-breaking, and audit.
 * Events have a TTL-based expiry for automatic cleanup.
 */
export interface KiciEventTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Event name (e.g. 'deploy-complete', '__workflow_complete', '__job_complete') */
  event_name: string;
  /** Event payload (JSONB) */
  payload: string;
  /** Source repo identifier (null for non-repo events) */
  source_repo: string | null;
  /** Source routing key */
  source_routing_key: string | null;
  /** Run ID that emitted this event */
  source_run_id: string | null;
  /** Job ID that emitted this event */
  source_job_id: string | null;
  /** Event chain depth for circuit breaker (0 = original, incremented at each hop) */
  chain_depth: Generated<number>;
  /** Whether all subscribers have processed this event */
  processed: Generated<boolean>;
  /** When this event was created */
  created_at: Generated<Date>;
  /** When this event expires (TTL-based cleanup) */
  expires_at: Date;
  /** Optional target repos for cross-repo event targeting (JSONB string[] or null) */
  target_repos: string | null;
  /** When the current lease was taken (NULL = unleased / available for claim) */
  claimed_at: Date | null;
  /** Node id holding the current lease (for diagnostics; not part of the lease check) */
  claimed_by: string | null;
  /** Number of times this event has been leased for processing */
  attempts: Generated<number>;
  /** Most recent dispatch failure message (truncated to 4 KB by application code) */
  last_error: string | null;
  /** Earliest moment the leader-only retry scanner should re-publish pg_notify */
  next_retry_at: Date | null;
  /** When the event entered the DLQ (NULL = not in DLQ) */
  dlq_at: Date | null;
  /** Short DLQ reason: 'exhausted_retries' | 'non_retryable' */
  dlq_reason: string | null;
}

// Convenience types for kici_events
export type KiciEvent = Selectable<KiciEventTable>;
export type NewKiciEvent = Insertable<KiciEventTable>;
export type KiciEventUpdate = Updateable<KiciEventTable>;

/**
 * Generic webhook sources table (generic_webhook_sources)
 * Stores per-source verification config, event extraction rules, and rate limits
 * for non-GitHub webhook sources.
 */
export interface GenericWebhookSourceTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Customer/tenant identifier */
  customer_id: string;
  /** Human-readable source name (unique within customer when not deleted) */
  name: string;
  /** Routing key for this source (e.g. 'generic:<customer_id>:<source_id>') */
  routing_key: string;
  /** Verification method: 'hmac_sha256' | 'bearer_token' | 'ip_allowlist' | 'none' */
  verification_method: Generated<string>;
  /** Verification config (JSONB): { secret, algorithm } | { token } | { allowlist } | {} */
  verification_config: Generated<string>;
  /** Header name to extract event type from (default: 'X-Event-Type') */
  event_type_header: string | null;
  /** JSONPath expression to extract event type from payload body */
  event_type_path: string | null;
  /** Header name for idempotency key */
  idempotency_key_header: string | null;
  /** JSONPath expression for idempotency key from body */
  idempotency_key_path: string | null;
  /** Dedup window in seconds (default: 300 = 5 min) */
  dedup_window_seconds: Generated<number>;
  /** Maximum payload size in bytes (default: 1048576 = 1MB) */
  max_payload_bytes: Generated<number>;
  /** JSON array of allowed event types (null = all) */
  allowed_events: string | null;
  /** JSON array of sensitive headers to strip (default: auth-related headers) */
  strip_headers: Generated<string>;
  /** Whether this source is active */
  enabled: Generated<boolean>;
  /** Token bucket rate limit: requests per minute */
  rate_limit_rpm: Generated<number>;
  /** When this source was created */
  created_at: Generated<Date>;
  /** When this source was last updated */
  updated_at: Generated<Date>;
  /** Soft-delete marker (null = active) */
  deleted_at: Date | null;
  /** Provider implementation to route this source through.
   *  'generic' (default) → GenericWebhookNormalizer (Stripe-shaped payloads).
   *  'local' → LocalWebhookNormalizer (github-shaped push/PR payloads for a
   *  git repository present on the agent filesystem, cloned via file://). */
  provider_type: Generated<string>;
  /** Git config (JSONB), dual-purpose discriminated by `provider_type`:
   *  - universal-git sources ('generic' with git_config) store a
   *    `UniversalGitConfig` (clone URLs, lock-file fetch, clone credentials
   *    against Forgejo / Gitea / Gogs / GitLab repo-webhook / GitHub repo).
   *  - local sources ('local') store a `LocalSourceConfig`
   *    (`{ repoBasePath, cloneUrlBase? }`).
   *  null for plain generic sources that don't drive git operations. Shape
   *  validated by the matching Zod schema at the application layer. */
  git_config: ColumnType<string | Record<string, unknown> | null, string | null, string | null>;
}

// Convenience types for generic_webhook_sources
export type GenericWebhookSource = Selectable<GenericWebhookSourceTable>;
export type NewGenericWebhookSource = Insertable<GenericWebhookSourceTable>;
export type GenericWebhookSourceUpdate = Updateable<GenericWebhookSourceTable>;

/**
 * Cross-repo trust table (cross_repo_trust)
 * Bidirectional trust relationships for cross-repo event delivery.
 * Both source and target must declare trust for delivery to proceed.
 */
export interface CrossRepoTrustTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Source repo that is trusted to emit events */
  source_repo: string;
  /** Source routing key */
  source_routing_key: string;
  /** Target repo that accepts events from source */
  target_repo: string;
  /** Target routing key */
  target_routing_key: string;
  /** JSON array of event name glob patterns allowed (null = all) */
  allowed_events: string | null;
  /** Whether this trust relationship is active */
  enabled: Generated<boolean>;
  /** When this trust relationship was created */
  created_at: Generated<Date>;
}

// Convenience types for cross_repo_trust
export type CrossRepoTrust = Selectable<CrossRepoTrustTable>;
export type NewCrossRepoTrust = Insertable<CrossRepoTrustTable>;
export type CrossRepoTrustUpdate = Updateable<CrossRepoTrustTable>;

/**
 * Test uploads table (test_uploads)
 * Tracks CLI code uploads for remote test runs.
 * Uploads are temporary (24h TTL) and cleaned up by a periodic job.
 */
export interface TestUploadsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Client-facing upload ID */
  upload_id: string;
  /** Routing key for this upload */
  routing_key: string;
  /** Git SHA from the upload */
  sha: string | null;
  /** Number of files in the upload */
  file_count: number | null;
  /** Compressed size in bytes */
  compressed_size: number | null;
  /** S3 object key for the uploaded tarball */
  storage_key: string;
  /** Ephemeral private key for decryption (stored encrypted with master key) */
  encryption_private_key: string | null;
  /** Upload status: pending | uploaded | dispatched | expired */
  status: Generated<string>;
  /** When this upload was created */
  created_at: Generated<Date>;
  /** When this upload expires (24h from creation) */
  expires_at: Date;
  /** Token identifier of the uploader */
  created_by: string | null;
}

// Convenience types for test_uploads
export type TestUpload = Selectable<TestUploadsTable>;
export type NewTestUpload = Insertable<TestUploadsTable>;
export type TestUploadUpdate = Updateable<TestUploadsTable>;

/**
 * Workflow registrations table
 * Per-workflow rows with full lock entry and trigger type index.
 * Each registration is unique per (routing_key, repo, workflow).
 */
export interface WorkflowRegistrationsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Repository identifier (e.g. "owner/repo") */
  repo_identifier: string;
  /** Workflow name from lock file */
  workflow_name: string;
  /** Full workflow lock file entry (JSONB) */
  lock_entry: string;
  /** Array of trigger type strings for GIN index queries */
  trigger_types: string[];
  /** Routing key that created this registration (e.g. "github:42") */
  routing_key: Generated<string>;
  /** Provider-specific context captured at registration time (e.g. { installationId }) */
  provider_context: Generated<string>;
  /** Whether this workflow registration is disabled (skipped during trigger matching) */
  disabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** Git commit SHA from the push that last updated this registration */
  commit_sha: ColumnType<string | null, string | null | undefined, string | null>;
  /** Source file path for this workflow (e.g. ".kici/workflows/deploy.ts") */
  source_file: ColumnType<string | null, string | null | undefined, string | null>;
  /** Whether this is a global workflow (triggers across all repos under same routing key) */
  is_global: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Customer/org ID that owns this registration. Backfilled from the source row
   * (sources or generic_webhook_sources joined on routing_key) by migration 020,
   * NOT NULL after backfill. Used by the cross-source webhook lookup index
   * (RegistrationIndex.byOrgAndEvent) to enforce org isolation.
   *
   * Required on insert (no DB default — migration 020 enforces NOT NULL);
   * Updateable type allows omission so the existing replaceAll UPDATE branch
   * (which preserves the existing customer_id alongside the rest of the row)
   * can keep its current shape.
   */
  customer_id: ColumnType<string, string, string | undefined>;
  /** When this registration was created */
  created_at: Generated<Date>;
  /** When this registration was last updated */
  updated_at: Generated<Date>;
}

// Convenience types for workflow_registrations
export type WorkflowRegistration = Selectable<WorkflowRegistrationsTable>;
export type NewWorkflowRegistration = Insertable<WorkflowRegistrationsTable>;
export type WorkflowRegistrationUpdate = Updateable<WorkflowRegistrationsTable>;

/**
 * Registry versions table
 * Cluster sync version counter. Incremented on registration changes.
 * Default row with id='default' inserted by migration.
 */
export interface RegistryVersionsTable {
  /** Version identifier (default: 'default') */
  id: Generated<string>;
  /** Monotonically increasing version counter */
  version: Generated<number>;
  /** When the version was last bumped */
  updated_at: Generated<Date>;
}

// Convenience types for registry_versions
export type RegistryVersion = Selectable<RegistryVersionsTable>;
export type RegistryVersionUpdate = Updateable<RegistryVersionsTable>;

/**
 * Cron last-fired table
 * Tracks the last time each cron-triggered workflow registration fired.
 * Used for fire-once-on-recovery after orchestrator restart.
 */
export interface CronLastFiredTable {
  /** References workflow_registrations.id (cascade delete) */
  registration_id: string;
  /** When this cron trigger last fired */
  last_fired_at: Date;
  /** When this record was last updated */
  updated_at: Generated<Date>;
}

// Convenience types for cron_last_fired
export type CronLastFired = Selectable<CronLastFiredTable>;
export type NewCronLastFired = Insertable<CronLastFiredTable>;
export type CronLastFiredUpdate = Updateable<CronLastFiredTable>;

/**
 * Run ephemeral keys table (run_ephemeral_keys)
 * Stores per-run X25519 key pairs for cross-job secret output encryption.
 * Private keys are encrypted with the orchestrator PSK (AES-256-GCM).
 */
export interface RunEphemeralKeysTable {
  /** Run ID (primary key, references execution_runs.run_id) */
  run_id: string;
  /** Base64-encoded AES-256-GCM encrypted private key */
  encrypted_private_key: string;
  /** Base64-encoded DER public key (X25519 SPKI format) */
  public_key: string;
  /** When this key pair was created */
  created_at: Generated<Date>;
}

// Convenience types for run_ephemeral_keys
export type RunEphemeralKey = Selectable<RunEphemeralKeysTable>;
export type NewRunEphemeralKey = Insertable<RunEphemeralKeysTable>;

/**
 * Run secret outputs table (run_secret_outputs)
 * Stores encrypted secret output values produced by jobs for cross-job consumption.
 * Values are encrypted with the run's ephemeral public key via ECDH + AES-256-GCM.
 */
export interface RunSecretOutputsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Run ID (references execution_runs.run_id) */
  run_id: string;
  /** Job ID that produced this output */
  job_id: string;
  /** Output key name */
  output_key: string;
  /** Base64-encoded encrypted value (agent-encrypted ECDH envelope) */
  encrypted_value: string;
  /** When this output was stored */
  created_at: Generated<Date>;
}

// Convenience types for run_secret_outputs
export type RunSecretOutput = Selectable<RunSecretOutputsTable>;
export type NewRunSecretOutput = Insertable<RunSecretOutputsTable>;

/**
 * Concurrency groups table (concurrency_groups)
 * Tracks active and queued runs per concurrency group for slot management.
 * Persists across orchestrator restarts; hydrated into in-memory tracker on startup.
 */
export interface ConcurrencyGroupsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Concurrency group key (e.g. "deploy-main") */
  group_key: string;
  /** Run ID that owns this slot or is queued */
  run_id: string;
  /** Job ID within the run */
  job_id: string;
  /** Routing key for scoping (e.g. "github:42") */
  routing_key: string;
  /** Status: 'active' | 'queued' | 'completed' | 'cancelled' */
  status: Generated<string>;
  /** When this entry was created */
  created_at: Generated<Date>;
  /** When this entry was completed/cancelled */
  completed_at: Date | null;
}

// Convenience types for concurrency_groups
export type ConcurrencyGroup = Selectable<ConcurrencyGroupsTable>;
export type NewConcurrencyGroup = Insertable<ConcurrencyGroupsTable>;
export type ConcurrencyGroupUpdate = Updateable<ConcurrencyGroupsTable>;

/**
 * Sources table
 * Stores webhook source configurations (e.g. GitHub Apps) with routing keys.
 * Secrets (private key, webhook secret) are stored separately in PgSecretStore.
 */
export interface SourcesTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Provider type (e.g. 'github') */
  provider: string;
  /** Human-readable source name */
  name: string;
  /** Routing key (e.g. 'github:12345') */
  routing_key: string;
  /** JSONB config (non-sensitive, e.g. { appId: '12345' }) */
  config: string;
  /** Customer/org identifier for secret and environment scoping */
  customer_id: Generated<string>;
  /** When this source was created */
  created_at: Generated<Date>;
  /** When this source was last updated */
  updated_at: Generated<Date>;
}

// Convenience types for sources
export type Source = Selectable<SourcesTable>;
export type NewSource = Insertable<SourcesTable>;
export type SourceUpdate = Updateable<SourcesTable>;

/**
 * Repo-pattern entry stored inside the three jsonb list columns of
 * `org_settings`. `routingKey` is optional — when undefined the entry
 * applies to any source in the org; when set, it qualifies the entry to
 * one specific webhook source.
 */
export interface OrgSettingsRepoPatternEntry {
  routingKey?: string;
  pattern: string;
}

/**
 * Org settings table (org_settings)
 * Per-org (customer_id) global workflow permissions. Each list column
 * holds a jsonb array of {routingKey?, pattern} entries — entries without
 * a `routingKey` apply to any source in the org, entries with a routing
 * key are scoped to that source only.
 */
export interface OrgSettingsTable {
  /** Customer/org identifier (primary key) */
  customer_id: string;
  /** Whether global workflows are enabled for this org */
  global_workflows_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** Repos allowed to author global workflows (null = any repo can author) */
  global_workflow_allowed_repos: ColumnType<
    OrgSettingsRepoPatternEntry[] | null,
    OrgSettingsRepoPatternEntry[] | null | undefined | string,
    OrgSettingsRepoPatternEntry[] | null | string
  >;
  /** Repos with elevated trust for global workflow execution (null = none) */
  global_workflow_elevated_repos: ColumnType<
    OrgSettingsRepoPatternEntry[] | null,
    OrgSettingsRepoPatternEntry[] | null | undefined | string,
    OrgSettingsRepoPatternEntry[] | null | string
  >;
  /**
   * Repos explicitly denied as event sources for global workflows.
   * Deny takes precedence over the allow-list (null = no deny patterns).
   */
  global_workflow_denied_repos: ColumnType<
    OrgSettingsRepoPatternEntry[] | null,
    OrgSettingsRepoPatternEntry[] | null | undefined | string,
    OrgSettingsRepoPatternEntry[] | null | string
  >;
  /**
   * When true, workflow `registries:` URLs may use plain `http://` to any host.
   * When false (default), only `https://` and loopback / `*.local` `http://`
   * URLs are accepted; arbitrary `http://` registries are rejected at dispatch.
   */
  allow_http_npm_registries: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Per-operation policy controlling which dashboard.* writes the orch
   * accepts when routed through Platform. JSONB shape:
   * `{ [operation]: boolean }` where operation matches the engine enum
   * `DashboardWriteOperation`. Empty object = all enabled (permissive).
   * Resolver in `@kici-dev/engine/protocol/dashboard-write-operations`
   * treats missing keys as `true`.
   */
  dashboard_write_policy: ColumnType<
    Record<string, boolean>,
    Record<string, boolean> | string | undefined,
    Record<string, boolean> | string
  >;
  /**
   * Per-org byte quota for the user-facing cache (UserCache). NULL = use the
   * cluster-wide default (`KICI_USER_CACHE_QUOTA_BYTES`, 5 GiB). Postgres
   * BIGINT — pg returns a string on select; accept a number on insert/update.
   */
  user_cache_quota_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-entry TTL (ms) for the user-facing cache (UserCache). NULL = use the
   * cluster-wide default (`KICI_USER_CACHE_TTL_MS`, 7 days). Postgres BIGINT —
   * pg returns a string on select; accept a number on insert/update.
   */
  user_cache_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-org dispatch-acknowledgment deadline (ms); null = cluster default
   * (config.dispatchAckTimeoutMs / KICI_DISPATCH_ACK_TIMEOUT_MS). Postgres
   * BIGINT — pg returns a string on select; accept a number on insert/update.
   */
  dispatch_ack_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-org expiry (seconds) for a held approval element before it is rejected
   * and its run/job/step fails. NOT NULL, default 86400 (one day). An SDK
   * `requireApproval` `timeout` overrides this per element.
   */
  approval_expiry_seconds: ColumnType<number, number | undefined, number>;
  /**
   * Whether the user who triggered a run may also approve its held elements.
   * NOT NULL, default true. Operators turn it off to enforce four-eyes review.
   */
  allow_self_approval: ColumnType<boolean, boolean | undefined, boolean>;
  /** When this setting was created */
  created_at: Generated<Date>;
  /** When this setting was last updated */
  updated_at: Generated<Date>;
}

// Convenience types for org_settings
export type OrgSettings = Selectable<OrgSettingsTable>;
export type NewOrgSettings = Insertable<OrgSettingsTable>;
export type OrgSettingsUpdate = Updateable<OrgSettingsTable>;

/**
 * Pending job contexts table
 * Persists PendingJobContext for crash-recovery of needs-gated jobs.
 * Keyed by (run_id, job_name) matching the in-memory Map key format.
 * Rows are created at storePendingJobContext time, deleted on consume or run completion.
 */
export interface PendingJobContextsTable {
  /** Run identifier */
  run_id: string;
  /** Job name within the workflow */
  job_name: string;
  /** Full QueuedJobInput serialized as JSONB */
  job_input: ColumnType<Record<string, unknown>, string, string>;
  /** string[] of labels serialized as JSONB */
  runs_on_labels: ColumnType<string[], string, string>;
  /** When this context was stored */
  created_at: Generated<Date>;
}

// Convenience types for pending_job_contexts
export type PendingJobContextRow = Selectable<PendingJobContextsTable>;
export type NewPendingJobContext = Insertable<PendingJobContextsTable>;

/**
 * Pending workflow dispatch contexts table.
 * Persists the serializable WorkflowDispatchContext inputs needed to resume a
 * workflow whose install gate held. One row per held run (keyed by run_id).
 * Created at hold time, deleted once the resume dispatch is kicked off.
 */
export interface PendingWorkflowContextsTable {
  /** Run identifier (one pending dispatch per run) */
  run_id: string;
  /** Organization id */
  org_id: string;
  /** Serializable WorkflowDispatchContext inputs as JSONB */
  context: ColumnType<Record<string, unknown>, string, string>;
  /** When this context was stored */
  created_at: Generated<Date>;
}
export type PendingWorkflowContextRow = Selectable<PendingWorkflowContextsTable>;
export type NewPendingWorkflowContext = Insertable<PendingWorkflowContextsTable>;

/**
 * Inbound webhook delivery event log table.
 * One row per inbound webhook delivery (relay or direct), regardless of
 * outcome. Joins with the Platform-side `event_log` on `(org_id, delivery_id)`.
 *
 * Payload bytes live in object storage (LogStorage) at `payload_key`. When
 * `payload_omitted=true`, the payload was not stored (size cap or upload
 * failure) -- the metadata + hash + size are still durable for correlation.
 *
 * Retention: 30 days, cleaned by queue/cleanup.ts.
 */
export interface EventLogTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Tenant ID (12-char NanoID) */
  org_id: string;
  /** Provider delivery ID (unique within org) */
  delivery_id: string;
  /** Routing key (e.g. "github:42", "generic:<org>:<src>") */
  routing_key: string;
  /** Provider event name (X-GitHub-Event / X-Event-Type / 'default') */
  event: string;
  /** payload.action when present */
  action: string | null;
  /** Where the delivery arrived: 'relay' (Platform WS) or 'direct' (HTTP) */
  source: string;
  /** Provider type ('github' / 'generic' / 'local') */
  provider: string;
  /** owner/repo when extractable */
  repo_identifier: string | null;
  /** Best-effort ref/branch */
  ref: string | null;
  /** Object-storage key under LogStorage. NULL when payload_omitted=true. */
  payload_key: string | null;
  /** True when payload was not stored (size cap or upload failure) */
  payload_omitted: Generated<boolean>;
  /** 'size_exceeded' | 'storage_failed' | NULL */
  payload_omitted_reason: string | null;
  /** Actual body byte size (pre-gzip) */
  payload_size_bytes: number;
  /** SHA-256 of raw body, identical algorithm to Platform event_log.payload_hash */
  payload_hash: string;
  /** Workflows matched by trigger evaluation (0 = no match) */
  matched_count: Generated<number>;
  /** 'received' | 'processed' | 'duplicate' | 'lockfile_missing' | 'failed' */
  status: string;
  /** First run spawned by this delivery (if any) */
  run_id: string | null;
  /** Failure reason when status='failed' */
  error_message: string | null;
  /** When the delivery was received */
  received_at: Generated<Date>;
  /** Phase E cold-store: set inside the archive transaction; NULL for hot rows. */
  archived_at: Date | null;
  /** Phase E cold-store: chunk object key when row is archived. */
  archive_object_key: string | null;
}

// Convenience types for event_log
export type EventLogRow = Selectable<EventLogTable>;
export type NewEventLogRow = Insertable<EventLogTable>;
export type EventLogRowUpdate = Updateable<EventLogTable>;

/**
 * Cold-store chunk counts table (cold_store_chunk_counts).
 * Tracks per-(db, table, tenant) archived-chunk metadata so the
 * `cold_store_chunks_total` gauge and the `kici-admin cold-store list-chunks`
 * CLI can report totals without S3 LIST calls. Phase A creates the table
 * empty; Phase B+ populates it transactionally on each chunk write.
 */
export interface ColdStoreChunkCountsTable {
  /** DbKind identifier ('orchestrator' on this side). */
  db: string;
  /** Source Postgres table name. */
  table_name: string;
  /** org_id for Platform tables, routing_key for Orchestrator tables. */
  tenant_id: string;
  /** Number of chunks written for this (db, table, tenant). */
  chunk_count: Generated<ColumnType<string, string | number, string | number>>;
  /** Total uncompressed bytes archived. */
  total_bytes: Generated<ColumnType<string, string | number, string | number>>;
  /** Total rows archived. */
  total_rows: Generated<ColumnType<string, string | number, string | number>>;
  /** Most recent chunk archive time; null until first chunk lands. */
  last_archived_at: Date | null;
}

// Convenience types for cold_store_chunk_counts
export type ColdStoreChunkCountsRow = Selectable<ColdStoreChunkCountsTable>;
export type NewColdStoreChunkCountsRow = Insertable<ColdStoreChunkCountsTable>;
export type ColdStoreChunkCountsUpdate = Updateable<ColdStoreChunkCountsTable>;

/**
 * Cold-store chunk index (cold_store_chunks). Phase 2.
 *
 * One row per archived chunk that the GC sweep can later purge from S3.
 * Inserted inside `markArchivedAndDelete`'s transaction by adapters that
 * opt into the per-bucket layout via `coldTtlDays(row)`. Pre-Phase-2
 * (v1) chunks are NOT in this table — they're treated as
 * `'forever'` and never purged.
 */
export interface ColdStoreChunksTable {
  /** DbKind identifier ('orchestrator' on this side). */
  db: string;
  /** Source Postgres table name. */
  table_name: string;
  /** org_id for Platform-keyed adapters, routing_key for Orchestrator. */
  tenant_id: string;
  /** Deterministic 16-hex chunk filename stem (matches the S3 object). */
  chunk_id: string;
  /** S3 prefix segment ('30d' / '180d' / '1y' / '2y' / 'forever'). */
  bucket: string;
  /** YYYY-MM-DD partition the chunk's rows came from. */
  partition_date: ColumnType<Date, string, string>;
  /** When the chunk landed in S3 + this row was inserted. */
  archived_at: Generated<Date>;
  /** Compressed size of the data chunk (bytes). */
  gzip_bytes: ColumnType<string, string | number, string | number>;
  /** Number of rows in the chunk. */
  row_count: ColumnType<string, string | number, string | number>;
  /**
   * Row-level cold-retention horizon — TEXT to accommodate both numeric
   * day-counts and the literal `'forever'`. The GC sweep checks
   * `max_cold_days != 'forever' AND now() > archived_at + max_cold_days
   * * INTERVAL '1 day'`.
   */
  max_cold_days: string;
  /** Full S3 key of the data chunk (used by the GC sweep's DeleteObject). */
  object_key: string;
}

// Convenience types for cold_store_chunks
export type ColdStoreChunksRow = Selectable<ColdStoreChunksTable>;
export type NewColdStoreChunksRow = Insertable<ColdStoreChunksTable>;
export type ColdStoreChunksUpdate = Updateable<ColdStoreChunksTable>;

/**
 * Check-run tracking table (check_run_tracking).
 *
 * HA-safe persistence for the per-coord state previously held in
 * `CheckRunReporter`'s six in-memory `Map`s. Replacement coord on a
 * Raft leader switch reads this table to recover check-run IDs, build
 * creation state, step-progress entries, in-progress-sent timestamps, and
 * the run-id reverse index used for cleanup. A coord crash mid-check-run
 * no longer leaves a GitHub check stuck in `queued` forever.
 */
export interface CheckRunTrackingTable {
  /** Provider type (e.g. 'github'). */
  provider: string;
  /** Repo owner / namespace. */
  owner: string;
  /** Repo name. */
  repo: string;
  /** Git commit SHA the check run is anchored to. */
  sha: string;
  /** Check-run name (e.g. 'kici/build', 'kici/build/job/test', 'kici/build/setup'). */
  check_name: string;
  /**
   * GitHub Checks API check-run ID. Populated by `checks.create()`; nullable
   * during the in-flight build-creation window (`build_creation_state =
   * 'pending'` before the create finishes).
   */
  check_run_id: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * Build check-run creation state: 'pending' while a `setBuildPending`
   * create is in flight, 'completed' once `setBuildComplete` has reconciled.
   * Replaces the in-memory `pendingBuildCreations` Promise map.
   */
  build_creation_state: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Step-progress entries as JSONB array. Each entry shape is
   * `{ name: string, status: string, durationMs?: number }`. Replaces the
   * in-memory `stepProgress` map.
   */
  step_progress_json: ColumnType<unknown, string | unknown, string | unknown>;
  /**
   * Timestamp the first in-progress transition was sent to GitHub. NULL
   * before the first running step. Replaces the in-memory `inProgressSent`
   * boolean map (presence-as-truth).
   */
  in_progress_sent_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * KiCI run identifier this check-run belongs to. Indexed (partial, NOT
   * NULL) to power `cleanupRun(runId)` without scanning the table.
   */
  run_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** When this row was first inserted. */
  created_at: Generated<Date>;
  /** When this row was last updated. */
  updated_at: Generated<Date>;
}

// Convenience types for check_run_tracking
export type CheckRunTrackingRow = Selectable<CheckRunTrackingTable>;
export type NewCheckRunTrackingRow = Insertable<CheckRunTrackingTable>;
export type CheckRunTrackingUpdate = Updateable<CheckRunTrackingTable>;

/**
 * Build-provenance attestation table.
 *
 * One row per `ctx.attestProvenance` bundle uploaded to object storage. The
 * dashboard lists/fetches attestations by `(run_id, job_id)`.
 */
export interface AttestationsTable {
  /** Random id (primary key). */
  id: string;
  /** KiCI run this attestation belongs to. */
  run_id: string;
  /** KiCI job this attestation was produced by. */
  job_id: string;
  /** Caller-supplied artifact name (e.g. an npm package coordinate). */
  subject_name: string;
  /** Primary subject digest (lowercase hex) used in the storage key. */
  subject_digest: string;
  /** Object-storage key the bundle was written to. */
  storage_key: string;
  /** Signing mode ('kici' for Mode A). */
  mode: string;
  /** Bundle media type. */
  media_type: string;
  /** When this row was inserted. */
  created_at: Generated<Date>;
}

// Convenience types for attestations
export type AttestationRow = Selectable<AttestationsTable>;
export type NewAttestationRow = Insertable<AttestationsTable>;

/**
 * Remote-source table (remote_sources).
 *
 * Anchors a Platform-relayed `kici run remote` to its real org: routing key
 * `remote:<orgId>` maps to the canonical org id so `resolveOrgId` resolves the
 * real tenant through the same local-source path a webhook takes. One row per
 * org served by this orchestrator, auto-provisioned on Platform auth.
 */
export interface RemoteSourcesTable {
  /** Canonical org id (`org_<…>`) this anchor resolves to. */
  customer_id: string;
  /** Deterministic routing key `remote:<orgId>`. */
  routing_key: string;
  /** Cluster id this orchestrator deployment reports, or null. */
  cluster_id: string | null;
  /** When this row was first provisioned. */
  created_at: Generated<Date>;
  /** When this row was last upserted. */
  updated_at: Generated<Date>;
}

export type RemoteSourceRow = Selectable<RemoteSourcesTable>;
export type NewRemoteSourceRow = Insertable<RemoteSourcesTable>;

/**
 * Host roster table (host_roster).
 *
 * KiCI's declared inventory: one durable row per agent the cluster has ever
 * enrolled, reconciled from the in-memory AgentRegistry on register/unregister.
 * `lifecycle_class` (snapshot of the auth token's `agent_type`) drives reaping;
 * `connected_instance_id` records which orchestrator holds the live WS (cluster
 * liveness + the host-fanout reroute target), null when disconnected. Status is
 * derived at read from the shared `last_seen` + `connected_instance_id`.
 */
export interface HostRosterTable {
  /** UUID primary key */
  id: Generated<string>;
  /** The agent identity the pin targets; unique. */
  agent_id: string;
  /** FK to agent_tokens.id (provenance), or null when auth mode is none. */
  token_id: string | null;
  /** Snapshot of the token's agent_type: 'static' | 'ephemeral'. */
  lifecycle_class: string;
  /** JSON-encoded string[] of the post-Gate-1 validated labels. */
  labels: string;
  hostname: string | null;
  platform: string | null;
  arch: string | null;
  /** Which orchestrator instance holds the live WS; null = disconnected. */
  connected_instance_id: string | null;
  /**
   * Typed host-vars dimension (jsonb). A `{ [key]: string | number | boolean }`
   * bag reported by the agent at registration and/or declared by the operator
   * (`kici-admin host declare --prop`), shallow-merged on upsert. NOT NULL,
   * defaults to `{}`. pg returns the parsed object on select; accept a
   * JSON-stringified value on insert/update.
   */
  host_properties: ColumnType<
    Record<string, string | number | boolean>,
    Record<string, string | number | boolean> | string | undefined,
    Record<string, string | number | boolean> | string
  >;
  last_seen: ColumnType<Date, Date | string | undefined, Date | string>;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}
export type HostRosterRow = Selectable<HostRosterTable>;
export type NewHostRosterRow = Insertable<HostRosterTable>;
export type HostRosterUpdate = Updateable<HostRosterTable>;

/**
 * Scaler spawning-agents table (scaler_spawning_agents).
 *
 * One row per agent that has been spawned via a scaler backend
 * (container / bare-metal / firecracker) but has not yet registered via
 * WS. Persists `bound_job_id` so a replacement coord still issues the
 * eager-dispatch hop when the agent eventually registers. GC'd by a
 * leader-gated sweep that drops rows older than the spawn-timeout.
 */
export interface ScalerSpawningAgentsTable {
  agent_id: string;
  scaler_name: string;
  label_set: ColumnType<string[], string | string[], string | string[]>;
  run_id: ColumnType<string | null, string | null | undefined, string | null>;
  job_id: ColumnType<string | null, string | null | undefined, string | null>;
  bound_job_id: ColumnType<string | null, string | null | undefined, string | null>;
  spawned_at: Generated<Date>;
}

export type ScalerSpawningAgentRow = Selectable<ScalerSpawningAgentsTable>;
export type NewScalerSpawningAgentRow = Insertable<ScalerSpawningAgentsTable>;

/**
 * Scaler agent-jobs table (scaler_agent_jobs).
 *
 * agentId → (runId, jobId) correlation used to route scaler-lifecycle
 * events (spawn / boot / ready / kill) to the execution tracker. Row
 * inserted in `correlateAgentToJob`, deleted on agent disconnect / job
 * completion.
 */
export interface ScalerAgentJobsTable {
  agent_id: string;
  run_id: string;
  job_id: string;
  correlated_at: Generated<Date>;
}

export type ScalerAgentJobRow = Selectable<ScalerAgentJobsTable>;
export type NewScalerAgentJobRow = Insertable<ScalerAgentJobsTable>;

/**
 * Scaler reservations table (scaler_reservations).
 *
 * One row per outstanding resource reservation. `perScalerUsage` /
 * `globalUsage` are derived state — recomputed from `SUM(...)` on coord
 * boot so the cap-check critical section is correct under HA.
 */
export interface ScalerReservationsTable {
  agent_id: string;
  scaler_name: string;
  cpu_units: number;
  mem_bytes: ColumnType<string, string | number, string | number>;
  reserved_at: Generated<Date>;
}

export type ScalerReservationRow = Selectable<ScalerReservationsTable>;
export type NewScalerReservationRow = Insertable<ScalerReservationsTable>;
