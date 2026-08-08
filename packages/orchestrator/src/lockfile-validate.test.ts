import { describe, it, expect } from 'vitest';
import {
  LockFileParseError,
  SCHEMA_VERSION,
  BREAKING_FLOOR,
  type LockFile,
} from '@kici-dev/engine';
import {
  parseLockDocument,
  assertLockFileSchemaCompatible,
  assertLockFileMatchersValid,
} from './lockfile-validate.js';

function baseLock(overrides: Partial<LockFile> = {}): LockFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: { file: 'test', export: '#default' },
    contentHash: 'hash',
    workflows: [],
    ...overrides,
  } as LockFile;
}

/** Wrap a single static job (with arbitrary extra fields) into a lock. */
function lockWithStaticJob(job: Record<string, unknown>): LockFile {
  return baseLock({
    workflows: [
      {
        name: 'wf',
        jobs: [{ _type: 'static', name: 'job', steps: [], ...job } as unknown as never],
      } as unknown as never,
    ],
  });
}

function lockWithRunsOn(runsOn: unknown): LockFile {
  return lockWithStaticJob({ runsOn });
}

describe('parseLockDocument', () => {
  it('throws LockFileParseError on invalid JSON', () => {
    expect(() => parseLockDocument('{not json', 'owner/repo', 'main')).toThrow(LockFileParseError);
  });

  it('throws LockFileParseError when schemaVersion is missing', () => {
    expect(() => parseLockDocument('{"workflows":[]}', 'owner/repo', 'main')).toThrow(
      /missing or invalid schemaVersion/,
    );
  });

  it('throws LockFileParseError when schemaVersion is non-numeric', () => {
    expect(() => parseLockDocument('{"schemaVersion":"21"}', 'owner/repo', 'main')).toThrow(
      LockFileParseError,
    );
  });

  it('returns the parsed lock for a structurally valid document', () => {
    const raw = JSON.stringify(baseLock());
    expect(parseLockDocument(raw, 'owner/repo', 'main').schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe('assertLockFileSchemaCompatible (compatibility window)', () => {
  const REPO = 'owner/repo';
  const REF = 'main';

  it('accepts a lock at the current version', () => {
    expect(() => assertLockFileSchemaCompatible(baseLock(), REPO, REF)).not.toThrow();
  });

  it('accepts a newer additive lock (schemaVersion above current, minReaderVersion at floor)', () => {
    expect(() =>
      assertLockFileSchemaCompatible(
        baseLock({
          schemaVersion: (SCHEMA_VERSION + 3) as never,
          minReaderVersion: BREAKING_FLOOR,
        }),
        REPO,
        REF,
      ),
    ).not.toThrow();
  });

  it('accepts an older-but-post-floor lock (down to the breaking floor)', () => {
    expect(() =>
      assertLockFileSchemaCompatible(
        baseLock({ schemaVersion: BREAKING_FLOOR as never }),
        REPO,
        REF,
      ),
    ).not.toThrow();
  });

  it('rejects a below-floor lock as LockFileParseError with compile-and-push guidance', () => {
    const stale = baseLock({ schemaVersion: (BREAKING_FLOOR - 1) as never });
    expect(() => assertLockFileSchemaCompatible(stale, REPO, REF)).toThrow(LockFileParseError);
    expect(() => assertLockFileSchemaCompatible(stale, REPO, REF)).toThrow(/kici compile/);
  });

  it('rejects a lock demanding a newer reader with the upgrade guidance', () => {
    const future = baseLock({
      schemaVersion: (SCHEMA_VERSION + 5) as never,
      minReaderVersion: SCHEMA_VERSION + 2,
    });
    expect(() => assertLockFileSchemaCompatible(future, REPO, REF)).toThrow(LockFileParseError);
    expect(() => assertLockFileSchemaCompatible(future, REPO, REF)).toThrow(
      /upgrade the orchestrator/i,
    );
  });

  it('missing minReaderVersion falls back to exact-match strictness for newer locks', () => {
    expect(() =>
      assertLockFileSchemaCompatible(
        baseLock({ schemaVersion: (SCHEMA_VERSION + 1) as never }),
        REPO,
        REF,
      ),
    ).toThrow(/upgrade the orchestrator/i);
    expect(() => assertLockFileSchemaCompatible(baseLock(), REPO, REF)).not.toThrow();
  });
});

describe('assertLockFileMatchersValid', () => {
  it('passes for valid exact/regex matchers', () => {
    const lock = lockWithRunsOn([{ kind: 'exact', value: 'firecracker' }]);
    expect(() => assertLockFileMatchersValid(lock)).not.toThrow();
  });

  it('throws for a stale string-array runsOn', () => {
    const lock = lockWithRunsOn(['firecracker', 'arm64']);
    expect(() => assertLockFileMatchersValid(lock)).toThrow(/recompile/i);
  });

  it('throws for a malformed matcher object', () => {
    const lock = lockWithRunsOn([{ kind: 'bogus' }]);
    expect(() => assertLockFileMatchersValid(lock)).toThrow(/invalid label matcher/i);
  });

  it('throws for a malformed excludeLabels element', () => {
    const lock = lockWithStaticJob({
      runsOn: [{ kind: 'exact', value: 'x' }],
      excludeLabels: ['stale-string'],
    });
    expect(() => assertLockFileMatchersValid(lock)).toThrow(/recompile/i);
  });

  it('throws for a malformed runsOnAll include matcher', () => {
    const lock = lockWithStaticJob({
      runsOnAll: { include: [['stale-string']], exclude: [] },
    });
    expect(() => assertLockFileMatchersValid(lock)).toThrow(/recompile/i);
  });

  it('throws for a malformed runsOnAll exclude matcher', () => {
    const lock = lockWithStaticJob({
      runsOnAll: { include: [[{ kind: 'exact', value: 'x' }]], exclude: ['stale-string'] },
    });
    expect(() => assertLockFileMatchersValid(lock)).toThrow(/recompile/i);
  });

  it('skips dynamic job generators (no static routing matchers to validate)', () => {
    const lock = baseLock({
      workflows: [
        {
          name: 'wf',
          jobs: [{ _type: 'dynamic', fn: () => [] } as unknown as never],
        } as unknown as never,
      ],
    });
    expect(() => assertLockFileMatchersValid(lock)).not.toThrow();
  });
});
