/**
 * Congruence guard: the `kici` CLI command tree must be a SUPERSET of the
 * developer-ops registry. Every `entrypoints.cli` op in `DEVELOPER_OPERATIONS`
 * (`@kici-dev/engine`) must map to a registered commander command. The registry
 * is the apex contract; this test walks the real `buildProgram()` command tree
 * and fails the build if a `cli:true` op has no command (or the op-id →
 * command-path table forgot a mapping for a new op). Same producer/consumer
 * drift-is-a-bug discipline as the MCP and HTTP congruence guards.
 */
import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { developerOpsForEntrypoint } from '@kici-dev/engine';
import { buildProgram } from './cli.js';

/** Op id → its command path in the `kici` tree (space-separated segments). */
const CLI_COMMAND: Record<string, string[]> = {
  'runs.list': ['runs', 'list'],
  'runs.get': ['runs', 'show'],
  'runs.stepLogs': ['runs', 'logs'],
  'runs.cancel': ['runs', 'cancel'],
  // `runs cancel --branch` cancels every in-progress run on a branch.
  'runs.cancelByBranch': ['runs', 'cancel'],
  'runs.rerun': ['runs', 'rerun'],
  'workflows.list': ['workflows', 'list'],
  'secrets.list': ['secrets', 'list'],
  'orchestrators.list': ['orchestrators', 'list'],
  'diagnostics.get': ['diagnostics'],
  'orgs.list': ['org', 'list'],
  'held-runs.approve': ['approve'],
  'held-runs.reject': ['reject'],
};

function commandExists(program: Command, path: string[]): boolean {
  let node: Command | undefined = program;
  for (const seg of path) {
    node = node?.commands.find((c) => c.name() === seg);
    if (!node) return false;
  }
  return true;
}

describe('CLI commands ⊇ registry', () => {
  it('covers every cli:true op with a registered command', () => {
    const program = buildProgram();
    for (const o of developerOpsForEntrypoint('cli')) {
      const path = CLI_COMMAND[o.id];
      expect(path, `map ${o.id} to a CLI command`).toBeTruthy();
      expect(commandExists(program, path), `no CLI command for ${o.id} (${path.join(' ')})`).toBe(
        true,
      );
    }
  });
});
