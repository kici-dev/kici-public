import { describe, expect, it, vi } from 'vitest';
import { COMPILE_SCHEMA_VERSION } from '@kici-dev/shared';
import {
  formatStaleLockWarning,
  staleCompileSchemaEntries,
  warnStaleCompileSchemas,
} from './compile-schema-staleness.js';

const row = (lockEntry: unknown, isGlobal?: boolean) => ({
  repoIdentifier: 'acme/app',
  workflowName: 'ci',
  lockEntry,
  ...(isGlobal !== undefined && { isGlobal }),
});

describe('staleCompileSchemaEntries', () => {
  // fails-when: a lock whose schema the agents reject is not reported
  it('reports a lock compiled for another schema', () => {
    expect(staleCompileSchemaEntries([row({ compileSchemaVersion: 5 })], 7)).toEqual([
      { repoIdentifier: 'acme/app', workflowName: 'ci', lockSchema: 5, isGlobal: false },
    ]);
  });

  // breaks-if-wrong: a current lock, or one with no schema claim, is never flagged
  it('leaves a current lock and a lock with no schema alone', () => {
    expect(
      staleCompileSchemaEntries(
        [row({ compileSchemaVersion: 7 }), row({ compileSchemaVersion: 0 }), row({})],
        7,
      ),
    ).toEqual([]);
  });

  it('defaults to this release schema and carries isGlobal', () => {
    const [stale] = staleCompileSchemaEntries([
      row({ compileSchemaVersion: COMPILE_SCHEMA_VERSION - 1 }, true),
    ]);
    expect(stale?.isGlobal).toBe(true);
  });
});

describe('formatStaleLockWarning', () => {
  const entry = { repoIdentifier: 'acme/app', workflowName: 'ci', lockSchema: 5, isGlobal: false };

  it('names the workflow, both schemas and the compiler release', () => {
    expect(formatStaleLockWarning(entry, 7, '0.25.0')).toBe(
      'acme/app workflow ci: its lock declares compile schema 5, but agents of this orchestrator ' +
        'release (0.25.0) implement schema 7. Recompile it with @kici-dev/compiler 0.25.0 and ' +
        'commit .kici/kici.lock.json.',
    );
  });

  it('reads without a release', () => {
    const line = formatStaleLockWarning(entry, 7, undefined);
    expect(line).not.toContain('undefined');
    expect(line).toContain('implement schema 7');
  });
});

describe('warnStaleCompileSchemas', () => {
  // fails-when: a stale lock is found but nothing is logged for it
  it('logs one warning per stale lock and returns them', () => {
    const log = { warn: vi.fn() };
    const stale = warnStaleCompileSchemas(log, [
      row({ compileSchemaVersion: COMPILE_SCHEMA_VERSION - 1 }),
      row({ compileSchemaVersion: COMPILE_SCHEMA_VERSION }),
    ]);
    expect(stale).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toBe('Registered workflow lock has a stale compile schema');
    expect(log.warn.mock.calls[0]![1]).toMatchObject({
      repo: 'acme/app',
      workflow: 'ci',
      lockSchema: COMPILE_SCHEMA_VERSION - 1,
      agentSchema: COMPILE_SCHEMA_VERSION,
    });
  });
});
