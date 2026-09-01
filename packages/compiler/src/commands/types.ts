import pc from 'picocolors';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadGlobalConfig } from '../remote/config.js';
import {
  DashboardClient,
  DashboardClientError,
  type DashboardErrorKind,
} from '../remote/dashboard-client.js';
import { generateSecretsDts } from '../generators/secrets-dts.js';
import type { ContextMetadata } from '../generators/secrets-dts.js';
import { toErrorMessage } from '@kici-dev/core';

/**
 * Error kinds meaning the Platform is genuinely unreachable or the CLI is not
 * configured to reach it — not authenticated, no active org, network down, or
 * orchestrator offline. For these, `kici types` writes a valid empty stub so
 * the declaration file always exists (typecheck degrades to "no known keys"
 * rather than "module has no exported member") instead of failing.
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

/** True if `p` exists (any type). Used to avoid clobbering a real snapshot. */
async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface TypesOptions {
  /** Path to .kici directory (defaults to .kici) */
  kiciDir?: string;
  /** Suppress the success line on stdout (so machine-readable output stays pure). */
  quiet?: boolean;
}

/**
 * Generate TypeScript declarations for context secrets.
 *
 * Fetches context metadata (with secret key names) through the Platform
 * and generates .kici/types/secrets.d.ts with module augmentation for
 * KnownSecretKeys and ContextSecrets.
 *
 * @param options - Command options
 * @returns true on success, false on error
 */
export async function typesCommand(options: TypesOptions = {}): Promise<boolean> {
  const kiciDir = options.kiciDir ?? '.kici';
  const typesDir = path.join(kiciDir, 'types');
  const outputPath = path.join(typesDir, 'secrets.d.ts');
  try {
    const config = await loadGlobalConfig();
    const client = DashboardClient.fromConfig(config);
    const contexts = await client.listContexts(true);

    const metadata: ContextMetadata[] = contexts.map((e) => ({
      name: e.name,
      keys: e.secretKeys ?? [],
    }));

    const source = config.platformEndpoint ?? config.endpoint ?? 'kici Platform';
    const dtsContent = generateSecretsDts({
      contexts: metadata,
      endpoint: source.replace(/\/+$/, ''),
    });

    await fs.mkdir(typesDir, { recursive: true });
    await fs.writeFile(outputPath, dtsContent, 'utf-8');

    if (!options.quiet) {
      console.log(pc.green('Types generated') + pc.dim(` ${outputPath}`));
    }
    return true;
  } catch (err: unknown) {
    if (err instanceof DashboardClientError && UNREACHABLE_ERROR_KINDS.includes(err.kind)) {
      // The Platform is unreachable / unconfigured. Keep an existing declaration
      // file untouched — a transient offline `kici compile` / `kici types` must
      // not clobber a developer's populated types with an empty stub. Only when
      // the file is absent (a fresh clone / unauthenticated CI, where it is now
      // gitignored) do we write a valid empty augmentation, so typecheck
      // degrades to "no known keys" rather than failing with "module has no
      // exported member". Either way, warn but do not fail the command.
      if (await fileExists(outputPath)) {
        console.error(
          pc.yellow(
            `${err.message} Keeping the existing ${outputPath}; run \`kici types\` when authenticated to refresh it.`,
          ),
        );
        return true;
      }
      const stub = generateSecretsDts({ contexts: [], endpoint: '', offline: true });
      await fs.mkdir(typesDir, { recursive: true });
      await fs.writeFile(outputPath, stub, 'utf-8');
      console.error(
        pc.yellow(
          `${err.message} Wrote an offline type stub to ${outputPath}; run \`kici types\` when authenticated to populate it.`,
        ),
      );
      return true;
    }
    if (err instanceof DashboardClientError) {
      console.error(pc.red(err.message));
      return false;
    }
    console.error(pc.red(`Failed to generate types: ${toErrorMessage(err)}`));
    return false;
  }
}
