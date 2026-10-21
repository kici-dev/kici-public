/**
 * Registered workflow locks whose compile schema this orchestrator release's
 * agents reject.
 *
 * Every warning surface (registration, startup, `kici-admin workflow list`,
 * `kici-admin diagnose`, `kici-admin orchestrator upgrade`, the dashboard)
 * compares against this release's {@link COMPILE_SCHEMA_VERSION}: running the
 * orchestrator and agents on the same release is the supported configuration,
 * and the fleet's reported schemas are empty at startup and right after an
 * upgrade, the two moments a warning matters most.
 */

import { COMPILE_SCHEMA_VERSION, lockCompileSchema } from '@kici-dev/shared';

declare const KICI_PKG_VERSION: string;

/** This orchestrator's release, which its agents share; `undefined` in a dev build. */
const ORCHESTRATOR_RELEASE: string | undefined =
  typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : undefined;

export interface StaleLockEntry {
  repoIdentifier: string;
  workflowName: string;
  lockSchema: number;
  isGlobal: boolean;
}

/** The entries whose lock declares a compile schema other than `agentSchema`. */
export function staleCompileSchemaEntries(
  rows: readonly {
    repoIdentifier: string;
    workflowName: string;
    isGlobal?: boolean;
    lockEntry: unknown;
  }[],
  agentSchema: number = COMPILE_SCHEMA_VERSION,
): StaleLockEntry[] {
  const stale: StaleLockEntry[] = [];
  for (const row of rows) {
    const lockSchema = lockCompileSchema(
      row.lockEntry as { compileSchemaVersion?: unknown } | null | undefined,
    );
    if (lockSchema === null || lockSchema === agentSchema) continue;
    stale.push({
      repoIdentifier: row.repoIdentifier,
      workflowName: row.workflowName,
      lockSchema,
      isGlobal: row.isGlobal === true,
    });
  }
  return stale;
}

/** One line naming a stale lock and the recompile that fixes it. */
export function formatStaleLockWarning(
  e: StaleLockEntry,
  agentSchema: number = COMPILE_SCHEMA_VERSION,
  release: string | undefined = ORCHESTRATOR_RELEASE,
): string {
  const agents = release
    ? `agents of this orchestrator release (${release}) implement schema ${agentSchema}`
    : `agents of this orchestrator release implement schema ${agentSchema}`;
  const compiler = release
    ? `@kici-dev/compiler ${release}`
    : `the @kici-dev/compiler release that matches this orchestrator`;
  return (
    `${e.repoIdentifier} workflow ${e.workflowName}: its lock declares compile schema ${e.lockSchema}, ` +
    `but ${agents}. Recompile it with ${compiler} and commit .kici/kici.lock.json.`
  );
}

/**
 * Log one warning per stale registered lock; returns the stale entries. Shared by
 * the push registration and the startup scan, so both log the same fields.
 */
export function warnStaleCompileSchemas(
  log: { warn(message: string, meta?: Record<string, unknown>): void },
  rows: Parameters<typeof staleCompileSchemaEntries>[0],
): StaleLockEntry[] {
  const stale = staleCompileSchemaEntries(rows);
  for (const e of stale) {
    log.warn('Registered workflow lock has a stale compile schema', {
      repo: e.repoIdentifier,
      workflow: e.workflowName,
      lockSchema: e.lockSchema,
      agentSchema: COMPILE_SCHEMA_VERSION,
      isGlobal: e.isGlobal,
      remedy: formatStaleLockWarning(e),
    });
  }
  return stale;
}
