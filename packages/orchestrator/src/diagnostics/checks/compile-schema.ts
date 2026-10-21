/**
 * Workflow-lock compile-schema check: does any registered workflow lock declare a
 * compile schema this orchestrator release's agents do not implement? Every run
 * of such a lock fails on the agent, and nothing else says so before it runs.
 *
 * WARN with `details.stale` naming each stale lock; PASS otherwise. A stale lock
 * breaks that workflow's runs only, so it is degraded, never `fail`.
 */
import { COMPILE_SCHEMA_VERSION, toErrorMessage } from '@kici-dev/shared';
import type { DiagnosticDeps, DiagnosticResult } from '../types.js';
import { staleCompileSchemaEntries } from '../../registration/compile-schema-staleness.js';

const NAME = 'Workflow lock compile schema';

/** A `lock_entry` column value: JSON text, or an already-parsed object. */
function parseLockEntry(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function checkCompileSchema(deps: DiagnosticDeps): Promise<DiagnosticResult> {
  const start = Date.now();
  if (!deps.db) {
    return {
      name: NAME,
      status: 'warn',
      message: 'No database connection; registered workflow locks could not be checked.',
      durationMs: Date.now() - start,
    };
  }
  try {
    const rows = await deps.db
      .selectFrom('workflow_registrations')
      .select(['repo_identifier', 'workflow_name', 'is_global', 'lock_entry'])
      .where('disabled', '=', false)
      .execute();
    const stale = staleCompileSchemaEntries(
      rows.map((r) => ({
        repoIdentifier: r.repo_identifier,
        workflowName: r.workflow_name,
        isGlobal: r.is_global,
        lockEntry: parseLockEntry(r.lock_entry),
      })),
    );
    if (stale.length === 0) {
      return {
        name: NAME,
        status: 'pass',
        message: `All ${rows.length} registered workflow locks match compile schema ${COMPILE_SCHEMA_VERSION}.`,
        details: { agentSchema: COMPILE_SCHEMA_VERSION, registrations: rows.length },
        durationMs: Date.now() - start,
      };
    }
    return {
      name: NAME,
      status: 'warn',
      message:
        `${stale.length} registered workflow lock(s) declare a compile schema other than ` +
        `${COMPILE_SCHEMA_VERSION}, which this release's agents implement. Their runs fail ` +
        `until each lock is recompiled with the matching @kici-dev/compiler and committed.`,
      details: { agentSchema: COMPILE_SCHEMA_VERSION, stale },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: NAME,
      status: 'warn',
      message: `Could not read workflow registrations: ${toErrorMessage(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
