import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { GenericInitConfig } from '@kici-dev/sdk';
import type { InitDirective } from './directives.js';
import { PRESET_REGISTRY, AUTO_DETECT_TABLE, type PresetName } from './registry.js';

/** Options for agent-side directive expansion. */
export interface ExpandOptions {
  cloneRoot: string;
  /** Host platform; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Optional info logger (e.g. to emit a pseudo-step line). */
  log?: (message: string) => void;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Scan the clone root for marker files and return matched presets in table order. */
async function autoDetect(cloneRoot: string): Promise<PresetName[]> {
  const matched: PresetName[] = [];
  for (const row of AUTO_DETECT_TABLE) {
    for (const marker of row.markers) {
      if (await fileExists(join(cloneRoot, marker))) {
        matched.push(row.preset);
        break;
      }
    }
  }
  return matched;
}

async function expandPreset(
  name: PresetName,
  config: unknown,
  opts: ExpandOptions,
): Promise<GenericInitConfig> {
  return PRESET_REGISTRY[name].expand({
    cloneRoot: opts.cloneRoot,
    config: config as never,
    ...(opts.platform ? { platform: opts.platform } : {}),
  });
}

/**
 * Expand normalized directives into concrete generic init configs, reading the
 * clone root for preset cache keys and `'auto'` marker detection.
 */
export async function expandInitDirectives(
  directives: InitDirective[],
  opts: ExpandOptions,
): Promise<GenericInitConfig[]> {
  const out: GenericInitConfig[] = [];
  for (const d of directives) {
    if (d.kind === 'generic') {
      out.push(d.config);
    } else if (d.kind === 'preset') {
      out.push(await expandPreset(d.name, d.config, opts));
    } else {
      const presets = await autoDetect(opts.cloneRoot);
      if (presets.length === 0) {
        opts.log?.('[kici] init: auto — no toolchain detected (no mise.toml / .tool-versions)');
        continue;
      }
      for (const name of presets) {
        out.push(await expandPreset(name, {}, opts));
      }
    }
  }
  return out;
}
