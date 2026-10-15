import type { CacheSpec, GenericInitConfig, MiseInitConfig } from '@kici-dev/sdk';
import { miseCacheKey } from './cache-key.js';
import { selectMiseTemplate, type MiseTemplate } from './templates.js';
import {
  miseWindowsArch,
  resolveLatestMiseWindowsAsset,
  type MiseWindowsArch,
} from './windows-install.js';

export interface MiseExpandArgs {
  cloneRoot: string;
  config: MiseInitConfig;
  /** Defaults to process.platform; injected by tests. */
  platform?: NodeJS.Platform;
  /** Defaults to the real GitHub lookup; injected by tests. */
  resolveWindowsAsset?: (arch: MiseWindowsArch) => Promise<string>;
}

async function buildRun(args: MiseExpandArgs, template: MiseTemplate): Promise<string> {
  if ((args.platform ?? process.platform) !== 'win32') return template.run;
  const arch = miseWindowsArch(process.env.PROCESSOR_ARCHITECTURE);
  const resolve = args.resolveWindowsAsset ?? ((a) => resolveLatestMiseWindowsAsset(a));
  const url = await resolve(arch);
  return template.run.replace('<ASSET_URL>', url);
}

async function defaultCache(cloneRoot: string, paths: string[]): Promise<CacheSpec> {
  return { key: await miseCacheKey(cloneRoot), paths, restoreKeys: ['mise-'] };
}

/** Turns MiseInitConfig into an OS-correct GenericInitConfig. */
export const miseExpander = {
  async expand(args: MiseExpandArgs): Promise<GenericInitConfig> {
    const platform = args.platform ?? process.platform;
    const template = selectMiseTemplate(platform);
    const run = await buildRun(args, template);

    const cache =
      args.config.cache === false
        ? undefined
        : (args.config.cache ?? (await defaultCache(args.cloneRoot, template.cachePaths)));

    const cfg: GenericInitConfig = {
      run,
      shell: args.config.shell ?? template.shell,
      timeout: args.config.timeout ?? 600_000,
    };
    if (cache) cfg.cache = cache;
    if (args.config.env) cfg.env = args.config.env;
    return cfg;
  },
};
