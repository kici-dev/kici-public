/**
 * Applies yarn-berry registry auth + a forced `nodeLinker: node-modules` to
 * `.kici/.yarnrc.yml` for one `yarn install`, restoring the file on cleanup:
 * the berry analog of `npm-registry-config.ts`, using `npmRegistryServer` /
 * `npmScopes` / `npmAuthToken` with `${VAR}` interpolation. Token bytes never
 * reach disk: each token is a job-scoped env var the file references.
 *
 * `nodeLinker: node-modules` gives a real `node_modules` tree (no PnP
 * `.pnp.cjs`), so the packer, restore, sibling-walk and workflow-loader work
 * unchanged. `enableScripts: false` applies to every install, the same model as
 * `--ignore-scripts` elsewhere; `KICI_ALLOW_INSTALL_SCRIPTS=true` arrives here
 * as `ignoreScripts: false`. The npm overlay's Args / Result shapes let
 * `dep-installer` pick either by flavor.
 */

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '@kici-dev/core/tmp';
import { parse, stringify } from 'yaml';
import type {
  ApplyNpmRegistryConfigArgs,
  ApplyNpmRegistryConfigResult,
} from './npm-registry-config.js';

function tokenEnvName(jobIdShort: string, index: number): string {
  return `KICI_NPM_TOKEN_${jobIdShort}_${index}`;
}

/** `{}` when absent or empty. */
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

  const { path: cacheFolder, cleanup: cleanupCache } = await makeTempDir('yarn-berry-cache');

  // Agent-managed keys (and tokens) win over committed ones.
  const merged: Record<string, unknown> = {
    ...doc,
    nodeLinker: 'node-modules',
    enableGlobalCache: false,
    cacheFolder,
  };

  const tokenEnv: Record<string, string> = {};
  const tokensForRedaction: string[] = [];

  // Off for every install, not only a private-registry one: a committed
  // `postinstall` is customer code running in the installing process.
  if (args.ignoreScripts !== false) {
    merged.enableScripts = false;
  }

  if (hasPrivateRegistry) {
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
    await cleanupCache().catch(() => {});
  };

  return {
    extraEnv: { ...installEnvSecrets, ...tokenEnv },
    tokensForRedaction,
    cleanup,
  };
}
