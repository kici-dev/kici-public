/**
 * Config management commands for kici-admin.
 *
 * Provides subcommands for orchestrator configuration management:
 *   config seed, get, set, delete, export, validate, diff, history, rollback, reload, init
 *
 * All commands except `validate --offline` and `init` are thin clients over
 * the admin REST API at /admin/config/*.
 *
 * Provider configuration (GitHub Apps, etc.) is managed via the `sources` table
 * and the `kici-admin source` commands, not through config seed.
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';

/**
 * YAML import helper. Uses the 'yaml' package (already a dependency of the orchestrator).
 */
async function parseYaml(content: string): Promise<unknown> {
  const { parse } = await import('yaml');
  return parse(content);
}

async function stringifyYaml(obj: unknown): Promise<string> {
  const { stringify } = await import('yaml');
  return stringify(obj);
}

/**
 * Format output according to the --format option.
 */
function formatOutput(data: unknown, format: string): string {
  switch (format) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'yaml':
      // Synchronous fallback: just use JSON for now; caller can use async version
      return JSON.stringify(data, null, 2);
    case 'table':
    default:
      if (Array.isArray(data)) {
        return formatTable(data);
      }
      return JSON.stringify(data, null, 2);
  }
}

/**
 * Format an array of objects as a simple table.
 */
function formatTable(rows: any[]): string {
  if (rows.length === 0) return 'No results.';

  const keys = Object.keys(rows[0]);
  const header = keys.join(' | ');
  const sep = '-'.repeat(header.length);
  const lines = rows.map((row) => keys.map((k) => String(row[k] ?? '-')).join(' | '));
  return [header, sep, ...lines].join('\n');
}

/**
 * Format diff results as a table.
 */
function formatDiffTable(differences: any[]): string {
  if (differences.length === 0) return 'No differences found.';

  const header = 'Path | Local | Shared';
  const sep = '-'.repeat(60);
  const rows = differences.map((d: any) => {
    const local = d.local === undefined ? '(absent)' : JSON.stringify(d.local).slice(0, 30);
    const shared = d.shared === undefined ? '(absent)' : JSON.stringify(d.shared).slice(0, 30);
    return `${d.path} | ${local} | ${shared}`;
  });
  return [header, sep, ...rows].join('\n');
}

/**
 * Format version history as a table.
 */
function formatHistoryTable(versions: any[]): string {
  if (versions.length === 0) return 'No config versions found.';

  const header = 'Version | Created At | Created By | Description';
  const sep = '-'.repeat(80);
  const rows = versions.map(
    (v: any) =>
      `${v.version} | ${v.createdAt ?? v.created_at ?? '-'} | ${v.createdBy ?? v.created_by ?? '-'} | ${v.description ?? '-'}`,
  );
  return [header, sep, ...rows].join('\n');
}

export function registerConfigCommands(program: Command, getClient: () => AdminApiClient): void {
  const cfg = program.command('config').description('Manage orchestrator configuration');

  // ── 1. config seed ──────────────────────────────────────────────
  cfg
    .command('seed')
    .description('Bulk import shared config from a YAML file')
    .requiredOption('--file <path>', 'Path to YAML config file')
    .option('--description <desc>', 'Change description')
    .option('--format <format>', 'Output format: json|yaml|table', 'json')
    .action(async (opts: { file: string; description?: string; format: string }) => {
      try {
        const content = await readFile(opts.file, 'utf-8');
        const config = (await parseYaml(content)) as Record<string, unknown>;

        if (!config || typeof config !== 'object') {
          console.error('Error: YAML file does not contain a valid config object');
          process.exit(1);
        }

        // Inject sensitive values from env vars
        const injected = injectSecretsFromEnv(config);
        if (injected.length > 0) {
          console.error('Injected sensitive fields from environment variables:');
          for (const path of injected) {
            console.error(`  - ${path}`);
          }
        }

        const result = await getClient().configSeed(config, opts.description);
        console.log(formatOutput(result, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── 2. config get ───────────────────────────────────────────────
  cfg
    .command('get [path]')
    .description('Get current effective config (merged local + shared + env)')
    .option('--format <format>', 'Output format: json|yaml|table', 'json')
    .action(async (path: string | undefined, opts: { format: string }) => {
      try {
        const result = await getClient().configGet(path);
        if (opts.format === 'yaml') {
          const yaml = await stringifyYaml(result.config);
          console.log(yaml);
        } else {
          console.log(formatOutput(result, opts.format));
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── 3. config set ───────────────────────────────────────────────
  cfg
    .command('set <path> <value>')
    .description('Set a single field in the shared config')
    .option('--description <desc>', 'Change description')
    .option('--format <format>', 'Output format: json|yaml|table', 'json')
    .action(async (path: string, value: string, opts: { description?: string; format: string }) => {
      try {
        // Try to parse value as JSON, fall back to string
        let parsedValue: unknown;
        try {
          parsedValue = JSON.parse(value);
        } catch {
          parsedValue = value;
        }

        const result = await getClient().configSet(path, parsedValue, opts.description);
        console.log(formatOutput(result, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── 4. config delete ────────────────────────────────────────────
  cfg
    .command('delete <path>')
    .description('Remove a field from the shared config')
    .option('--description <desc>', 'Change description')
    .option('--format <format>', 'Output format: json|yaml|table', 'json')
    .action(async (path: string, opts: { description?: string; format: string }) => {
      try {
        const result = await getClient().configDelete(path, opts.description);
        console.log(formatOutput(result, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── 5. config export ────────────────────────────────────────────
  cfg
    .command('export')
    .description('Export shared config (sensitive values redacted)')
    .option('--format <format>', 'Output format: json|yaml', 'yaml')
    .action(async (opts: { format: string }) => {
      try {
        const result = await getClient().configExport();
        if (opts.format === 'yaml') {
          const yaml = await stringifyYaml(result.config);
          console.log(yaml);
        } else {
          console.log(formatOutput(result, opts.format));
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── 6. config validate ──────────────────────────────────────────
  cfg
    .command('validate')
    .description('Validate a config file against schema')
    .requiredOption('--file <path>', 'Path to config file')
    .option('--type <type>', 'Schema type: local|shared|full', 'shared')
    .option('--offline', 'Validate locally without contacting orchestrator')
    .option('--format <format>', 'Output format: json|yaml|table', 'json')
    .action(async (opts: { file: string; type: string; offline?: boolean; format: string }) => {
      try {
        const content = await readFile(opts.file, 'utf-8');
        const config = await parseYaml(content);

        if (!config || typeof config !== 'object') {
          console.error('Error: File does not contain a valid config object');
          process.exit(1);
        }

        if (opts.offline) {
          // Offline validation: import schemas directly
          const schemas = await import('../../config/schema.js');
          let schema;
          switch (opts.type) {
            case 'local':
              schema = schemas.localConfigSchema;
              break;
            case 'shared':
              schema = schemas.sharedConfigSchema;
              break;
            case 'full':
              schema = schemas.appConfigSchema;
              break;
            default:
              console.error(`Invalid type: ${opts.type}`);
              process.exit(1);
          }

          const result = schema.safeParse(config);
          if (result.success) {
            console.log(formatOutput({ valid: true }, opts.format));
          } else {
            const errors = result.error.issues.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
              code: e.code,
            }));
            console.log(formatOutput({ valid: false, errors }, opts.format));
            process.exit(1);
          }
        } else {
          // Online validation via API
          const result = await getClient().configValidate(config as object, opts.type);
          console.log(formatOutput(result, opts.format));
          if (!result.valid) process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── 7. config diff ──────────────────────────────────────────────
  cfg
    .command('diff')
    .description('Compare local YAML config vs shared DB config')
    .option('--format <format>', 'Output format: json|yaml|table', 'table')
    .action(async (opts: { format: string }) => {
      try {
        const result = await getClient().configDiff();
        if (opts.format === 'table') {
          console.log(formatDiffTable(result.differences));
        } else {
          console.log(formatOutput(result, opts.format));
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── 8. config history ───────────────────────────────────────────
  cfg
    .command('history')
    .description('Show config version history')
    .option('--limit <n>', 'Maximum versions to show', '20')
    .option('--format <format>', 'Output format: json|yaml|table', 'table')
    .action(async (opts: { limit: string; format: string }) => {
      try {
        const limit = parseInt(opts.limit, 10);
        const result = await getClient().configHistory(limit);
        if (opts.format === 'table') {
          console.log(formatHistoryTable(result.versions));
        } else {
          console.log(formatOutput(result, opts.format));
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── 9. config rollback ──────────────────────────────────────────
  cfg
    .command('rollback')
    .description('Rollback shared config to a specific version')
    .requiredOption('--to <version>', 'Target version number')
    .option('--format <format>', 'Output format: json|yaml|table', 'json')
    .action(async (opts: { to: string; format: string }) => {
      try {
        const version = parseInt(opts.to, 10);
        if (Number.isNaN(version) || version < 1) {
          console.error('Error: --to must be a positive integer');
          process.exit(1);
        }
        const result = await getClient().configRollback(version);
        console.log(formatOutput(result, opts.format));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── 10. config reload ───────────────────────────────────────────
  cfg
    .command('reload')
    .description('Trigger config reload across the cluster')
    .option('--drain', 'Drain in-flight work before reloading')
    .option('--target <instance-id>', 'Target specific instance')
    .option('--format <format>', 'Output format: json|yaml|table', 'json')
    .action(async (opts: { drain?: boolean; target?: string; format: string }) => {
      try {
        const result = await getClient().configReload({
          drain: opts.drain,
          target: opts.target,
        });
        console.log(formatOutput(result, opts.format));
        if (!result.success) process.exit(1);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── 11. config init ─────────────────────────────────────────────
  cfg
    .command('init')
    .description('Generate a starter orchestrator.yaml with commented defaults')
    .option('--output <path>', 'Output file path', './orchestrator.yaml')
    .action(async (opts: { output: string }) => {
      try {
        const template = generateConfigTemplate();
        await writeFile(opts.output, template, 'utf-8');
        console.log(`Config template written to ${opts.output}`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

/**
 * Inject sensitive values from environment variables into the config object.
 * Returns a list of paths that were injected.
 *
 * Note: Provider secrets (GitHub private keys, webhook secrets) are now
 * managed via the sources table and `kici-admin source add`, not config seed.
 */
function injectSecretsFromEnv(config: Record<string, unknown>): string[] {
  const injected: string[] = [];

  // Check for other sensitive env vars
  const platformToken = process.env.KICI_PLATFORM_TOKEN;
  if (platformToken) {
    if (!config.platform) config.platform = {};
    (config.platform as Record<string, unknown>).token = platformToken;
    injected.push('platform.token');
  }

  const secretKey = process.env.KICI_SECRET_KEY;
  if (secretKey) {
    if (!config.secrets) config.secrets = {};
    (config.secrets as Record<string, unknown>).key = secretKey;
    injected.push('secrets.key');
  }

  const bootstrapToken = process.env.KICI_BOOTSTRAP_ADMIN_TOKEN;
  if (bootstrapToken) {
    if (!config.secrets) config.secrets = {};
    (config.secrets as Record<string, unknown>).bootstrapAdminToken = bootstrapToken;
    injected.push('secrets.bootstrapAdminToken');
  }

  const clusterJoinToken = process.env.KICI_CLUSTER_JOIN_TOKEN;
  if (clusterJoinToken) {
    if (!config.cluster) config.cluster = {};
    (config.cluster as Record<string, unknown>).joinToken = clusterJoinToken;
    injected.push('cluster.joinToken');
  }

  return injected;
}

/**
 * Generate a well-commented starter orchestrator.yaml template.
 */
function generateConfigTemplate(): string {
  return `# KiCI Orchestrator Configuration
# ================================
#
# This file defines the local configuration for a single orchestrator instance.
# Shared settings (storage, Platform, etc.) are managed in the database via
# 'kici-admin config seed' and the admin API.
#
# Provider configuration (GitHub Apps) is managed via 'kici-admin source add'.
#
# Config resolution precedence: env var > local YAML > shared DB > defaults
# Env var convention: KICI_<UPPER_SNAKE_CASE> (e.g., KICI_DATABASE_URL)

# Database connection (required)
database:
  url: "postgresql://kici:kici@localhost:5432/kici"

# Instance settings
instance:
  # Unique identifier for this orchestrator instance
  # Default: auto-generated from hostname
  # id: "orch-1"

  # Operating mode: platform | hybrid | independent
  # - platform: connects to KiCI Platform relay for webhook routing
  # - hybrid: Platform relay + direct webhook ingestion
  # - independent: standalone, direct webhook ingestion only
  mode: "platform"

# HTTP server settings
server:
  # Port to listen on (default: 4000)
  port: 4000

  # Base path prefix for all routes (default: "/")
  # basePath: "/kici"

  # Log level: debug | info | warn | error (default: info)
  logLevel: "info"

# Scaler configuration (auto-scaling agents)
# scaler:
#   # Path to scalers.yaml config file
#   configPath: "/etc/kici/scalers.yaml"
#   # Directory for scalers.d/ drop-in configs
#   configDir: "/etc/kici/scalers.d"

# ─── Shared Config (managed via DB, shown here for reference) ───────
#
# These fields are typically managed via 'kici-admin config seed' or
# the admin API, not in this YAML file. They are stored encrypted in
# the database and shared across all orchestrator instances.
#
# platform:
#   url: "wss://relay.kici.dev"
#   # token injected via KICI_PLATFORM_TOKEN
#
# storage:
#   type: "s3"
#   bucket: "kici-cache"
#   endpoint: "http://seaweedfs:3900"
#   forcePathStyle: true
#
# agentAuth: "token"
# agentTokenTtlMs: 3600000
#
# queue:
#   maxDepth: 1000
#   timeoutMs: 600000
#
# lockfileCache:
#   max: 500
#   ttlMs: 3600000
#
# staleDetector:
#   scanIntervalMs: 60000
#   thresholdMultiplier: 2
#   heartbeatIntervalMs: 60000
#
# secrets:
#   # Master encryption key for secrets at rest (64-char hex or base64)
#   # Inject via KICI_SECRET_KEY env var
#   # key: ""
#   # bootstrapAdminToken injected via KICI_BOOTSTRAP_ADMIN_TOKEN
#
# cluster:
#   # Join token for cluster bootstrap
#   # joinToken: ""
#   # credentialFile: "~/.kici/peer-credential"
#   # address: "ws://orch-1:4000"
#   # peers: ["ws://orch-2:4000"]
`;
}
