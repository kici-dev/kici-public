/**
 * Apply yarn-berry registry auth + a forced `nodeLinker: node-modules` to a
 * workflow's `.kici/.yarnrc.yml` for the lifetime of one `yarn install`, then
 * restore the file on cleanup. The berry analog of `npm-registry-config.ts`:
 * berry reads `.yarnrc.yml` (not `.npmrc`), so the auth block uses berry's
 * `npmRegistryServer` / `npmScopes` / `npmAuthToken` keys with `${VAR}`
 * env-var interpolation. Token bytes never reach disk — each registry token is
 * exposed as a job-scoped env var and the on-disk value is the `${VAR}`
 * reference.
 *
 * `nodeLinker: node-modules` makes berry lay down a real `node_modules` tree
 * (no PnP `.pnp.cjs`), so the agent's packer / restore / sibling-walk /
 * workflow-loader work unchanged. `enableScripts: false` (when a private
 * registry is configured) keeps dependency lifecycle scripts from seeing the
 * synthesized token env vars — the same security model as npm/pnpm/classic
 * `--ignore-scripts`.
 *
 * Reuses the same `ApplyNpmRegistryConfigArgs` / `ApplyNpmRegistryConfigResult`
 * shapes as the npm overlay so `dep-installer` can pick either by flavor.
 */

import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type {
  ApplyNpmRegistryConfigArgs,
  ApplyNpmRegistryConfigResult,
} from './npm-registry-config.js';

/** Build the synthesized env-var name for registry index `i`. */
function tokenEnvName(jobIdShort: string, index: number): string {
  return `KICI_NPM_TOKEN_${jobIdShort}_${index}`;
}

/** Read + parse an existing `.yarnrc.yml`, or `{}` when absent/empty. */
async function readOriginalYarnrc(
  path: string,
): Promise<{ raw: string | null; doc: Record<string, unknown> }> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = (parse(raw) as Record<string, unknown> | null) ?? {};
    return { raw, doc: parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { raw: null, doc: {} };
    throw err;
  }
}

/** One berry npm-scope/registry auth block built from a registry spec. */
interface BerryRegistryBlock {
  npmRegistryServer: string;
  npmAuthToken: string;
  npmAlwaysAuth?: boolean;
}

function buildRegistryBlock(envVar: string, url: string, alwaysAuth: boolean): BerryRegistryBlock {
  return {
    npmRegistryServer: url,
    npmAuthToken: `\${${envVar}}`,
    ...(alwaysAuth ? { npmAlwaysAuth: true } : {}),
  };
}

export async function applyYarnrcBerryConfig(
  args: ApplyNpmRegistryConfigArgs,
): Promise<ApplyNpmRegistryConfigResult> {
  const registries = args.npmRegistries ?? [];
  const installEnvSecrets = args.installEnvSecrets ?? {};
  const hasPrivateRegistry = registries.length > 0 || Object.keys(installEnvSecrets).length > 0;

  const yarnrcPath = join(args.kiciDir, '.yarnrc.yml');
  const { raw: original, doc } = await readOriginalYarnrc(yarnrcPath);

  const cacheFolder = await mkdtemp(join(tmpdir(), 'kici-yarn-berry-cache-'));

  // Agent-managed keys win over committed ones (managed token beats committed).
  const merged: Record<string, unknown> = {
    ...doc,
    nodeLinker: 'node-modules',
    enableGlobalCache: false,
    cacheFolder,
  };

  const tokenEnv: Record<string, string> = {};
  const tokensForRedaction: string[] = [];

  if (hasPrivateRegistry) {
    merged.enableScripts = false;
    const npmScopes: Record<string, BerryRegistryBlock> = {
      ...((doc.npmScopes as Record<string, BerryRegistryBlock> | undefined) ?? {}),
    };
    for (let i = 0; i < registries.length; i++) {
      const reg = registries[i];
      const envVar = tokenEnvName(args.jobIdShort, i);
      tokenEnv[envVar] = reg.token;
      tokensForRedaction.push(reg.token);
      const block = buildRegistryBlock(envVar, reg.url, reg.alwaysAuth);
      if (reg.scope) {
        npmScopes[reg.scope] = block;
      } else {
        merged.npmRegistryServer = reg.url;
        merged.npmAuthToken = block.npmAuthToken;
        if (reg.alwaysAuth) merged.npmAlwaysAuth = true;
      }
    }
    if (Object.keys(npmScopes).length > 0) merged.npmScopes = npmScopes;
    for (const value of Object.values(installEnvSecrets)) {
      if (value) tokensForRedaction.push(value);
    }
  }

  await writeFile(yarnrcPath, stringify(merged), { encoding: 'utf8', mode: 0o600 });

  const cleanup = async (): Promise<void> => {
    try {
      if (original === null) {
        await unlink(yarnrcPath).catch(() => {});
      } else {
        await writeFile(yarnrcPath, original, { encoding: 'utf8' });
      }
    } catch {
      // best-effort restore; never fail the install on a restore error
    }
    await rm(cacheFolder, { recursive: true, force: true }).catch(() => {});
  };

  return {
    extraEnv: { ...installEnvSecrets, ...tokenEnv },
    tokensForRedaction,
    cleanup,
  };
}
