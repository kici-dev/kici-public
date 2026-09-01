import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

import type {
  ApprovalRequirement,
  ApproverClause,
  InitFailure,
  StepApprovalPayload,
} from '@kici-dev/engine';

/**
 * Job kind stored in `execution_jobs.job_kind`. `Standard` runs steps on an
 * agent; `Gate` is an invoke gate that summons source-repo runs; `Proxy`
 * mirrors one summoned run's lifecycle. Mirrors the engine wire `JobKind` enum
 * (`@kici-dev/engine`) — keep the two vocabularies in step.
 */
export enum JobKind {
  Standard = 'standard',
  Gate = 'gate',
  Proxy = 'proxy',
}

/**
 * PostgreSQL-only database types.
 * Column names use snake_case matching the actual database column names.
 */
export interface Database {
  dispatch_queue: DispatchQueueTable;
  dedup_cache: DedupCacheTable;
  ingest_overflow_buffer: IngestOverflowBufferTable;
  ip_allocations: IpAllocationTable;
  execution_runs: ExecutionRunTable;
  execution_jobs: ExecutionJobTable;
  execution_steps: ExecutionStepTable;
  raft_state: RaftStateTable;
  secret_audit_log: SecretAuditLogTable;
  contexts: ContextsTable;
  scoped_secrets: ScopedSecretsTable;
  context_bindings: ContextBindingsTable;
  context_variables: ContextVariablesTable;
  context_source_overrides: ContextSourceOverridesTable;
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
  org_trust_policy: OrgTrustPolicyTable;
  org_trust_directory: OrgTrustDirectoryTable;
  org_plan_headroom: OrgPlanHeadroomTable;
  cluster_settings: ClusterSettingsTable;
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
  scaler_pending_claims: ScalerPendingClaimsTable;
  scaler_provision_outcomes: ScalerProvisionOutcomesTable;
  attestations: AttestationsTable;
  orchestrator_signing_keys: OrchestratorSigningKeysTable;
  dashboard_encryption_keys: DashboardEncryptionKeysTable;
  pending_attestations: PendingAttestationsTable;
  artifacts: ArtifactsTable;
  remote_sources: RemoteSourcesTable;
  host_roster: HostRosterTable;
  request_idempotency: RequestIdempotencyTable;
  batch_accumulation_windows: BatchAccumulationWindowsTable;
  batch_accumulation_items: BatchAccumulationItemsTable;
  backup_runs: BackupRunsTable;
}

/**
 * Open accumulation window for a `workflowsFailedBatch` registration.
 * One live window per subscribing workflow (`registration_id` is unique);
 * the first matching failure opens it and the leader sweep closes it once
 * `expires_at` passes, emitting a single `__workflows_failed_batch` event.
 */
export interface BatchAccumulationWindowsTable {
  /** Window id (primary key). */
  id: string;
  /** Owning customer/org id. */
  customer_id: string;
  /** Subscribing registration id (unique — open-once). */
  registration_id: string;
  /** Routing key captured at open time so the sweep can emit without the index. */
  routing_key: string;
  /** Repo identifier captured at open time. */
  repo_identifier: string;
  /** Accumulation window length in milliseconds. */
  accumulate_for_ms: number;
  /** When the window opened (first failure). */
  opened_at: Generated<Date>;
  /** When the window is due for the leader sweep. */
  expires_at: Date;
}

// Convenience types for batch_accumulation_windows
export type BatchAccumulationWindow = Selectable<BatchAccumulationWindowsTable>;
export type NewBatchAccumulationWindow = Insertable<BatchAccumulationWindowsTable>;

/**
 * A single failed run buffered into a batch-accumulation window.
 * Deleted with its window via `ON DELETE CASCADE` when the window is swept.
 */
export interface BatchAccumulationItemsTable {
  /** Item id (primary key). */
  id: string;
  /** Owning window id (FK, cascade-deleted). */
  window_id: string;
  /** The failed run's id. */
  run_id: string;
  /** Repo identifier of the failed run. */
  repo_identifier: string;
  /** Workflow name of the failed run. */
  workflow_name: string;
  /** Failure class (`RunFailureClass`) when known. */
  failure_class: string | null;
  /** Triggering actor username when known. */
  sender_username: string | null;
  /** When the item was buffered. */
  created_at: Generated<Date>;
}

// Convenience types for batch_accumulation_items
export type BatchAccumulationItem = Selectable<BatchAccumulationItemsTable>;
export type NewBatchAccumulationItem = Insertable<BatchAccumulationItemsTable>;

/**
 * Request idempotency claim table.
 * Keyed on the Platform `requestId`; makes run-minting dashboard requests
 * (`run.rerun.request`, `run.manual_schedule.request`) idempotent across an HA
 * relay failover so a re-sent request returns the first coordinator's
 * `new_run_id` instead of creating a second run. Pruned after 1h.
 */
export interface RequestIdempotencyTable {
  /** Platform-minted requestId for the run-minting request (primary key / idempotency key). */
  request_id: string;
  /** The run id the winning coordinator created for this requestId. */
  new_run_id: string;
  /** When the claim was recorded. */
  created_at: Generated<Date>;
}

// Convenience types for request_idempotency
export type RequestIdempotency = Selectable<RequestIdempotencyTable>;
export type NewRequestIdempotency = Insertable<RequestIdempotencyTable>;
export type RequestIdempotencyUpdate = Updateable<RequestIdempotencyTable>;

/**
 * Backup run log. One row per successful `kici-admin db backup`. Read by the
 * `checkBackupFreshness` diagnostic (`MAX(created_at)`).
 */
export interface BackupRunsTable {
  id: Generated<string>;
  created_at: Generated<Date>;
  /** Local path the dump was written to (informational). */
  dump_path: string;
  /** Size of the dump file in bytes. */
  byte_size: string | bigint;
  /** Secret-key generation the DB's encrypted config was under (null when no encrypted config). */
  secret_key_version: number | null;
  /** Server version string the dump was taken from (e.g. "160003"). */
  pg_server_version: string;
  /** Bundled-migrations content hash at backup time. */
  migrations_hash: string;
  /** Host that ran the backup. */
  hostname: string;
}

// Convenience types for backup_runs
export type BackupRun = Selectable<BackupRunsTable>;
export type NewBackupRun = Insertable<BackupRunsTable>;

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
  /**
   * When this job first read unroutable — no registered agent and no scaler
   * backend matched its selectors. NULL once it reads routable again, so the
   * grace clock only ever measures a CONTINUOUS unroutable window. Persisted
   * rather than in-memory so a restart mid-grace resumes the same clock.
   */
  unroutable_since: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
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
  /**
   * Durable owner of a dispatched job: the agent the job was handed to. Written
   * at dispatch, cleared on requeue. Distinct from `ack_agent_id`, which is
   * cleared as soon as the agent answers the dispatch and so cannot resolve
   * ownership later — this column lets a coordinator that never saw the
   * dispatch answer "does this agent own this job?" from the database alone.
   * NULL for pending rows and for rows dispatched before the column existed.
   */
  agent_id: ColumnType<string | null, string | null | undefined, string | null>;
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

/**
 * Durable overflow buffer for shed webhook-ingest deliveries (migration 075).
 * `status` values come from OverflowStatus, `source_kind` from OverflowSourceKind
 * (packages/orchestrator/src/webhook/ingest-overflow-types.ts). `body` is base64.
 */
export interface IngestOverflowBufferTable {
  /** Surrogate PK (bigint identity). */
  id: Generated<number>;
  /** Delivery id — the dedup key. */
  delivery_id: string;
  /** Routing key (e.g. "github:42"). */
  routing_key: string;
  /** Ingest boundary: 'direct' (HTTP, verified) | 'relay' (WS, unverified). */
  source_kind: string;
  /** Provider type; null for relay (resolved at replay). */
  provider: string | null;
  /** Provider event type. */
  event: string;
  /** Payload action, or null. */
  action: string | null;
  /** Base64 of the raw delivery bytes. */
  body: string;
  /** Verify-input envelope (relay) or {} (direct). */
  meta: Generated<Record<string, unknown>>;
  /** Capture timestamp (defaults to now()). */
  captured_at: Generated<Date>;
  /** Replay attempt counter. */
  replay_attempts: Generated<number>;
  /** OverflowStatus value. */
  status: Generated<string>;
  /** Last replay error, or null. */
  last_error: string | null;
  /**
   * When the row moved `buffered` → `replaying`; null while it is buffered.
   * Separate from `captured_at` (which orders the FIFO drain) so a long-buffered
   * row is not reclaimed the instant a worker picks it up.
   */
  claimed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
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
  /**
   * Owning org (customer_id), denormalized from routing_key at insert time so
   * the concurrency-gate running count can be scoped per tenant. Defaults to
   * '__default__' (the no-source fallback org) via the column DEFAULT.
   */
  customer_id: Generated<string>;
  /** Workflow name from lock file */
  workflow_name: string;
  /** Run status: running | success | failed | cancelled */
  status: Generated<string>;
  /** Provider type (e.g. "github", "gitlab") */
  provider: string;
  /** Repository identifier (e.g. "owner/repo") */
  repo_identifier: string;
  /**
   * The branch (or tag) the run PRESENTS — `event.targetBranch`: the branch a
   * push landed on, the base branch of a pull request, the default branch a
   * schedule fire executes, the branch an internal trigger inherited.
   *
   * It is NOT a job's checkout ref. A pull-request job checks out the PR HEAD
   * branch, and every `QueuedJobInput.ref` carries that value instead — the two
   * are different facts and only one of them belongs here. The distinction is
   * load-bearing: this column is what an internally-triggered run inherits as
   * its branch claim before the context branch gate matches it against a
   * context's `branchRestrictions`, and a fork contributor names the head
   * branch freely. Every writer that CREATES the row uses the presented branch.
   * The two reroute projections (`cluster/coordinator.ts`, `worker-core.ts`)
   * are the exception: they insert from a `job.reroute` message, which carries
   * only the job's ref. Their row is fail-safe by conflicting — the run is
   * registered before the first job is handed to an agent
   * (`startRunBeforeDispatch`), so a reroute is only possible once the
   * authoritative row exists, and their insert is
   * `ON CONFLICT (run_id) DO NOTHING`.
   */
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
  /** True when the run executed an uploaded local working tree (`kici run remote`). */
  local_working_tree: Generated<boolean>;
  /** Fixture ID for test runs (null for real webhook runs) */
  fixture_id: string | null;
  /** Parent run ID for re-run lineage (null for original runs). */
  parent_run_id: string | null;
  /** Root ancestor run ID for re-run lineage (null for original runs). Always points to the first run in the chain. */
  original_run_id: string | null;
  /** User identity that triggered this re-run (null for webhook-triggered). Format: "user:email" or "key:name". */
  triggered_by: string | null;
  /** Agent provenance label when the run was triggered through an agent credential (null otherwise). */
  triggered_by_agent_label: string | null;
  /** User identity that cancelled this run (null for non-cancelled). */
  cancelled_by: string | null;
  /** Agent provenance label when the run was cancelled through an agent credential (null otherwise). */
  cancelled_by_agent_label: string | null;
  /** Context name for this run (null if no context applies) */
  context: string | null;
  /** Matched context id for this run (null if no/unresolved context). */
  context_id: string | null;
  /** Trust tier of the contributor for PR runs (null for non-PR events) */
  trust_tier: string | null;
  /** Lock file source: 'head' or 'base' (null for non-PR events) */
  lock_file_source: string | null;
  /** Username of the contributor (null for non-PR events) */
  contributor_username: string | null;
  /** Pull-request number for PR-triggered runs (null for non-PR events). Scopes `/kici approve|reject` hold selection to the comment's PR. */
  pr_number: number | null;
  /**
   * Origin provider of the triggering actor (`github` today). Provider-generic
   * so GitLab/Bitbucket extend later. Null when no actor was captured.
   */
  trigger_actor_provider: string | null;
  /**
   * Provider login of the person who triggered the run (pusher / PR author).
   * Captured for ALL event types, unlike the PR-only `contributor_username`.
   */
  trigger_actor_username: string | null;
  /**
   * Immutable provider user id of the triggering actor (mirrors
   * `identity_links.provider_user_id`). Preferred over the mutable username
   * when resolving the actor to a KiCI user.
   */
  trigger_actor_user_id: string | null;
  /**
   * The repository that DEFINES this run's workflow, when that is not the
   * repository the run acted on.
   *
   * `repo_identifier` is the repository the run acted on and whose code its
   * jobs check out. For an organization-wide workflow dispatched against
   * another repository, the workflow was authored somewhere else, and that
   * authoring repository is recorded here. NULL means the two are the same —
   * true of every per-repository run.
   *
   * Read by the rerun path, which must resolve the workflow from the
   * repository that defines it rather than from the one it ran against.
   */
  workflow_repo_identifier: string | null;
  /**
   * True when this row records a global evaluation round rather than a
   * workflow.
   *
   * A round decides which organization-wide workflows apply to an event; a
   * round that fails is recorded as one errored run so the suppression is
   * visible. Re-running such a run re-executes the evaluation, not a workflow,
   * so the re-run path branches on this column. It is structural on purpose:
   * the round job's `__globaleval__` name prefix is a string a customer
   * workflow may also carry, and a name a customer chooses must not decide
   * which code path a re-run takes.
   */
  is_global_eval_round: Generated<boolean>;
  /**
   * The source whose credentials `provider_context` holds, when that is not the
   * source the event arrived on.
   *
   * `routing_key` records the INBOUND source. For a cross-provider global
   * workflow the lock file resolves through another source's bundle, and the
   * context is written from that source's credentials — so anything pairing
   * `routing_key` with `provider_context` hands one source's credentials to
   * another source's API client. NULL means the two are the same, which is true
   * of every ordinary run.
   *
   * Read by the rerun path of a failed evaluation round, which re-drives the
   * organization-wide pass and has to hand it the same dispatch pair the
   * delivery used.
   */
  dispatch_routing_key: string | null;
  /** Human-readable reason why the run failed (null for non-failed runs). */
  failure_reason: string | null;
  /**
   * Why the run failed (`RunFailureClass` from `@kici-dev/engine`): never_started
   * / timed_out / dead_orchestrator / step_failure / cancelled. Derived at run
   * completion from the terminal job statuses. NULL for success / not-yet-terminal.
   */
  failure_class: string | null;
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
  /**
   * For a run summoned by an invoke gate, the summoning (global) run's id. NULL
   * for every run not summoned by a gate.
   */
  summoned_by_run_id: string | null;
  /**
   * For a summoned run, the proxy job name in the summoning run to update when
   * this run completes. NULL for every run not summoned by a gate.
   */
  summoned_by_proxy_job: string | null;
  /**
   * How deep this run sits in an invoke chain. A webhook-triggered run is depth
   * 0; a run summoned by an invoke gate carries its summoner's depth + 1. Read
   * back when this run fires its own invoke gate so the chain-depth circuit
   * breaker bounds recursion. Defaults to 0.
   */
  chain_depth: Generated<number>;
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
  /**
   * Operator-facing reason this job cannot currently be routed to any agent.
   * Written by the unroutable probe while the job is still queued, so the cause
   * is visible long before the job terminalizes; cleared when a matching agent
   * or scaler backend appears. NULL whenever the job is routable.
   */
  routing_reason: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Matrix values JSON (e.g. {"node": "18"}). JSONB: the driver returns a parsed
   * object on SELECT, while writers pass a `JSON.stringify` string.
   */
  matrix_values: ColumnType<Record<string, unknown> | null, string | null, string | null>;
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
  /**
   * Labels used for agent routing (e.g. ["kici:os:linux", "kici:arch:x64"]). JSONB:
   * the driver returns a parsed array on SELECT, while writers pass a
   * `JSON.stringify` string. Re-parsing it as a string yields null for every job.
   */
  runs_on_labels: ColumnType<string[] | null, string | null, string | null>;
  /** Last heartbeat received from agent (for stale run detection) */
  last_heartbeat_at: Date | null;
  /** JSON array of secret context names dispatched with this job */
  dispatched_contexts: Generated<string>;
  /** Aggregated step outputs JSONB (step-keyed map of outputs). Populated on job success. */
  outputs: string | null;
  /**
   * Ordered bound deployment-context names for this job, JSON-encoded
   * `string[]` (null when the job binds none). Written at dispatch and
   * overwritten with the agent-resolved list for dynamic contexts.
   */
  contexts: string | null;
  /**
   * Bound contexts skipped on a test/local run (non-test or unconfigured),
   * JSON-encoded `string[]`. NULL = nothing skipped.
   */
  skipped_contexts: string | null;
  /** User-visible warning naming the skipped test-run contexts. NULL = none. */
  env_warning: string | null;
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
  /**
   * Job kind (`JobKind`): `standard` runs steps on an agent, `gate` is an
   * invoke gate, `proxy` mirrors a summoned run. Defaults to `standard`.
   */
  job_kind: Generated<string>;
  /** For a `proxy` job, the summoned run it mirrors. NULL for every other kind. */
  summoned_run_id: string | null;
  /**
   * For a `gate` job, its own wall-clock timeout in milliseconds (copied from the
   * lock job). A gate runs no steps on an agent, so the agent-side job timeout
   * cannot fire for it; the orchestrator sweeps this column and fails a gate whose
   * proxies have not all terminalized in time. NULL = no gate timeout.
   */
  timeout_ms: number | null;
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
  /**
   * Parallel step-group concurrency role (`sequential` | `parallel-child` |
   * `parallel-group`). NULL for an ordinary sequential step.
   */
  concurrency_kind: string | null;
  /** Parallel-group correlation id shared by a group's children. NULL for sequential steps. */
  group_id: string | null;
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
  /**
   * Per-edge run-on status-set: a JSON-encoded array of upstream terminal
   * statuses (ExecutionJobStatus[]) that satisfy the edge. Default
   * `'["success"]'`. The downstream dispatches when the upstream's terminal
   * status is a member of this set.
   */
  run_on: Generated<string>;
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
 * Contexts table
 * Named deployment contexts with concurrency, branch restrictions, and approval rules.
 * Scoped to an organization.
 */
export interface ContextsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Organization ID */
  org_id: string;
  /** Context name (unique within org) */
  name: string;
  /** Context type: 'fixed' | 'dynamic' */
  type: Generated<string>;
  /** Glob pattern for dynamic contexts (null for fixed) */
  glob_pattern: string | null;
  /** JSONB array of branch restriction patterns */
  branch_restrictions: Generated<string>;
  /** JSONB array of trigger type filters */
  trigger_type_filters: Generated<string>;
  /** JSONB array of repo patterns */
  repo_patterns: Generated<string>;
  /** Max concurrent runs (null = unlimited) */
  concurrency_limit: number | null;
  /**
   * Strategy when concurrency exceeded; see `ConcurrencyStrategy` in
   * `@kici-dev/engine` for the vocabulary. Stays a plain `string` so a row
   * written by another orchestrator version always maps (null = unset).
   */
  concurrency_strategy: Generated<string | null>;
  /** Timeout for queued runs in milliseconds */
  concurrency_timeout_ms: Generated<number>;
  /** JSONB array of required reviewer identities (null = no approval required) */
  required_reviewers: string | null;
  /** Seconds to wait before deploying (null = no wait timer) */
  wait_timer_seconds: number | null;
  /** Seconds before a held run expires (null = unset, the default window applies) */
  hold_expiry_seconds: Generated<number | null>;
  /** Minimum trust tier required for CI execution (null = no trust requirement) */
  minimum_trust: string | null;
  /** Whether this context allows local (no-remote) executions. Default false. */
  allow_local_execution: Generated<boolean>;
  /** Whether this context is active */
  enabled: Generated<boolean>;
  /** When this context was created */
  created_at: Generated<Date>;
  /** When this context was last updated */
  updated_at: Generated<Date>;
  /** Who created this context */
  created_by: string | null;
}

// Convenience types for contexts
export type Context = Selectable<ContextsTable>;
export type NewContext = Insertable<ContextsTable>;
export type ContextUpdate = Updateable<ContextsTable>;

/**
 * Scoped secrets table
 * Encrypted key-value pairs scoped to org + scope (e.g. context name, repo pattern).
 */
export interface ScopedSecretsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Organization ID */
  org_id: string;
  /** Scope identifier (e.g. context name, repo pattern) */
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
 * Context bindings table
 * Links contexts to scope patterns (e.g. workflow names, repo identifiers).
 */
export interface ContextBindingsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Organization ID */
  org_id: string;
  /** Context ID (FK to contexts.id, cascade delete) */
  context_id: string;
  /** Scope pattern for matching (e.g. workflow name glob, repo pattern) */
  scope_pattern: string;
  /**
   * Host selector this binding applies to (exact / glob / regex over a fan-out
   * child's agentId / hostname / labels). `'**'` (the default) matches every
   * host.
   */
  host_pattern: Generated<string>;
  /** When this binding was created */
  created_at: Generated<Date>;
}

// Convenience types for context_bindings
export type ContextBinding = Selectable<ContextBindingsTable>;
export type NewContextBinding = Insertable<ContextBindingsTable>;

/**
 * Context variables table
 * Non-secret key-value pairs attached to a context.
 */
export interface ContextVariablesTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Organization ID */
  org_id: string;
  /** Context ID (FK to contexts.id, cascade delete) */
  context_id: string;
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

// Convenience types for context_variables
export type ContextVariable = Selectable<ContextVariablesTable>;
export type NewContextVariable = Insertable<ContextVariablesTable>;
export type ContextVariableUpdate = Updateable<ContextVariablesTable>;

/**
 * Context source overrides table
 * Per-source (routing key) variable overrides within a context.
 */
export interface ContextSourceOverridesTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Organization ID */
  org_id: string;
  /** Context ID (FK to contexts.id, cascade delete) */
  context_id: string;
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

// Convenience types for context_source_overrides
export type ContextSourceOverride = Selectable<ContextSourceOverridesTable>;
export type NewContextSourceOverride = Insertable<ContextSourceOverridesTable>;
export type ContextSourceOverrideUpdate = Updateable<ContextSourceOverridesTable>;

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
  /** Context ID (FK to contexts.id); null once the context is deleted */
  context_id: string | null;
  /**
   * Hold type — an engine `HoldType` member ('reviewer' | 'timer' |
   * 'concurrency' | 'security'). Stays `string` so a row written by a
   * different orchestrator version is never rejected; read it through
   * `normalizePersistedHoldType`.
   */
  hold_type: string;
  /** Hold status: 'pending' | 'approved' | 'rejected' | 'expired' | 'released' */
  status: Generated<string>;
  /** Queue type: 'context' | 'security' */
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
   * Existing context holds are job-scoped, hence the 'job' default.
   */
  hold_scope: Generated<string>;
  /** Step index within the job for step-scoped holds; null otherwise. */
  step_index: number | null;
  /**
   * What created the hold: 'context' (mandatory env policy) | 'explicit'
   * (SDK `approval`). Engine `TriggerSource`.
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
  /**
   * Drift payload `{ summaryMarkdown, drift }` captured when a `when: 'drift'`
   * step-approval gate fires. Null for every non-drift hold.
   */
  payload: ColumnType<
    StepApprovalPayload | null,
    StepApprovalPayload | string | null | undefined,
    StepApprovalPayload | string | null
  >;
  /**
   * Whether this hold's pending `KiCI Security` check actually reached the
   * provider. `true` after a post returned; `false` when none was attempted or
   * one failed; `null` on a row written before the column existed, for which
   * the hold's shape is still the only available answer.
   *
   * Read through `postedPendingSecurityCheck`. It decides whether a hold has a
   * check to terminalize — and terminalizing one it never posted CREATES a
   * `KiCI Security` run on a commit that had none.
   */
  posted_pending_check: Generated<boolean | null>;
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
  /**
   * Human-set agent name, when the actor authenticated with an agent-kind PAT.
   * NULL for ordinary human / API-key / system actors. Queryable so the access
   * log can be filtered by agent.
   */
  agent_label: string | null;
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
  /**
   * JSON-encoded string[] of mandatory labels (a Kubernetes-taint-style gate):
   * a static agent registering with this token only accepts a job when every
   * label here appears in the job's required labels. null = no taint (the
   * default; the agent accepts any job its advertised labels match).
   * Authorized at mint time alongside `labels`.
   */
  mandatory_labels: string | null;
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
  /**
   * Single-use marker for bootstrap (init-runner) tokens. Set the first time
   * the token is consumed at `agent.register`; a second register is rejected.
   * NULL = never consumed (every static / ephemeral token stays reusable until
   * expiry).
   */
  consumed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
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
  /**
   * The repository's default branch, captured from the push that last updated
   * this registration. A `__schedule_fire` run executes this branch's lock
   * file, so this IS that run's branch when a context evaluates branch
   * restrictions.
   *
   * NULL when the registration predates migration 123, or when the webhook
   * payload named no default branch. There is no backfill: the value is only
   * knowable from a payload, so a NULL row heals on its repo's next
   * default-branch push. NULL presents no branch, which keeps the honest
   * branch-gate rejection rather than inventing a branch.
   */
  default_branch: ColumnType<string | null, string | null | undefined, string | null>;
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
  /** Per-schedule identity: `${cronExpression}\n${timezone}` (see scheduleTriggerKey) */
  schedule_key: string;
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
  /**
   * GitHub App slug (the URL-safe identifier GitHub assigns, e.g.
   * `my-kici-app`). NULL until the GitHub identity fetch populates it. GitHub
   * is the source of truth for both `name` and `slug` on GitHub-App sources.
   */
  slug: string | null;
  /** Customer/org identifier for secret and context scoping */
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
   * May an UNTRUSTED ref build its job's container image from a Dockerfile?
   *
   * Default false. The build runs outside the job's hardened sandbox, so this
   * is an opt-in, never inherited.
   */
  allow_untrusted_dockerfile_builds: ColumnType<boolean, boolean | undefined, boolean>;
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
   * Per-org byte quota for user-facing artifacts (ArtifactStore). NULL = use the
   * cluster-wide default (`KICI_ARTIFACT_QUOTA_BYTES`, 20 GiB). Postgres BIGINT —
   * pg returns a string on select; accept a number on insert/update.
   */
  artifact_quota_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-artifact TTL (ms) for user-facing artifacts (ArtifactStore). NULL = use
   * the cluster-wide default (`KICI_ARTIFACT_TTL_MS`, 30 days). Postgres BIGINT —
   * pg returns a string on select; accept a number on insert/update.
   */
  artifact_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-org per-artifact size cap (bytes) for user-facing artifacts
   * (ArtifactStore). NULL = use the cluster-wide default
   * (`KICI_ARTIFACT_MAX_BYTES`, 1 GiB). Postgres BIGINT — pg returns a string on
   * select; accept a number on insert/update.
   */
  artifact_max_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-org per-run artifact count cap for user-facing artifacts
   * (ArtifactStore). NULL = use the cluster-wide default
   * (`KICI_ARTIFACT_MAX_PER_RUN`, 50). Postgres BIGINT — pg returns a string on
   * select; accept a number on insert/update.
   */
  artifact_max_per_run: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-org dispatch-acknowledgment deadline (ms); null = cluster default
   * (config.dispatchAckTimeoutMs / KICI_DISPATCH_ACK_TIMEOUT_MS). Postgres
   * BIGINT — pg returns a string on select; accept a number on insert/update.
   */
  dispatch_ack_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-org webhook-ingest concurrency cap; null = cluster default
   * (config.ingestOrgMaxConcurrency / KICI_INGEST_ORG_MAX_CONCURRENCY). Postgres
   * BIGINT — pg returns a string on select; accept a number on insert/update.
   */
  ingest_max_concurrency: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-org scaler spawn deadline (ms) for a single `backend.spawn` (image pull
   * + container create + start); null = cluster default
   * (config.scalerSpawnTimeoutMs / KICI_SCALER_SPAWN_TIMEOUT_MS). Postgres
   * BIGINT — pg returns a string on select; accept a number on insert/update.
   */
  scaler_spawn_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-org reroute spawn window (ms): how long the coordinator waits after a
   * peer ACKs a reroute before treating "accepted but no progress" as a spawn
   * failure and re-dispatching. Null = cluster default (config.rerouteSpawnWindowMs).
   * BIGINT — pg returns a string on select; accept a number on insert/update.
   */
  reroute_spawn_window_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-org reroute ACK timeout (ms) for the reroute sendAndWaitAck deadline.
   * Null = cluster default (config.rerouteAckTimeoutMs). BIGINT.
   */
  reroute_ack_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Per-org maximum peer hops for a rerouted job. Null = cluster default
   * (config.rerouteMaxHops). Plain INTEGER — pg returns a number on select.
   */
  reroute_max_hops: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * Per-org staleness threshold (hours) for the DB-backup freshness diagnostic.
   * Null = cluster default (config.backupStalenessWarnHours). Plain INTEGER.
   */
  backup_staleness_warn_hours: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * Per-org dispatch-queue job timeout (ms). A queued job's deadline is
   * `job.timeoutMs ?? <this> ?? config.queueTimeoutMs`. Null = cluster default
   * (config.queueTimeoutMs / KICI_QUEUE_TIMEOUT_MS). Postgres BIGINT — pg
   * returns a string on select; accept a number on insert/update.
   */
  queue_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
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
  /**
   * Container-sandbox escape-hatch allow-list: the Linux capabilities a workflow
   * may request via the SDK `sandbox: { capabilities }` field. NULL / absent
   * reads as `[]` (deny every capability request). Postgres TEXT[].
   */
  sandbox_allowed_capabilities: ColumnType<
    string[] | null,
    string[] | null | undefined,
    string[] | null
  >;
  /**
   * Container-sandbox escape-hatch allow-list: whether a workflow may request
   * `sandbox: { network: 'host' }`. NULL / absent reads as `false` (deny host
   * networking). Postgres BOOLEAN.
   */
  sandbox_allow_host_network: ColumnType<
    boolean | null,
    boolean | null | undefined,
    boolean | null
  >;
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
 * Org trust policy (org_trust_policy) — the orchestrator's cache of the
 * Platform-owned per-org trust policy delivered on `trust_policy.update`.
 * Distinct from `org_settings`, which holds operator-owned config: the operator
 * tunes org_settings, the Platform owns this. `source` records which of the two
 * wrote the row.
 *
 * The three policy columns are plain `string`, not the Zod enums that name the
 * known vocabulary — same reasoning as `held_runs.hold_type`: a value written by
 * a newer Platform must still be readable rather than failing the row.
 */
export interface OrgTrustPolicyTable {
  /** Customer/org identifier (primary key) */
  customer_id: string;
  /** How to treat a pull request opened from a fork: hold | reject | allow */
  fork_policy: string;
  /** How to treat a PR from a contributor with no resolved identity: hold | reject */
  unknown_contributor_policy: string;
  /** How to treat a PR that modifies workflow files: hold | reject | allow */
  workflow_change_policy: string;
  /**
   * The coarse, hours-granularity view of the security-hold window.
   *
   * Retained and always written, because it is the only window an older peer or
   * CLI can read. This build derives it from `approval_expiry_seconds` on every
   * write (rounded up, never below 1), so the two columns cannot disagree.
   */
  approval_expiry_hours: number;
  /**
   * How long a security hold stays approvable before it expires, in seconds —
   * the authoritative window, and the only granularity that can express a
   * sub-hour hold.
   *
   * Nullable: NULL means no seconds value was ever written (a row predating the
   * column, or one written by an older build), and every reader falls back to
   * `approval_expiry_hours * 3600`. Same convention as
   * `contexts.hold_expiry_seconds`.
   */
  approval_expiry_seconds: ColumnType<number | null, number | null | undefined, number | null>;
  /** Which side last wrote this row: platform | local */
  source: string;
  /** When this policy was last written */
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

// Convenience types for org_trust_policy
export type OrgTrustPolicy = Selectable<OrgTrustPolicyTable>;
export type NewOrgTrustPolicy = Insertable<OrgTrustPolicyTable>;
export type OrgTrustPolicyUpdate = Updateable<OrgTrustPolicyTable>;

/**
 * Org trust directory (org_trust_directory) — the approval directory
 * `/kici approve` resolves a commenter against: identity links, per-member CI
 * trust levels, and team memberships. Sibling of `org_trust_policy`, same
 * ownership shape: wherever a Platform is attached it pushes this next to the
 * policy on `trust_policy.update` and the orchestrator only reads it back, so
 * approvals survive a restart. On an independent orchestrator there is no
 * Platform, so the operator writes it through
 * `kici-admin trust-policy directory-set` instead.
 *
 * The three JSONB columns are `unknown` on the select side because the pg
 * driver hands back whatever JSON the column holds; `TrustDirectoryStore`
 * validates each one against the wire schema before returning it. Inserts are
 * `JSON.stringify`d strings, matching every other JSONB column here.
 */
export interface OrgTrustDirectoryTable {
  /** Customer/org identifier (primary key) */
  customer_id: string;
  /** JSONB array of `{ userId, provider, providerUsername, providerUserId? }` links */
  identity_links: ColumnType<unknown, string, string>;
  /** JSONB object mapping a KiCI user id to its `none | read | write | admin` CI trust level */
  member_ci_trust: ColumnType<unknown, string, string>;
  /** JSONB array of `{ teamName, memberUserIds }` entries */
  team_memberships: ColumnType<unknown, string, string>;
  /** When this directory was last written */
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

// Convenience types for org_trust_directory
export type OrgTrustDirectory = Selectable<OrgTrustDirectoryTable>;
export type NewOrgTrustDirectory = Insertable<OrgTrustDirectoryTable>;
export type OrgTrustDirectoryUpdate = Updateable<OrgTrustDirectoryTable>;

/**
 * Org plan headroom (org_plan_headroom) — the orchestrator's cache of the
 * Platform-owned worker ceiling pushed on `plan.headroom`. Single row
 * (id='default'), because the orchestrator serves exactly one org. Same
 * ownership shape as org_trust_policy: the Platform writes it, the orchestrator
 * only reads it back, so it survives a Platform outage + a coordinator restart.
 */
export interface OrgPlanHeadroomTable {
  /** Single-row sentinel id, always 'default'. */
  id: string;
  /** Absolute ceiling on this coordinator's connected worker peers. */
  max_worker_peers: number;
  /** The org's combined orchestrator limit, for the rejection reason. */
  org_limit: number;
  /** The org's combined orchestrator total at push time, for the rejection reason. */
  org_total: number;
  /** Whether the Platform asked the coordinator to drain its excess workers. */
  evict_excess: boolean;
  /** When this ceiling was last written. */
  updated_at: ColumnType<Date, Date, Date>;
}

/**
 * Cluster-global settings (cluster_settings) — a single row (id='default') of
 * fleet-wide operator tunables. Each knob is nullable; NULL = use the cluster
 * default from config.ts. Read via ClusterSettingsReader. Distinct from
 * org_settings (per customer_id) — these knobs have no per-tenant meaning.
 * Byte-valued knobs are Postgres BIGINT (pg returns a string on select); count
 * / seconds knobs are INTEGER (pg returns a number).
 */
export interface ClusterSettingsTable {
  id: ColumnType<string, string | undefined, never>;
  max_github_payload_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  event_log_max_payload_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  lock_file_max_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  webhook_dedup_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  contributor_cache_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  event_router_event_ttl_seconds: ColumnType<
    number | null,
    number | null | undefined,
    number | null
  >;
  event_router_max_dispatch_attempts: ColumnType<
    number | null,
    number | null | undefined,
    number | null
  >;
  queue_max_depth: ColumnType<number | null, number | null | undefined, number | null>;
  reroute_flap_grace_ms: ColumnType<string | null, number | null | undefined, number | null>;
  max_fanout_hosts: ColumnType<number | null, number | null | undefined, number | null>;
  event_router_rate_limit_per_workflow_per_minute: ColumnType<
    number | null,
    number | null | undefined,
    number | null
  >;
  cache_max_tarball_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  cache_ttl_days: ColumnType<number | null, number | null | undefined, number | null>;
  /** LRU entry ceiling for the lock-file cache. NULL ⇒ the configured default. Applies at next restart. */
  lockfile_cache_max: ColumnType<string | null, number | null | undefined, number | null>;
  /** Byte ceiling for the lock-file cache. NULL ⇒ the configured default. Applies at next restart. */
  lockfile_cache_max_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  /** Entry TTL (ms) for the lock-file cache. NULL ⇒ the configured default. Applies at next restart. */
  lockfile_cache_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /** LRU entry ceiling for the Tier-1 content cache. NULL ⇒ the configured default. Applies at next restart. */
  content_cache_max: ColumnType<string | null, number | null | undefined, number | null>;
  /** Byte ceiling for the Tier-1 content cache. NULL ⇒ the configured default. Applies at next restart. */
  content_cache_max_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  /** Entry TTL (ms) for the Tier-1 content cache. NULL ⇒ the configured default. Applies at next restart. */
  content_cache_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /** Wall-clock budget (ms) for a whole Tier-2 global eval round. NULL ⇒ the configured default. Read per round. */
  global_eval_round_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /** Wall-clock budget (ms) for one candidate inside a round. NULL ⇒ the configured default. Read per round. */
  global_eval_candidate_timeout_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /** LRU entry ceiling for the round-result cache. NULL ⇒ the configured default. Applies at next restart. */
  global_eval_cache_max: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Orchestrator-side ceiling (ms) on waiting for one eval round to settle.
   * Distinct from the two budgets above, which the agent enforces on itself: a
   * round that never reaches an agent — or an agent that wedges before its own
   * budget starts — is only bounded here. NULL ⇒ the configured default. Read
   * per round.
   */
  global_eval_wait_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Retention window in days for `check_run_tracking` rows. The hourly cleanup
   * sweep deletes rows untouched for longer than this; 0 disables the sweep.
   * NULL ⇒ the orchestrator's configured default.
   */
  check_run_tracking_ttl_days: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * Grace window (ms) a job may stay continuously unroutable before it is
   * terminalized as `unroutable`. NULL = the orchestrator's configured default;
   * 0 disables fast-fail, leaving `queue_timeout_ms` as the only backstop.
   */
  unroutable_grace_ms: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * Fleet-wide master switch for global workflows. NULL ⇒ the orchestrator's
   * configured default (`KICI_GLOBAL_WORKFLOWS_ENABLED`, default false). Read
   * per policy decision through `ClusterSettingsReader.tryGetBoolean`, which
   * reports an unreadable row separately so the gate can fail closed.
   */
  global_workflows_enabled: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  /**
   * How long a `replaying` claim on `ingest_overflow_buffer` may stand before
   * the drain pass reclaims the row for another worker. NULL ⇒ the
   * orchestrator's configured default. Must exceed the longest a single
   * delivery's pipeline can legitimately run.
   */
  ingest_overflow_claim_timeout_ms: ColumnType<
    number | null,
    number | null | undefined,
    number | null
  >;
  concurrency_wait_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  agent_token_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * How often the leader sweeps for stranded event-scaler provisions. Re-read
   * at the end of every sweep, so a change reschedules the timer on the next
   * tick rather than waiting for a leadership transition. NULL ⇒ the
   * orchestrator's configured default.
   */
  scaler_reap_interval_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * How long an adopted event-scaler provision whose agent is registered on no
   * coordinator may sit before it is torn down. Set it well above the peer
   * heartbeat period: the "registered nowhere" signal is partly heartbeat
   * derived. NULL ⇒ the orchestrator's configured default. Read per sweep.
   */
  scaler_reap_stranded_timeout_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * How long before the reaper retries a provision whose previous teardown left
   * the row in place. NULL ⇒ the orchestrator's configured default. Read per
   * sweep.
   */
  scaler_reap_reattempt_interval_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * How long an expired scaler provisioning claim is kept before the reaper's
   * sweep deletes it. An expired claim can never be redeemed, so this only
   * controls how long a late redeemer is told "expired" rather than "unknown
   * code". NULL ⇒ the orchestrator's configured default. Read per sweep.
   */
  scaler_claim_retention_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * First deferral applied to an external (event) scaler after one consecutive
   * provisioning failure. Each further consecutive failure doubles it, up to
   * `scaler_provision_backoff_max_ms`. NULL ⇒ the orchestrator's configured
   * default. Read per spawn request.
   */
  scaler_provision_backoff_base_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * Ceiling on the doubling above, so a long provider outage settles into a
   * steady retry cadence instead of growing without bound. NULL ⇒ the
   * orchestrator's configured default. Read per spawn request.
   */
  scaler_provision_backoff_max_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * How many consecutive provisioning failures a scaler may record before its
   * refusals name repeated failure as the cause rather than a single timeout.
   * NULL ⇒ the orchestrator's configured default. Read per spawn request.
   */
  scaler_provision_max_consecutive_failures: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * Deadline for one database-backed agent-ownership lookup. Past it the lookup
   * resolves as undecided and the frame is refused without counting a
   * violation. NULL ⇒ the orchestrator's configured default.
   */
  ownership_db_check_timeout_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * Verified-tier origin the dashboard fetches the orchestrator's X25519
   * dashboard-encryption public key from (and always displays) under the
   * `encrypted` dashboard-write posture. The tier is explicit opt-in: NULL ⇒ it
   * is not offered and the convenient tier is used.
   */
  dashboard_verified_issuer: ColumnType<string | null, string | null | undefined, string | null>;
  /** Monotonic settings version; bumped on each real settings change, advertised to workers. */
  version: ColumnType<string | number, number | undefined, number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// Convenience types for cluster_settings
export type ClusterSettings = Selectable<ClusterSettingsTable>;
export type NewClusterSettings = Insertable<ClusterSettingsTable>;
export type ClusterSettingsUpdate = Updateable<ClusterSettingsTable>;

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
  /**
   * For an invoke-gate job, its invoke parameters (event, payload, optional,
   * maxParallel, failFast) serialized as JSON. Non-null marks this pending
   * context as a gate: when released it summons the source repo's subscribers
   * instead of dispatching to an agent. NULL for every ordinary job.
   */
  invoke_config: ColumnType<string | null, string | null | undefined, string | null>;
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
   * When the terminal (`completed`) check-run update was accepted by the
   * provider. NULL means we have no record of sending it — either it never
   * happened, or the best-effort write failed. Never treat NULL as proof the
   * update failed.
   *
   * `check_run_id` is written at create time, while the check run is still
   * `queued`, so it proves creation and never completion. This column is the
   * completion signal.
   */
  terminal_sent_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * KiCI run identifier this check-run belongs to, written at create time.
   * Indexed (partial, NOT NULL) so a per-run lookup never scans the table.
   * It is an attribution key, not a retention key — rows are reclaimed by
   * the `updated_at`-age sweep, which deliberately ignores this column.
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
  /**
   * Server-side verification verdict computed at ingest. One of
   * `verified` / `failed` / `unverifiable` / `pending`
   * (`attestationVerifyStatusSchema.enum.*`). DB default is `pending`.
   */
  verify_status: Generated<string>;
  /** First failure code from `verifyKiciBundle`, or NULL when verified/pending. */
  verify_reason: string | null;
  /** When the verdict was recorded (explicitly set, not DB-generated). */
  verified_at: Date | null;
}

// Convenience types for attestations
export type AttestationRow = Selectable<AttestationsTable>;
export type NewAttestationRow = Insertable<AttestationsTable>;

/**
 * Cluster-scoped ES256 provenance signing keys. The orchestrator signs its own
 * build attestations with the one `active` key and serves the public halves of
 * every non-`revoked` key at `/.well-known/jwks.json`.
 */
export interface OrchestratorSigningKeysTable {
  /** RFC 7638 thumbprint of the public JWK (primary key, also the token `kid`). */
  kid: string;
  /** The non-secret public JWK (JSONB) served in the JWKS. */
  public_jwk: unknown;
  /**
   * AES-256-GCM-wrapped private JWK for `db` custody (master-key wrapped). NULL
   * for `aws-kms` / `command` custody where the private key never lives here.
   */
  encrypted_private_jwk: string | null;
  key_version: Generated<number>;
  /** JOSE alg (always `ES256`). */
  alg: string;
  /** Custody backend discriminator (`db` | `aws-kms` | `command`). */
  signer_kind: string;
  /** External key locator (KMS ARN / signer command) for non-`db` custody; NULL for `db`. */
  key_ref: string | null;
  /** Lifecycle status (`SigningKeyStatus`: active | retiring | retired | revoked). */
  status: Generated<string>;
  revocation_reason: string | null;
  created_at: Generated<Date>;
  activated_at: Date | null;
  retired_at: Date | null;
  revoked_at: Date | null;
}

export type OrchestratorSigningKeyRow = Selectable<OrchestratorSigningKeysTable>;
export type NewOrchestratorSigningKeyRow = Insertable<OrchestratorSigningKeysTable>;

/**
 * The orchestrator's X25519 dashboard-encryption keys — the trust root for
 * browser-sealed dashboard writes under the `encrypted` posture. One `active`
 * key seals; rotated-out keys go `revoked` and leave the published JWKS, while
 * their rows stay so envelopes already sealed to the old `kid` still decrypt.
 */
export interface DashboardEncryptionKeysTable {
  /** RFC 7638 thumbprint of the public JWK (primary key, also the `kid`). */
  kid: string;
  /** The non-secret OKP/X25519 public JWK (`use:'enc'`) served in the JWKS. */
  public_jwk: unknown;
  /** AES-256-GCM-wrapped DER private key (master-key wrapped under KICI_SECRET_KEY). */
  encrypted_private_key: string;
  /** Lifecycle status (`active` | `revoked`). */
  status: Generated<string>;
  revocation_reason: string | null;
  created_at: Generated<Date>;
  activated_at: Date | null;
  revoked_at: Date | null;
}

export type DashboardEncryptionKeyRow = Selectable<DashboardEncryptionKeysTable>;
export type NewDashboardEncryptionKeyRow = Insertable<DashboardEncryptionKeysTable>;

/**
 * A user-facing build artifact (`ctx.artifacts.upload`). Named + immutable per
 * run: `UNIQUE (run_id, name)` enforces the first-upload-wins semantics at the
 * DB layer. `customer_id` scopes the row to an org for quota accounting; the
 * tarball lives at `storage_key` (`artifacts/{run_id}/{name}-{discriminator}.tar.gz`,
 * where the discriminator is a hash of the exact name). Reads go through the
 * stored key rather than re-deriving it, so a row written under an earlier key
 * format resolves unchanged.
 */
export interface ArtifactsTable {
  /** Random id (primary key). */
  id: string;
  /** Owning customer/org id (quota-accounting scope). */
  customer_id: string;
  /** KiCI run this artifact belongs to. */
  run_id: string;
  /** KiCI job that produced this artifact. */
  job_id: string;
  /** Caller-supplied artifact name (unique within the run). */
  name: string;
  /** Packed tarball size in bytes. Postgres BIGINT — pg returns a string on select. */
  size_bytes: ColumnType<string, number, number>;
  /** SHA-256 (hex) of the tarball bytes. */
  sha256: string;
  /** Object-storage key the tarball was written to. */
  storage_key: string;
  /** When this row was inserted. */
  created_at: Generated<Date>;
}

// Convenience types for artifacts
export type ArtifactRow = Selectable<ArtifactsTable>;
export type NewArtifactRow = Insertable<ArtifactsTable>;

/**
 * Deferred-attestation outbox: a build whose provenance mint failed transiently
 * freezes its DSSE-signed statement here; a leader-only retrier mints the token
 * later and records the fulfilled `attestations` row.
 */
export interface PendingAttestationsTable {
  /** Random id (primary key). */
  id: string;
  /** KiCI run this deferred attestation belongs to. */
  run_id: string;
  /** KiCI job this deferred attestation was produced by. */
  job_id: string;
  /** Caller-supplied artifact name. */
  subject_name: string;
  /** Primary subject digest (lowercase hex). */
  subject_digest: string;
  /** Requested token audience. */
  audience: string;
  /** The frozen, agent-signed DSSE envelope (JSONB). */
  dsse_envelope: unknown;
  /** The ephemeral public-key JWK (JSONB). */
  public_key: unknown;
  /** Bundle media type. */
  media_type: string;
  /** SHA-256 of the frozen statement payload — the later-mint binding. */
  statement_hash: string;
  /** Non-`live` AttestationOrigin: `deferred` | `offline-backfill`. */
  origin_kind: string;
  /** Retry attempts so far. */
  attempt_count: Generated<number>;
  /** First-capture time = the true build-time anchor. */
  created_at: Generated<Date>;
  /** When fulfilment was last attempted. */
  last_attempt_at: Date | null;
  /** Last fulfilment error, or NULL. */
  last_error: string | null;
  /**
   * Terminal-rejection time: the Platform definitively rejected the mint
   * (run/job absent). NULL while the row is still pending a later mint.
   */
  rejected_at: Date | null;
}
export type PendingAttestationRow = Selectable<PendingAttestationsTable>;
export type NewPendingAttestationRow = Insertable<PendingAttestationsTable>;

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
  /**
   * True when an auto-scaler backend spawned this agent. Written from the
   * scaler manager's registration lookup (a spawn record exists for the agent
   * id), NOT from `lifecycle_class` — that column snapshots the auth TOKEN's
   * type and reads `ephemeral` for every agent when the auth mode is `none`.
   *
   * `runsOnAll` fan-out targets declared fleet members, so a true here keeps
   * the host out of the fan-out set. Defaults false, so a row predating the
   * column stays a fan-out target without re-registering.
   */
  scaler_managed: ColumnType<boolean, boolean | undefined, boolean>;
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
  /**
   * Reboot-pending flag for workflow-level host restart. When set to a future
   * timestamp, the host's imminent disconnect is an expected reboot (not a
   * recovery-fail) and its pinned post-restart job is held until the host
   * reconnects (down-then-up). NULL = no reboot pending.
   */
  reboot_pending_until: ColumnType<Date | null, Date | string | null, Date | string | null>;
  /**
   * Pre-agent reach metadata: how to SSH to a declared host before it has a
   * KiCI agent, for bootstrap bring-up. All nullable — a host with no reach
   * metadata cannot be bootstrapped and behaves exactly as before.
   */
  address: ColumnType<string | null, string | null | undefined, string | null>;
  ssh_user: ColumnType<string | null, string | null | undefined, string | null>;
  ssh_port: ColumnType<number | null, number | null | undefined, number | null>;
  /** Scoped-secret ref (`scope/key`) holding the bring-up private key. */
  ssh_key_secret: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Delivery hint: when true, the box can reach the orchestrator's object
   * storage, so bring-up picks `s3-direct` (the box pulls the payload via a
   * presigned URL). NULL / false ⇒ the conservative `ssh-push` fallback.
   */
  s3_reachable: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
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
 * (container / bare-metal / firecracker / event) but has not yet registered
 * via WS. Persists `bound_job_id` so a replacement coord still issues the
 * eager-dispatch hop when the agent eventually registers, and `run_id`
 * alongside it so a coordinator that never spawned the agent — the
 * leader-gated reaper routinely is not the spawner — can still attribute a
 * provisioning failure back to the job waiting on it. Reaped per
 * instance and adoption-aware: `listReapCandidates` narrows to event rows that
 * are either adopted or past their spawn deadline, and the reaper tears each
 * one down with `deleteSpawningAgent` — an adopted event agent legitimately
 * outlives the spawn timeout, so no blanket age-based sweep may drop it.
 */
export interface ScalerSpawningAgentsTable {
  agent_id: string;
  scaler_name: string;
  label_set: ColumnType<string[], string | string[], string | string[]>;
  run_id: ColumnType<string | null, string | null | undefined, string | null>;
  job_id: ColumnType<string | null, string | null | undefined, string | null>;
  bound_job_id: ColumnType<string | null, string | null | undefined, string | null>;
  spawned_at: Generated<Date>;
  /**
   * The coordinator instance that spawned this agent. Scopes recovery and the
   * per-instance reaper. NULL reads as "unknown owner" — never as "not mine".
   */
  owner_instance_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** The coordinator the agent actually reached when it registered. */
  adopted_by: ColumnType<string | null, string | null | undefined, string | null>;
  /** When the adopting coordinator claimed the agent. */
  adopted_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * The scaler's mandatory labels, copied onto the row so a coordinator with no
   * matching scaler entry can still stamp the taint and emit the teardown.
   */
  mandatory_labels: ColumnType<
    string[] | null,
    string | string[] | null | undefined,
    string | string[] | null
  >;
  /** The scaler's provisioning targets, copied onto the row for the same reason. */
  provisioning_targets: ColumnType<
    string[] | null,
    string | string[] | null | undefined,
    string | string[] | null
  >;
  /** The scaler's roles, copied onto the row for the same reason. */
  roles: ColumnType<
    string[] | null,
    string | string[] | null | undefined,
    string | string[] | null
  >;
  /**
   * The scaler backend that spawned the agent: `container`, `bare-metal`,
   * `firecracker`, or `event`. `event` is the value every adoption and reap
   * predicate matches on, so a row missing it can be adopted and reaped by
   * nobody. NULL means the row predates the column.
   */
  backend_type: ColumnType<string | null, string | null | undefined, string | null>;
}

export type ScalerSpawningAgentRow = Selectable<ScalerSpawningAgentsTable>;
export type NewScalerSpawningAgentRow = Insertable<ScalerSpawningAgentsTable>;

/**
 * Scaler provision-outcomes table (scaler_provision_outcomes).
 *
 * One row per provisioned agent id, recording what became of the provision.
 * Outlives `scaler_spawning_agents`, whose row is deleted on teardown — so the
 * stale-spawn prune can tell an adopted provision from one that was never
 * adopted, which the spawn row's absence cannot.
 *
 * `adopted_by` is written in the same transaction as
 * `scaler_spawning_agents.adopted_by`, inside `adoptSpawningAgent`, which is
 * the single writer of that column. Any future writer of `adopted_by` MUST
 * write this row too, or the prune loses the signal again.
 */
export interface ScalerProvisionOutcomesTable {
  agent_id: string;
  scaler_name: string;
  /** The coordinator that adopted the provision. NULL means it never was. */
  adopted_by: ColumnType<string | null, string | null | undefined, string | null>;
  /** When it was first adopted. Never refreshed by a re-adopt. */
  adopted_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * The reaper's teardown reason (`spawn-timeout` / `heartbeat-timeout`), set
   * only once the teardown was actually delivered. Independent of `adopted_by`:
   * a `heartbeat-timeout` condemns a provision that WAS adopted, and clearing
   * the adoption here would restore the misattribution this table removes.
   */
  condemned_reason: ColumnType<string | null, string | null | undefined, string | null>;
  /** When the reaper condemned it. */
  condemned_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  recorded_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type ScalerProvisionOutcomeRow = Selectable<ScalerProvisionOutcomesTable>;
export type NewScalerProvisionOutcomeRow = Insertable<ScalerProvisionOutcomesTable>;

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
  /**
   * The coordinator instance holding the reservation. Scopes recovery and the
   * per-instance reaper. NULL reads as "unknown owner" — never as "not mine".
   */
  owner_instance_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export type ScalerReservationRow = Selectable<ScalerReservationsTable>;
export type NewScalerReservationRow = Insertable<ScalerReservationsTable>;

/**
 * Pending provisioning claims (scaler_pending_claims).
 *
 * One row per outstanding event-scaler claim code, so any coordinator behind the
 * shared endpoint can redeem a code rather than only the process that minted it.
 * The code itself is never stored — only its sha256 — so a DB read cannot hand
 * back a redeemable secret. Single use is enforced by a conditional UPDATE on
 * `consumed_at`.
 */
export interface ScalerPendingClaimsTable {
  claim_hash: string;
  claim_prefix: string;
  agent_id: string;
  scaler_name: string;
  labels: ColumnType<string[], string | string[], string | string[]>;
  /** BIGINT: node-pg returns it as a string, so callers coerce on read. */
  agent_token_ttl_ms: ColumnType<string, number | string, number | string>;
  orchestrator_url: string;
  expires_at: Date;
  consumed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: Generated<Date>;
}

export type ScalerPendingClaimRow = Selectable<ScalerPendingClaimsTable>;
export type NewScalerPendingClaimRow = Insertable<ScalerPendingClaimsTable>;
