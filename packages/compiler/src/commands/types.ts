import pc from 'picocolors';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadGlobalConfig, type GlobalConfig } from '../remote/config.js';
import {
  DashboardClient,
  DashboardClientError,
  type DashboardErrorKind,
} from '../remote/dashboard-client.js';
import { DirectApiUnavailableError, DirectRunClient } from '../remote/direct-client.js';
import { ConnectionError } from '../remote/platform-client.js';
import { resolveRunTarget, type RunTarget } from '../remote/target.js';
import {
  existingTypesSource,
  mayReplace,
  sourceHeaderLabel,
  type TypesSource,
} from '../remote/types-sources.js';
import { loadLocalSecretContexts } from '../local-plane/secret-seed.js';
import { generateSecretsDts } from '../generators/secrets-dts.js';
import { resolveKiciDir } from '../execution/executor.js';
import type { ContextMetadata } from '../generators/secrets-dts.js';
import { toErrorMessage } from '@kici-dev/core';

/**
 * Error kinds meaning the Platform is genuinely unreachable or the CLI is not
 * configured to reach it — not authenticated, no active org, network down, or
 * orchestrator offline. For these, `kici types` falls back to the local secret
 * files, then to an empty stub, so the declaration file always exists
 * (typecheck degrades to "no known keys" rather than "module has no exported
 * member") instead of failing.
 *
 * An authenticated-but-rejected response (`unauthorized`, `forbidden`, …) is
 * deliberately excluded: that is a real credential/permission problem the user
 * must see, and writing a stub would mask it.
 */
const UNREACHABLE_ERROR_KINDS: readonly DashboardErrorKind[] = [
  'not_logged_in',
  'no_active_org',
  'orchestrator_offline',
  'http',
];

export interface TypesOptions {
  /**
   * Path to the `.kici` directory (defaults to `.kici`). Resolved through
   * `resolveKiciDir`, the same resolver every other command uses, so a
   * relative value is interpreted against the project rather than against
   * whatever directory the CLI happened to be invoked from.
   */
  kiciDir?: string;
  /** Suppress the success line on stdout (so machine-readable output stays pure). */
  quiet?: boolean;
  /** `--orchestrator-url`: read key names from this orchestrator directly. */
  orchestratorUrl?: string;
}

/** Key names from one source, or why that source could not supply them. */
type SourceRead =
  | { kind: 'ok'; source: TypesSource; contexts: ContextMetadata[] }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'refused'; message: string };

async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

/** Read context key names straight from an orchestrator. */
async function readFromOrchestrator(
  target: Extract<RunTarget, { kind: 'direct' }>,
): Promise<SourceRead> {
  const client = new DirectRunClient({ url: target.url, token: target.token });
  try {
    const me = await client.whoami();
    if (!me.orgId) {
      return {
        kind: 'unreachable',
        reason: `The orchestrator at ${client.url} has no organization yet.`,
      };
    }
    const contexts = await client.listContextSecretKeys(me.orgId);
    return { kind: 'ok', source: { kind: 'orchestrator', url: client.url }, contexts };
  } catch (err) {
    if (err instanceof ConnectionError || err instanceof DirectApiUnavailableError) {
      return { kind: 'unreachable', reason: err.message };
    }
    return { kind: 'refused', message: toErrorMessage(err) };
  }
}

/** Read context key names through the Platform login. */
async function readFromPlatform(config: GlobalConfig): Promise<SourceRead> {
  try {
    const client = DashboardClient.fromConfig(config);
    const contexts = await client.listContexts(true);
    return {
      kind: 'ok',
      source: { kind: 'platform', orgId: config.activeOrgId ?? '' },
      contexts: contexts.map((e) => ({ name: e.name, keys: e.secretKeys ?? [] })),
    };
  } catch (err) {
    if (err instanceof DashboardClientError && UNREACHABLE_ERROR_KINDS.includes(err.kind)) {
      return { kind: 'unreachable', reason: err.message };
    }
    if (err instanceof DashboardClientError) return { kind: 'refused', message: err.message };
    throw err;
  }
}

/** Key names from `.kici/.secrets` and `.kici/secrets.yaml` (never values). */
async function readFromLocalFiles(kiciDir: string): Promise<ContextMetadata[]> {
  const contexts = await loadLocalSecretContexts(kiciDir);
  return Object.entries(contexts).map(([name, values]) => ({ name, keys: Object.keys(values) }));
}

/** Read from the remote target (direct orchestrator, else the Platform login). */
async function readRemote(config: GlobalConfig, options: TypesOptions): Promise<SourceRead | null> {
  const resolved = resolveRunTarget({
    flagUrl: options.orchestratorUrl,
    env: process.env,
    config,
  });
  if (!resolved.ok) {
    // An explicit --orchestrator-url that cannot be used is the user's error.
    if (options.orchestratorUrl) return { kind: 'refused', message: resolved.error };
    return readFromPlatform(config);
  }
  return resolved.target.kind === 'direct'
    ? readFromOrchestrator(resolved.target)
    : readFromPlatform(config);
}

/**
 * Generate TypeScript declarations for context secrets.
 *
 * Reads context secret key names from a direct orchestrator target, else the
 * Platform login, else the local secret files, and writes
 * .kici/types/secrets.d.ts with module augmentation for KnownSecretKeys and
 * ContextSecrets. The header names the source. A key set read from an
 * orchestrator or the Platform is never replaced by local files or the
 * offline stub.
 *
 * @param options - Command options
 * @returns true on success, false on error
 */
export async function typesCommand(options: TypesOptions = {}): Promise<boolean> {
  // Resolve before joining. `path.join('.kici', 'types')` is cwd-relative, and
  // `resolveKiciDir` accepts the cwd already being the `.kici` directory, so an
  // unresolved join lands the declarations at `<project>/.kici/.kici/types/` —
  // inside the tree `hashKiciSourceTree` walks and outside the `.kici/types/`
  // prefix it excludes. That poisons the digest the compiler just recorded into
  // the lock file, and every agent re-walking the tree then rejects the run as
  // a stale lock.
  const kiciDir = resolveKiciDir(options.kiciDir);
  const typesDir = path.join(kiciDir, 'types');
  const outputPath = path.join(typesDir, 'secrets.d.ts');
  try {
    const config = await loadGlobalConfig();
    const remote = await readRemote(config, options);
    if (remote?.kind === 'refused') {
      console.error(pc.red(remote.message));
      return false;
    }
    if (remote?.kind === 'ok') {
      return await writeTypes(outputPath, remote.source, remote.contexts, options);
    }
    const reason = remote?.reason ?? 'No orchestrator or Platform is configured.';

    const local = await readFromLocalFiles(kiciDir);
    if (local.length > 0) {
      return await writeTypes(outputPath, { kind: 'local' }, local, options, reason);
    }
    return await writeOfflineStub(outputPath, reason);
  } catch (err: unknown) {
    console.error(pc.red(`Failed to generate types: ${toErrorMessage(err)}`));
    return false;
  }
}

/** Write a key set unless the existing file holds a remote one local files must not replace. */
async function writeTypes(
  outputPath: string,
  source: TypesSource,
  contexts: ContextMetadata[],
  options: TypesOptions,
  fallbackReason?: string,
): Promise<boolean> {
  const incoming = source.kind === 'local' ? 'local' : 'remote';
  const existing = existingTypesSource(await readFileOrNull(outputPath));
  if (!mayReplace(existing, incoming)) {
    console.error(
      pc.yellow(
        `${fallbackReason ? `${fallbackReason} ` : ''}Keeping ${outputPath} from ${existing === 'remote' ? 'an orchestrator or the Platform' : existing}; ` +
          'local secret files never replace a key set read from an orchestrator or the Platform.',
      ),
    );
    return true;
  }
  const dtsContent = generateSecretsDts({ contexts, sourceLabel: sourceHeaderLabel(source) });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, dtsContent, 'utf-8');
  if (fallbackReason) {
    console.error(pc.yellow(`${fallbackReason} Generated types from the local secret files.`));
  }
  if (!options.quiet) {
    console.log(
      pc.green('Types generated') + pc.dim(` ${outputPath} (from ${sourceHeaderLabel(source)})`),
    );
  }
  return true;
}

/**
 * No source supplied key names. Keep an existing declaration file untouched —
 * a transient offline `kici compile` / `kici types` must not clobber a
 * developer's populated types with an empty stub. Only when the file is
 * absent or itself a stub (a fresh clone / unauthenticated CI, where it is
 * gitignored) write a valid empty augmentation, so typecheck degrades to "no
 * known keys" rather than failing with "module has no exported member".
 * Either way, warn but do not fail the command.
 */
async function writeOfflineStub(outputPath: string, reason: string): Promise<boolean> {
  const existing = existingTypesSource(await readFileOrNull(outputPath));
  if (!mayReplace(existing, 'offline')) {
    console.error(
      pc.yellow(
        `${reason} Keeping the existing ${outputPath}; run \`kici types\` when a source is reachable to refresh it.`,
      ),
    );
    return true;
  }
  const stub = generateSecretsDts({ contexts: [], sourceLabel: '', offline: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, stub, 'utf-8');
  console.error(
    pc.yellow(
      `${reason} Wrote an offline type stub to ${outputPath}; run \`kici types\` with \`kici connect\`, \`kici login\` or local secret files to populate it.`,
    ),
  );
  return true;
}
