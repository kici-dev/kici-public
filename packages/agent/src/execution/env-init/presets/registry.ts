import type { GenericInitConfig } from '@kici-dev/sdk';
import { miseExpander } from './mise/expander.js';

/**
 * A preset expander: clone root + typed config -> a concrete generic init config.
 * Expanders may accept additional optional fields (e.g. an injected `platform`
 * for tests); the agent path passes only `cloneRoot` + `config`.
 */
export interface PresetExpander<C> {
  expand(args: {
    cloneRoot: string;
    config: C;
    platform?: NodeJS.Platform;
  }): Promise<GenericInitConfig>;
}

/**
 * The set of typed presets. Nix is added here (one row) once its provider lands.
 */
export const PRESET_REGISTRY = {
  mise: miseExpander,
} satisfies Record<string, PresetExpander<any>>;

export type PresetName = keyof typeof PRESET_REGISTRY;

/**
 * Ordered auto-detect table: `init: 'auto'` tries each row against the clone
 * root and accumulates matches in this order. (nix row added with its provider.)
 */
export const AUTO_DETECT_TABLE: { markers: string[]; preset: PresetName }[] = [
  { markers: ['mise.toml', '.mise.toml', '.tool-versions'], preset: 'mise' },
];
