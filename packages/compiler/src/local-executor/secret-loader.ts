import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ParsedSecrets } from '../test-runner/secrets-file.js';
import { loadSecretsFile } from '../test-runner/secrets-file.js';

/**
 * Parse a dotenv-style file (.env.local) into flat key-value pairs.
 * Lines starting with # are comments. Blank lines are ignored.
 */
function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    // Strip surrounding quotes (double or single)
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Parse a secrets.yaml file.
 * Expected format: top-level keys are environment names, values are key-value maps.
 * For local execution, all environments are merged flat (no environment resolution).
 */
function parseSecretsYaml(content: string): Record<string, string> {
  const parsed = parseYaml(content);
  if (!parsed || typeof parsed !== 'object') return {};

  const result: Record<string, string> = {};

  for (const [, envSecrets] of Object.entries(parsed)) {
    if (envSecrets && typeof envSecrets === 'object' && !Array.isArray(envSecrets)) {
      for (const [key, value] of Object.entries(envSecrets as Record<string, unknown>)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          result[key] = String(value);
        }
      }
    }
  }

  return result;
}

/**
 * Parse --env KEY=VALUE flags into a flat map.
 */
function parseEnvFlags(flags: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (const flag of flags) {
    const eqIndex = flag.indexOf('=');
    if (eqIndex === -1) continue;

    const key = flag.slice(0, eqIndex).trim();
    const value = flag.slice(eqIndex + 1);
    result[key] = value;
  }

  return result;
}

/**
 * Read a file, returning null if it doesn't exist.
 */
async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Load secrets from multiple sources with merge precedence.
 *
 * Merge order (lowest to highest priority):
 * 1. .kici/.secrets (INI-style, backward compat)
 * 2. .kici/.env.local (dotenv format)
 * 3. .kici/secrets.yaml (YAML with environment scopes, merged flat)
 * 4. --env KEY=VALUE CLI flags
 *
 * Note: process.env is NOT merged here -- it's handled at step-context level.
 *
 * @param kiciDir - Path to the .kici directory
 * @param envFlags - Optional --env KEY=VALUE flag values
 * @returns Merged secrets with correct precedence
 */
export async function loadLocalSecrets(
  kiciDir: string,
  envFlags?: string[],
): Promise<ParsedSecrets> {
  // 1. Load .secrets (backward compat) -- lowest priority
  const iniSecrets = await loadSecretsFile(kiciDir);

  // Start with INI secrets as base
  const flat: Record<string, string> = { ...iniSecrets.flat };
  const contexts: Record<string, Record<string, string>> = {};

  // Copy contexts from INI
  for (const [ctx, vals] of Object.entries(iniSecrets.contexts)) {
    contexts[ctx] = { ...vals };
  }

  // 2. Load .env.local -- overrides .secrets
  const envLocalContent = await readFileOrNull(path.join(kiciDir, '.env.local'));
  if (envLocalContent !== null) {
    const envLocalSecrets = parseDotenv(envLocalContent);
    Object.assign(flat, envLocalSecrets);
  }

  // 3. Load secrets.yaml -- overrides .env.local
  const yamlContent = await readFileOrNull(path.join(kiciDir, 'secrets.yaml'));
  if (yamlContent !== null) {
    const yamlSecrets = parseSecretsYaml(yamlContent);
    Object.assign(flat, yamlSecrets);
  }

  // 4. Parse --env flags -- highest priority
  if (envFlags && envFlags.length > 0) {
    const flagSecrets = parseEnvFlags(envFlags);
    Object.assign(flat, flagSecrets);
  }

  return { flat, contexts };
}
