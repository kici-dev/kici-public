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
      };
    },
  };
}
