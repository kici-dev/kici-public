import type { CacheSpec, GenericInitConfig, MiseInitConfig } from '@kici-dev/sdk';
import { normalizeMiseVersion } from '@kici-dev/sdk/internal';
import { miseCacheKey } from './cache-key.js';
import { selectMiseTemplate, type MiseTemplate } from './templates.js';
import {
  miseWindowsArch,
  resolveMiseWindowsAsset,
  type MiseWindowsArch,
} from './windows-install.js';

/** Arguments to expand the mise preset into a concrete generic init config. */
export interface MiseExpandArgs {
  cloneRoot: string;
  config: MiseInitConfig;
  /** Host platform (defaults to process.platform). Injected for tests. */
  platform?: NodeJS.Platform;
  /** Windows asset resolver for the pinned (bare) or latest release. Injected for tests. */
  resolveWindowsAsset?: (arch: MiseWindowsArch, version: string | undefined) => Promise<string>;
}

/**
 * The bare pinned mise release (`2026.5.1`), or `undefined` when the preset is
 * not pinned. `job()` validates the pin at author time; this re-checks it here
 * because the value is substituted into a shell script.
 */
function pinnedMiseVersion(config: MiseInitConfig): string | undefined {
  if (config.version === undefined) return undefined;
  const bare =
    typeof config.version === 'string' ? normalizeMiseVersion(config.version) : undefined;
  if (bare === undefined) {
    throw new Error(
      `init mise.version ${JSON.stringify(config.version)} is not a mise release; ` +
        `use a release such as '2026.5.1' or 'v2026.5.1'`,
    );
  }
  return bare;
}

/** Whether the preset's `env` sets PATH for the init command (any case on Windows). */
function initSetsPath(config: MiseInitConfig, platform: NodeJS.Platform): boolean {
  return Object.keys(config.env ?? {}).some((key) =>
    platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH',
  );
}

async function buildRun(
  args: MiseExpandArgs,
  template: MiseTemplate,
  version: string | undefined,
): Promise<string> {
  if ((args.platform ?? process.platform) !== 'win32') return template.run;
  const arch = miseWindowsArch(process.env.PROCESSOR_ARCHITECTURE);
  const resolve =
    args.resolveWindowsAsset ?? ((a, v) => resolveMiseWindowsAsset(a, { version: v }));
  return template.run.replace('<ASSET_URL>', await resolve(arch, version));
}

async function defaultCache(cloneRoot: string, paths: string[]): Promise<CacheSpec> {
  return { key: await miseCacheKey(cloneRoot), paths, restoreKeys: ['mise-'] };
}

/** The mise preset expander: turns MiseInitConfig into an OS-correct GenericInitConfig. */
export const miseExpander = {
  async expand(args: MiseExpandArgs): Promise<GenericInitConfig> {
    const platform = args.platform ?? process.platform;
    const version = pinnedMiseVersion(args.config);
    const template = selectMiseTemplate(platform, version, initSetsPath(args.config, platform));
    const run = await buildRun(args, template, version);

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
