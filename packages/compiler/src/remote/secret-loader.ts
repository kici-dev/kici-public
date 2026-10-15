import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ParsedSecrets } from '../test-runner/secrets-file.js';
import { loadSecretsFile } from '../test-runner/secrets-file.js';

/** Dotenv (`.env.local`): `#` comments, surrounding quotes stripped. */
function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

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

/** Top-level keys are context names; local execution merges every context flat. */
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

/** Null on ENOENT. */
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
 * 1. .kici/.secrets (INI-style; its `[section]` blocks are the only context-scoped source)
 * 2. .kici/.env.local (dotenv format)
 * 3. .kici/secrets.yaml (YAML with context scopes, merged flat)
 * 4. --env KEY=VALUE CLI flags
 *
 * process.env is not merged here; the step context handles it.
 */
export async function loadLocalSecrets(
  kiciDir: string,
  envFlags?: string[],
): Promise<ParsedSecrets> {
  const iniSecrets = await loadSecretsFile(kiciDir);

  const flat: Record<string, string> = { ...iniSecrets.flat };
  const contexts: Record<string, Record<string, string>> = {};

  for (const [ctx, vals] of Object.entries(iniSecrets.contexts)) {
    contexts[ctx] = { ...vals };
  }

  const envLocalContent = await readFileOrNull(path.join(kiciDir, '.env.local'));
  if (envLocalContent !== null) {
    const envLocalSecrets = parseDotenv(envLocalContent);
    Object.assign(flat, envLocalSecrets);
  }

  const yamlContent = await readFileOrNull(path.join(kiciDir, 'secrets.yaml'));
  if (yamlContent !== null) {
    const yamlSecrets = parseSecretsYaml(yamlContent);
    Object.assign(flat, yamlSecrets);
  }

  if (envFlags && envFlags.length > 0) {
    const flagSecrets = parseEnvFlags(envFlags);
    Object.assign(flat, flagSecrets);
  }

  return { flat, contexts };
}
