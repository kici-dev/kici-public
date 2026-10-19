/**
 * Command-line arguments of the agent binary. The agent reads its configuration
 * from environment variables only; the arguments print help or the version and
 * exit before any configuration is loaded. Any other argument is refused, so a
 * typo never starts an agent. Output is plain text whatever `KICI_LOG_FORMAT`
 * says: it is CLI output, not a log line.
 */
import fs from 'node:fs';
import { docsUrl } from '@kici-dev/core';
import type { EnvFieldSpec } from '@kici-dev/shared/env';
import { envDef } from './config.js';
import { readAgentVersion } from './version.js';

// Build-time constant injected by Rolldown (scripts/build-service.mjs).
declare const KICI_PKG_VERSION: string;

export type AgentCliAction =
  { kind: 'run' } | { kind: 'help' } | { kind: 'version' } | { kind: 'usage-error'; arg: string };

const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-V', '--version']);
const USAGE = 'Usage: kici-agent [-h | --help] [-V | --version]';

/**
 * Config fields listed under "Frequently used environment variables", by field
 * path. Required fields are listed on their own; the full list is in the docs.
 */
export const AGENT_HELP_FIELDS: readonly string[] = [
  'agentToken',
  'scalerClaimCode',
  'labels',
  'roles',
  'agentId',
  'port',
];

/** Classify argv. An unknown argument wins over every flag, so `--help --bogus` is refused. */
export function parseAgentArgs(args: readonly string[]): AgentCliAction {
  const unknown = args.find((arg) => !HELP_FLAGS.has(arg) && !VERSION_FLAGS.has(arg));
  if (unknown !== undefined) return { kind: 'usage-error', arg: unknown };
  if (args.some((arg) => HELP_FLAGS.has(arg))) return { kind: 'help' };
  if (args.length > 0) return { kind: 'version' };
  return { kind: 'run' };
}

function renderRows(specs: readonly EnvFieldSpec[], width: number): string[] {
  return specs.map((spec) => {
    const defaultText = spec.defaultValue === undefined ? '' : ` Default: ${spec.defaultValue}.`;
    return `  ${spec.envVar.padEnd(width)}  ${spec.description ?? ''}${defaultText}`.trimEnd();
  });
}

/** Help text, with the variable rows taken from the agent's config schema. */
export function renderAgentHelp(specs: readonly EnvFieldSpec[]): string {
  const required = specs.filter((spec) => spec.required);
  const frequent = AGENT_HELP_FIELDS.map((field) =>
    specs.find((spec) => spec.fieldPath === field),
  ).filter((spec): spec is EnvFieldSpec => spec !== undefined && !spec.required);
  const width = Math.max(...[...required, ...frequent].map((spec) => spec.envVar.length));
  return [
    USAGE,
    '',
    'Runs a KiCI agent. The agent connects to a KiCI orchestrator, takes jobs and runs their steps.',
    'The agent reads its configuration from environment variables only.',
    '',
    'Options:',
    '  -h, --help     Print this help and exit.',
    '  -V, --version  Print the agent version and exit.',
    '',
    'Required environment variables:',
    ...renderRows(required, width),
    '',
    'Frequently used environment variables:',
    ...renderRows(frequent, width),
    '',
    `All environment variables: ${docsUrl('operator/agent/configuration')}`,
    '',
  ].join('\n');
}

/**
 * The installed package version first: a prerelease install publishes
 * `<base>-<counter>` while the build bakes only `<base>`. A standalone bundle has
 * no package manifest, so the baked value is its only source.
 */
export function resolveAgentVersion(manifest: string | null, baked: string | undefined): string {
  return manifest ?? baked ?? 'unknown';
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  exit(code: number): never;
}

/**
 * Default IO. `fs.writeSync` flushes before `process.exit`, which a pipe write
 * through `process.stdout` does not guarantee. EPIPE (the reader closed early,
 * as in `kici-agent --help | head -1`) is ignored.
 */
export function makeIo(writeSync: (fd: number, text: string) => unknown = fs.writeSync): CliIo {
  const write = (fd: number, text: string): void => {
    try {
      writeSync(fd, text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err;
    }
  };
  return {
    stdout: (text) => write(1, text),
    stderr: (text) => write(2, text),
    exit: (code) => process.exit(code),
  };
}

/** Handle argv; returns only when the agent should start. */
export function handleAgentCliArgs(args: readonly string[], io: CliIo = makeIo()): void {
  const action = parseAgentArgs(args);
  switch (action.kind) {
    case 'run':
      return;
    case 'help':
      io.stdout(renderAgentHelp(envDef.describe()));
      io.exit(0);
      return;
    case 'version': {
      const baked = typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : undefined;
      io.stdout(`${resolveAgentVersion(readAgentVersion(), baked)}\n`);
      io.exit(0);
      return;
    }
    case 'usage-error':
      io.stderr(
        `kici-agent: unknown argument "${action.arg}"\n${USAGE}\nRun "kici-agent --help" for details.\n`,
      );
      io.exit(2);
  }
}
