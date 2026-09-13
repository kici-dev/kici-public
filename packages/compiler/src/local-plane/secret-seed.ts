/**
 * Seed a project's local `secrets.yaml` (and `.kici/.secrets` INI) contexts into
 * the local dev plane's real `scoped_secrets` store, preserving context/scope
 * structure so the plane's real `SecretResolver` honors scoping at dispatch —
 * the routed local run resolves scoped secrets through the plane's real
 * resolver rather than a flat merge.
 *
 * Local secret files are READ-ONLY here: values are only READ and transit into
 * the local plane's Postgres via the admin secret API. Nothing is written back
 * to a secret file, and nothing leaves this machine (the plane is local).
 *
 * Scope model: each `secrets.yaml` top-level key is a context name. The seeder
 * creates a context of that name, binds it to a scope pattern equal to the
 * context name, and stores each secret at that scope. So a workflow job bound to
 * context `production` resolves `production`-scoped secrets through the resolver.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AdminApiClient } from '@kici-dev/orchestrator';
import { parseSecretsFile } from '../test-runner/secrets-file.js';

/** Minimal AdminApiClient surface the seeder needs (for test injection). */
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

/** Result of a seed run: the contexts seeded and how many secret keys landed. */
export interface SeededSecrets {
  contexts: string[];
  secretCount: number;
}

/**
 * Read a file, returning null when it does not exist.
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
 * Parse `secrets.yaml`, PRESERVING its top-level context structure (a flat merge
 * would collapse the contexts). Top-level keys are context names; values are
 * key→value maps. Non-scalar leaf values are stringified.
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
 * Collect the per-context secrets from a project's `.kici/` directory,
 * preserving context structure. Reads `.kici/.secrets` (INI sections) and
 * `.kici/secrets.yaml` (top-level contexts). The yaml layer wins on key
 * collisions within a context. Flat (context-less) secrets are ignored here —
 * a routed job only resolves secrets for the contexts it binds.
 */
export async function loadLocalSecretContexts(
  kiciDir: string,
): Promise<Record<string, Record<string, string>>> {
  const contexts: Record<string, Record<string, string>> = {};

  // 1. .secrets INI sections (lowest priority).
  const iniContent = await readFileOrNull(path.join(kiciDir, '.secrets'));
  if (iniContent !== null) {
    const parsed = parseSecretsFile(iniContent);
    for (const [ctx, vals] of Object.entries(parsed.contexts)) {
      contexts[ctx] = { ...(contexts[ctx] ?? {}), ...vals };
    }
  }

  // 2. secrets.yaml contexts (override .secrets on key collision).
  const yamlContent = await readFileOrNull(path.join(kiciDir, 'secrets.yaml'));
  if (yamlContent !== null) {
    for (const [ctx, vals] of Object.entries(parseSecretsYamlContexts(yamlContent))) {
      contexts[ctx] = { ...(contexts[ctx] ?? {}), ...vals };
    }
  }

  return contexts;
}

/**
 * Seed the local plane's `scoped_secrets` store from a project's `secrets.yaml`
 * / `.secrets` contexts. Idempotent: `createContext` upserts, `bind` is a no-op
 * when the scope is already bound, and `setSecret` overwrites in place. Returns
 * the contexts + secret-key count seeded (never the values).
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
    // Create the context (allowLocalExecution so a CLI-initiated local run can
    // resolve its secrets) and bind a scope equal to the context name.
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
