/**
 * Source management commands for kici-admin.
 *
 * Provides subcommands for webhook source CRUD:
 *   source add github         Add a new GitHub App source
 *   source add generic        Add a new generic webhook source
 *   source list               List all configured sources
 *   source get <id>           Get details of a specific generic source
 *   source update <routingKey> Update a GitHub source
 *   source update-generic <id> Update a generic source
 *   source remove <routingKey> Remove a source (GitHub or generic with --generic flag)
 *   source enable <id>        Enable a generic source
 *   source disable <id>       Disable a generic source
 *
 * Supports multiple secret input modes:
 *   --private-key <value>      Direct value
 *   --private-key @/path/file  Read from file (@ prefix)
 *   --from-env <VAR_NAME>      Read from environment variable
 *   --stdin                    Read from stdin
 */

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { Command } from 'commander';
import type { AdminApiClient, GenericSourceResponse } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';
import { UNIVERSAL_GIT_PRESETS } from '../../providers/universal-git/index.js';
import { LocalSourceConfigSchema } from '../../providers/local/local-source-config.js';
import { buildLocalTriggerRequest, readRepoHead, sendLocalTrigger } from './local-trigger.js';
import { renderPostReceiveHook, installPostReceiveHook } from './local-hook.js';
import { runGithubManifestSetup } from './source-manifest.js';

/** Default orchestrator base URL for the webhook trigger route, matching the
 *  kici-admin global `--url` default. */
const DEFAULT_ORCH_URL = process.env.KICI_ADMIN_URL ?? 'http://localhost:8080';

/** Parse a generic source's git_config (string or object) into a LocalSourceConfig.
 *  Returns null when the row is not a valid local source. */
function parseLocalConfig(
  s: GenericSourceResponse,
): { repoBasePath: string; cloneUrlBase?: string } | null {
  if (s.provider_type !== 'local' || !s.git_config) return null;
  const raw = typeof s.git_config === 'string' ? safeParse(s.git_config) : s.git_config;
  const parsed = LocalSourceConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Short reason shown in `(unavailable — <reason>)` when no webhook URL could be
 * resolved for an added source.
 */
function webhookNoteReason(note: string | undefined): string {
  switch (note) {
    case 'github-ingress-platform-only':
      return 'this orchestrator runs in independent mode';
    case 'platform-no-public-url':
      return 'the Platform has no public webhook URL configured';
    case 'platform-unavailable':
      return 'could not reach the Platform';
    default:
      return 'webhook URL could not be determined';
  }
}

/** Actionable next-step hint paired with {@link webhookNoteReason}. */
function webhookNoteHint(note: string | undefined): string {
  switch (note) {
    case 'github-ingress-platform-only':
      return 'GitHub App ingress is served by the KiCI Platform; find the URL in the dashboard under Sources.';
    case 'platform-unavailable':
      return 'Retry once the orchestrator reconnects, or find the URL in the dashboard under Sources.';
    default:
      return 'Find the webhook URL in the dashboard under Sources.';
  }
}

/**
 * Resolve a secret value from various input modes.
 * Returns undefined if no input mode is specified.
 */
async function resolveSecret(opts: {
  value?: string;
  stdin?: boolean;
  fromEnv?: string;
}): Promise<string | undefined> {
  if (opts.value) {
    // @file: prefix reads from file
    if (opts.value.startsWith('@')) {
      return (await readFile(opts.value.slice(1), 'utf-8')).trim();
    }
    return opts.value;
  }
  if (opts.fromEnv) {
    const val = process.env[opts.fromEnv];
    if (!val) throw new Error(`Environment variable ${opts.fromEnv} is not set`);
    return val;
  }
  if (opts.stdin) {
    return readFromStdin();
  }
  return undefined;
}

async function readFromStdin(): Promise<string> {
  const chunks: string[] = [];
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    chunks.push(line);
  }
  return chunks.join('\n');
}

/** Shape of the `source refresh` route response (one source). */
interface RefreshResultJson {
  routingKey: string;
  changed: boolean;
  oldName: string;
  newName: string;
  oldSlug: string | null;
  newSlug: string;
}

/** Print a `source refresh` result, showing old → new for name + slug. */
function printRefreshResult(r: RefreshResultJson): void {
  if (!r.changed) {
    console.log(`${r.routingKey}: up to date (name "${r.newName}", slug "${r.newSlug}")`);
    return;
  }
  console.log(`${r.routingKey}: updated`);
  if (r.oldName !== r.newName) {
    console.log(`  name: ${r.oldName} → ${r.newName}`);
  }
  if (r.oldSlug !== r.newSlug) {
    console.log(`  slug: ${r.oldSlug ?? '(none)'} → ${r.newSlug}`);
  }
}

/**
 * Format a generic source for display.
 */
function formatGenericSource(s: GenericSourceResponse): void {
  console.log(`  ID:                   ${s.id}`);
  console.log(`  Name:                 ${s.name}`);
  console.log(`  Routing key:          ${s.routing_key}`);
  console.log(`  Org:                  ${s.customer_id}`);
  console.log(`  Enabled:              ${s.enabled}`);
  console.log(`  Verification:         ${s.verification_method}`);
  if (s.event_type_header) console.log(`  Event type header:    ${s.event_type_header}`);
  if (s.event_type_path) console.log(`  Event type path:      ${s.event_type_path}`);
  if (s.idempotency_key_header) console.log(`  Idempotency header:   ${s.idempotency_key_header}`);
  if (s.idempotency_key_path) console.log(`  Idempotency path:     ${s.idempotency_key_path}`);
  console.log(`  Dedup window:         ${s.dedup_window_seconds}s`);
  console.log(`  Max payload:          ${s.max_payload_bytes} bytes`);
  console.log(`  Rate limit:           ${s.rate_limit_rpm} rpm`);
  if (s.allowed_events) {
    try {
      const events = JSON.parse(s.allowed_events);
      console.log(
        `  Allowed events:       ${Array.isArray(events) ? events.join(', ') : s.allowed_events}`,
      );
    } catch {
      console.log(`  Allowed events:       ${s.allowed_events}`);
    }
  }
  try {
    const headers = JSON.parse(s.strip_headers);
    console.log(
      `  Strip headers:        ${Array.isArray(headers) ? headers.join(', ') : s.strip_headers}`,
    );
  } catch {
    console.log(`  Strip headers:        ${s.strip_headers}`);
  }
  console.log(`  Created:              ${s.created_at}`);
  console.log(`  Updated:              ${s.updated_at}`);
  if (s.deleted_at) console.log(`  Deleted:              ${s.deleted_at}`);
  if (s.git_config) {
    let gc: Record<string, unknown> | null = null;
    try {
      gc = typeof s.git_config === 'string' ? JSON.parse(s.git_config) : s.git_config;
    } catch {
      gc = null;
    }
    // A local (`file://`) source stores its config in the same git_config column,
    // discriminated by provider_type='local'. Render its fields, not the
    // universal-git ones.
    if (gc && s.provider_type === 'local') {
      console.log(`  Local (file://):      yes`);
      if (typeof gc.repoBasePath === 'string') {
        console.log(`    Repo base path:     ${gc.repoBasePath}`);
      }
      if (typeof gc.cloneUrlBase === 'string') {
        console.log(`    Clone URL base:     ${gc.cloneUrlBase}`);
      }
    } else if (gc) {
      console.log(`  Universal-git:        yes`);
      if (typeof gc.preset === 'string') {
        console.log(`    Preset:             ${gc.preset}`);
      }
      if (typeof gc.gitUrlTemplate === 'string') {
        console.log(`    Git URL template:   ${gc.gitUrlTemplate}`);
      }
      if (typeof gc.credentialType === 'string') {
        console.log(`    Credential type:    ${gc.credentialType}`);
      }
      const ref = gc.credentialRef as { key?: string; store?: string } | undefined;
      if (ref?.key) {
        console.log(
          `    Credential ref:     ${ref.key}${ref.store ? ` (store=${ref.store})` : ''}`,
        );
      }
      if (typeof gc.sshHostKeyPolicy === 'string') {
        console.log(`    SSH host-key:       ${gc.sshHostKeyPolicy}`);
      }
    }
  }
}

/**
 * Parse a comma-separated string into an array, or return undefined.
 */
function parseCommaSeparated(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read a PEM-ish string from either a literal value or a file (when the
 * value begins with '@'). Used by the --ssh-known-hosts-pem flag, which
 * follows the same @-prefix convention as --private-key / --secret.
 */
async function readPemMaybeFromFile(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  if (value.startsWith('@')) {
    return (await readFile(value.slice(1), 'utf-8')).trim();
  }
  return value;
}

/**
 * Universal-git flag set shared by `source add generic` and
 * `source update-generic`. Assembles a `gitConfig` object from CLI flags,
 * or returns `undefined` if none of the universal-git flags are set.
 *
 * Throws (caught by the caller) with a clear message on required-flag
 * combinations that would otherwise fail at Zod validation later.
 */
async function buildUniversalGitConfigFromOpts(
  opts: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const anyFlag =
    opts.preset ||
    opts.gitUrlTemplate ||
    opts.credentialRef ||
    opts.credentialStore ||
    opts.credentialType ||
    opts.credentialUser ||
    opts.sshHostKeyPolicy ||
    opts.sshKnownHostsPem;
  if (!anyFlag) return undefined;

  const preset = (opts.preset as string | undefined) ?? 'custom';
  const gitUrlTemplate = opts.gitUrlTemplate as string | undefined;
  const credentialRefKey = opts.credentialRef as string | undefined;
  const credentialType = opts.credentialType as string | undefined;

  if (!gitUrlTemplate) {
    throw new Error('--git-url-template is required for universal-git sources');
  }
  if (!credentialRefKey) {
    throw new Error('--credential-ref is required for universal-git sources');
  }
  if (!credentialType) {
    throw new Error('--credential-type is required (pat, basic, or ssh)');
  }

  const sshHostKeyPolicy = (opts.sshHostKeyPolicy as string | undefined) ?? 'accept-new';
  const sshKnownHostsPem = await readPemMaybeFromFile(opts.sshKnownHostsPem as string | undefined);

  const cfg: Record<string, unknown> = {
    preset,
    gitUrlTemplate,
    credentialRef: {
      key: credentialRefKey,
      ...(opts.credentialStore ? { store: opts.credentialStore as string } : {}),
    },
    credentialType,
    sshHostKeyPolicy,
  };
  if (opts.credentialUser) cfg.credentialUser = opts.credentialUser as string;
  if (sshKnownHostsPem) cfg.sshKnownHostsPem = sshKnownHostsPem;
  return cfg;
}

export function registerSourceCommands(program: Command, getClient: () => AdminApiClient): void {
  const src = program.command('source').description('Manage webhook sources');

  // -- source add --
  const add = src.command('add').description('Add a new webhook source');

  // source add github
  add
    .command('github')
    .description('Add a new GitHub App source')
    .requiredOption('--name <name>', 'Human-readable source name')
    .option('--app-id <id>', 'GitHub App ID (omit when using --manifest)')
    .option('--private-key <pathOrValue>', 'Private key (prefix with @ for file path)')
    .option('--webhook-secret <secret>', 'Webhook secret')
    .option('--from-env <varName>', 'Read private key from environment variable')
    .option('--stdin', 'Read private key from stdin')
    .option(
      '--manifest',
      'One-click setup: create and configure a new GitHub App via the App Manifest flow',
    )
    .option('--no-browser', 'Headless manifest setup: print a URL and paste the setup code back')
    .option(
      '--github-org <slug>',
      'Create the App under a GitHub org instead of your personal account',
    )
    .option(
      '--webhook-url <url>',
      'Advanced/self-hosted: bake this https:// URL into the App webhook verbatim and skip ' +
        'platform-mode URL resolution. KiCI adds no ingress at this URL — your own infra owns delivery.',
    )
    .option('--json', 'Emit raw JSON (the API response) instead of formatted text')
    .action(async (opts) => {
      // One-click manifest setup creates AND configures the App for the
      // operator; the manual path below only stores already-created credentials.
      if (opts.manifest) {
        try {
          await runGithubManifestSetup(
            {
              name: opts.name,
              noBrowser: !opts.browser,
              githubOrg: opts.githubOrg,
              webhookUrl: opts.webhookUrl,
            },
            getClient(),
          );
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
        return;
      }
      try {
        if (!opts.appId) {
          console.error('Error: --app-id is required (or use --manifest for one-click setup)');
          process.exit(1);
        }
        const privateKey = await resolveSecret({
          value: opts.privateKey,
          stdin: opts.stdin,
          fromEnv: opts.fromEnv,
        });
        if (!privateKey) {
          console.error('Error: Private key is required (--private-key, --stdin, or --from-env)');
          process.exit(1);
        }

        const result = await getClient().post<{
          routingKey: string;
          name: string;
          webhookUrl: string | null;
          webhookNote?: string;
        }>('/api/v1/admin/sources', {
          provider: 'github',
          name: opts.name,
          appId: opts.appId,
          privateKey,
          webhookSecret: opts.webhookSecret,
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Source added: ${result.routingKey} (${result.name})`);
          if (result.webhookUrl) {
            console.log(`Webhook URL:  ${result.webhookUrl}`);
            console.log(`  ↳ Paste this into your GitHub App's "Webhook URL" field.`);
          } else {
            console.log(`Webhook URL:  (unavailable — ${webhookNoteReason(result.webhookNote)})`);
            console.log(`  ↳ ${webhookNoteHint(result.webhookNote)}`);
          }
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // source add generic
  add
    .command('generic')
    .description('Add a new generic webhook source')
    .requiredOption('--org <orgId>', 'Organization/customer ID')
    .requiredOption('--name <name>', 'Human-readable source name')
    .option(
      '--verification <method>',
      'Verification method: hmac_sha256, bearer_token, ip_allowlist, none',
    )
    .option(
      '--secret <value>',
      'Verification secret (HMAC secret or bearer token, prefix with @ for file)',
    )
    .option('--from-env <varName>', 'Read verification secret from environment variable')
    .option('--stdin', 'Read verification secret from stdin')
    .option('--event-type-header <header>', 'Header name for event type extraction')
    .option('--event-type-path <jsonpath>', 'JSONPath for event type extraction from body')
    .option('--idempotency-key-header <header>', 'Header name for idempotency key')
    .option('--idempotency-key-path <jsonpath>', 'JSONPath for idempotency key from body')
    .option('--dedup-window <seconds>', 'Dedup window in seconds (default: 300)', parseInt)
    .option('--max-payload <bytes>', 'Maximum payload size in bytes (default: 1048576)', parseInt)
    .option('--allowed-events <events>', 'Comma-separated list of allowed event types')
    .option('--strip-headers <headers>', 'Comma-separated list of headers to strip')
    .option('--rate-limit <rpm>', 'Rate limit in requests per minute (default: 600)', parseInt)
    // Universal-git flags (Phase 1): present iff the source should also know
    // how to clone, fetch lock files, and match triggers against a real git
    // server. Supplying --preset or --git-url-template flips this source
    // into a universal-git source; omitting them keeps it payload-only.
    .option(
      '--preset <name>',
      'Universal-git preset: forgejo, gitea, gogs, gitlab-repo, github-repo, custom',
    )
    .option('--git-url-template <url>', 'Clone URL template with {owner}/{name}/{repo}')
    .option('--credential-ref <key>', 'Secret key name (under __source__/<id> scope)')
    .option('--credential-store <backend>', 'Secret backend name (default: pg)')
    .option('--credential-type <type>', 'Credential type: pat, basic, ssh')
    .option('--credential-user <user>', 'Username for PAT/basic auth (default: x-access-token)')
    .option('--ssh-host-key-policy <policy>', 'SSH host-key policy: accept-new, pinned')
    .option(
      '--ssh-known-hosts-pem <pathOrValue>',
      'Pinned SSH known_hosts (prefix with @ for file). Required when --ssh-host-key-policy=pinned',
    )
    .option(
      '--provider-type <type>',
      'Provider implementation: generic (default) or local (a git repo on the agent filesystem cloned via file://)',
    )
    .option('--json', 'Emit raw JSON (the full source row) instead of formatted text')
    .action(async (opts) => {
      try {
        // Build verification config from secret input
        const secret = await resolveSecret({
          value: opts.secret,
          stdin: opts.stdin,
          fromEnv: opts.fromEnv,
        });

        let verificationConfig: Record<string, unknown> | undefined;
        if (secret) {
          const method = opts.verification ?? 'hmac_sha256';
          if (method === 'hmac_sha256') {
            verificationConfig = { secret };
          } else if (method === 'bearer_token') {
            verificationConfig = { token: secret };
          } else if (method === 'ip_allowlist') {
            verificationConfig = { allowlist: secret.split(',').map((s: string) => s.trim()) };
          }
        }

        const data: Record<string, unknown> = {
          orgId: opts.org,
          name: opts.name,
        };
        if (opts.verification) data.verificationMethod = opts.verification;
        if (verificationConfig) data.verificationConfig = verificationConfig;
        if (opts.eventTypeHeader) data.eventTypeHeader = opts.eventTypeHeader;
        if (opts.eventTypePath) data.eventTypePath = opts.eventTypePath;
        if (opts.idempotencyKeyHeader) data.idempotencyKeyHeader = opts.idempotencyKeyHeader;
        if (opts.idempotencyKeyPath) data.idempotencyKeyPath = opts.idempotencyKeyPath;
        if (opts.dedupWindow !== undefined) data.dedupWindowSeconds = opts.dedupWindow;
        if (opts.maxPayload !== undefined) data.maxPayloadBytes = opts.maxPayload;
        if (opts.allowedEvents) data.allowedEvents = parseCommaSeparated(opts.allowedEvents);
        if (opts.stripHeaders) data.stripHeaders = parseCommaSeparated(opts.stripHeaders);
        if (opts.rateLimit !== undefined) data.rateLimitRpm = opts.rateLimit;
        if (opts.providerType) data.providerType = opts.providerType;

        const gitConfig = await buildUniversalGitConfigFromOpts(opts);
        if (gitConfig) data.gitConfig = gitConfig;

        const result = await getClient().createGenericSource(data as any);
        const s = result.source;
        if (opts.json) {
          console.log(JSON.stringify(s, null, 2));
          return;
        }
        console.log(`Generic source created:`);
        console.log(`  ID:           ${s.id}`);
        console.log(`  Name:         ${s.name}`);
        console.log(`  Routing key:  ${s.routing_key}`);
        console.log(`  Org:          ${s.customer_id}`);
        console.log(`  Enabled:      ${s.enabled}`);
        if (gitConfig) {
          console.log(`  Git preset:   ${(gitConfig as { preset: string }).preset}`);
          console.log(
            `  Git URL:      ${(gitConfig as { gitUrlTemplate: string }).gitUrlTemplate}`,
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // source add local
  // Register a git repository present on the agent's filesystem as a file://
  // source. Verification is 'none' by design (no remote forge to sign the
  // payload) — only point it at repos the operator trusts.
  add
    .command('local')
    .description('Register a git repo present on the agent filesystem as a file:// source')
    .requiredOption('--org <orgId>', 'Organization/customer ID')
    .requiredOption(
      '--path <dir>',
      'Absolute path to the repo (or base dir of repos) on the agent filesystem',
    )
    .option('--name <name>', 'Human-readable source name', 'local')
    .option(
      '--clone-url-base <url>',
      'Optional git://|http:// base for remote agents that do not share the orchestrator filesystem (default: file://)',
    )
    .option('--json', 'Emit raw JSON (the full source row) instead of formatted text')
    .action(async (opts) => {
      try {
        if (!path.isAbsolute(opts.path)) {
          console.error(`Error: --path must be an absolute path: ${opts.path}`);
          process.exit(1);
        }
        const localConfig: { repoBasePath: string; cloneUrlBase?: string } = {
          repoBasePath: opts.path,
        };
        if (opts.cloneUrlBase) localConfig.cloneUrlBase = opts.cloneUrlBase;
        const result = await getClient().createGenericSource({
          orgId: opts.org,
          name: opts.name,
          providerType: 'local',
          verificationMethod: 'none',
          localConfig,
        });
        const s = result.source;
        if (opts.json) {
          console.log(JSON.stringify(s, null, 2));
          return;
        }
        console.log(`Local source created:`);
        console.log(`  ID:           ${s.id}`);
        console.log(`  Name:         ${s.name}`);
        console.log(`  Routing key:  ${s.routing_key}`);
        console.log(`  Org:          ${s.customer_id}`);
        console.log(`  Repo path:    ${opts.path}`);
        console.log('');
        console.log(`Trigger runs with: kici-admin source trigger-local ${s.id}`);
        console.log(`Or install a push hook: kici-admin source install-hook ${s.id}`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source list-presets --
  // Dump the built-in universal-git preset table so operators can discover
  // which forge shapes KiCI knows natively without digging into source code.
  // Intentionally local (no network call) — listing presets is a pure code
  // concern and stays operable even when the orchestrator is offline.
  src
    .command('list-presets')
    .description('List built-in universal-git presets (forge shapes supported out of the box)')
    .option('--format <format>', 'Output format: table|json', 'table')
    .action((opts: { format: string }) => {
      const rows = Object.entries(UNIVERSAL_GIT_PRESETS).map(([name, def]) => ({
        preset: name,
        repoIdentifier: def.payloadPaths.repoIdentifier,
        defaultBranch: def.payloadPaths.defaultBranch,
        pushEvents: def.eventMapping.push.join(', '),
        pullRequestEvents: def.eventMapping.pullRequest.join(', '),
      }));

      if (opts.format === 'json') {
        console.log(
          JSON.stringify(
            { presets: rows, custom: 'Requires explicit payloadPaths + eventMapping' },
            null,
            2,
          ),
        );
        return;
      }

      console.log('Universal-git presets:');
      console.log('');
      const header = `  ${'Preset'.padEnd(14)}${'Repo path'.padEnd(34)}${'Push events'.padEnd(22)}PR events`;
      console.log(header);
      console.log('  ' + '-'.repeat(header.length - 2));
      for (const r of rows) {
        console.log(
          `  ${r.preset.padEnd(14)}${r.repoIdentifier.padEnd(34)}${r.pushEvents.padEnd(22)}${r.pullRequestEvents}`,
        );
      }
      console.log('');
      console.log(
        '  custom         (requires --preset custom plus explicit payloadPaths + eventMapping)',
      );
      console.log('');
      console.log('Use with: kici-admin source add generic --preset <name> ...');
    });

  // -- source list --
  src
    .command('list')
    .description('List all configured sources (GitHub and generic)')
    .option('--org <orgId>', 'Filter generic sources by organization ID')
    .option('--include-deleted', 'Include soft-deleted generic sources')
    .option('--json', 'Emit raw JSON ({github: [...], generic: [...]}) instead of formatted text')
    .action(async (opts) => {
      try {
        // List GitHub sources
        const { sources: githubSources } = await getClient().get<{
          sources: Array<{
            id: string;
            routingKey: string;
            name: string;
            provider: string;
            customerId: string;
            config: Record<string, unknown>;
            createdAt: string;
            updatedAt: string;
          }>;
        }>('/api/v1/admin/sources');

        let genericSources: GenericSourceResponse[] = [];
        if (opts.org) {
          const res = await getClient().listGenericSources(opts.org, opts.includeDeleted);
          genericSources = res.sources;
        }

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                github: githubSources,
                generic: genericSources,
              },
              null,
              2,
            ),
          );
          return;
        }

        if (githubSources.length > 0) {
          console.log('GitHub sources:');
          for (const s of githubSources) {
            console.log(`  ${s.routingKey.padEnd(20)} ${s.name.padEnd(30)} (${s.provider})`);
          }
        }

        if (opts.org) {
          if (genericSources.length > 0) {
            if (githubSources.length > 0) console.log('');
            console.log('Generic sources:');
            for (const s of genericSources) {
              const status = s.enabled ? 'enabled' : 'disabled';
              const deleted = s.deleted_at ? ' [deleted]' : '';
              console.log(
                `  ${s.id.padEnd(38)} ${s.name.padEnd(25)} ${status.padEnd(10)} ${s.routing_key}${deleted}`,
              );
            }
          } else if (githubSources.length === 0) {
            console.log('No sources configured.');
          }
        } else if (githubSources.length === 0) {
          console.log('No sources configured.');
          console.log('Tip: use --org <orgId> to also list generic sources.');
        } else {
          console.log('');
          console.log('Tip: use --org <orgId> to also list generic sources.');
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source get-webhook-secret <routingKey> --
  src
    .command('get-webhook-secret <routingKey>')
    .description('Get the webhook secret for a source (for GitHub webhook configuration)')
    .action(async (routingKey: string) => {
      try {
        const result = await getClient().get<{
          routingKey: string;
          webhookSecret: string | null;
        }>(`/api/v1/admin/sources/${encodeURIComponent(routingKey)}/webhook-secret`);

        if (!result.webhookSecret) {
          console.log(`No webhook secret configured for source "${routingKey}".`);
          console.log(
            'Set one with: kici-admin source update <routingKey> --webhook-secret <secret>',
          );
          process.exit(1);
        }

        console.log(result.webhookSecret);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source get <id> --
  src
    .command('get <id>')
    .description('Get details of a generic webhook source')
    .option('--json', 'Emit raw JSON (the full source row) instead of formatted text')
    .action(async (id: string, opts) => {
      try {
        const { source } = await getClient().getGenericSource(id);
        if (opts.json) {
          console.log(JSON.stringify(source, null, 2));
          return;
        }
        console.log('Generic source:');
        formatGenericSource(source);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source update <routingKey> (GitHub sources) --
  src
    .command('update <routingKey>')
    .description('Update a GitHub source')
    .option('--name <name>', 'New name')
    .option('--private-key <pathOrValue>', 'New private key (prefix with @ for file)')
    .option('--webhook-secret <secret>', 'New webhook secret')
    .option('--from-env <varName>', 'Read new private key from environment variable')
    .option('--stdin', 'Read new private key from stdin')
    .option(
      '--customer-id <orgId>',
      'Update the customer/org ID used for secret and environment scoping',
    )
    .action(async (routingKey: string, opts) => {
      try {
        const privateKey = await resolveSecret({
          value: opts.privateKey,
          stdin: opts.stdin,
          fromEnv: opts.fromEnv,
        });
        const body: Record<string, unknown> = {};
        if (opts.name) body.name = opts.name;
        if (privateKey) body.privateKey = privateKey;
        if (opts.webhookSecret) body.webhookSecret = opts.webhookSecret;
        if (opts.customerId) body.customerId = opts.customerId;

        const result = await getClient().patch<{ routingKey: string }>(
          `/api/v1/admin/sources/${encodeURIComponent(routingKey)}`,
          body,
        );
        console.log(`Source updated: ${result.routingKey}`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source refresh <routingKey> --
  // Re-sync a GitHub source's display name + slug from GitHub. GitHub is the
  // source of truth: this fetches `GET /app` now and applies any drift, printing
  // old → new for both fields. With --all, every GitHub source is refreshed.
  src
    .command('refresh [routingKey]')
    .description("Re-sync a GitHub source's name and slug from GitHub (use --all for every source)")
    .option('--all', 'Refresh every GitHub source')
    .option('--json', 'Emit raw JSON instead of formatted text')
    .action(async (routingKey: string | undefined, opts) => {
      try {
        if (opts.all) {
          const res = await getClient().post<{
            results: Array<RefreshResultJson>;
            errors: Array<{ routingKey: string; error: string }>;
          }>('/api/v1/admin/sources/refresh-all', {});
          if (opts.json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          for (const r of res.results) printRefreshResult(r);
          for (const e of res.errors) {
            console.error(`  ${e.routingKey}: ${e.error}`);
          }
          if (res.results.length === 0 && res.errors.length === 0) {
            console.log('No GitHub sources to refresh.');
          }
          return;
        }

        if (!routingKey) {
          console.error('Error: provide a <routingKey> or use --all');
          process.exit(1);
        }
        const result = await getClient().post<RefreshResultJson>(
          `/api/v1/admin/sources/${encodeURIComponent(routingKey)}/refresh`,
          {},
        );
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printRefreshResult(result);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source update-generic <id> --
  src
    .command('update-generic <id>')
    .description('Update a generic webhook source')
    .option('--name <name>', 'New name')
    .option(
      '--verification <method>',
      'Verification method: hmac_sha256, bearer_token, ip_allowlist, none',
    )
    .option('--secret <value>', 'New verification secret (prefix with @ for file)')
    .option('--from-env <varName>', 'Read verification secret from environment variable')
    .option('--stdin', 'Read verification secret from stdin')
    .option('--event-type-header <header>', 'Header name for event type extraction')
    .option('--event-type-path <jsonpath>', 'JSONPath for event type extraction from body')
    .option('--idempotency-key-header <header>', 'Header name for idempotency key')
    .option('--idempotency-key-path <jsonpath>', 'JSONPath for idempotency key from body')
    .option('--dedup-window <seconds>', 'Dedup window in seconds', parseInt)
    .option('--max-payload <bytes>', 'Maximum payload size in bytes', parseInt)
    .option('--allowed-events <events>', 'Comma-separated list of allowed event types')
    .option('--strip-headers <headers>', 'Comma-separated list of headers to strip')
    .option('--rate-limit <rpm>', 'Rate limit in requests per minute', parseInt)
    // Universal-git flags mirror `source add generic`. Supplying any of them
    // re-validates the full gitConfig; pass --clear-git-config to revert the
    // source to payload-only.
    .option('--preset <name>', 'Universal-git preset')
    .option('--git-url-template <url>', 'Clone URL template')
    .option('--credential-ref <key>', 'Secret key name')
    .option('--credential-store <backend>', 'Secret backend name')
    .option('--credential-type <type>', 'Credential type: pat, basic, ssh')
    .option('--credential-user <user>', 'Username for PAT/basic auth')
    .option('--ssh-host-key-policy <policy>', 'SSH host-key policy: accept-new, pinned')
    .option(
      '--ssh-known-hosts-pem <pathOrValue>',
      'Pinned SSH known_hosts (prefix with @ for file)',
    )
    .option('--clear-git-config', 'Revert this source back to a payload-only generic webhook')
    .option(
      '--provider-type <type>',
      'Provider implementation: generic (default) or local (a git repo on the agent filesystem cloned via file://)',
    )
    .option('--json', 'Emit raw JSON (the full source row) instead of formatted text')
    .action(async (id: string, opts) => {
      try {
        const secret = await resolveSecret({
          value: opts.secret,
          stdin: opts.stdin,
          fromEnv: opts.fromEnv,
        });

        if (secret && !opts.verification) {
          console.error(
            'Error: --verification is required when updating --secret (needed to format the config correctly)',
          );
          process.exit(1);
        }

        const data: Record<string, unknown> = {};
        if (opts.name) data.name = opts.name;
        if (opts.verification) data.verificationMethod = opts.verification;
        if (secret) {
          const method = opts.verification;
          if (method === 'bearer_token') {
            data.verificationConfig = { token: secret };
          } else if (method === 'ip_allowlist') {
            data.verificationConfig = { allowlist: secret.split(',').map((s: string) => s.trim()) };
          } else {
            data.verificationConfig = { secret };
          }
        }
        if (opts.eventTypeHeader) data.eventTypeHeader = opts.eventTypeHeader;
        if (opts.eventTypePath) data.eventTypePath = opts.eventTypePath;
        if (opts.idempotencyKeyHeader) data.idempotencyKeyHeader = opts.idempotencyKeyHeader;
        if (opts.idempotencyKeyPath) data.idempotencyKeyPath = opts.idempotencyKeyPath;
        if (opts.dedupWindow !== undefined) data.dedupWindowSeconds = opts.dedupWindow;
        if (opts.maxPayload !== undefined) data.maxPayloadBytes = opts.maxPayload;
        if (opts.allowedEvents) data.allowedEvents = parseCommaSeparated(opts.allowedEvents);
        if (opts.stripHeaders) data.stripHeaders = parseCommaSeparated(opts.stripHeaders);
        if (opts.rateLimit !== undefined) data.rateLimitRpm = opts.rateLimit;
        if (opts.providerType) data.providerType = opts.providerType;

        if (opts.clearGitConfig) {
          data.gitConfig = null;
        } else {
          const gitConfig = await buildUniversalGitConfigFromOpts(opts);
          if (gitConfig) data.gitConfig = gitConfig;
        }

        if (Object.keys(data).length === 0) {
          console.error('Error: no fields to update. Provide at least one option.');
          process.exit(1);
        }

        const result = await getClient().updateGenericSource(id, data as any);
        if (opts.json) {
          console.log(JSON.stringify(result.source, null, 2));
        } else {
          console.log(`Generic source updated: ${result.source.id} (${result.source.name})`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source update-local <id> --
  // Update a local (file://) source's repoBasePath / cloneUrlBase.
  src
    .command('update-local <id>')
    .description('Update a local filesystem (file://) source')
    .option('--name <name>', 'New name')
    .option('--path <dir>', 'New absolute repo base path on the agent filesystem')
    .option('--clone-url-base <url>', 'New git://|http:// clone base (default: file://)')
    .option('--json', 'Emit raw JSON (the full source row) instead of formatted text')
    .action(async (id: string, opts) => {
      try {
        const data: Record<string, unknown> = {};
        if (opts.name) data.name = opts.name;
        if (opts.path !== undefined) {
          if (!path.isAbsolute(opts.path)) {
            console.error(`Error: --path must be an absolute path: ${opts.path}`);
            process.exit(1);
          }
          const localConfig: { repoBasePath: string; cloneUrlBase?: string } = {
            repoBasePath: opts.path,
          };
          if (opts.cloneUrlBase) localConfig.cloneUrlBase = opts.cloneUrlBase;
          data.localConfig = localConfig;
        }
        if (Object.keys(data).length === 0) {
          console.error('Error: no fields to update. Provide --path and/or --name.');
          process.exit(1);
        }
        const result = await getClient().updateGenericSource(id, data as any);
        if (opts.json) {
          console.log(JSON.stringify(result.source, null, 2));
        } else {
          console.log(`Local source updated: ${result.source.id} (${result.source.name})`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source remove <routingKey> --
  src
    .command('remove <routingKey>')
    .description('Remove a source (GitHub, or generic/local with --generic / --local)')
    .option('--yes', 'Skip confirmation')
    .option('--generic', 'Remove a generic source (routingKey is treated as source ID)')
    .option('--local', 'Remove a local (file://) source (routingKey is treated as source ID)')
    .option('--hard', 'Permanently delete a generic/local source (requires --generic or --local)')
    .action(async (routingKey: string, opts) => {
      try {
        if (!opts.yes) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(`Remove source "${routingKey}"? (y/N) `, resolve);
          });
          rl.close();
          if (answer.toLowerCase() !== 'y') {
            console.log('Cancelled.');
            return;
          }
        }

        // Local sources are generic_webhook_sources rows, so they soft/hard
        // delete through the same admin endpoint as --generic.
        if (opts.generic || opts.local) {
          const result = await getClient().deleteGenericSource(routingKey, opts.hard);
          const mode = result.hard ? 'permanently deleted' : 'soft-deleted';
          const kind = opts.local ? 'Local' : 'Generic';
          console.log(`${kind} source ${mode}: ${routingKey}`);
        } else {
          if (opts.hard) {
            console.error('Error: --hard flag is only supported with --generic / --local');
            process.exit(1);
          }
          await getClient().delete(`/api/v1/admin/sources/${encodeURIComponent(routingKey)}`);
          console.log(`Source removed: ${routingKey}`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source enable <id> --
  src
    .command('enable <id>')
    .description('Enable a generic webhook source')
    .action(async (id: string) => {
      try {
        await getClient().enableGenericSource(id);
        console.log(`Generic source enabled: ${id}`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source disable <id> --
  src
    .command('disable <id>')
    .description('Disable a generic webhook source')
    .action(async (id: string) => {
      try {
        await getClient().disableGenericSource(id);
        console.log(`Generic source disabled: ${id}`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source trigger-local <id> --
  // Drive a run against a local source by POSTing a synthetic GitHub-shaped
  // webhook to the orchestrator's generic webhook route. When --ref/--sha are
  // omitted, HEAD is read from the local repo (so this must run where the repo
  // is reachable).
  src
    .command('trigger-local <id>')
    .description('Trigger a run against a local source (reads HEAD when --ref/--sha omitted)')
    .option('--event <event>', 'push | pull_request', 'push')
    .option('--ref <ref>', 'Git ref (default: repo HEAD branch)')
    .option('--sha <sha>', 'Commit SHA (default: repo HEAD)')
    .option('--repo-full-name <name>', 'owner/name identifier used in the payload', 'local/repo')
    .option('--base-url <url>', 'Orchestrator base URL', DEFAULT_ORCH_URL)
    .action(async (id: string, opts) => {
      try {
        const { source } = await getClient().getGenericSource(id);
        const cfg = parseLocalConfig(source);
        if (!cfg) {
          console.error(`Error: no local source with id ${id}`);
          process.exit(1);
        }
        const head =
          opts.ref && opts.sha ? { ref: opts.ref, sha: opts.sha } : readRepoHead(cfg.repoBasePath);
        // The generic webhook route resolves a source by (customer_id, name) —
        // NOT by the routing key's id segment — so the trigger URL must carry
        // the source's org + name.
        const orgId = source.customer_id;
        const sourceId = source.name;
        const req = buildLocalTriggerRequest({
          orgId,
          sourceId,
          repoFullName: opts.repoFullName,
          event: opts.event === 'pull_request' ? 'pull_request' : 'push',
          ref: head.ref,
          sha: head.sha,
          defaultBranch: head.ref.replace('refs/heads/', ''),
        });
        const status = await sendLocalTrigger(opts.baseUrl, req);
        console.log(`Triggered local source ${id}: HTTP ${status}`);
        if (status >= 400) process.exit(1);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // -- source install-hook <id> --
  // Write a post-receive hook into the local repo so every push triggers a run.
  src
    .command('install-hook <id>')
    .description('Install a post-receive hook in the local source repo that triggers runs on push')
    .option('--repo <path>', 'Repo path (default: the source repoBasePath)')
    .option('--base-url <url>', 'Orchestrator base URL', DEFAULT_ORCH_URL)
    .action(async (id: string, opts) => {
      try {
        const { source } = await getClient().getGenericSource(id);
        const cfg = parseLocalConfig(source);
        if (!cfg) {
          console.error(`Error: no local source with id ${id}`);
          process.exit(1);
        }
        const repoPath = opts.repo ?? cfg.repoBasePath;
        const script = renderPostReceiveHook({ sourceId: id, baseUrl: opts.baseUrl });
        const hookPath = installPostReceiveHook(repoPath, script);
        console.log(`Installed post-receive hook: ${hookPath}`);
        console.log(`Every push to ${repoPath} will now trigger a run for source ${id}.`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
