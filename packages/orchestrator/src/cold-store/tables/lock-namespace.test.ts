import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { AccessLogAdapter } from './access-log.js';
import { EventLogAdapter } from './event-log.js';
import { ExecutionJobsAdapter } from './execution-jobs.js';
import { ExecutionRunsAdapter } from './execution-runs.js';
import { ExecutionStepsAdapter } from './execution-steps.js';
import { SecretAuditLogAdapter } from './secret-audit-log.js';

/**
 * The lock namespace is part of the advisory-lock identity every archiver
 * replica computes; a replica on a different value would archive the same
 * partition concurrently during a rolling deploy. The key built from it is
 * proven against real Postgres in `@kici-dev/shared`'s pg-table-adapter test.
 */
describe('orchestrator cold-store adapter lock namespaces', () => {
  const kdb = {} as unknown as Kysely<Database>;
  const namespaceOf = (adapter: object): unknown =>
    (adapter as { lockNamespace?: unknown }).lockNamespace;

  // fails-when: an adapter's namespace string changes, or the base class stops storing it
  it.each([
    [new ExecutionStepsAdapter(kdb, 'i'), 'cold-store|orchestrator|execution_steps'],
    [new ExecutionJobsAdapter(kdb, 'i'), 'cold-store|orchestrator|execution_jobs'],
    [new ExecutionRunsAdapter(kdb, 'i'), 'cold-store|orchestrator|execution_runs'],
    [new SecretAuditLogAdapter(kdb, 'i'), 'cold-store|orchestrator|secret_audit_log'],
    [new AccessLogAdapter(kdb, 'i'), 'cold-store|orchestrator|access_log'],
    [new EventLogAdapter(kdb, 'i'), 'cold-store|orchestrator|event_log'],
  ])('%#: %s', (adapter, namespace) => {
    expect(namespaceOf(adapter)).toBe(namespace);
  });
});
