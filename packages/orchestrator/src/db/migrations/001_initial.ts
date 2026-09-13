import { type Kysely, sql } from 'kysely';

/**
 * Squashed initial migration -- creates the complete Orchestrator database schema.
 *
 * This file replaces all prior orchestrator migrations (original 001..027) with
 * a single baseline that reproduces the current live schema. The project is
 * pre-release, so there is no production data to preserve across squashes.
 *
 * Includes:
 *   - 36 tables covering dispatch queue, execution state (runs/jobs/steps),
 *     agents, sources, secrets, environments, registrations, etc.
 *   - 2 plpgsql functions (notify_sources_change, notify_source_secrets_change)
 *     and their triggers on `sources` / `scoped_secrets` for LISTEN/NOTIFY wiring.
 *   - 1 sequence (config_versions_version_seq) + its column default.
 *   - All primary keys, uniques, indexes, and foreign-key constraints.
 *
 * The DDL order mirrors what pg_dump emits: tables → functions → sequence →
 * sequence-owned-by → default → constraints → indexes → triggers → FK
 * constraints. FK constraints come last so every referenced table is already
 * in place when the FK is added.
 */

const DDL_STATEMENTS: readonly string[] = [
  `CREATE FUNCTION public.notify_source_secrets_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
    DECLARE
      source_id TEXT;
      rk TEXT;
    BEGIN
      IF NEW.scope LIKE '__source__/%' OR NEW.scope LIKE '__webhook__/%' THEN
        source_id := substring(NEW.scope from '[^/]+$');
        SELECT routing_key INTO rk FROM sources WHERE id::text = source_id;
        IF rk IS NOT NULL THEN
          PERFORM pg_notify('sources_change', rk);
        END IF;
      END IF;
      RETURN NULL;
    END;
    $_$;`,
  `CREATE FUNCTION public.notify_sources_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('sources_change', OLD.routing_key);
      ELSE
        PERFORM pg_notify('sources_change', NEW.routing_key);
      END IF;
      RETURN NULL;
    END;
    $$;`,
  `SET default_tablespace = '';`,
  `SET default_table_access_method = heap;`,
  `CREATE TABLE public.admin_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    label text NOT NULL,
    role text NOT NULL,
    routing_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    revoked boolean DEFAULT false NOT NULL
);`,
  `CREATE TABLE public.agent_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    token_prefix text NOT NULL,
    labels text,
    agent_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    created_by text,
    revoked_at timestamp with time zone,
    expires_at timestamp with time zone,
    CONSTRAINT agent_tokens_agent_type_check CHECK ((agent_type = ANY (ARRAY['ephemeral'::text, 'static'::text])))
);`,
  `CREATE TABLE public.cluster_meta (
    key character varying(64) NOT NULL,
    value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.concurrency_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_key text NOT NULL,
    run_id uuid NOT NULL,
    job_id uuid NOT NULL,
    routing_key text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);`,
  `CREATE TABLE public.config_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version integer NOT NULL,
    config jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    description text,
    encrypted_paths text[] DEFAULT '{}'::text[] NOT NULL
);`,
  `CREATE SEQUENCE public.config_versions_version_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;`,
  `ALTER SEQUENCE public.config_versions_version_seq OWNED BY public.config_versions.version;`,
  `CREATE TABLE public.cron_last_fired (
    registration_id uuid NOT NULL,
    last_fired_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.cross_repo_trust (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_repo character varying(500) NOT NULL,
    source_routing_key character varying(255) NOT NULL,
    target_repo character varying(500) NOT NULL,
    target_routing_key character varying(255) NOT NULL,
    allowed_events jsonb,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.dedup_cache (
    delivery_id text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);`,
  `CREATE TABLE public.dispatch_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id text NOT NULL,
    workflow_name text NOT NULL,
    job_name text NOT NULL,
    runs_on_labels jsonb NOT NULL,
    job_config text NOT NULL,
    repo_url text NOT NULL,
    ref text NOT NULL,
    sha text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    delivery_id text NOT NULL,
    provider text DEFAULT 'github'::text NOT NULL,
    provider_context text DEFAULT '{}'::text NOT NULL,
    bundle_url text,
    bundle_hash text,
    deps_url text,
    deps_hash text,
    request_id text,
    exclude_labels jsonb DEFAULT '[]'::jsonb,
    routing_key text NOT NULL
);`,
  `CREATE TABLE public.environment_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id character varying(12) NOT NULL,
    environment_id uuid NOT NULL,
    scope_pattern text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.environment_source_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id character varying(12) NOT NULL,
    environment_id uuid NOT NULL,
    routing_key text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.environment_variables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id character varying(12) NOT NULL,
    environment_id uuid NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.environments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id character varying(12) NOT NULL,
    name text NOT NULL,
    type text DEFAULT 'fixed'::text NOT NULL,
    glob_pattern text,
    branch_restrictions jsonb DEFAULT '[]'::jsonb NOT NULL,
    trigger_type_filters jsonb DEFAULT '[]'::jsonb NOT NULL,
    repo_patterns jsonb DEFAULT '[]'::jsonb NOT NULL,
    concurrency_limit integer,
    concurrency_strategy text DEFAULT 'queue'::text,
    concurrency_timeout_ms integer DEFAULT 1800000,
    required_reviewers jsonb,
    wait_timer_seconds integer,
    hold_expiry_seconds integer DEFAULT 86400,
    minimum_trust text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    allow_local_execution boolean DEFAULT false NOT NULL
);`,
  `CREATE TABLE public.event_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id character varying(12) NOT NULL,
    delivery_id text NOT NULL,
    routing_key text NOT NULL,
    event text NOT NULL,
    action text,
    source text NOT NULL,
    provider text NOT NULL,
    repo_identifier text,
    ref text,
    payload_key text,
    payload_omitted boolean DEFAULT false NOT NULL,
    payload_omitted_reason text,
    payload_size_bytes integer NOT NULL,
    payload_hash text NOT NULL,
    matched_count integer DEFAULT 0 NOT NULL,
    status text NOT NULL,
    run_id uuid,
    error_message text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    CONSTRAINT event_log_payload_omitted_reason_check CHECK (((payload_omitted_reason IS NULL) OR (payload_omitted_reason = ANY (ARRAY['size_exceeded'::text, 'storage_failed'::text])))),
    CONSTRAINT event_log_source_check CHECK ((source = ANY (ARRAY['relay'::text, 'direct'::text]))),
    CONSTRAINT event_log_status_check CHECK ((status = ANY (ARRAY['received'::text, 'processed'::text, 'duplicate'::text, 'lockfile_missing'::text, 'failed'::text])))
);`,
  `CREATE TABLE public.execution_job_needs (
    run_id uuid NOT NULL,
    job_name text NOT NULL,
    upstream_name text NOT NULL,
    if_failed text DEFAULT 'skip'::text NOT NULL
);`,
  `CREATE TABLE public.execution_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    job_id text NOT NULL,
    job_name text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    matrix_values jsonb,
    agent_id text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    duration_ms integer,
    error_message text,
    last_heartbeat_at timestamp with time zone,
    dispatched_contexts jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    runs_on_labels jsonb,
    outputs jsonb,
    needs_satisfied boolean DEFAULT false NOT NULL,
    ready_at timestamp with time zone,
    group_name text
);`,
  `CREATE TABLE public.execution_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    workflow_name text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    provider text NOT NULL,
    repo_identifier text NOT NULL,
    ref text NOT NULL,
    sha text NOT NULL,
    delivery_id text,
    trigger_decision jsonb,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    duration_ms integer,
    provider_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    routing_key text,
    is_test_run boolean DEFAULT false NOT NULL,
    fixture_id text,
    parent_run_id uuid,
    triggered_by text,
    cancelled_by text,
    original_run_id text,
    environment text,
    trust_tier text,
    lock_file_source text,
    contributor_username text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    failure_reason text
);`,
  `CREATE TABLE public.execution_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    job_id text NOT NULL,
    step_index integer NOT NULL,
    step_name text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    step_type text DEFAULT 'step'::text NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    duration_ms integer,
    exit_code integer,
    error_message text,
    log_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    secrets_accessed jsonb
);`,
  `CREATE TABLE public.generic_webhook_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    routing_key character varying(500) NOT NULL,
    verification_method character varying(50) DEFAULT 'hmac_sha256'::character varying NOT NULL,
    verification_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    event_type_header character varying(255) DEFAULT 'X-Event-Type'::character varying,
    event_type_path character varying(500),
    idempotency_key_header character varying(255),
    idempotency_key_path character varying(500),
    dedup_window_seconds integer DEFAULT 300 NOT NULL,
    max_payload_bytes integer DEFAULT 1048576 NOT NULL,
    allowed_events jsonb,
    strip_headers jsonb DEFAULT '["authorization", "cookie", "set-cookie", "proxy-authorization", "x-api-key", "x-auth-token"]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    rate_limit_rpm integer DEFAULT 600 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    provider_type text DEFAULT 'generic'::text NOT NULL,
    git_config jsonb,
    CONSTRAINT generic_webhook_sources_provider_type_check CHECK ((provider_type = ANY (ARRAY['generic'::text, 'internal'::text])))
);`,
  `CREATE TABLE public.held_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id character varying(12) NOT NULL,
    run_id uuid NOT NULL,
    job_id text NOT NULL,
    environment_id uuid NOT NULL,
    hold_type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    queue_type text DEFAULT 'environment'::text NOT NULL,
    reason text,
    approved_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone
);`,
  `CREATE TABLE public.ip_allocations (
    ip text NOT NULL,
    vm_id text NOT NULL,
    scaler_name text NOT NULL,
    tap_device text NOT NULL,
    mac_address text NOT NULL,
    allocated_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.join_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash character varying(64) NOT NULL,
    routing_info jsonb NOT NULL,
    created_by character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    consumed_by character varying(255),
    role character varying(20) DEFAULT 'coordinator'::character varying NOT NULL
);`,
  `CREATE TABLE public.kici_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_name character varying(255) NOT NULL,
    payload jsonb NOT NULL,
    source_repo character varying(500),
    source_routing_key character varying(255),
    source_run_id character varying(255),
    source_job_id character varying(255),
    chain_depth integer DEFAULT 0 NOT NULL,
    processed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    target_repos jsonb
);`,
  `CREATE TABLE public.org_settings (
    routing_key text NOT NULL,
    global_workflows_enabled boolean DEFAULT false NOT NULL,
    global_workflow_allowed_repos text[],
    global_workflow_elevated_repos text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    global_workflow_denied_repos text[]
);`,
  `CREATE TABLE public.peer_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instance_id text NOT NULL,
    credential_hash character varying(64) NOT NULL,
    role character varying(20) DEFAULT 'coordinator'::character varying NOT NULL,
    routing_keys text[] DEFAULT '{}'::text[] NOT NULL,
    source_token_hash character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    last_validated_by character varying(255)
);`,
  `CREATE TABLE public.pending_job_contexts (
    run_id text NOT NULL,
    job_name text NOT NULL,
    job_input jsonb NOT NULL,
    runs_on_labels jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.raft_state (
    cluster_id text DEFAULT 'default'::text NOT NULL,
    current_term integer DEFAULT 0 NOT NULL,
    voted_for text,
    leader_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.registry_versions (
    id character varying(50) DEFAULT 'default'::character varying NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.run_ephemeral_keys (
    run_id character varying(255) NOT NULL,
    encrypted_private_key text NOT NULL,
    public_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.run_secret_outputs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id character varying(255) NOT NULL,
    job_id character varying(255) NOT NULL,
    output_key character varying(255) NOT NULL,
    encrypted_value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.scoped_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id character varying(12) NOT NULL,
    scope text NOT NULL,
    key text NOT NULL,
    encrypted_value text NOT NULL,
    backend_type text DEFAULT 'pg'::text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);`,
  `CREATE TABLE public.secret_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    action text NOT NULL,
    context_name text NOT NULL,
    routing_key text,
    secret_keys jsonb,
    outcome text NOT NULL,
    run_id text,
    job_id text,
    user_id text,
    role text,
    metadata jsonb
);`,
  `CREATE TABLE public.secret_backends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    backend_type text NOT NULL,
    config_encrypted text NOT NULL,
    config_key_version integer DEFAULT 1 NOT NULL,
    scope_filter text DEFAULT '**'::text NOT NULL,
    sync_interval_ms integer DEFAULT 300000 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_sync_at timestamp with time zone,
    last_sync_error text,
    last_health_check_at timestamp with time zone,
    health_status text DEFAULT 'unknown'::text NOT NULL,
    scope_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT secret_backends_backend_type_check CHECK ((backend_type = ANY (ARRAY['pg'::text, 'vault'::text])))
);`,
  `CREATE TABLE public.sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    name text NOT NULL,
    routing_key text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    customer_id character varying(255) DEFAULT '__default__'::character varying NOT NULL
);`,
  `CREATE TABLE public.test_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    upload_id text NOT NULL,
    routing_key text NOT NULL,
    sha text,
    file_count integer,
    compressed_size bigint,
    storage_key text NOT NULL,
    encryption_private_key text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_by text
);`,
  `CREATE TABLE public.workflow_registrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    repo_identifier character varying(500) NOT NULL,
    workflow_name character varying(255) NOT NULL,
    lock_entry jsonb NOT NULL,
    trigger_types text[] NOT NULL,
    routing_key character varying(500) DEFAULT ''::character varying NOT NULL,
    provider_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    commit_sha text,
    source_file text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_global boolean DEFAULT false NOT NULL,
    customer_id text NOT NULL
);`,
  `ALTER TABLE ONLY public.config_versions ALTER COLUMN version SET DEFAULT nextval('public.config_versions_version_seq'::regclass);`,
  `ALTER TABLE ONLY public.admin_tokens
    ADD CONSTRAINT admin_tokens_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.admin_tokens
    ADD CONSTRAINT admin_tokens_token_hash_key UNIQUE (token_hash);`,
  `ALTER TABLE ONLY public.agent_tokens
    ADD CONSTRAINT agent_tokens_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.agent_tokens
    ADD CONSTRAINT agent_tokens_token_hash_key UNIQUE (token_hash);`,
  `ALTER TABLE ONLY public.cluster_meta
    ADD CONSTRAINT cluster_meta_pkey PRIMARY KEY (key);`,
  `ALTER TABLE ONLY public.concurrency_groups
    ADD CONSTRAINT concurrency_groups_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.config_versions
    ADD CONSTRAINT config_versions_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.config_versions
    ADD CONSTRAINT config_versions_version_key UNIQUE (version);`,
  `ALTER TABLE ONLY public.cron_last_fired
    ADD CONSTRAINT cron_last_fired_pkey PRIMARY KEY (registration_id);`,
  `ALTER TABLE ONLY public.cross_repo_trust
    ADD CONSTRAINT cross_repo_trust_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.cross_repo_trust
    ADD CONSTRAINT cross_repo_trust_source_repo_source_routing_key_target_repo_key UNIQUE (source_repo, source_routing_key, target_repo, target_routing_key);`,
  `ALTER TABLE ONLY public.dedup_cache
    ADD CONSTRAINT dedup_cache_pkey PRIMARY KEY (delivery_id);`,
  `ALTER TABLE ONLY public.dispatch_queue
    ADD CONSTRAINT dispatch_queue_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.environment_bindings
    ADD CONSTRAINT environment_bindings_env_id_scope_unique UNIQUE (environment_id, scope_pattern);`,
  `ALTER TABLE ONLY public.environment_bindings
    ADD CONSTRAINT environment_bindings_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.environment_source_overrides
    ADD CONSTRAINT environment_source_overrides_org_env_rk_key_unique UNIQUE (org_id, environment_id, routing_key, key);`,
  `ALTER TABLE ONLY public.environment_source_overrides
    ADD CONSTRAINT environment_source_overrides_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.environment_variables
    ADD CONSTRAINT environment_variables_org_env_key_unique UNIQUE (org_id, environment_id, key);`,
  `ALTER TABLE ONLY public.environment_variables
    ADD CONSTRAINT environment_variables_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_org_id_name_unique UNIQUE (org_id, name);`,
  `ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.event_log
    ADD CONSTRAINT event_log_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.execution_job_needs
    ADD CONSTRAINT execution_job_needs_pkey PRIMARY KEY (run_id, job_name, upstream_name);`,
  `ALTER TABLE ONLY public.execution_jobs
    ADD CONSTRAINT execution_jobs_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.execution_runs
    ADD CONSTRAINT execution_runs_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.execution_runs
    ADD CONSTRAINT execution_runs_run_id_key UNIQUE (run_id);`,
  `ALTER TABLE ONLY public.execution_steps
    ADD CONSTRAINT execution_steps_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.generic_webhook_sources
    ADD CONSTRAINT generic_webhook_sources_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.generic_webhook_sources
    ADD CONSTRAINT generic_webhook_sources_routing_key_key UNIQUE (routing_key);`,
  `ALTER TABLE ONLY public.held_runs
    ADD CONSTRAINT held_runs_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.ip_allocations
    ADD CONSTRAINT ip_allocations_pkey PRIMARY KEY (ip);`,
  `ALTER TABLE ONLY public.join_tokens
    ADD CONSTRAINT join_tokens_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.join_tokens
    ADD CONSTRAINT join_tokens_token_hash_key UNIQUE (token_hash);`,
  `ALTER TABLE ONLY public.kici_events
    ADD CONSTRAINT kici_events_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.org_settings
    ADD CONSTRAINT org_settings_pkey PRIMARY KEY (routing_key);`,
  `ALTER TABLE ONLY public.peer_credentials
    ADD CONSTRAINT peer_credentials_credential_hash_key UNIQUE (credential_hash);`,
  `ALTER TABLE ONLY public.peer_credentials
    ADD CONSTRAINT peer_credentials_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.pending_job_contexts
    ADD CONSTRAINT pending_job_contexts_pkey PRIMARY KEY (run_id, job_name);`,
  `ALTER TABLE ONLY public.raft_state
    ADD CONSTRAINT raft_state_pkey PRIMARY KEY (cluster_id);`,
  `ALTER TABLE ONLY public.registry_versions
    ADD CONSTRAINT registry_versions_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.run_ephemeral_keys
    ADD CONSTRAINT run_ephemeral_keys_pkey PRIMARY KEY (run_id);`,
  `ALTER TABLE ONLY public.run_secret_outputs
    ADD CONSTRAINT run_secret_outputs_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.run_secret_outputs
    ADD CONSTRAINT run_secret_outputs_run_id_job_id_output_key_key UNIQUE (run_id, job_id, output_key);`,
  `ALTER TABLE ONLY public.scoped_secrets
    ADD CONSTRAINT scoped_secrets_org_id_scope_key_unique UNIQUE (org_id, scope, key);`,
  `ALTER TABLE ONLY public.scoped_secrets
    ADD CONSTRAINT scoped_secrets_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.secret_audit_log
    ADD CONSTRAINT secret_audit_log_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.secret_backends
    ADD CONSTRAINT secret_backends_name_key UNIQUE (name);`,
  `ALTER TABLE ONLY public.secret_backends
    ADD CONSTRAINT secret_backends_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_routing_key_key UNIQUE (routing_key);`,
  `ALTER TABLE ONLY public.test_uploads
    ADD CONSTRAINT test_uploads_pkey PRIMARY KEY (id);`,
  `ALTER TABLE ONLY public.test_uploads
    ADD CONSTRAINT test_uploads_upload_id_key UNIQUE (upload_id);`,
  `ALTER TABLE ONLY public.workflow_registrations
    ADD CONSTRAINT uq_wf_reg_routing_repo_wf UNIQUE (routing_key, repo_identifier, workflow_name);`,
  `ALTER TABLE ONLY public.workflow_registrations
    ADD CONSTRAINT workflow_registrations_pkey PRIMARY KEY (id);`,
  `CREATE INDEX dedup_cache_expires_at_idx ON public.dedup_cache USING btree (expires_at);`,
  `CREATE INDEX dispatch_queue_status_created_at_idx ON public.dispatch_queue USING btree (status, created_at);`,
  `CREATE INDEX event_log_expires_at_idx ON public.event_log USING btree (expires_at);`,
  `CREATE UNIQUE INDEX event_log_org_delivery_idx ON public.event_log USING btree (org_id, delivery_id);`,
  `CREATE INDEX event_log_org_received_idx ON public.event_log USING btree (org_id, received_at DESC);`,
  `CREATE INDEX execution_runs_original_run_id_idx ON public.execution_runs USING btree (original_run_id);`,
  `CREATE INDEX held_runs_org_id_status_idx ON public.held_runs USING btree (org_id, status);`,
  `CREATE INDEX held_runs_org_queue_type_status_idx ON public.held_runs USING btree (org_id, queue_type, status);`,
  `CREATE INDEX idx_agent_tokens_hash ON public.agent_tokens USING btree (token_hash);`,
  `CREATE INDEX idx_agent_tokens_type ON public.agent_tokens USING btree (agent_type);`,
  `CREATE INDEX idx_concurrency_groups_key ON public.concurrency_groups USING btree (group_key, routing_key, status);`,
  `CREATE INDEX idx_concurrency_groups_run_id ON public.concurrency_groups USING btree (run_id);`,
  `CREATE INDEX idx_config_versions_created_at ON public.config_versions USING btree (created_at DESC);`,
  `CREATE INDEX idx_config_versions_version ON public.config_versions USING btree (version DESC);`,
  `CREATE INDEX idx_dispatch_queue_labels_gin ON public.dispatch_queue USING gin (runs_on_labels);`,
  `CREATE INDEX idx_dispatch_queue_status_created ON public.dispatch_queue USING btree (status, created_at) WHERE (status = 'dispatched'::text);`,
  `CREATE INDEX idx_ej_needs_satisfied ON public.execution_jobs USING btree (run_id, needs_satisfied) WHERE (needs_satisfied = false);`,
  `CREATE INDEX idx_ejn_job ON public.execution_job_needs USING btree (run_id, job_name);`,
  `CREATE INDEX idx_ejn_upstream ON public.execution_job_needs USING btree (run_id, upstream_name);`,
  `CREATE INDEX idx_execution_jobs_heartbeat ON public.execution_jobs USING btree (status, last_heartbeat_at) WHERE (status = 'running'::text);`,
  `CREATE INDEX idx_execution_jobs_run_id ON public.execution_jobs USING btree (run_id);`,
  `CREATE INDEX idx_execution_jobs_status ON public.execution_jobs USING btree (status);`,
  `CREATE INDEX idx_execution_jobs_status_created ON public.execution_jobs USING btree (status, created_at) WHERE (status = 'running'::text);`,
  `CREATE UNIQUE INDEX idx_execution_jobs_unique ON public.execution_jobs USING btree (run_id, job_id);`,
  `CREATE INDEX idx_execution_runs_is_test_run ON public.execution_runs USING btree (is_test_run);`,
  `CREATE INDEX idx_execution_runs_repo ON public.execution_runs USING btree (repo_identifier);`,
  `CREATE INDEX idx_execution_runs_routing_key ON public.execution_runs USING btree (routing_key);`,
  `CREATE INDEX idx_execution_runs_run_id ON public.execution_runs USING btree (run_id);`,
  `CREATE INDEX idx_execution_runs_sha ON public.execution_runs USING btree (sha);`,
  `CREATE INDEX idx_execution_runs_status ON public.execution_runs USING btree (status);`,
  `CREATE INDEX idx_execution_steps_job_id ON public.execution_steps USING btree (job_id);`,
  `CREATE INDEX idx_execution_steps_run_id ON public.execution_steps USING btree (run_id);`,
  `CREATE UNIQUE INDEX idx_execution_steps_unique ON public.execution_steps USING btree (run_id, job_id, step_index);`,
  `CREATE UNIQUE INDEX idx_generic_webhook_sources_customer_name ON public.generic_webhook_sources USING btree (customer_id, name) WHERE (deleted_at IS NULL);`,
  `CREATE INDEX idx_join_tokens_hash ON public.join_tokens USING btree (token_hash);`,
  `CREATE INDEX idx_kici_events_expiry ON public.kici_events USING btree (expires_at);`,
  `CREATE INDEX idx_kici_events_routing ON public.kici_events USING btree (event_name, processed, created_at);`,
  `CREATE INDEX idx_kici_events_source ON public.kici_events USING btree (source_routing_key, event_name);`,
  `CREATE INDEX idx_peer_credentials_hash ON public.peer_credentials USING btree (credential_hash);`,
  `CREATE INDEX idx_peer_credentials_instance ON public.peer_credentials USING btree (instance_id);`,
  `CREATE INDEX idx_run_secret_outputs_run_id ON public.run_secret_outputs USING btree (run_id);`,
  `CREATE INDEX idx_secret_audit_log_context_name ON public.secret_audit_log USING btree (context_name);`,
  `CREATE INDEX idx_secret_audit_log_timestamp ON public.secret_audit_log USING btree ("timestamp");`,
  `CREATE INDEX idx_secret_backends_name ON public.secret_backends USING btree (name);`,
  `CREATE INDEX idx_test_uploads_expires_at ON public.test_uploads USING btree (expires_at);`,
  `CREATE INDEX idx_test_uploads_upload_id ON public.test_uploads USING btree (upload_id);`,
  `CREATE INDEX idx_wf_reg_triggers ON public.workflow_registrations USING gin (trigger_types);`,
  `CREATE INDEX idx_workflow_registrations_customer_id ON public.workflow_registrations USING btree (customer_id);`,
  `CREATE INDEX idx_workflow_registrations_customer_id_webhook ON public.workflow_registrations USING btree (customer_id) WHERE ('webhook'::text = ANY (trigger_types));`,
  `CREATE INDEX idx_workflow_registrations_is_global ON public.workflow_registrations USING btree (is_global, routing_key) WHERE (is_global = true);`,
  `CREATE INDEX ip_allocations_vm_id_idx ON public.ip_allocations USING btree (vm_id);`,
  `CREATE INDEX sources_customer_id_idx ON public.sources USING btree (customer_id);`,
  `CREATE INDEX sources_provider_idx ON public.sources USING btree (provider);`,
  `CREATE TRIGGER source_secrets_change_trigger AFTER INSERT OR UPDATE ON public.scoped_secrets FOR EACH ROW EXECUTE FUNCTION public.notify_source_secrets_change();`,
  `CREATE TRIGGER sources_change_trigger AFTER INSERT OR DELETE OR UPDATE ON public.sources FOR EACH ROW EXECUTE FUNCTION public.notify_sources_change();`,
  `ALTER TABLE ONLY public.cron_last_fired
    ADD CONSTRAINT cron_last_fired_registration_id_fkey FOREIGN KEY (registration_id) REFERENCES public.workflow_registrations(id) ON DELETE CASCADE;`,
  `ALTER TABLE ONLY public.environment_bindings
    ADD CONSTRAINT environment_bindings_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;`,
  `ALTER TABLE ONLY public.environment_source_overrides
    ADD CONSTRAINT environment_source_overrides_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;`,
  `ALTER TABLE ONLY public.environment_variables
    ADD CONSTRAINT environment_variables_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;`,
  `ALTER TABLE ONLY public.execution_jobs
    ADD CONSTRAINT execution_jobs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.execution_runs(run_id);`,
  `ALTER TABLE ONLY public.execution_runs
    ADD CONSTRAINT execution_runs_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES public.execution_runs(run_id);`,
  `ALTER TABLE ONLY public.held_runs
    ADD CONSTRAINT held_runs_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id);`,
];

export async function up(db: Kysely<any>): Promise<void> {
  for (const stmt of DDL_STATEMENTS) {
    await sql.raw(stmt).execute(db);
  }

  await sql`
    INSERT INTO cluster_meta (key, value)
    VALUES ('cluster_id', gen_random_uuid()::text)
    ON CONFLICT (key) DO NOTHING
  `.execute(db);

  await sql`
    INSERT INTO registry_versions (id, version)
    VALUES ('default', 0)
    ON CONFLICT (id) DO NOTHING
  `.execute(db);

  await sql`
    INSERT INTO secret_backends (name, backend_type, config_encrypted, scope_filter)
    VALUES ('pg', 'pg', '', '**')
    ON CONFLICT (name) DO NOTHING
  `.execute(db);
}

/**
 * Rollback drops everything created above. Uses CASCADE on table drops to cut
 * through the FK graph without relying on exact topological order.
 */
export async function down(db: Kysely<any>): Promise<void> {
  // Drop triggers first (they reference functions).
  const triggers: Array<[string, string]> = [
    ['source_secrets_change_trigger', 'scoped_secrets'],
    ['sources_change_trigger', 'sources'],
  ];
  for (const [trig, tbl] of triggers) {
    await sql.raw(`DROP TRIGGER IF EXISTS ${trig} ON public.${tbl}`).execute(db);
  }

  // Drop all tables. CASCADE breaks FK links and drops dependent sequences.
  const dropOrder = [
    'workflow_registrations',
    'test_uploads',
    'sources',
    'secret_backends',
    'secret_audit_log',
    'scoped_secrets',
    'run_secret_outputs',
    'run_ephemeral_keys',
    'registry_versions',
    'raft_state',
    'pending_job_contexts',
    'peer_credentials',
    'org_settings',
    'kici_events',
    'join_tokens',
    'ip_allocations',
    'held_runs',
    'generic_webhook_sources',
    'execution_steps',
    'execution_runs',
    'execution_jobs',
    'execution_job_needs',
    'event_log',
    'environments',
    'environment_variables',
    'environment_source_overrides',
    'environment_bindings',
    'dispatch_queue',
    'dedup_cache',
    'cross_repo_trust',
    'cron_last_fired',
    'config_versions',
    'concurrency_groups',
    'cluster_meta',
    'agent_tokens',
    'admin_tokens',
  ];
  for (const table of dropOrder) {
    await sql.raw(`DROP TABLE IF EXISTS public.${table} CASCADE`).execute(db);
  }

  await sql`DROP SEQUENCE IF EXISTS public.config_versions_version_seq CASCADE`.execute(db);

  // Drop functions last (triggers have been removed already).
  await sql`DROP FUNCTION IF EXISTS public.notify_source_secrets_change() CASCADE`.execute(db);
  await sql`DROP FUNCTION IF EXISTS public.notify_sources_change() CASCADE`.execute(db);
}
