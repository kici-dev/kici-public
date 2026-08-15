/**
 * Static migration provider for bundled builds.
 *
 * Rolldown doesn't support dynamic `import()` of migration files at runtime,
 * so we statically import all migrations and provide them to Kysely's Migrator.
 */
import type { Migration, MigrationProvider } from 'kysely/migration';
import * as m001 from './migrations/001_initial.js';
import * as m002 from './migrations/002_config_versions_key_version.js';
import * as m003 from './migrations/003_access_log.js';
import * as m004 from './migrations/004_rename_bundle_to_source.js';
import * as m005 from './migrations/005_cold_store_chunk_counter.js';
import * as m006 from './migrations/006_runs_jobs_steps_archived_at.js';
import * as m007 from './migrations/007_audit_logs_archived_at.js';
import * as m008 from './migrations/008_event_log_archived_at.js';
import * as m009 from './migrations/009_access_log_trigram.js';
import * as m010 from './migrations/010_cold_store_chunks.js';
import * as m011 from './migrations/011_drop_source_secrets_notify.js';
import * as m012 from './migrations/012_peer_credentials_active_uniq.js';
import * as m013 from './migrations/013_execution_log_bytes.js';
import * as m014 from './migrations/014_kici_events_lease_retry.js';
import * as m015 from './migrations/015_org_settings_customer_scoped.js';
import * as m016 from './migrations/016_org_settings_allow_http_npm.js';
import * as m017 from './migrations/017_org_id_widen.js';
import * as m018 from './migrations/018_org_id_prefix_backfill.js';
import * as m019 from './migrations/019_generic_sources_change_notify.js';
import * as m020 from './migrations/020_org_settings_dashboard_write_policy.js';
import * as m021 from './migrations/021_check_run_tracking.js';
import * as m022 from './migrations/022_scaler_manager_state.js';
import * as m023 from './migrations/023_dispatch_queue_recovery_deadline.js';
import * as m024 from './migrations/024_dispatch_queue_provisioning_error.js';
import * as m025 from './migrations/025_init_failure.js';
import * as m026 from './migrations/026_event_log_lockfile_corrupt.js';
import * as m027 from './migrations/027_workflow_timeout.js';
import * as m028 from './migrations/028_org_settings_user_cache.js';
import * as m029 from './migrations/029_dispatch_queue_attempts.js';
import * as m030 from './migrations/030_held_runs_env_set_null.js';
import * as m031 from './migrations/031_dispatch_queue_ack_deadline.js';
import * as m032 from './migrations/032_org_settings_dispatch_ack_timeout.js';
import * as m033 from './migrations/033_org_settings_approval.js';
import * as m034 from './migrations/034_held_runs_generalize.js';
import * as m035 from './migrations/035_pending_workflow_contexts.js';
import * as m036 from './migrations/036_attestations.js';
import * as m037 from './migrations/037_generic_sources_provider_type_local.js';
import * as m038 from './migrations/038_remote_sources.js';
import * as m039 from './migrations/039_host_roster.js';
import * as m040 from './migrations/040_runsonall_pin.js';
import * as m041 from './migrations/041_wave_gated.js';
import * as m042 from './migrations/042_dispatch_queue_patterns.js';
import * as m043 from './migrations/043_rerouted_to_peer.js';
import * as m044 from './migrations/044_check_mode.js';
import * as m045 from './migrations/045_host_properties.js';
import * as m046 from './migrations/046_join_token_consumed_by_instance.js';
import * as m047 from './migrations/047_needs_run_on.js';
import * as m048 from './migrations/048_host_reboot_pending.js';
import * as m049 from './migrations/049_held_runs_payload.js';
import * as m050 from './migrations/050_sources_slug.js';
import * as m051 from './migrations/051_binding_host_pattern.js';
import * as m052 from './migrations/052_host_reach_metadata.js';
import * as m053 from './migrations/053_agent_token_single_use.js';
import * as m054 from './migrations/054_local_working_tree.js';
import * as m055 from './migrations/055_agent_token_mandatory_labels.js';
import * as m056 from './migrations/056_execution_jobs_environments.js';
import * as m057 from './migrations/057_step_concurrency.js';
import * as m058 from './migrations/058_access_log_agent_label.js';
import * as m059 from './migrations/059_attestation_verdict.js';
import * as m060 from './migrations/060_run_trigger_actor.js';
import * as m061 from './migrations/061_execution_runs_environment_id.js';
import * as m062 from './migrations/062_execution_runs_agent_label.js';
import * as m063 from './migrations/063_access_log_agent_label_index.js';
import * as m064 from './migrations/064_execution_jobs_skipped_environments.js';
import * as m065 from './migrations/065_pending_attestations.js';
import * as m066 from './migrations/066_pending_attestations_rejected.js';
import * as m067 from './migrations/067_environments_to_contexts.js';
import * as m068 from './migrations/068_request_idempotency.js';
import * as m069 from './migrations/069_reroute_tunables.js';
import * as m070 from './migrations/070_execution_runs_failure_class.js';
import * as m071 from './migrations/071_batch_accumulation.js';
import * as m072 from './migrations/072_dispatch_queue_run_id_index.js';
import * as m073 from './migrations/073_org_settings_ingest_concurrency.js';
import * as m074 from './migrations/074_normalize_zero_concurrency_limit.js';
import * as m075 from './migrations/075_ingest_overflow_buffer.js';
import * as m076 from './migrations/076_artifacts.js';
import * as m077 from './migrations/077_backup_runs.js';
import * as m078 from './migrations/078_org_settings_backup_staleness.js';
import * as m079 from './migrations/079_org_settings_scaler_spawn_timeout.js';
import * as m080 from './migrations/080_cluster_settings.js';
import * as m081 from './migrations/081_org_settings_queue_timeout.js';
import * as m082 from './migrations/082_host_s3_reachable.js';
import * as m083 from './migrations/083_org_settings_artifact_caps.js';
import * as m084 from './migrations/084_orchestrator_signing_keys.js';
import * as m085 from './migrations/085_cluster_settings_reroute_flap_grace_ms.js';
import * as m086 from './migrations/086_cluster_settings_max_fanout_hosts.js';
import * as m087 from './migrations/087_cluster_settings_event_router_rate_limit.js';
import * as m088 from './migrations/088_cluster_settings_cache_max_tarball_bytes.js';
import * as m089 from './migrations/089_cluster_settings_cache_ttl_days.js';
import * as m090 from './migrations/090_cluster_settings_concurrency_wait_timeout_ms.js';
import * as m091 from './migrations/091_cluster_settings_agent_token_ttl_ms.js';
import * as m092 from './migrations/092_cluster_settings_version.js';
import * as m093 from './migrations/093_org_settings_sandbox_allowlist.js';
import * as m094 from './migrations/094_dashboard_encryption_keys.js';
import * as m095 from './migrations/095_dashboard_write_policy_tristate.js';
import * as m096 from './migrations/096_multi_schedule_cron_last_fired.js';
import * as m097 from './migrations/097_execution_runs_pr_number.js';
import * as m098 from './migrations/098_execution_runs_customer_id.js';
import * as m099 from './migrations/099_cluster_settings_dashboard_verified_issuer.js';
import * as m100 from './migrations/100_held_runs_hold_type_vocabulary.js';
import * as m101 from './migrations/101_contexts_hold_expiry_drop_default.js';
import * as m102 from './migrations/102_dispatch_queue_agent_id.js';
import * as m103 from './migrations/103_cluster_settings_ownership_db_check_timeout_ms.js';
import * as m104 from './migrations/104_check_run_terminal_sent.js';
import * as m105 from './migrations/105_org_trust_policy.js';
import * as m106 from './migrations/106_cluster_settings_check_run_tracking_ttl_days.js';
import * as m107 from './migrations/107_check_run_tracking_updated_at_index.js';
import * as m108 from './migrations/108_unroutable_fast_fail.js';
import * as m109 from './migrations/109_cluster_settings_cache_knobs.js';
import * as m110 from './migrations/110_cluster_settings_global_eval_knobs.js';
import * as m111 from './migrations/111_cluster_settings_global_eval_wait.js';
import * as m112 from './migrations/112_execution_runs_workflow_repo.js';
import * as m113 from './migrations/113_execution_runs_workflow_repo_index.js';
import * as m114 from './migrations/114_ingest_queue_claim.js';
import * as m115 from './migrations/115_global_workflows_cluster_switch.js';

export function createMigrationProvider(): MigrationProvider {
  return {
    async getMigrations(): Promise<Record<string, Migration>> {
      return {
        '001_initial': m001,
        '002_config_versions_key_version': m002,
        '003_access_log': m003,
        '004_rename_bundle_to_source': m004,
        '005_cold_store_chunk_counter': m005,
        '006_runs_jobs_steps_archived_at': m006,
        '007_audit_logs_archived_at': m007,
        '008_event_log_archived_at': m008,
        '009_access_log_trigram': m009,
        '010_cold_store_chunks': m010,
        '011_drop_source_secrets_notify': m011,
        '012_peer_credentials_active_uniq': m012,
        '013_execution_log_bytes': m013,
        '014_kici_events_lease_retry': m014,
        '015_org_settings_customer_scoped': m015,
        '016_org_settings_allow_http_npm': m016,
        '017_org_id_widen': m017,
        '018_org_id_prefix_backfill': m018,
        '019_generic_sources_change_notify': m019,
        '020_org_settings_dashboard_write_policy': m020,
        '021_check_run_tracking': m021,
        '022_scaler_manager_state': m022,
        '023_dispatch_queue_recovery_deadline': m023,
        '024_dispatch_queue_provisioning_error': m024,
        '025_init_failure': m025,
        '026_event_log_lockfile_corrupt': m026,
        '027_workflow_timeout': m027,
        '028_org_settings_user_cache': m028,
        '029_dispatch_queue_attempts': m029,
        '030_held_runs_env_set_null': m030,
        '031_dispatch_queue_ack_deadline': m031,
        '032_org_settings_dispatch_ack_timeout': m032,
        '033_org_settings_approval': m033,
        '034_held_runs_generalize': m034,
        '035_pending_workflow_contexts': m035,
        '036_attestations': m036,
        '037_generic_sources_provider_type_local': m037,
        '038_remote_sources': m038,
        '039_host_roster': m039,
        '040_runsonall_pin': m040,
        '041_wave_gated': m041,
        '042_dispatch_queue_patterns': m042,
        '043_rerouted_to_peer': m043,
        '044_check_mode': m044,
        '045_host_properties': m045,
        '046_join_token_consumed_by_instance': m046,
        '047_needs_run_on': m047,
        '048_host_reboot_pending': m048,
        '049_held_runs_payload': m049,
        '050_sources_slug': m050,
        '051_binding_host_pattern': m051,
        '052_host_reach_metadata': m052,
        '053_agent_token_single_use': m053,
        '054_local_working_tree': m054,
        '055_agent_token_mandatory_labels': m055,
        '056_execution_jobs_environments': m056,
        '057_step_concurrency': m057,
        '058_access_log_agent_label': m058,
        '059_attestation_verdict': m059,
        '060_run_trigger_actor': m060,
        '061_execution_runs_environment_id': m061,
        '062_execution_runs_agent_label': m062,
        '063_access_log_agent_label_index': m063,
        '064_execution_jobs_skipped_environments': m064,
        '065_pending_attestations': m065,
        '066_pending_attestations_rejected': m066,
        '067_environments_to_contexts': m067,
        '068_request_idempotency': m068,
        '069_reroute_tunables': m069,
        '070_execution_runs_failure_class': m070,
        '071_batch_accumulation': m071,
        '072_dispatch_queue_run_id_index': m072,
        '073_org_settings_ingest_concurrency': m073,
        '074_normalize_zero_concurrency_limit': m074,
        '075_ingest_overflow_buffer': m075,
        '076_artifacts': m076,
        '077_backup_runs': m077,
        '078_org_settings_backup_staleness': m078,
        '079_org_settings_scaler_spawn_timeout': m079,
        '080_cluster_settings': m080,
        '081_org_settings_queue_timeout': m081,
        '082_host_s3_reachable': m082,
        '083_org_settings_artifact_caps': m083,
        '084_orchestrator_signing_keys': m084,
        '085_cluster_settings_reroute_flap_grace_ms': m085,
        '086_cluster_settings_max_fanout_hosts': m086,
        '087_cluster_settings_event_router_rate_limit': m087,
        '088_cluster_settings_cache_max_tarball_bytes': m088,
        '089_cluster_settings_cache_ttl_days': m089,
        '090_cluster_settings_concurrency_wait_timeout_ms': m090,
        '091_cluster_settings_agent_token_ttl_ms': m091,
        '092_cluster_settings_version': m092,
        '093_org_settings_sandbox_allowlist': m093,
        '094_dashboard_encryption_keys': m094,
        '095_dashboard_write_policy_tristate': m095,
        '096_multi_schedule_cron_last_fired': m096,
        '097_execution_runs_pr_number': m097,
        '098_execution_runs_customer_id': m098,
        '099_cluster_settings_dashboard_verified_issuer': m099,
        '100_held_runs_hold_type_vocabulary': m100,
        '101_contexts_hold_expiry_drop_default': m101,
        '102_dispatch_queue_agent_id': m102,
        '103_cluster_settings_ownership_db_check_timeout_ms': m103,
        '104_check_run_terminal_sent': m104,
        '105_org_trust_policy': m105,
        '106_cluster_settings_check_run_tracking_ttl_days': m106,
        '107_check_run_tracking_updated_at_index': m107,
        '108_unroutable_fast_fail': m108,
        '109_cluster_settings_cache_knobs': m109,
        '110_cluster_settings_global_eval_knobs': m110,
        '111_cluster_settings_global_eval_wait': m111,
        '112_execution_runs_workflow_repo': m112,
        '113_execution_runs_workflow_repo_index': m113,
        '114_ingest_queue_claim': m114,
        '115_global_workflows_cluster_switch': m115,
      };
    },
  };
}
