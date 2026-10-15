/**
 * Seeds a project's local `secrets.yaml` (and `.kici/.secrets` INI) contexts
 * into the local dev plane's real `scoped_secrets` store, keeping the
 * context/scope structure so the plane's real `SecretResolver` honors scoping
 * at dispatch, not a flat merge.
 *
 * Local secret files are READ-ONLY: values only transit into the local plane's
 * Postgres via the admin secret API, and nothing leaves this machine.
 *
 * Each top-level key is a context, bound to a scope pattern equal to its name,
 * with each secret stored at that scope: a job bound to `production` resolves
 * `production`-scoped secrets.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AdminApiClient } from '@kici-dev/orchestrator';
import { parseSecretsFile } from '../test-runner/secrets-file.js';

/** For test injection. */
export interface SecretSeedClient {
  createContext(data: {
    orgId: string;
    name: string;
    allowLocalExecution?: boolean;
  }): Promise<{ envId: string; created: boolean }>;
  bindContext(data: {
    orgId: string;
    name: string;
    scopePattern: string;
    hostPattern?: string;
  }): Promise<unknown>;
  setSecret(orgId: string, scope: string, key: string, value: string): Promise<void>;
}

export interface SeededSecrets {
  contexts: string[];
  secretCount: number;
}

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
 * Keeps the top-level context structure (a flat merge would collapse it).
 * Scalar leaf values are stringified; non-scalar leaves are dropped.
 */
function parseSecretsYamlContexts(content: string): Record<string, Record<string, string>> {
  const parsed = parseYaml(content);
  if (!parsed || typeof parsed !== 'object') return {};

  const out: Record<string, Record<string, string>> = {};
  for (const [contextName, contextSecrets] of Object.entries(parsed)) {
    if (contextSecrets && typeof contextSecrets === 'object' && !Array.isArray(contextSecrets)) {
      const map: Record<string, string> = {};
      for (const [key, value] of Object.entries(contextSecrets as Record<string, unknown>)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          map[key] = String(value);
        }
      }
      if (Object.keys(map).length > 0) out[contextName] = map;
    }
  }
  return out;
}

/**
 * `.secrets` INI sections, then `secrets.yaml` contexts, which win on key
 * collisions. Flat (context-less) secrets are ignored: a routed job only
 * resolves secrets for the contexts it binds.
 */
export async function loadLocalSecretContexts(
  kiciDir: string,
): Promise<Record<string, Record<string, string>>> {
  const contexts: Record<string, Record<string, string>> = {};

  const iniContent = await readFileOrNull(path.join(kiciDir, '.secrets'));
  if (iniContent !== null) {
    const parsed = parseSecretsFile(iniContent);
    for (const [ctx, vals] of Object.entries(parsed.contexts)) {
      contexts[ctx] = { ...(contexts[ctx] ?? {}), ...vals };
    }
  }

  const yamlContent = await readFileOrNull(path.join(kiciDir, 'secrets.yaml'));
  if (yamlContent !== null) {
    for (const [ctx, vals] of Object.entries(parseSecretsYamlContexts(yamlContent))) {
      contexts[ctx] = { ...(contexts[ctx] ?? {}), ...vals };
    }
  }

  return contexts;
}

/**
 * Idempotent: `createContext` upserts, `bind` is a no-op when the scope is
 * already bound, and `setSecret` overwrites in place. Never returns values.
 */
export async function seedLocalSecrets(
  planeUrl: string,
  adminToken: string,
  opts: { orgId: string; kiciDir: string; client?: SecretSeedClient },
): Promise<SeededSecrets> {
  const client: SecretSeedClient = opts.client ?? new AdminApiClient(planeUrl, adminToken);
  const contexts = await loadLocalSecretContexts(opts.kiciDir);

  const seeded: string[] = [];
  let secretCount = 0;
  for (const [contextName, secrets] of Object.entries(contexts)) {
    // allowLocalExecution lets a CLI-initiated local run resolve its secrets.
    await client.createContext({ orgId: opts.orgId, name: contextName, allowLocalExecution: true });
    await client.bindContext({
      orgId: opts.orgId,
      name: contextName,
      scopePattern: contextName,
      hostPattern: '**',
    });
    for (const [key, value] of Object.entries(secrets)) {
      await client.setSecret(opts.orgId, contextName, key, value);
      secretCount++;
    }
    seeded.push(contextName);
  }

  return { contexts: seeded, secretCount };
}
