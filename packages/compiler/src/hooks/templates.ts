import type { HookToolName } from './detector.js';

/** Marker comment to identify kici-added hooks */
export const KICI_HOOK_MARKER = '# KiCI: compile workflows on commit';

/** Template configuration for each hook tool */
interface HookTemplate {
  /** Get shell command/config to add */
  getCommand: (command: string) => string;
  /** Full hook script template (for new hooks) */
  getFullScript?: (command: string) => string;
}

const TEMPLATES: Record<HookToolName, HookTemplate> = {
  husky: {
    getCommand: (cmd) => `\n${KICI_HOOK_MARKER}\n${cmd}\n`,
    getFullScript: (cmd) => `#!/usr/bin/env sh

${KICI_HOOK_MARKER}
${cmd}
`,
  },

  lefthook: {
    // Lefthook uses YAML, return the command block to add
    getCommand: (cmd) => `    kici-compile:
      run: ${cmd}`,
  },

  'pre-commit': {
    // pre-commit uses YAML with repos/hooks structure
    getCommand: (cmd) => `  - repo: local
    hooks:
      - id: kici-compile
        name: KiCI Compile
        entry: ${cmd}
        language: system
        pass_filenames: false
        always_run: true`,
  },

  prek: {
    // prek uses same format as pre-commit
    getCommand: (cmd) => `  - repo: local
    hooks:
      - id: kici-compile
        name: KiCI Compile
        entry: ${cmd}
        language: system
        pass_filenames: false
        always_run: true`,
  },

  git: {
    // Raw git hook - simple shell script
    getCommand: (cmd) => `\n${KICI_HOOK_MARKER}\n${cmd}\n`,
    getFullScript: (cmd) => `#!/bin/sh
# pre-commit hook

${KICI_HOOK_MARKER}
${cmd}
`,
  },
};

/**
 * Get the hook template for a specific tool.
 *
 * @param tool - Hook tool name
 * @returns Template configuration for the tool
 */
export function getHookTemplate(tool: HookToolName): HookTemplate {
  return TEMPLATES[tool];
}

/**
 * Check if a file already contains the kici hook.
 *
 * @param content - File content to check
 * @returns true if kici hook marker is present
 */
export function hasKiciHook(content: string): boolean {
  return (
    content.includes(KICI_HOOK_MARKER) ||
    content.includes('kici compile') ||
    content.includes('kici-compile') ||
    content.includes('@kici-dev/compiler')
  );
}
