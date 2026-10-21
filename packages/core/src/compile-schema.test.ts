import { describe, expect, it } from 'vitest';
import {
  COMPILE_SCHEMA_MISMATCH_PREFIX,
  COMPILE_SCHEMA_VERSION,
  formatCompileSchemaMismatch,
  formatRerunLockNote,
  isCompileSchemaMismatchMessage,
  lockCompileSchema,
  type CompileSchemaMismatchInput,
} from './compile-schema.js';
import { COMPILE_SCHEMA_VERSION as DIGEST_COMPILE_SCHEMA_VERSION } from './kici-source-digest.js';

const REPO = 'acme/ci-workflows';
const SHA = '1889df900fd4886706990f81ef150fe052a70f18';

describe('COMPILE_SCHEMA_VERSION', () => {
  it('is the binding the kici-source-digest subpath re-exports', () => {
    expect(DIGEST_COMPILE_SCHEMA_VERSION).toBe(COMPILE_SCHEMA_VERSION);
  });
});

describe('lockCompileSchema', () => {
  it('reads a positive finite schema', () => {
    expect(lockCompileSchema({ compileSchemaVersion: 5 })).toBe(5);
  });

  // fails-when: the 0 "no bundle" sentinel, a fraction or a non-number counts as a schema claim
  it.each([0, -1, 6.5, Number.NaN, '5', undefined])('returns null for %s', (v) => {
    expect(lockCompileSchema({ compileSchemaVersion: v })).toBeNull();
  });

  it('returns null for a missing entry', () => {
    expect(lockCompileSchema(null)).toBeNull();
    expect(lockCompileSchema(undefined)).toBeNull();
  });
});

describe('formatCompileSchemaMismatch', () => {
  const older: CompileSchemaMismatchInput = {
    lockSchema: 5,
    implementedSchema: 7,
    implementer: 'agents',
    lockRepo: REPO,
    implementerRelease: '0.24.0',
  };

  // fails-when: the remedy suggests upgrading the agent to the lock's schema (the
  // legacy text: "upgrade the agent to one implementing schema 5", a downgrade)
  it('older lock: recompile remedy only', () => {
    const msg = formatCompileSchemaMismatch(older);
    expect(msg.startsWith(COMPILE_SCHEMA_MISMATCH_PREFIX)).toBe(true);
    for (const part of [
      REPO,
      'schema 5',
      'schema 7',
      '@kici-dev/compiler 0.24.0',
      'npx kici compile',
      '.kici/kici.lock.json',
    ]) {
      expect(msg).toContain(part);
    }
    expect(msg).not.toMatch(/upgrade the agent/i);
    expect(msg).not.toMatch(/upgrade[^.]*schema 5/i);
  });

  it('older lock without a release names the schema to match', () => {
    const msg = formatCompileSchemaMismatch({ ...older, implementerRelease: undefined });
    expect(msg).toContain('implements schema 7');
    expect(msg).not.toContain('undefined');
  });

  // breaks-if-wrong: the upgrade remedy must survive where it is right
  it('newer lock: upgrade the agents first', () => {
    const msg = formatCompileSchemaMismatch({ ...older, lockSchema: 8 });
    expect(msg).toContain('Upgrade the agents');
    expect(msg).toContain('@kici-dev/compiler 0.24.0');
  });

  it('a single agent speaks for itself', () => {
    const msg = formatCompileSchemaMismatch({ ...older, implementer: 'agent' });
    expect(msg).toContain('this agent implements schema 7');
  });

  it('no repo: names the lock file only', () => {
    const msg = formatCompileSchemaMismatch({ ...older, lockRepo: undefined });
    expect(msg).toContain('.kici/kici.lock.json');
    expect(msg).not.toContain(' in undefined');
  });

  it('rerun clause', () => {
    const msg = formatCompileSchemaMismatch({ ...older, rerun: { repo: 'o/r', sha: SHA } });
    expect(msg).toContain('re-run');
    expect(msg).toContain('o/r@1889df9');
    expect(msg).toContain('new event');
  });

  it('formatRerunLockNote is the clause the formatter appends', () => {
    const rerun = { repo: 'o/r', sha: SHA };
    const msg = formatCompileSchemaMismatch({ ...older, rerun });
    expect(msg.endsWith(` ${formatRerunLockNote(rerun)}`)).toBe(true);
  });

  // fails-when: any runtime sentence grows past the STE 34-word floor
  it('every sentence is at most 34 words', () => {
    for (const lockSchema of [5, 8]) {
      for (const implementer of ['agent', 'agents'] as const) {
        for (const rerun of [undefined, { repo: REPO, sha: SHA }]) {
          for (const implementerRelease of [undefined, '0.24.0-10335']) {
            const msg = formatCompileSchemaMismatch({
              ...older,
              lockSchema,
              implementer,
              rerun,
              implementerRelease,
            });
            for (const sentence of msg.split('. ')) {
              const words = sentence.trim().split(/\s+/).filter(Boolean);
              expect(words.length, sentence).toBeLessThanOrEqual(34);
            }
          }
        }
      }
    }
  });
});

describe('isCompileSchemaMismatchMessage', () => {
  it('recognises the new message', () => {
    expect(
      isCompileSchemaMismatchMessage(
        formatCompileSchemaMismatch({
          lockSchema: 5,
          implementedSchema: 7,
          implementer: 'agent',
        }),
      ),
    ).toBe(true);
  });

  it('recognises the legacy agent text', () => {
    expect(
      isCompileSchemaMismatchMessage(
        'kici.lock.json was compiled by an incompatible @kici-dev/compiler: the lock declares compile schema 5, this agent implements 7.',
      ),
    ).toBe(true);
  });

  it('rejects a drift error', () => {
    expect(
      isCompileSchemaMismatchMessage('Lock file is out of date: workflow source changed'),
    ).toBe(false);
  });
});
