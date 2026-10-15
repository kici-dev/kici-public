import type { HookToolName } from './detector.js';

/** Identifies kici-added hooks. */
export const KICI_HOOK_MARKER = '# KiCI: compile workflows on commit';

interface HookTemplate {
  /** The command or config block to add to an existing hook. */
  getCommand: (command: string) => string;
  /** A whole script, for a new hook. */
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
    // A YAML command block.
    getCommand: (cmd) => `    kici-compile:
      run: ${cmd}`,
  },

  'pre-commit': {
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
    // Same format as pre-commit.
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
    getCommand: (cmd) => `\n${KICI_HOOK_MARKER}\n${cmd}\n`,
    getFullScript: (cmd) => `#!/bin/sh
# pre-commit hook

${KICI_HOOK_MARKER}
${cmd}
`,
  },
};

export function getHookTemplate(tool: HookToolName): HookTemplate {
  return TEMPLATES[tool];
}

/** True for the marker or any recognizable `kici compile` invocation. */
export function hasKiciHook(content: string): boolean {
  return (
    content.includes(KICI_HOOK_MARKER) ||
    content.includes('kici compile') ||
    content.includes('kici-compile') ||
    content.includes('@kici-dev/compiler')
  );
}
