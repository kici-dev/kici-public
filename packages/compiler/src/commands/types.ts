import pc from 'picocolors';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadGlobalConfig } from '../remote/config.js';
import { DashboardClient, DashboardClientError } from '../remote/dashboard-client.js';
import { generateSecretsDts } from '../generators/secrets-dts.js';
import type { EnvironmentMetadata } from '../generators/secrets-dts.js';
import { toErrorMessage } from '@kici-dev/core';

export interface TypesOptions {
  /** Path to .kici directory (defaults to .kici) */
  kiciDir?: string;
  /** Suppress the success line on stdout (so machine-readable output stays pure). */
  quiet?: boolean;
}

/**
 * Generate TypeScript declarations for environment secrets.
 *
 * Fetches environment metadata (with secret key names) through the Platform
 * and generates .kici/types/secrets.d.ts with module augmentation for
 * KnownSecretKeys and EnvironmentSecrets.
 *
 * @param options - Command options
 * @returns true on success, false on error
 */
export async function typesCommand(options: TypesOptions = {}): Promise<boolean> {
  try {
    const config = await loadGlobalConfig();
    const client = DashboardClient.fromConfig(config);
    const environments = await client.listEnvironments(true);

    const metadata: EnvironmentMetadata[] = environments.map((e) => ({
      name: e.name,
      keys: e.secretKeys ?? [],
    }));

    const source = config.platformEndpoint ?? config.endpoint ?? 'kici Platform';
    const dtsContent = generateSecretsDts({
      environments: metadata,
      endpoint: source.replace(/\/+$/, ''),
      generatedAt: new Date(),
    });

    const kiciDir = options.kiciDir ?? '.kici';
    const typesDir = path.join(kiciDir, 'types');
    await fs.mkdir(typesDir, { recursive: true });

    const outputPath = path.join(typesDir, 'secrets.d.ts');
    await fs.writeFile(outputPath, dtsContent, 'utf-8');

    if (!options.quiet) {
      console.log(pc.green('Types generated') + pc.dim(` ${outputPath}`));
    }
    return true;
  } catch (err: unknown) {
    if (err instanceof DashboardClientError) {
      console.error(pc.red(err.message));
      return false;
    }
    console.error(pc.red(`Failed to generate types: ${toErrorMessage(err)}`));
    return false;
  }
}
