import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

import type {
  ApprovalRequirement,
  ApproverClause,
  InitFailure,
  StepApprovalPayload,
} from '@kici-dev/engine';
import type { PrecursorResult } from '../cache/precursor-result.js';
import type { DeferredContextResolution } from '../pipeline/held-context-data.js';

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
 * Who last set a roster host's identity (labels, hostname, properties).
 * `platform` marks an unconfirmed placeholder created from the dashboard: it
 * is never a fan-out, inventory, agent-pin or unreachable-alarm target until
 * its agent registers (`agent`) or an operator declares it (`operator`).
 */
export enum HostIdentitySource {
  agent = 'agent',
  operator = 'operator',
  platform = 'platform',
}

/** PostgreSQL schema; every key and column name is the snake_case database name. */
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
  cluster_instances: ClusterInstancesTable;
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
 * Open accumulation window for a `workflowsFailedBatch` registration, one per subscribing
 * workflow. The first matching failure opens it; the leader sweep closes it once `expires_at`
 * passes, emitting a single `__workflows_failed_batch` event.
 */
export interface BatchAccumulationWindowsTable {
  /** Primary key. */
  id: string;
  /** Owning customer/org id. */
  customer_id: string;
  /** Subscribing registration id (unique — open-once). */
  registration_id: string;
  /** Routing key captured at open time so the sweep can emit without the index. */
  routing_key: string;
  /** Captured at open time. */
  repo_identifier: string;
  /** Accumulation window length in milliseconds. */
  accumulate_for_ms: number;
  /** When the window opened (first failure). */
  opened_at: Generated<Date>;
  /** When the window is due for the leader sweep. */
  expires_at: Date;
}

export type BatchAccumulationWindow = Selectable<BatchAccumulationWindowsTable>;
export type NewBatchAccumulationWindow = Insertable<BatchAccumulationWindowsTable>;

/** A failed run buffered into a batch-accumulation window; cascade-deleted with its window. */
export interface BatchAccumulationItemsTable {
  /** Primary key. */
  id: string;
  window_id: string;
  run_id: string;
  repo_identifier: string;
  workflow_name: string;
  /** Failure class (`RunFailureClass`) when known. */
  failure_class: string | null;
  /** Triggering actor username when known. */
  sender_username: string | null;
  created_at: Generated<Date>;
}

export type BatchAccumulationItem = Selectable<BatchAccumulationItemsTable>;
export type NewBatchAccumulationItem = Insertable<BatchAccumulationItemsTable>;

/**
 * Makes run-minting dashboard requests (`run.rerun.request`, `run.manual_schedule.request`)
 * idempotent across an HA relay failover: a re-sent Platform `requestId` returns the first
 * coordinator's `new_run_id` instead of a second run. Pruned after 1h.
 */
export interface RequestIdempotencyTable {
  /** Platform-minted requestId (primary key). */
  request_id: string;
  /** The run the winning coordinator created. */
  new_run_id: string;
  created_at: Generated<Date>;
}

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
  /** Dump size in bytes. */
  byte_size: string | bigint;
  /** Secret-key generation of the DB's encrypted config (null when it has none). */
  secret_key_version: number | null;
  /** Server version string the dump was taken from (e.g. "160003"). */
  pg_server_version: string;
  /** Bundled-migrations content hash at backup time. */
  migrations_hash: string;
  /** Host that ran the backup. */
  hostname: string;
}

export type BackupRun = Selectable<BackupRunsTable>;
export type NewBackupRun = Insertable<BackupRunsTable>;

/** Key-value store for cluster-wide configuration (e.g. cluster_id). */
export interface ClusterMetaTable {
  /** Primary key. */
  key: string;
  value: string;
  created_at: Generated<Date>;
}

export type ClusterMeta = Selectable<ClusterMetaTable>;
export type NewClusterMeta = Insertable<ClusterMetaTable>;

/**
 * Stores hashed join tokens. `kici-admin join` and peer token mode find a row by
 * its hash; a token is consumed on first use and re-usable by the instance that
 * consumed it until it expires.
 */
export interface JoinTokenTable {
  /** UUID primary key */
  id: Generated<string>;
  /** SHA-256 hash of the token secret (for lookup) */
  token_hash: string;
  /** Routing info embedded in the token (orgId, routingKey, expiry) */
  routing_info: string;
  created_by: string;
  created_at: Generated<Date>;
  expires_at: Date;
  /** null = unused */
  consumed_at: Date | null;
  /** The coordinator that processed the claim (null = unused) */
  consumed_by: string | null;
  /**
   * The joining peer that consumed the token (null = unused); `consumed_by` is the coordinator.
   * The same peer may reuse the token until `expires_at` to self-heal after a transient outage.
   */
  consumed_by_instance: string | null;
}

export type JoinToken = Selectable<JoinTokenTable>;
export type NewJoinToken = Insertable<JoinTokenTable>;

/** Holds jobs waiting to be dispatched to agents. */
export interface DispatchQueueTable {
  /** UUID primary key */
  id: Generated<string>;
  run_id: string;
  /** Workflow name from lock file */
  workflow_name: string;
  job_name: string;
  /** JSONB label array: insert `JSON.stringify(labels)`; the pg driver parses it on select. */
  runs_on_labels: string;
  /** JSON-encoded Record of the job configuration, without the fields in `sealed_secrets` */
  job_config: string;
  /**
   * The secret fields of the stored job, AES-256-GCM encrypted under the
   * orchestrator master key (`secrets/job-secret-seal.ts`). NULL when there is
   * nothing to seal, when no master key is configured, and on a row written
   * before the column existed: those rows keep the fields in the plain column.
   */
  sealed_secrets: ColumnType<string | null, string | null | undefined, string | null>;
  repo_url: string;
  /** Git ref (branch/tag) */
  ref: string;
  sha: string;
  /** Job status: a `DispatchQueueStatus` value (`queue/job-queue.ts`). */
  status: Generated<string>;
  /** When this job was queued */
  created_at: Generated<Date>;
  /** When this job expires (null = wait indefinitely) */
  expires_at: Date | null;
  /** Webhook delivery ID for tracing */
  delivery_id: string;

  /** e.g. "github", "gitlab" */
  provider: Generated<string>;
  /** JSON-encoded provider-specific context (e.g., {"installationId": 42}) */
  provider_context: Generated<string>;
  /** Pre-packed `.kici/` source tarball URL (from cache). Nullable. */
  source_tar_url: string | null;
  source_tar_digest: string | null;
  /** Pre-built dependency tarball URL (from dep cache). Nullable. */
  deps_url: string | null;
  /** SHA-256 hash of the dependency tarball. Nullable. */
  deps_hash: string | null;
  /** Request trace ID for cross-tier correlation. Nullable for background ops. */
  request_id: string | null;
  /** JSONB array of exclusion labels. Default '[]'. */
  exclude_labels: Generated<string>;
  /** Required LabelMatcher[] regexes; JS post-filter over runs_on_labels. Default '[]'. */
  runs_on_patterns: Generated<string>;
  /** Regex matchers (LabelMatcher[]) that disqualify an agent; JS post-filter. Default '[]'. */
  exclude_patterns: Generated<string>;
  /** NOT NULL; e.g. "github:12345". Picks the per-app provider bundle in multi-app setups. */
  routing_key: string;
  /**
   * For `status='recovering'` jobs, when the recovery grace period elapses. Set when an agent
   * disconnects with the job in flight; cleared when the agent reconnects and claims it, or when
   * the leader-gated sweep fails the row. NULL for all other statuses.
   */
  recovery_deadline: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * The agent that owned the job before disconnect; a reconnecting agent must match it.
   * NULL for non-recovering rows.
   */
  recovery_agent_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Latest scaler spawn-failure detail (e.g. "agent process error: spawn node ENOENT"). Written
   * on a `scaler.failed` event bound to the job, surfaced by the queue-timeout reaper as the
   * provisioning cause, cleared on dispatch. NULL when none recorded.
   */
  last_provisioning_error: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * When the job first read unroutable (no agent and no scaler backend matched its selectors).
   * NULL once routable again, so the grace clock measures only a CONTINUOUS unroutable window.
   * Persisted so a restart mid-grace resumes the same clock.
   */
  unroutable_since: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Times this job was returned to pending for re-dispatch (job.reject / pre-start agent loss). */
  dispatch_attempts: Generated<number>;
  /**
   * Deadline for the agent to answer job.dispatch (job.ack / job.reject / job.status running).
   * Stamped on send, cleared on any answer; a `dispatched` row past it is requeued by the owning
   * coord's timer or the leader sweep.
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
   * Durable owner: the agent the job was handed to. Written at dispatch, cleared on requeue.
   * Unlike `ack_agent_id` (cleared once the agent answers), it lets a coordinator that never saw
   * the dispatch resolve ownership from the database alone. NULL for pending rows and for rows
   * dispatched before the column existed.
   */
  agent_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * The coordinator that armed this dispatch's timers, which every cluster-wide sweep must know
   * before it acts. Written at claim/dispatch from `config.instanceId`, cleared on requeue.
   * NULL reads as "unknown owner", never "not mine" (the migration 119 scaler-plane convention):
   * recovery selection spares the row, and the stale detector's dispatch-time scan reaps it if
   * genuinely dead.
   */
  owner_instance_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * When the row was handed to an agent; `created_at` is when it was enqueued. Only this one
   * measures "this dispatch has gone unacknowledged" for a job that waited behind a busy fleet.
   * NULL for pending rows and for rows dispatched before the column existed; readers fall back
   * to `created_at`.
   */
  dispatched_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/**
 * Coordinator heartbeats: the liveness source every ownership predicate reads. Each
 * orchestrator upserts its row on a fixed tick; a `last_heartbeat_at` inside the grace window
 * means alive. A DB heartbeat, not the in-memory peer registry, because that registry is empty
 * when startup recovery runs and because it needs no peer connectivity (non-Raft and standalone
 * deployments work the same). `host_roster` does the same job for agents.
 */
export interface ClusterInstancesTable {
  /** The coordinator's instance id (`config.instanceId`). */
  instance_id: string;
  /** Raft role at the last heartbeat, or null when the node runs without Raft. */
  role: string | null;
  /** Orchestrator version at the last heartbeat. */
  version: string | null;
  /** When this instance last started. */
  started_at: Generated<Date>;
  /** Refreshed every tick; staleness past the grace window reads as dead. */
  last_heartbeat_at: Generated<Date>;
}

export type ClusterInstance = Selectable<ClusterInstancesTable>;
export type NewClusterInstance = Insertable<ClusterInstancesTable>;

/** Tracks recently processed webhook delivery IDs to prevent reprocessing. */
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
   * When the row moved `buffered` → `replaying`; null while buffered. Separate from
   * `captured_at` (the FIFO drain order) so a long-buffered row is not reclaimed on pickup.
   */
  claimed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export type DispatchQueueItem = Selectable<DispatchQueueTable>;
export type NewDispatchQueueItem = Insertable<DispatchQueueTable>;
export type DispatchQueueItemUpdate = Updateable<DispatchQueueTable>;

/** Firecracker VM IPs assigned from the CIDR pool; DB-backed to survive restarts. */
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
  allocated_at: Generated<Date>;
}

/** Top-level workflow runs, one per webhook trigger. */
export interface ExecutionRunTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Unique run identifier matching runId in protocol messages */
  run_id: string;
  /** Routing key (e.g. github:appId) for Platform StaleOrchDetector when sharing DB */
  routing_key: string | null;
  /**
   * Owning org, denormalized from routing_key at insert so the concurrency-gate running count
   * is per tenant. Column DEFAULT '__default__' (the no-source fallback org).
   */
  customer_id: Generated<string>;
  /** Workflow name from lock file */
  workflow_name: string;
  /** Run status: an `ExecutionRunStatus` value (engine). */
  status: Generated<string>;
  /** Provider type (e.g. "github", "gitlab") */
  provider: string;
  /** Repository identifier (e.g. "owner/repo") */
  repo_identifier: string;
  /**
   * The branch (or tag) the run PRESENTS — `event.targetBranch`: where a push landed, a PR's
   * base branch, the default branch a schedule fire executes, or an internal trigger's
   * inherited branch.
   *
   * NOT a job's checkout ref: a PR job checks out the HEAD branch, carried in
   * `QueuedJobInput.ref`. Load-bearing: an internally-triggered run inherits this column as its
   * branch claim before the context branch gate matches `branchRestrictions`, and a fork
   * contributor names the head branch freely. Every writer that CREATES the row uses the
   * presented branch. The two reroute projections (`cluster/coordinator.ts`, `worker-core.ts`)
   * insert from a `job.reroute` message carrying only the job's ref; they are fail-safe because
   * the run is registered before the first job reaches an agent (`startRunBeforeDispatch`) and
   * their insert is `ON CONFLICT (run_id) DO NOTHING`.
   */
  ref: string;
  sha: string;
  /** Webhook delivery ID for tracing */
  delivery_id: string | null;
  /** Serialized WorkflowDecision (trigger decision trace) */
  trigger_decision: string | null;
  started_at: Generated<Date>;
  completed_at: Date | null;
  /**
   * When the run entered `cancelling`. Stamped once on the transition and never cleared: the
   * only record of when the cancel started, read by the stuck-cancelling re-drive. NULL for a
   * run that never cancelled and for one that entered `cancelling` before the column existed.
   */
  cancelling_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * TRUE once a forced cancel reached the run (migration 153); the stuck-cancelling re-drive
   * re-sends an incomplete cancel with `force`. Never reset to FALSE: a later graceful cancel
   * does not undo a forced one. NULL re-drives gracefully.
   */
  cancel_force: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  /**
   * Status generation (migration 150): starts at 0, +1 each time the run leaves a terminal
   * status to continue. Sent on every `execution.status` frame as `statusEpoch` so the Platform
   * tells a reopen from a late frame.
   */
  status_epoch: Generated<number>;
  /** Total execution duration in milliseconds */
  duration_ms: number | null;
  /**
   * Raw log bytes across all jobs: the sum of the agent's `LogStreamer.getTotalBytes()` on each
   * terminal `step.status`. Default 0 for pre-migration rows. Feeds the Platform's
   * `kici_org_log_bytes` capacity gauge. Postgres BIGINT — pg returns string; cast at read sites.
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
  /** First run in the re-run chain (null for original runs). */
  original_run_id: string | null;
  /** Who triggered this re-run: "user:email" or "key:name" (null for webhook-triggered). */
  triggered_by: string | null;
  /** Agent provenance label when triggered through an agent credential (null otherwise). */
  triggered_by_agent_label: string | null;
  /** User identity that cancelled this run (null for non-cancelled). */
  cancelled_by: string | null;
  /** Agent provenance label when cancelled through an agent credential (null otherwise). */
  cancelled_by_agent_label: string | null;
  /** Context name for this run (null if no context applies) */
  context: string | null;
  /** Matched context id for this run (null if no/unresolved context). */
  context_id: string | null;
  /**
   * The event type that started this run (`push`, `pr:open`, `schedule`, …). The git credential
   * relay checks a context's `triggerTypeFilters` against it; NULL (never recorded) fails that
   * rule closed, withholding the credential.
   */
  trigger_event: string | null;
  /**
   * The event the OIDC token's SUBJECT derives from, when it differs from
   * {@link ExecutionRunTable.trigger_event}. A re-run records `trigger_event: 'rerun'` (which the
   * dashboard filter and `triggerTypeFilters` read) and copies the original event here, so a
   * re-run of a PR keeps the PR-shaped subject instead of a push's branch-shaped one.
   * `buildIdTokenSubject` is the ONLY reader. NULL means "use `trigger_event`", so a legacy row
   * keeps the subject it already mints.
   */
  subject_trigger_event: string | null;
  /**
   * The PR HEAD branch, where a contributor's code lives; {@link ExecutionRunTable.ref} is the
   * base branch. NULL for a non-PR run and for a row written before this column existed.
   */
  head_ref: string | null;
  /**
   * `owner/repo` of the PR HEAD: `repo_identifier` for a same-repo PR, the contributor's fork
   * for a fork PR. NULL for a non-PR run and for a legacy row.
   */
  head_repository: string | null;
  /**
   * True when the PR came from a fork (head repo != base repo). NULL means NOT RESOLVED: a
   * legacy row, or a reroute projection (its `job.reroute` message carries no event context).
   * Derived claims render NULL as `'unresolved'`, never `'false'`, so a trust policy pinning it
   * fails closed.
   */
  is_fork: boolean | null;
  /** Trust tier of the contributor for PR runs (null for non-PR events) */
  trust_tier: string | null;
  /** Lock file source: 'head' or 'base' (null for non-PR events) */
  lock_file_source: string | null;
  /** Username of the contributor (null for non-PR events) */
  contributor_username: string | null;
  /**
   * PR number for PR-triggered runs (null for non-PR events). Scopes `/kici approve|reject`
   * hold selection to the comment's PR.
   */
  pr_number: number | null;
  /**
   * Origin provider of the triggering actor (`github` today; provider-generic for later
   * GitLab/Bitbucket). Null when no actor was captured.
   */
  trigger_actor_provider: string | null;
  /**
   * Provider login of whoever triggered the run (pusher / PR author), for ALL event types,
   * unlike the PR-only `contributor_username`.
   */
  trigger_actor_username: string | null;
  /**
   * Immutable provider user id of the triggering actor (mirrors
   * `identity_links.provider_user_id`); preferred over the mutable username when resolving
   * the actor to a KiCI user.
   */
  trigger_actor_user_id: string | null;
  /**
   * The repository that DEFINES this run's workflow, when it differs from `repo_identifier`
   * (the repository acted on and checked out), as for an organization-wide workflow. NULL means
   * the same — every per-repository run. The rerun path resolves the workflow from here.
   */
  workflow_repo_identifier: string | null;
  /**
   * Workflow-repository commit dispatched when `workflow_repo_identifier` is set; a re-run
   * dispatches this exact commit. NULL on every per-repository run.
   */
  workflow_sha: string | null;
  /**
   * The workflow repository's registered branch when the workflow lives elsewhere; the
   * git-credential relay checks context branch rules against it. NULL on every per-repository
   * run.
   */
  workflow_branch: string | null;
  /**
   * True when the row records a global evaluation round (which decides the org-wide workflows
   * for an event; a failed round is one errored run so the suppression is visible). The re-run
   * path branches on it to re-execute the evaluation. Structural on purpose: the round job's
   * `__globaleval__` name prefix is a string a customer workflow may also carry.
   */
  is_global_eval_round: Generated<boolean>;
  /**
   * The source whose credentials `provider_context` holds, when not the INBOUND source in
   * `routing_key` (a cross-provider global workflow resolves through another source's bundle).
   * Pairing `routing_key` with `provider_context` there would hand one source's credentials to
   * another's API client. NULL means the same — every ordinary run. The rerun path of a failed
   * evaluation round reads it to re-drive the org-wide pass with the delivery's dispatch pair.
   */
  dispatch_routing_key: string | null;
  /** Human-readable reason why the run failed (null for non-failed runs). */
  failure_reason: string | null;
  /**
   * `RunFailureClass` (`@kici-dev/engine`): never_started / timed_out / dead_orchestrator /
   * step_failure / cancelled, derived at completion from the terminal job statuses. NULL for
   * success / not-yet-terminal.
   */
  failure_class: string | null;
  /**
   * `InitFailure` (`@kici-dev/engine`) detail. Non-null means the run never executed a step
   * because the init phase failed (lock-file fetch, provider context, agent spawn). NULL for
   * normal runs.
   */
  init_failure: ColumnType<InitFailure | null, unknown, unknown>;
  /**
   * Whole-run wall-clock timeout in ms from the workflow lock (null = unset), read by the
   * WorkflowDeadlineDetector. INTEGER like the other `*_ms` columns, so pg returns a number.
   */
  workflow_timeout_ms: ColumnType<number | null, number | null | undefined, number | null>;
  created_at: Generated<Date>;
  /**
   * Idempotent-step mode (`CheckMode`: `apply` | `check` | `check-fail-on-drift`). NULL means a
   * legacy/apply run; a non-apply value labels the run a check-mode preview in the dashboard.
   */
  check_mode: string | null;
  /**
   * Set inside the cold-store archive transaction before the row is DELETEd; survivors carry
   * NULL. Lets the promote-chunk-back-into-PG path restore rows with their archive pointer.
   */
  archived_at: Date | null;
  /** S3 object key of the chunk that carried this row; see `archived_at`. */
  archive_object_key: string | null;
  /** The summoning (global) run's id for a gate-summoned run; NULL otherwise. */
  summoned_by_run_id: string | null;
  /**
   * The summoning run's proxy job to update when this run completes; NULL for every run not
   * summoned by a gate.
   */
  summoned_by_proxy_job: string | null;
  /**
   * Invoke-chain depth: 0 for a webhook-triggered run, the summoner's depth + 1 for a summoned
   * one. Read when this run fires its own invoke gate so the chain-depth circuit breaker bounds
   * recursion. Defaults to 0.
   */
  chain_depth: Generated<number>;
  /**
   * The coordinator whose dispatch pipeline still has jobs to register for this run: the
   * durable form of the pending-jobs token (`ExecutionTracker.holdRunForPendingJobs`). Written
   * on its first token, cleared on its last; every finalization path defers while it names a
   * LIVE sibling (liveness from `cluster_instances`, as the dispatch queue's
   * `owner_instance_id` predicates read it). A dead holder reads as no window. NULL with no
   * window open and on rows written before the column existed.
   */
  registration_window_instance_id: string | null;
}

/** Individual jobs within a run, including matrix expansions. */
export interface ExecutionJobTable {
  /** UUID primary key */
  id: Generated<string>;
  /** References execution_runs.run_id */
  run_id: string;
  /** Job identifier from dispatch */
  job_id: string;
  /** Job name (e.g. "test", "test[node-18]") */
  job_name: string;
  /**
   * The workflow that defines the job. A run can span several workflows (an older `kici`'s shared
   * fixture run), so the run's own
   * `workflow_name` does not name it. NULL on a row written before the column existed.
   */
  workflow_name: ColumnType<string | null, string | null | undefined, string | null>;
  /** Job status: an `ExecutionJobStatus` value (engine). */
  status: Generated<string>;
  /**
   * Operator-facing reason the job cannot be routed to any agent. Written by the unroutable
   * probe while queued, so the cause shows before the job terminalizes; cleared when a matching
   * agent or scaler backend appears. NULL whenever the job is routable.
   */
  routing_reason: ColumnType<string | null, string | null | undefined, string | null>;
  /** Matrix values JSONB (e.g. {"node": "18"}); writers pass a `JSON.stringify` string. */
  matrix_values: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  /** Agent ID that ran this job */
  agent_id: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  /** Job execution duration in milliseconds */
  duration_ms: number | null;
  /**
   * Raw log bytes across the job's steps (agent `LogStreamer.getTotalBytes()` on each terminal
   * `step.status`). Default 0 for pre-migration rows. Postgres BIGINT — pg returns string; cast
   * at read sites.
   */
  log_bytes: Generated<number>;
  error_message: string | null;
  /**
   * `InitFailure` (`@kici-dev/engine`) detail. Non-null means the job never executed a step
   * because init failed (lock-file fetch, provider context, agent spawn). NULL for normal runs.
   */
  init_failure: ColumnType<InitFailure | null, unknown, unknown>;
  /**
   * Agent-routing labels JSONB (e.g. ["kici:os:linux", "kici:arch:x64"]); writers pass a
   * `JSON.stringify` string. The driver returns a parsed array: re-parsing it as a string
   * yields null for every job.
   */
  runs_on_labels: ColumnType<string[] | null, string | null, string | null>;
  /** Last heartbeat received from agent (for stale run detection) */
  last_heartbeat_at: Date | null;
  /** JSON array of secret context names dispatched with this job */
  dispatched_contexts: Generated<string>;
  /** Aggregated step outputs JSONB (step-keyed map of outputs). Populated on job success. */
  outputs: string | null;
  /**
   * Ordered bound deployment-context names, JSON `string[]` (null when none). Written at
   * dispatch; overwritten with the agent-resolved list for dynamic contexts.
   */
  contexts: string | null;
  /**
   * The lock entry's `gitCredentials` map: server truth the credential relay reads on every git
   * network operation. JSONB; writers pass a `JSON.stringify` string. Copied verbatim because
   * the relay compares byte for byte: `<name>Secret` is a qualified `<context>:<key>` secret
   * NAME, and `<name>Value` is material for a credential with no store entry.
   *
   * Written after the dispatch loop, so NULL means "declared none" or "not caught up yet"; the
   * relay does not guess — `git/job-context.ts` reads the dispatch record, which carries the
   * same declaration and is written before the agent learns of the job.
   */
  git_credentials: ColumnType<
    Record<string, Record<string, string>> | null,
    string | null,
    string | null
  >;
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
   * Wave gate: `true` holds a fan-out child beyond the `maxParallel` window instead of
   * dispatching it; the wave-scheduler clears it when a sibling terminates and frees a slot.
   * NULL/false for any job not held by a rolling wave.
   */
  wave_gated: Generated<boolean>;
  /** The fan-out base's `maxParallel`, stamped on every child. NULL = no bounded wave. */
  wave_max_parallel: number | null;
  /** The fan-out base's `failFast` policy, stamped on every child. NULL = no bounded wave. */
  wave_fail_fast: boolean | null;
  /** Instance id of the worker peer this job was rerouted to, or null if local. */
  rerouted_to_peer: string | null;
  created_at: Generated<Date>;
  /**
   * Copied from execution_runs at insert; the cold-store partition tenant. NULLable for safety:
   * the cold-store adapter skips a row an insert site left without it.
   */
  routing_key: string | null;
  /** Cold-store archive marker — see ExecutionRunTable.archived_at. */
  archived_at: Date | null;
  /** S3 object key of the chunk that carried this row. */
  archive_object_key: string | null;
  /** `JobKind`; defaults to `standard`. */
  job_kind: Generated<string>;
  /** For a `proxy` job, the summoned run it mirrors. NULL for every other kind. */
  summoned_run_id: string | null;
  /**
   * A `gate` job's wall-clock timeout in ms, copied from the lock job. A gate runs no agent
   * steps, so no agent-side timeout fires; the orchestrator sweeps this column and fails a gate
   * whose proxies have not all terminalized in time. NULL = no gate timeout.
   */
  timeout_ms: number | null;
  /**
   * The `PrecursorResult` a build / init / dynamic-eval job reported on its terminal
   * `job.status`, persisted so any coordinator can settle its pending tracker from the shared
   * row. JSONB; writers pass a `JSON.stringify` string. NULL for ordinary jobs and for a
   * precursor job not yet terminal.
   */
  precursor_result: ColumnType<PrecursorResult | null, string | null | undefined, string | null>;
}

/** Individual steps within a job. */
export interface ExecutionStepTable {
  /** UUID primary key */
  id: Generated<string>;
  /** References execution_runs.run_id */
  run_id: string;
  job_id: string;
  /** Step index within the job (0-based) */
  step_index: number;
  step_name: string;
  /** Step status: an `ExecutionStepStatus` value (engine). */
  status: Generated<string>;
  started_at: Date | null;
  completed_at: Date | null;
  /** Step execution duration in milliseconds */
  duration_ms: number | null;
  exit_code: number | null;
  error_message: string | null;
  /** Path in storage backend (e.g. "executions/{runId}/job-test/step-0.log") */
  log_path: string | null;
  /** Step type: 'step' for regular steps, 'hook:onCancel', 'hook:cleanup', etc. for hooks */
  step_type: Generated<string>;
  /** JSON array of secret context names the step accessed. NULL = not tracked (old runs). */
  secrets_accessed: string | null;
  /**
   * `CheckStepOutcome`: skipped | applied | declined | dry-run | no_check. NULL when the step
   * ran without a check mode. Orthogonal to `status`.
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
  created_at: Generated<Date>;
  /** Copied from execution_runs at insert; the cold-store partition tenant. NULLable for safety. */
  routing_key: string | null;
  /** Cold-store archive marker — see ExecutionRunTable.archived_at. */
  archived_at: Date | null;
  /** S3 object key of the chunk that carried this row. */
  archive_object_key: string | null;
}

export type ExecutionRun = Selectable<ExecutionRunTable>;
export type NewExecutionRun = Insertable<ExecutionRunTable>;
export type ExecutionRunUpdate = Updateable<ExecutionRunTable>;

export type ExecutionJob = Selectable<ExecutionJobTable>;
export type NewExecutionJob = Insertable<ExecutionJobTable>;
export type ExecutionJobUpdate = Updateable<ExecutionJobTable>;

export type ExecutionStep = Selectable<ExecutionStepTable>;
export type NewExecutionStep = Insertable<ExecutionStepTable>;
export type ExecutionStepUpdate = Updateable<ExecutionStepTable>;

/**
 * One row per concrete dependency edge in a run: static-to-static edges at run start, group
 * edges after resolution.
 */
export interface ExecutionJobNeedsTable {
  /** References execution_runs.run_id */
  run_id: string;
  /** Downstream job name (the job that depends on the upstream) */
  job_name: string;
  /** Upstream job name (the job that must complete first) */
  upstream_name: string;
  /**
   * JSON `ExecutionJobStatus[]` of upstream terminal statuses that satisfy the edge (default
   * `'["success"]'`); the downstream dispatches when the upstream ends in one of them.
   */
  run_on: Generated<string>;
}

export type ExecutionJobNeeds = Selectable<ExecutionJobNeedsTable>;
export type NewExecutionJobNeeds = Insertable<ExecutionJobNeedsTable>;

/** Raft leader-election state, one row per cluster (default cluster_id = 'default'). */
export interface RaftStateTable {
  /** Cluster identifier (primary key). Default 'default'. */
  cluster_id: Generated<string>;
  current_term: Generated<number>;
  /** Instance ID this node voted for in the current term */
  voted_for: string | null;
  /** Current known leader instance ID */
  leader_id: string | null;
  updated_at: Generated<Date>;
}

export type RaftState = Selectable<RaftStateTable>;
export type RaftStateUpdate = Updateable<RaftStateTable>;

/**
 * Org-scoped named deployment contexts with concurrency, branch restrictions and approval rules.
 */
export interface ContextsTable {
  /** UUID primary key */
  id: Generated<string>;
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
   * `ConcurrencyStrategy` (`@kici-dev/engine`) applied when concurrency is exceeded; a plain
   * `string` so a row from another orchestrator version always maps (null = unset).
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
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
}

export type Context = Selectable<ContextsTable>;
export type NewContext = Insertable<ContextsTable>;
export type ContextUpdate = Updateable<ContextsTable>;

/** Encrypted key-value pairs scoped to org + scope (e.g. context name, repo pattern). */
export interface ScopedSecretsTable {
  /** UUID primary key */
  id: Generated<string>;
  org_id: string;
  /** Scope identifier (e.g. context name, repo pattern) */
  scope: string;
  key: string;
  /** Encrypted secret value */
  encrypted_value: string;
  /** Backend type for secret storage (e.g. 'pg', 'vault') */
  backend_type: Generated<string>;
  /** Version of the encryption key used */
  key_version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ScopedSecret = Selectable<ScopedSecretsTable>;
export type NewScopedSecret = Insertable<ScopedSecretsTable>;
export type ScopedSecretUpdate = Updateable<ScopedSecretsTable>;

/** Links contexts to scope patterns (e.g. workflow names, repo identifiers). */
export interface ContextBindingsTable {
  /** UUID primary key */
  id: Generated<string>;
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
  created_at: Generated<Date>;
}

export type ContextBinding = Selectable<ContextBindingsTable>;
export type NewContextBinding = Insertable<ContextBindingsTable>;

/** Non-secret key-value pairs attached to a context. */
export interface ContextVariablesTable {
  /** UUID primary key */
  id: Generated<string>;
  org_id: string;
  /** Context ID (FK to contexts.id, cascade delete) */
  context_id: string;
  key: string;
  value: string;
  /** Whether this variable is locked (cannot be overridden by workflow) */
  locked: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ContextVariable = Selectable<ContextVariablesTable>;
export type NewContextVariable = Insertable<ContextVariablesTable>;
export type ContextVariableUpdate = Updateable<ContextVariablesTable>;

/** Per-source (routing key) variable overrides within a context. */
export interface ContextSourceOverridesTable {
  /** UUID primary key */
  id: Generated<string>;
  org_id: string;
  /** Context ID (FK to contexts.id, cascade delete) */
  context_id: string;
  routing_key: string;
  key: string;
  value: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ContextSourceOverride = Selectable<ContextSourceOverridesTable>;
export type NewContextSourceOverride = Insertable<ContextSourceOverridesTable>;
export type ContextSourceOverrideUpdate = Updateable<ContextSourceOverridesTable>;

/** Tracks runs waiting for approval, wait timer, or concurrency slot. */
export interface HeldRunsTable {
  /** UUID primary key */
  id: Generated<string>;
  org_id: string;
  /** Run ID (references execution_runs) */
  run_id: string;
  job_id: string;
  /** Context ID (FK to contexts.id); null once the context is deleted */
  context_id: string | null;
  /**
   * Engine `HoldType` ('reviewer' | 'timer' | 'concurrency' | 'security'). A plain `string`
   * so a row from a different orchestrator version is never rejected.
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
  created_at: Generated<Date>;
  expires_at: Date;
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
   * must satisfy. Null for a hold with no requirement: security, wait and queue
   * holds, which `security-hold-check.ts` tells apart on this column.
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
   * Whether the hold's pending `KiCI Security` check reached the provider: `true` after a post
   * returned, `false` when none was attempted or one failed, `null` on a pre-column row (the
   * hold's shape is then the only answer). Read through `postedPendingSecurityCheck` to decide
   * whether a hold has a check to terminalize — terminalizing one never posted CREATES a
   * `KiCI Security` run on a commit that had none.
   */
  posted_pending_check: Generated<boolean | null>;
}

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
  created_at: Generated<Date>;
}

export type HeldRunApproval = Selectable<HeldRunApprovalsTable>;
export type NewHeldRunApproval = Insertable<HeldRunApprovalsTable>;
export type HeldRunApprovalUpdate = Updateable<HeldRunApprovalsTable>;

/** Immutable log of secret access and denial events. */
export interface SecretAuditLogTable {
  /** UUID primary key */
  id: Generated<string>;
  timestamp: Generated<Date>;
  /** The action performed (e.g., 'getSecrets', 'setSecret') */
  action: string;
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
  /** Set inside the archive transaction before the row is DELETEd; survivors carry NULL. */
  archived_at: Date | null;
  /** S3 object key of the chunk that carried this row; see `archived_at`. */
  archive_object_key: string | null;
}

export type SecretAuditLogRow = Selectable<SecretAuditLogTable>;
export type NewSecretAuditLogRow = Insertable<SecretAuditLogTable>;

/**
 * One row per read or orchestrator-admin mutation attributable to an
 * ActorPrincipal (user / api_key / service_account / platform_operator /
 * system). Retention: see `archived_at`.
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
   * Human-set agent name when the actor used an agent-kind PAT; NULL for human / API-key /
   * system actors. Queryable so the access log filters by agent.
   */
  agent_label: string | null;
  created_at: Generated<Date>;
  /**
   * Set inside the archive transaction before the row is DELETEd; survivors carry NULL. No
   * `expires_at`-based TTL. With the cold store on, rows past their per-action warm TTL
   * (`accessLogWarmSqlCase`) are archived to S3; with it off, the database retention sweep
   * (`audit_retention_days`) prunes them.
   */
  archived_at: Date | null;
  /** S3 object key of the chunk that carried this row; see `archived_at`. */
  archive_object_key: string | null;
}

export type AccessLogRow = Selectable<AccessLogTable>;
export type NewAccessLogRow = Insertable<AccessLogTable>;

/** Hashed tokens for admin API authentication with role-based access. */
export interface AdminTokenTable {
  /** UUID primary key */
  id: Generated<string>;
  /** SHA-256 hash of the token */
  token_hash: string;
  label: string;
  /** Role (e.g. 'admin', 'reader') */
  role: string;
  /** Routing key scope (null = all) */
  routing_key: string | null;
  /**
   * The intended holder from `token create --subject` (an OIDC `sub` or an email). Advisory
   * only: never verified and never read when authorizing. The join key the Platform's RBAC
   * drift report compares against org membership; NULL is the report's `unlinked` finding.
   */
  subject: string | null;
  created_at: Generated<Date>;
  /** When this token expires (null = never) */
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked: Generated<boolean>;
}

export type AdminTokenRow = Selectable<AdminTokenTable>;
export type NewAdminTokenRow = Insertable<AdminTokenTable>;

/**
 * Hashed PSK tokens for agent authentication: static (long-lived, CLI-created) or ephemeral
 * (scaler-issued, TTL-bound).
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
   * JSON `string[]` of mandatory labels (a Kubernetes-taint-style gate): a static agent on this
   * token accepts a job only when every label here is among the job's required labels. null =
   * no taint (the default). Authorized at mint time alongside `labels`.
   */
  mandatory_labels: string | null;
  /** Token type: 'ephemeral' (scaler-issued) or 'static' (CLI-created) */
  agent_type: string;
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
   * Single-use marker for bootstrap (init-runner) tokens, set on first `agent.register`; a
   * second register is rejected. NULL = never consumed (static / ephemeral tokens stay
   * reusable until expiry).
   */
  consumed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export type AgentTokenRow = Selectable<AgentTokenTable>;
export type NewAgentTokenRow = Insertable<AgentTokenTable>;

/**
 * Versioned JSONB config snapshots with audit trail; each change adds a version. Sensitive
 * fields are encrypted and listed in `encrypted_paths`.
 */
export interface ConfigVersionTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Auto-incrementing version number (SERIAL) */
  version: Generated<number>;
  /** Full config snapshot as JSONB */
  config: string;
  created_at: Generated<Date>;
  /** Who created this version (e.g. "cli:seed", "api:set", "api:rollback") */
  created_by: string;
  /** Human-readable description of the change */
  description: string | null;
  /** JSONB paths that contain encrypted values */
  encrypted_paths: Generated<string[]>;
  /**
   * Master-key generation of this row's sensitive fields, bumped atomically by
   * `kici-admin rotate-key`; decrypt accepts current and previous during a grace window.
   */
  key_version: Generated<number>;
}

export type ConfigVersionRow = Selectable<ConfigVersionTable>;
export type NewConfigVersionRow = Insertable<ConfigVersionTable>;

/** Internal events (system + custom) for routing, circuit-breaking and audit; TTL-expired. */
export interface KiciEventTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Event name (e.g. 'deploy-complete', '__workflow_complete', '__job_complete') */
  event_name: string;
  /** Event payload (JSONB) */
  payload: string;
  /** Source repo identifier (null for non-repo events) */
  source_repo: string | null;
  source_routing_key: string | null;
  /** Run ID that emitted this event */
  source_run_id: string | null;
  /** Job ID that emitted this event */
  source_job_id: string | null;
  /** Event chain depth for circuit breaker (0 = original, incremented at each hop) */
  chain_depth: Generated<number>;
  /** Whether all subscribers have processed this event */
  processed: Generated<boolean>;
  created_at: Generated<Date>;
  expires_at: Date;
  /** Optional target repos for cross-repo event targeting (JSONB string[] or null) */
  target_repos: string | null;
  /** When the current lease was taken (NULL = unleased / available for claim) */
  claimed_at: Date | null;
  /** Node id holding the current lease (for diagnostics; not part of the lease check) */
  claimed_by: string | null;
  /** Times the event has been leased for processing */
  attempts: Generated<number>;
  /** Most recent dispatch failure message (truncated to 4 KB by application code) */
  last_error: string | null;
  /** Earliest moment the leader-only retry scanner should re-publish pg_notify */
  next_retry_at: Date | null;
  /** When the event entered the DLQ (NULL = not in DLQ) */
  dlq_at: Date | null;
  /** Short DLQ reason: 'exhausted_retries' | 'non_retryable' */
  dlq_reason: string | null;
  /** How the router resolved the event (an `EventMatchOutcome`); NULL until processed */
  match_outcome: string | null;
  /** Registrations the event was dispatched to; NULL until processed */
  matched_count: number | null;
}

export type KiciEvent = Selectable<KiciEventTable>;
export type NewKiciEvent = Insertable<KiciEventTable>;
export type KiciEventUpdate = Updateable<KiciEventTable>;

/** Non-GitHub webhook sources: verification config, event extraction rules and rate limits. */
export interface GenericWebhookSourceTable {
  /** UUID primary key */
  id: Generated<string>;
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
  enabled: Generated<boolean>;
  /** Token bucket rate limit: requests per minute */
  rate_limit_rpm: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  /** Soft-delete marker (null = active) */
  deleted_at: Date | null;
  /**
   * Normalizer: 'generic' (default) → GenericWebhookNormalizer (Stripe-shaped payloads);
   * 'local' → LocalWebhookNormalizer (github-shaped push/PR payloads for a repository on the
   * agent filesystem, cloned via file://).
   */
  provider_type: Generated<string>;
  /**
   * Git config JSONB, discriminated by `provider_type`: a universal-git source ('generic' with
   * git_config) stores a `UniversalGitConfig` (clone URLs, lock-file fetch, clone credentials
   * against Forgejo / Gitea / Gogs / GitLab repo-webhook / GitHub repo); a 'local' source a
   * `LocalSourceConfig` (`{ repoBasePath, cloneUrlBase? }`). null for plain generic sources
   * with no git operations. Validated by the matching Zod schema in the application layer.
   */
  git_config: ColumnType<string | Record<string, unknown> | null, string | null, string | null>;
}

export type GenericWebhookSource = Selectable<GenericWebhookSourceTable>;
export type NewGenericWebhookSource = Insertable<GenericWebhookSourceTable>;
export type GenericWebhookSourceUpdate = Updateable<GenericWebhookSourceTable>;

/** Cross-repo event-delivery trust; delivery needs both source and target to declare it. */
export interface CrossRepoTrustTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Source repo that is trusted to emit events */
  source_repo: string;
  source_routing_key: string;
  /** Target repo that accepts events from source */
  target_repo: string;
  target_routing_key: string;
  /** JSON array of event name glob patterns allowed (null = all) */
  allowed_events: string | null;
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
}

export type CrossRepoTrust = Selectable<CrossRepoTrustTable>;
export type NewCrossRepoTrust = Insertable<CrossRepoTrustTable>;
export type CrossRepoTrustUpdate = Updateable<CrossRepoTrustTable>;

/** CLI code uploads for remote test runs; a periodic job removes them after a 24h TTL. */
export interface TestUploadsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Client-facing upload ID */
  upload_id: string;
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
  created_at: Generated<Date>;
  /** When this upload expires (24h from creation) */
  expires_at: Date;
  /** Token identifier of the uploader */
  created_by: string | null;
}

export type TestUpload = Selectable<TestUploadsTable>;
export type NewTestUpload = Insertable<TestUploadsTable>;
export type TestUploadUpdate = Updateable<TestUploadsTable>;

/** One row per (routing_key, repo, workflow): the full lock entry plus a trigger-type index. */
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
   * The repo's default branch from the push that last updated this registration. A
   * `__schedule_fire` run executes this branch's lock file, so this IS that run's branch for
   * context branch restrictions. NULL when the row predates migration 123 or the payload named
   * no default branch; no backfill is possible, so a NULL row heals on the next default-branch
   * push. NULL presents no branch, keeping the honest branch-gate rejection.
   */
  default_branch: ColumnType<string | null, string | null | undefined, string | null>;
  /** Source file path for this workflow (e.g. ".kici/workflows/deploy.ts") */
  source_file: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * `lockfileHash` of the lock file that last registered this workflow: the package-manager
   * lockfile hash a dispatched run probes the dependency cache with. NULL when that lock file
   * records none and on rows before migration 149; the run then installs deps on the agent.
   */
  lockfile_hash: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * `siblingsDigest` of the lock file that last registered this workflow: the
   * in-repo `workspace:` sibling closure, part of the dependency-cache key next to
   * `lockfile_hash`. NULL when that lock file records none.
   */
  siblings_digest: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * The `commit_sha` written with `lockfile_hash` and `siblings_digest`; the key is used only
   * while this equals `commit_sha`, since a writer unaware of the key columns moves
   * `commit_sha` alone and leaves an older lock file's key. NULL (rows before migration 151 or
   * registered with no commit) uses no key.
   */
  dep_cache_key_sha: ColumnType<string | null, string | null | undefined, string | null>;
  /** Whether this is a global workflow (triggers across all repos under same routing key) */
  is_global: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Owning org, backfilled by migration 020 from sources / generic_webhook_sources on
   * routing_key and NOT NULL since. The cross-source lookup index
   * (RegistrationIndex.byOrgAndEvent) enforces org isolation with it. Required on insert (no DB
   * default); optional on update because the replaceAll UPDATE branch preserves it.
   */
  customer_id: ColumnType<string, string, string | undefined>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type WorkflowRegistration = Selectable<WorkflowRegistrationsTable>;
export type NewWorkflowRegistration = Insertable<WorkflowRegistrationsTable>;
export type WorkflowRegistrationUpdate = Updateable<WorkflowRegistrationsTable>;

/**
 * Cluster sync version counter, bumped on registration changes. A migration inserts the
 * id='default' row.
 */
export interface RegistryVersionsTable {
  /** Version identifier (default: 'default') */
  id: Generated<string>;
  /** Monotonically increasing version counter */
  version: Generated<number>;
  updated_at: Generated<Date>;
}

export type RegistryVersion = Selectable<RegistryVersionsTable>;
export type RegistryVersionUpdate = Updateable<RegistryVersionsTable>;

/** Last fire time per cron registration, for fire-once-on-recovery after a restart. */
export interface CronLastFiredTable {
  /** References workflow_registrations.id (cascade delete) */
  registration_id: string;
  /** Per-schedule identity: `${cronExpression}\n${timezone}` (see scheduleTriggerKey) */
  schedule_key: string;
  last_fired_at: Date;
  updated_at: Generated<Date>;
}

export type CronLastFired = Selectable<CronLastFiredTable>;
export type NewCronLastFired = Insertable<CronLastFiredTable>;
export type CronLastFiredUpdate = Updateable<CronLastFiredTable>;

/**
 * Per-run X25519 key pairs for cross-job secret output encryption. Private keys are encrypted
 * with the orchestrator master key (`KICI_SECRET_KEY`, AES-256-GCM).
 */
export interface RunEphemeralKeysTable {
  /** Run ID (primary key, references execution_runs.run_id) */
  run_id: string;
  /** Base64-encoded AES-256-GCM encrypted private key */
  encrypted_private_key: string;
  /** Base64-encoded DER public key (X25519 SPKI format) */
  public_key: string;
  /** Master-key generation this row is sealed under. Bumped by `rotate-key`. */
  key_version: Generated<number>;
  created_at: Generated<Date>;
}

export type RunEphemeralKey = Selectable<RunEphemeralKeysTable>;
export type NewRunEphemeralKey = Insertable<RunEphemeralKeysTable>;

/**
 * Encrypted job secret outputs for cross-job consumption. The agent seals each value to the
 * run's ephemeral public key (ECDH + AES-256-GCM); the orchestrator opens it with the run
 * private key and RE-ENCRYPTS it under the master key (`KICI_SECRET_KEY`) before storing, so
 * this store moves with every key rotation.
 */
export interface RunSecretOutputsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Run ID (references execution_runs.run_id) */
  run_id: string;
  /** Job ID that produced this output */
  job_id: string;
  output_key: string;
  /**
   * Base64 value, AES-256-GCM sealed under the master key with AAD `secret-output:<run_id>`.
   * Read through `unsealSecretOutput`, which carries the rotation grace window's old-key fallback.
   */
  encrypted_value: string;
  /** Master-key generation this row is sealed under. Bumped by `rotate-key`. */
  key_version: Generated<number>;
  created_at: Generated<Date>;
}

export type RunSecretOutput = Selectable<RunSecretOutputsTable>;
export type NewRunSecretOutput = Insertable<RunSecretOutputsTable>;

/**
 * The arbiter of `concurrency: { group, max }`: an advisory-locked transaction counts
 * `status='active'` rows for the scope and inserts only below `max`, so the cap holds across
 * restarts and every coordinator (a per-process map cannot). A partial unique index on
 * `(routing_key, group_key, run_id) WHERE status='active'` makes a re-acquire idempotent.
 */
export interface ConcurrencyGroupsTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Concurrency group key (e.g. "deploy-main") */
  group_key: string;
  /** Run ID that owns this slot or is queued */
  run_id: string;
  job_id: string;
  /** Routing key for scoping (e.g. "github:42") */
  routing_key: string;
  /** Status: 'active' | 'queued' | 'completed' | 'cancelled' */
  status: Generated<string>;
  created_at: Generated<Date>;
  /** When this entry was completed/cancelled */
  completed_at: Date | null;
}

export type ConcurrencyGroup = Selectable<ConcurrencyGroupsTable>;
export type NewConcurrencyGroup = Insertable<ConcurrencyGroupsTable>;
export type ConcurrencyGroupUpdate = Updateable<ConcurrencyGroupsTable>;

/**
 * Webhook source configs (e.g. GitHub Apps) with routing keys. Secrets (private key, webhook
 * secret) live separately in PgSecretStore.
 */
export interface SourcesTable {
  /** UUID primary key */
  id: Generated<string>;
  /** Provider type (e.g. 'github') */
  provider: string;
  name: string;
  /** Routing key (e.g. 'github:12345') */
  routing_key: string;
  /** JSONB config (non-sensitive, e.g. { appId: '12345' }) */
  config: string;
  /**
   * GitHub App slug (e.g. `my-kici-app`); NULL until the GitHub identity fetch populates it.
   * GitHub is the source of truth for `name` and `slug` on GitHub-App sources.
   */
  slug: string | null;
  /** Customer/org identifier for secret and context scoping */
  customer_id: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type Source = Selectable<SourcesTable>;
export type NewSource = Insertable<SourcesTable>;
export type SourceUpdate = Updateable<SourcesTable>;

/**
 * Repo-pattern entry stored inside the jsonb repo-list columns of
 * `org_settings`. `routingKey` is optional — when undefined the entry
 * applies to any source in the org; when set, it qualifies the entry to
 * one specific webhook source.
 */
export interface OrgSettingsRepoPatternEntry {
  routingKey?: string;
  pattern: string;
}

/**
 * Per-org (customer_id) global workflow permissions and overrides of cluster defaults. Repo
 * list columns hold `OrgSettingsRepoPatternEntry[]` jsonb. A BIGINT column reads back from pg
 * as a string and takes a number on write.
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
  /**
   * Repos denied as event sources for global workflows; deny beats the allow-list (null = none).
   */
  global_workflow_denied_repos: ColumnType<
    OrgSettingsRepoPatternEntry[] | null,
    OrgSettingsRepoPatternEntry[] | null | undefined | string,
    OrgSettingsRepoPatternEntry[] | null | string
  >;
  /**
   * True lets workflow `registries:` URLs use plain `http://` to any host. False (default)
   * accepts only `https://` and loopback / `*.local` `http://`; others are rejected at dispatch.
   */
  allow_http_npm_registries: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * May an UNTRUSTED ref build its job's container image from a Dockerfile? Default false: the
   * build runs outside the job's hardened sandbox, so this is opt-in, never inherited.
   */
  allow_untrusted_dockerfile_builds: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Which Platform-routed dashboard.* writes the orch accepts: JSONB
   * `{ [operation]: boolean }` keyed by engine `DashboardWriteOperation`. The resolver in
   * `@kici-dev/engine/protocol/dashboard-write-operations` treats missing keys as `true`, so
   * `{}` enables all.
   */
  dashboard_write_policy: ColumnType<
    Record<string, boolean>,
    Record<string, boolean> | string | undefined,
    Record<string, boolean> | string
  >;
  /**
   * UserCache byte quota. NULL = cluster default (`KICI_USER_CACHE_QUOTA_BYTES`, 5 GiB). BIGINT.
   */
  user_cache_quota_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * UserCache per-entry TTL (ms). NULL = cluster default (`KICI_USER_CACHE_TTL_MS`, 7 days).
   * BIGINT.
   */
  user_cache_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * ArtifactStore byte quota. NULL = cluster default (`KICI_ARTIFACT_QUOTA_BYTES`, 20 GiB).
   * BIGINT.
   */
  artifact_quota_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * ArtifactStore per-artifact TTL (ms). NULL = cluster default (`KICI_ARTIFACT_TTL_MS`,
   * 30 days). BIGINT.
   */
  artifact_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * ArtifactStore per-artifact size cap (bytes). NULL = cluster default
   * (`KICI_ARTIFACT_MAX_BYTES`, 1 GiB). BIGINT.
   */
  artifact_max_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * ArtifactStore per-run artifact count cap. NULL = cluster default
   * (`KICI_ARTIFACT_MAX_PER_RUN`, 50). BIGINT.
   */
  artifact_max_per_run: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Dispatch-acknowledgment deadline (ms); null = cluster default
   * (config.dispatchAckTimeoutMs / KICI_DISPATCH_ACK_TIMEOUT_MS). BIGINT.
   */
  dispatch_ack_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Webhook-ingest concurrency cap; null = cluster default
   * (config.ingestOrgMaxConcurrency / KICI_INGEST_ORG_MAX_CONCURRENCY). BIGINT.
   */
  ingest_max_concurrency: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Deadline (ms) for one `backend.spawn` (image pull + container create + start); null =
   * cluster default (config.scalerSpawnTimeoutMs / KICI_SCALER_SPAWN_TIMEOUT_MS). BIGINT.
   */
  scaler_spawn_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Reroute spawn window (ms): how long after a peer ACKs a reroute the coordinator waits
   * before treating "accepted but no progress" as a spawn failure and re-dispatching. Null =
   * cluster default (config.rerouteSpawnWindowMs). BIGINT.
   */
  reroute_spawn_window_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Reroute sendAndWaitAck deadline (ms). Null = cluster default (config.rerouteAckTimeoutMs).
   * BIGINT.
   */
  reroute_ack_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /** Max peer hops for a rerouted job. Null = cluster default (config.rerouteMaxHops). INTEGER. */
  reroute_max_hops: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * Agent spawns a worker attempts for one rerouted job. Null = cluster default
   * (config.rerouteSpawnMaxAttempts). INTEGER.
   */
  reroute_spawn_max_attempts: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * Wait (ms) after a failed spawn of a rerouted job. Null = cluster default
   * (config.rerouteSpawnRetryBackoffMs). BIGINT.
   */
  reroute_spawn_retry_backoff_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * DB-backup freshness diagnostic threshold (hours). Null = cluster default
   * (config.backupStalenessWarnHours). INTEGER.
   */
  backup_staleness_warn_hours: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * Dispatch-queue job timeout (ms): a queued job's deadline is
   * `job.timeoutMs ?? <this> ?? config.queueTimeoutMs`. Null = cluster default
   * (config.queueTimeoutMs / KICI_QUEUE_TIMEOUT_MS). BIGINT.
   */
  queue_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Bound (ms) on how long a build job's success waits for the cache publish its agent
   * reported just before; 0 turns the wait off. Null = cluster default
   * (config.cacheUploadSettleTimeoutMs / KICI_CACHE_UPLOAD_SETTLE_TIMEOUT_MS). BIGINT.
   */
  cache_upload_settle_timeout_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * Seconds before a held approval element is rejected and its run/job/step fails. NOT NULL,
   * default 86400 (one day); an SDK `requireApproval` `timeout` overrides it per element.
   */
  approval_expiry_seconds: ColumnType<number, number | undefined, number>;
  /**
   * Whether a run's triggering user may approve its held elements. NOT NULL, default true;
   * turn it off to enforce four-eyes review.
   */
  allow_self_approval: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Sandbox escape-hatch allow-list: Linux capabilities a workflow may request via SDK
   * `sandbox: { capabilities }`. NULL reads as `[]` (deny every request). TEXT[].
   */
  sandbox_allowed_capabilities: ColumnType<
    string[] | null,
    string[] | null | undefined,
    string[] | null
  >;
  /**
   * Sandbox escape-hatch: whether a workflow may request `sandbox: { network: 'host' }`. NULL
   * reads as `false` (deny host networking).
   */
  sandbox_allow_host_network: ColumnType<
    boolean | null,
    boolean | null | undefined,
    boolean | null
  >;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type OrgSettings = Selectable<OrgSettingsTable>;
export type NewOrgSettings = Insertable<OrgSettingsTable>;
export type OrgSettingsUpdate = Updateable<OrgSettingsTable>;

/**
 * The orchestrator's cache of the Platform-owned per-org trust policy from
 * `trust_policy.update`; `org_settings` is the operator-owned counterpart. The policy column is
 * a plain `string`, not the Zod enum, so a value from a newer Platform stays readable (as with
 * `held_runs.hold_type`).
 */
export interface OrgTrustPolicyTable {
  /** Customer/org identifier (primary key) */
  customer_id: string;
  /** How to treat a pull request opened from a fork: ignore | hold | allow */
  fork_policy: string;
  /** How long a security hold stays approvable before it expires, in seconds. */
  approval_expiry_seconds: number;
  /** Which side last wrote this row: platform | local */
  source: string;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type OrgTrustPolicy = Selectable<OrgTrustPolicyTable>;
export type NewOrgTrustPolicy = Insertable<OrgTrustPolicyTable>;
export type OrgTrustPolicyUpdate = Updateable<OrgTrustPolicyTable>;

/**
 * The approval directory `/kici approve` resolves a commenter against: identity links, per-member
 * CI trust levels and team memberships. With a Platform attached, it pushes this beside the
 * policy on `trust_policy.update` and the orchestrator only reads it back, so approvals survive
 * a restart; an independent orchestrator's operator writes it with
 * `kici-admin trust-policy directory-set`. JSONB columns select as `unknown` because pg returns
 * whatever JSON is stored; `TrustDirectoryStore` validates each against the wire schema.
 * Inserts are `JSON.stringify`d strings.
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
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type OrgTrustDirectory = Selectable<OrgTrustDirectoryTable>;
export type NewOrgTrustDirectory = Insertable<OrgTrustDirectoryTable>;
export type OrgTrustDirectoryUpdate = Updateable<OrgTrustDirectoryTable>;

/**
 * Cache of the Platform-owned worker ceiling pushed on `plan.headroom`. Single row
 * (id='default'): the orchestrator serves exactly one org. The Platform writes it and the
 * orchestrator only reads it back, so it survives a Platform outage plus a coordinator restart.
 */
export interface OrgPlanHeadroomTable {
  id: string;
  /** Absolute ceiling on this coordinator's connected worker peers. */
  max_worker_peers: number;
  /** The org's combined orchestrator limit, for the rejection reason. */
  org_limit: number;
  /** The org's combined orchestrator total at push time, for the rejection reason. */
  org_total: number;
  /** Whether the Platform asked the coordinator to drain its excess workers. */
  evict_excess: boolean;
  updated_at: ColumnType<Date, Date, Date>;
}

/**
 * Single row (id='default') of fleet-wide operator tunables with no per-tenant meaning, read via
 * ClusterSettingsReader. Each knob is nullable; NULL = the config.ts default. A BIGINT knob (every
 * byte-valued knob, and some counts) reads back as a string; an INTEGER knob as a number.
 */
export interface ClusterSettingsTable {
  /**
   * Database-side retention windows in days; 0 disables one. They prune the warm tables for
   * installs with no object store; with the cold store on, the archivers keep sole ownership
   * of the tables they register.
   */
  run_retention_days: number | null;
  audit_retention_days: number | null;
  provenance_retention_days: number | null;
  held_run_retention_days: number | null;
  /**
   * When the retention sweep first reported a non-zero window. Deletion starts
   * a week later, so an upgrade never removes history on its first night.
   */
  retention_announced_at: Date | null;
  id: ColumnType<string, string | undefined, never>;
  max_github_payload_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  event_log_max_payload_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  lock_file_max_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  webhook_dedup_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
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
  /** LRU entry ceiling for the lock-file cache. Applies at next restart. */
  lockfile_cache_max: ColumnType<string | null, number | null | undefined, number | null>;
  /** Byte ceiling for the lock-file cache. Applies at next restart. */
  lockfile_cache_max_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  /** Entry TTL (ms) for the lock-file cache. Applies at next restart. */
  lockfile_cache_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /** LRU entry ceiling for the Tier-1 content cache. Applies at next restart. */
  content_cache_max: ColumnType<string | null, number | null | undefined, number | null>;
  /** Byte ceiling for the Tier-1 content cache. Applies at next restart. */
  content_cache_max_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  /** Entry TTL (ms) for the Tier-1 content cache. Applies at next restart. */
  content_cache_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /** Wall-clock budget (ms) for a whole Tier-2 global eval round. Read per round. */
  global_eval_round_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /** Wall-clock budget (ms) for one candidate inside a round. Read per round. */
  global_eval_candidate_timeout_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /** LRU entry ceiling for the round-result cache. Applies at next restart. */
  global_eval_cache_max: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * Orchestrator-side ceiling (ms) on waiting for one eval round to settle. The round and
   * candidate budgets are agent-enforced, so a round that never reaches an agent, or an agent
   * that wedges before its budget starts, is bounded only here. Read per round.
   */
  global_eval_wait_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /** How long a Firecracker spawn waits for the VM's API socket. */
  firecracker_api_socket_wait_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * Retention in days for `check_run_tracking`: the hourly cleanup deletes rows untouched for
   * longer; 0 disables the sweep.
   */
  check_run_tracking_ttl_days: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * Grace (ms) a job may stay continuously unroutable before it terminalizes as `unroutable`;
   * 0 disables fast-fail, leaving `queue_timeout_ms` as the only backstop.
   */
  unroutable_grace_ms: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * Fleet-wide master switch for global workflows (default `KICI_GLOBAL_WORKFLOWS_ENABLED`,
   * false). Read per policy decision via `ClusterSettingsReader.tryGetBoolean`, which reports
   * an unreadable row separately so the gate fails closed.
   */
  global_workflows_enabled: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  /**
   * How long a `replaying` claim on `ingest_overflow_buffer` stands before the drain pass
   * reclaims the row. Must exceed the longest legitimate single-delivery pipeline run.
   */
  ingest_overflow_claim_timeout_ms: ColumnType<
    number | null,
    number | null | undefined,
    number | null
  >;
  concurrency_wait_timeout_ms: ColumnType<string | null, number | null | undefined, number | null>;
  agent_token_ttl_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * How often the leader sweeps for stranded event-scaler provisions. Re-read after every
   * sweep, so a change reschedules on the next tick, not at a leadership transition.
   */
  scaler_reap_interval_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * How long an adopted event-scaler provision whose agent is registered nowhere may sit
   * before teardown. Keep it well above the peer heartbeat period: "registered nowhere" is
   * partly heartbeat-derived. Read per sweep.
   */
  scaler_reap_stranded_timeout_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * How long before the reaper retries a provision whose last teardown left the row in place.
   * Read per sweep.
   */
  scaler_reap_reattempt_interval_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * How long the reaper keeps an expired provisioning claim. It is never redeemable, so this
   * only sets how long a late redeemer hears "expired" instead of "unknown code". Read per
   * sweep.
   */
  scaler_claim_retention_ms: ColumnType<string | null, number | null | undefined, number | null>;
  /**
   * First deferral for an external (event) scaler after one provisioning failure; each further
   * consecutive failure doubles it, up to `scaler_provision_backoff_max_ms`. Read per spawn
   * request.
   */
  scaler_provision_backoff_base_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * Ceiling on that doubling, so a long provider outage settles into a steady retry cadence.
   * Read per spawn request.
   */
  scaler_provision_backoff_max_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * Consecutive provisioning failures before a scaler's refusals name repeated failure, not a
   * single timeout, as the cause. Read per spawn request.
   */
  scaler_provision_max_consecutive_failures: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * Deadline for one DB-backed agent-ownership lookup; past it the lookup is undecided and the
   * frame is refused without counting a violation.
   */
  ownership_db_check_timeout_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * How long a coordinator leaves a queued job alone after failing to open its sealed secrets
   * before claiming it again.
   */
  sealed_secrets_retry_backoff_ms: ColumnType<
    string | null,
    number | null | undefined,
    number | null
  >;
  /**
   * Verified-tier origin the dashboard fetches (and always displays) the orchestrator's X25519
   * dashboard-encryption public key from, under the `encrypted` write posture. Explicit opt-in:
   * NULL means the tier is not offered and the convenient tier is used.
   */
  dashboard_verified_issuer: ColumnType<string | null, string | null | undefined, string | null>;
  /** Monotonic settings version; bumped on each real settings change, advertised to workers. */
  version: ColumnType<string | number, number | undefined, number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ClusterSettings = Selectable<ClusterSettingsTable>;
export type NewClusterSettings = Insertable<ClusterSettingsTable>;
export type ClusterSettingsUpdate = Updateable<ClusterSettingsTable>;

/**
 * Persisted PendingJobContext for crash recovery of needs-gated jobs, keyed by (run_id,
 * job_name) like the in-memory Map. Created by storePendingJobContext, deleted on consume or
 * run completion.
 */
export interface PendingJobContextsTable {
  run_id: string;
  job_name: string;
  /** Full QueuedJobInput serialized as JSONB */
  job_input: ColumnType<Record<string, unknown>, string, string>;
  /** string[] of labels serialized as JSONB */
  runs_on_labels: ColumnType<string[], string, string>;
  /**
   * An invoke-gate job's parameters (event, payload, optional, maxParallel, failFast) as JSON.
   * Non-null marks a gate: on release it summons the source repo's subscribers instead of
   * dispatching to an agent. NULL for every ordinary job.
   */
  invoke_config: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * JSONB inputs the stored job's dispatch resolves context variables and secrets from (context
   * names, org, routing key, host facts, registry-auth inputs); never a secret value. NULL for a
   * job with no bound context and for a pre-column row, whose `job_input` carries the resolved
   * context data.
   */
  context_resolution: ColumnType<
    DeferredContextResolution | null,
    string | null | undefined,
    string | null
  >;
  /** Sealed secret fields; same contract as `dispatch_queue.sealed_secrets`. */
  sealed_secrets: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
}

export type PendingJobContextRow = Selectable<PendingJobContextsTable>;
export type NewPendingJobContext = Insertable<PendingJobContextsTable>;

/**
 * Serializable WorkflowDispatchContext inputs to resume a workflow whose install gate held. One
 * row per held run, created at hold time and deleted once the resume dispatch starts.
 */
export interface PendingWorkflowContextsTable {
  run_id: string;
  org_id: string;
  /** Serializable WorkflowDispatchContext inputs as JSONB */
  context: ColumnType<Record<string, unknown>, string, string>;
  /** Sealed secret fields; same contract as `dispatch_queue.sealed_secrets`. */
  sealed_secrets: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
}
export type PendingWorkflowContextRow = Selectable<PendingWorkflowContextsTable>;
export type NewPendingWorkflowContext = Insertable<PendingWorkflowContextsTable>;

/**
 * One row per inbound webhook delivery (relay or direct), whatever the outcome; joins the
 * Platform-side `event_log` on `(org_id, delivery_id)`. Payload bytes live in LogStorage at
 * `payload_key`; an omitted payload still keeps metadata, hash and size for correlation.
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
  received_at: Generated<Date>;
  /** Cold-store: set inside the archive transaction; NULL for hot rows. */
  archived_at: Date | null;
  /** Cold-store: chunk object key when row is archived. */
  archive_object_key: string | null;
}

export type EventLogRow = Selectable<EventLogTable>;
export type NewEventLogRow = Insertable<EventLogTable>;
export type EventLogRowUpdate = Updateable<EventLogTable>;

/**
 * Per-(db, table, tenant) archived-chunk totals, so the `cold_store_chunks_total` gauge and
 * `kici-admin cold-store list-chunks` need no S3 LIST. The archiver updates it transactionally
 * on each chunk write.
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

export type ColdStoreChunkCountsRow = Selectable<ColdStoreChunkCountsTable>;
export type NewColdStoreChunkCountsRow = Insertable<ColdStoreChunkCountsTable>;
export type ColdStoreChunkCountsUpdate = Updateable<ColdStoreChunkCountsTable>;

/**
 * One row per archived chunk the GC sweep can later purge from S3, inserted in
 * `markArchivedAndDelete`'s transaction by adapters that opt into the per-bucket layout via
 * `coldTtlDays(row)`. V1 chunks are NOT here: they count as `'forever'` and are never purged.
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
  row_count: ColumnType<string, string | number, string | number>;
  /**
   * Row-level cold-retention horizon: TEXT holding a day count or the literal `'forever'`. The
   * GC sweep checks
   * `max_cold_days != 'forever' AND now() > archived_at + max_cold_days * INTERVAL '1 day'`.
   */
  max_cold_days: string;
  /** Full S3 key of the data chunk (used by the GC sweep's DeleteObject). */
  object_key: string;
}

export type ColdStoreChunksRow = Selectable<ColdStoreChunksTable>;
export type NewColdStoreChunksRow = Insertable<ColdStoreChunksTable>;
export type ColdStoreChunksUpdate = Updateable<ColdStoreChunksTable>;

/**
 * HA-safe `CheckRunReporter` state: a replacement coord after a Raft leader switch recovers
 * check-run IDs, build creation state, step progress, in-progress-sent timestamps and the run-id
 * cleanup index from here, so a coord crash mid-check-run cannot leave a GitHub check stuck in
 * `queued`.
 */
export interface CheckRunTrackingTable {
  /** Provider type (e.g. 'github'). */
  provider: string;
  /** Repo owner / namespace. */
  owner: string;
  repo: string;
  /** Git commit SHA the check run is anchored to. */
  sha: string;
  /** Check-run name (e.g. 'kici/build', 'kici/build/job/test', 'kici/build/setup'). */
  check_name: string;
  /**
   * GitHub Checks API check-run ID from `checks.create()`; null while the build create is in
   * flight (`build_creation_state = 'pending'`).
   */
  check_run_id: ColumnType<number | null, number | null | undefined, number | null>;
  /**
   * Build check-run creation state: 'pending' while a `setBuildPending` create is in flight,
   * 'completed' once `setBuildComplete` has reconciled.
   */
  build_creation_state: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * JSONB array of `{ name: string, status: string, durationMs?: number }` step-progress entries.
   */
  step_progress_json: ColumnType<unknown, string | unknown, string | unknown>;
  /**
   * When the first in-progress transition was sent to GitHub; NULL before the first running
   * step. Presence is the truth value.
   */
  in_progress_sent_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * When the provider accepted the terminal (`completed`) update: the completion signal, since
   * `check_run_id` is written while still `queued` and proves only creation. NULL means no
   * record of sending (never sent, or the best-effort write failed), never proof it failed.
   */
  terminal_sent_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * Owning KiCI run, written at create time; partial NOT NULL index so a per-run lookup never
   * scans. An attribution key, not a retention key: the `updated_at`-age sweep reclaims rows and
   * deliberately ignores it.
   */
  run_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type CheckRunTrackingRow = Selectable<CheckRunTrackingTable>;
export type NewCheckRunTrackingRow = Insertable<CheckRunTrackingTable>;
export type CheckRunTrackingUpdate = Updateable<CheckRunTrackingTable>;

/**
 * One row per `ctx.attestProvenance` bundle in object storage; the dashboard lists and fetches
 * them by `(run_id, job_id)`.
 */
export interface AttestationsTable {
  /** Random id (primary key). */
  id: string;
  run_id: string;
  job_id: string;
  /** Caller-supplied artifact name (e.g. an npm package coordinate). */
  subject_name: string;
  /** Primary subject digest (lowercase hex) used in the storage key. */
  subject_digest: string;
  /** Object-storage key the bundle was written to. */
  storage_key: string;
  /** Signing mode ('kici' for Mode A). */
  mode: string;
  media_type: string;
  created_at: Generated<Date>;
  /**
   * Ingest-time server-side verdict: `verified` / `failed` / `unverifiable` / `pending`
   * (`attestationVerifyStatusSchema.enum.*`); DB default `pending`.
   */
  verify_status: Generated<string>;
  /** First failure code from `verifyKiciBundle`, or NULL when verified/pending. */
  verify_reason: string | null;
  /** When the verdict was recorded (explicitly set, not DB-generated). */
  verified_at: Date | null;
}

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
 * X25519 dashboard-encryption keys: the trust root for browser-sealed dashboard writes under
 * the `encrypted` posture. One `active` key seals; rotated-out keys go `revoked` and leave the
 * published JWKS, but their rows stay so envelopes sealed to an old `kid` still decrypt.
 */
export interface DashboardEncryptionKeysTable {
  /** RFC 7638 thumbprint of the public JWK (primary key, also the `kid`). */
  kid: string;
  /** The non-secret OKP/X25519 public JWK (`use:'enc'`) served in the JWKS. */
  public_jwk: unknown;
  /** AES-256-GCM-wrapped DER private key (master-key wrapped under KICI_SECRET_KEY). */
  encrypted_private_key: string;
  /** Master-key generation this row is sealed under. Bumped by `rotate-key`. */
  key_version: Generated<number>;
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
 * A user-facing build artifact (`ctx.artifacts.upload`), named and immutable per run:
 * `UNIQUE (run_id, name)` enforces first-upload-wins. The tarball lives at `storage_key`
 * (`artifacts/{run_id}/{name}-{discriminator}.tar.gz`, discriminator = a hash of the exact
 * name); reads use the stored key, never re-derive it, so older key formats resolve unchanged.
 */
export interface ArtifactsTable {
  /** Random id (primary key). */
  id: string;
  /** Owning customer/org id (quota-accounting scope). */
  customer_id: string;
  run_id: string;
  job_id: string;
  /** Caller-supplied artifact name (unique within the run). */
  name: string;
  /** Packed tarball size in bytes. Postgres BIGINT — pg returns a string on select. */
  size_bytes: ColumnType<string, number, number>;
  /** SHA-256 (hex) of the tarball bytes. */
  sha256: string;
  /** Object-storage key the tarball was written to. */
  storage_key: string;
  created_at: Generated<Date>;
}

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
  run_id: string;
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
  media_type: string;
  /** SHA-256 of the frozen statement payload — the later-mint binding. */
  statement_hash: string;
  /** Non-`live` AttestationOrigin: `deferred` | `offline-backfill`. */
  origin_kind: string;
  attempt_count: Generated<number>;
  /** First-capture time = the true build-time anchor. */
  created_at: Generated<Date>;
  last_attempt_at: Date | null;
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
 * Anchors a Platform-relayed `kici run remote` to its org: routing key `remote:<orgId>` maps to
 * the canonical org id, so `resolveOrgId` takes the same local-source path as a webhook. One
 * row per served org, auto-provisioned on Platform auth.
 */
export interface RemoteSourcesTable {
  /** Canonical org id (`org_<…>`) this anchor resolves to. */
  customer_id: string;
  /** Deterministic routing key `remote:<orgId>`. */
  routing_key: string;
  /** Cluster id this orchestrator deployment reports, or null. */
  cluster_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type RemoteSourceRow = Selectable<RemoteSourcesTable>;
export type NewRemoteSourceRow = Insertable<RemoteSourcesTable>;

/**
 * KiCI's declared inventory: one durable row per agent ever enrolled, reconciled from the
 * AgentRegistry on register/unregister. `lifecycle_class` drives reaping; status is derived at
 * read from the shared `last_seen` + `connected_instance_id`.
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
   * True when an auto-scaler backend spawned this agent, per the scaler manager's spawn record;
   * NOT from `lifecycle_class`, which reads `ephemeral` for every agent under auth mode `none`.
   * True keeps the host out of `runsOnAll` fan-out (declared fleet members only). Default false
   * keeps pre-column rows fan-out targets without re-registering.
   */
  scaler_managed: ColumnType<boolean, boolean | undefined, boolean>;
  /** JSON-encoded string[] of the post-Gate-1 validated labels. */
  labels: string;
  hostname: string | null;
  platform: string | null;
  arch: string | null;
  /**
   * Which orchestrator holds the live WS (cluster liveness and the host-fanout reroute target);
   * null = disconnected.
   */
  connected_instance_id: string | null;
  /**
   * Typed host-vars jsonb bag, reported by the agent at registration and/or declared by the
   * operator (`kici-admin host declare --prop`), shallow-merged on upsert. NOT NULL, default
   * `{}`.
   */
  host_properties: ColumnType<
    Record<string, string | number | boolean>,
    Record<string, string | number | boolean> | string | undefined,
    Record<string, string | number | boolean> | string
  >;
  last_seen: ColumnType<Date, Date | string | undefined, Date | string>;
  /**
   * Workflow-level host restart: a future timestamp marks the imminent disconnect as an
   * expected reboot (not a recovery-fail) and holds the pinned post-restart job until the host
   * reconnects (down-then-up). NULL = no reboot pending.
   */
  reboot_pending_until: ColumnType<Date | null, Date | string | null, Date | string | null>;
  /**
   * Pre-agent SSH reach metadata for bootstrap bring-up of a declared host. All nullable: a
   * host without it cannot be bootstrapped and is otherwise unaffected.
   */
  address: ColumnType<string | null, string | null | undefined, string | null>;
  ssh_user: ColumnType<string | null, string | null | undefined, string | null>;
  ssh_port: ColumnType<number | null, number | null | undefined, number | null>;
  /** Scoped-secret ref (`scope/key`) holding the bring-up private key. */
  ssh_key_secret: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * True when the box reaches the orchestrator's object storage, so bring-up picks `s3-direct`
   * (the box pulls the payload via a presigned URL). NULL / false ⇒ the `ssh-push` fallback.
   */
  s3_reachable: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  /** Who last set the host's identity. See {@link HostIdentitySource}. */
  identity_source: ColumnType<
    HostIdentitySource,
    HostIdentitySource | undefined,
    HostIdentitySource
  >;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}
export type HostRosterRow = Selectable<HostRosterTable>;
export type NewHostRosterRow = Insertable<HostRosterTable>;
export type HostRosterUpdate = Updateable<HostRosterTable>;

/**
 * One row per agent spawned via a scaler backend but not yet registered via WS. `bound_job_id`
 * lets a replacement coord still issue the eager-dispatch hop on registration; `run_id` lets a
 * non-spawning coordinator (the leader-gated reaper usually is one) attribute a provisioning
 * failure to the waiting job. Reaping is per instance and adoption-aware:
 * `listReapCandidates` narrows to event rows that are adopted or past their spawn deadline,
 * torn down via `deleteSpawningAgent`. An adopted event agent legitimately outlives the spawn
 * timeout, so no blanket age-based sweep may drop it.
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
   * The spawning coordinator; scopes recovery and the per-instance reaper. NULL reads as
   * "unknown owner", never "not mine".
   */
  owner_instance_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** The coordinator the agent actually reached when it registered. */
  adopted_by: ColumnType<string | null, string | null | undefined, string | null>;
  /** When the adopting coordinator claimed the agent. */
  adopted_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * The scaler's mandatory labels, copied so a coordinator with no matching scaler entry can
   * still stamp the taint and emit the teardown.
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
   * Spawning backend: `container`, `bare-metal`, `firecracker` or `event`. Every adoption and
   * reap predicate matches `event`, so a row missing it is adopted and reaped by nobody. NULL
   * means the row predates the column.
   */
  backend_type: ColumnType<string | null, string | null | undefined, string | null>;
}

export type ScalerSpawningAgentRow = Selectable<ScalerSpawningAgentsTable>;
export type NewScalerSpawningAgentRow = Insertable<ScalerSpawningAgentsTable>;

/**
 * What became of each provisioned agent id. Outlives the `scaler_spawning_agents` row (deleted
 * on teardown), so the stale-spawn prune can tell an adopted provision from a never-adopted one.
 * `adopted_by` is written in the same transaction as `scaler_spawning_agents.adopted_by`, in
 * `adoptSpawningAgent`, its single writer. Any future writer of `adopted_by` MUST write this row
 * too, or the prune loses the signal.
 */
export interface ScalerProvisionOutcomesTable {
  agent_id: string;
  scaler_name: string;
  /** The coordinator that adopted the provision. NULL means it never was. */
  adopted_by: ColumnType<string | null, string | null | undefined, string | null>;
  /** When it was first adopted. Never refreshed by a re-adopt. */
  adopted_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * The reaper's teardown reason (`spawn-timeout` / `heartbeat-timeout`), set only once the
   * teardown was delivered. Independent of `adopted_by`: a `heartbeat-timeout` condemns an
   * adopted provision, and clearing the adoption would restore the misattribution.
   */
  condemned_reason: ColumnType<string | null, string | null | undefined, string | null>;
  condemned_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  recorded_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type ScalerProvisionOutcomeRow = Selectable<ScalerProvisionOutcomesTable>;
export type NewScalerProvisionOutcomeRow = Insertable<ScalerProvisionOutcomesTable>;

/**
 * agentId → (runId, jobId) correlation routing scaler-lifecycle events (spawn / boot / ready /
 * kill) to the execution tracker. Inserted in `correlateAgentToJob`, deleted on agent
 * disconnect / job completion.
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
 * One row per outstanding resource reservation. `perScalerUsage` / `globalUsage` are derived:
 * recomputed from `SUM(...)` on coord boot so the cap-check critical section holds under HA.
 */
export interface ScalerReservationsTable {
  agent_id: string;
  scaler_name: string;
  cpu_units: number;
  mem_bytes: ColumnType<string, string | number, string | number>;
  reserved_at: Generated<Date>;
  /**
   * The holding coordinator; scopes recovery and the per-instance reaper. NULL reads as
   * "unknown owner", never "not mine".
   */
  owner_instance_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export type ScalerReservationRow = Selectable<ScalerReservationsTable>;
export type NewScalerReservationRow = Insertable<ScalerReservationsTable>;

/**
 * One row per outstanding event-scaler claim code, so any coordinator behind the shared
 * endpoint can redeem it, not only the minting process. Only the code's sha256 is stored, so a
 * DB read never yields a redeemable secret. A conditional UPDATE on `consumed_at` enforces
 * single use.
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
