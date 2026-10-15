import type { GenericInitConfig } from '@kici-dev/sdk';
import { miseExpander } from './mise/expander.js';

/**
 * Clone root + typed config -> a concrete generic init config. The agent
 * passes only `cloneRoot` + `config`; `platform` is a test injection.
 */
export interface PresetExpander<C> {
  expand(args: {
    cloneRoot: string;
    config: C;
    platform?: NodeJS.Platform;
  }): Promise<GenericInitConfig>;
}

export const PRESET_REGISTRY = {
  mise: miseExpander,
} satisfies Record<string, PresetExpander<any>>;

export type PresetName = keyof typeof PRESET_REGISTRY;

/** `init: 'auto'` tries each row against the clone root, accumulating matches in this order. */
export const AUTO_DETECT_TABLE: { markers: string[]; preset: PresetName }[] = [
  { markers: ['mise.toml', '.mise.toml', '.tool-versions'], preset: 'mise' },
];
