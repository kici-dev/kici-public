/**
 * YAML configuration file loader for the orchestrator.
 *
 * Reads the local YAML config file from a configurable path with fallback:
 * 1. Explicit configPath argument
 * 2. KICI_CONFIG environment variable
 * 3. /etc/kici/orchestrator.yaml default
 *
 * When no YAML file is found and no explicit path was given,
 * returns an empty config (YAML is optional -- env-only mode).
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { localConfigSchema } from './schema.js';
import type { LocalConfig } from './types.js';
import { toErrorMessage } from '@kici-dev/shared';

/** Default config file path when no explicit path or env var is set */
const DEFAULT_CONFIG_PATH = '/etc/kici/orchestrator.yaml';

/**
 * Shared config field paths that contain sensitive values.
 * Used by SharedConfigStore for encryption before DB storage.
 */
export const SENSITIVE_FIELD_PATHS = [
  'platform.token',
  'secrets.key',
  'secrets.bootstrapAdminToken',
  'cluster.joinToken',
] as const;

/**
 * Load and validate the local orchestrator YAML configuration.
 *
 * @param configPath - Explicit path to the config file (highest precedence)
 * @returns Validated LocalConfig
 * @throws Error if explicit path doesn't exist, or if validation fails
 */
export async function loadLocalConfig(configPath?: string): Promise<LocalConfig> {
  const resolvedPath = configPath ?? process.env.KICI_CONFIG ?? DEFAULT_CONFIG_PATH;
  const isExplicit = configPath !== undefined || process.env.KICI_CONFIG !== undefined;

  let rawYaml: string;
  try {
    rawYaml = await readFile(resolvedPath, 'utf-8');
  } catch (err: unknown) {
    // If file doesn't exist and no explicit path, YAML is optional
    if (!isExplicit && isNodeError(err) && err.code === 'ENOENT') {
      return { database: { url: '' } } as unknown as LocalConfig;
    }
    // If explicit path was given, throw with clear error
    throw new Error(`Failed to read config file at ${resolvedPath}: ${toErrorMessage(err)}`);
  }

  const parsed = parseYaml(rawYaml) as Record<string, unknown> | null;

  // Empty YAML file
  if (!parsed || typeof parsed !== 'object') {
    if (isExplicit) {
      throw new Error(`Config file at ${resolvedPath} is empty or not a valid YAML object`);
    }
    return { database: { url: '' } } as unknown as LocalConfig;
  }

  const result = localConfigSchema.safeParse(parsed);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Config validation failed for ${resolvedPath}:\n${errors}`);
  }

  return result.data;
}

/**
 * Type guard for Node.js errors with a `code` property.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
