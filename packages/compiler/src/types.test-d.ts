import { describe, it, expectTypeOf } from 'vitest';
import type { LockJob } from './types.js';

/**
 * The lock-file dynamic fields no longer admit the schema-v11 inline
 * expression `{ _type: 'inline', expression }`. That object is itself a
 * `Record<string, string>`, so the `env` axis is pinned by type identity rather
 * than by an assignment the compiler would accept either way; the two string
 * fields refuse the object outright.
 */
describe('LockJob dynamic fields', () => {
  // fails-when: `concurrencyGroup` regains `| LockInlineValue`
  it('refuses an inline expression as the concurrency group', () => {
    const job: LockJob = {
      _type: 'static',
      name: 'build',
      steps: [],
      needs: [],
      // @ts-expect-error — the concurrency group is a plain string
      concurrencyGroup: { _type: 'inline', expression: '() => "deploy"' },
    };
    expectTypeOf(job).toBeObject();
  });

  // fails-when: `contexts[].value` regains `| LockInlineValue`
  it('refuses an inline expression as a context name', () => {
    const job: LockJob = {
      _type: 'static',
      name: 'build',
      steps: [],
      needs: [],
      // @ts-expect-error — a bound context is named by a plain string
      contexts: [{ value: { _type: 'inline', expression: '() => "prod"' }, dynamic: false }],
    };
    expectTypeOf(job).toBeObject();
  });

  // fails-when: `env` regains `| LockInlineValue` — the union is a distinct type
  // even though the inline object is assignable to the record
  it('types env as exactly a plain record', () => {
    expectTypeOf<LockJob['env']>().toEqualTypeOf<Record<string, string> | undefined>();
  });

  // breaks-if-wrong: the static shapes must still compile
  it('accepts the static shapes', () => {
    const job: LockJob = {
      _type: 'static',
      name: 'build',
      steps: [],
      needs: [],
      env: { NODE_ENV: 'test' },
      dynamicEnv: true,
      concurrencyGroup: 'deploy',
      contexts: [{ value: 'production', dynamic: false }],
    };
    expectTypeOf(job.env).toEqualTypeOf<Record<string, string> | undefined>();
    expectTypeOf(job.concurrencyGroup).toEqualTypeOf<string | undefined>();
  });
});
