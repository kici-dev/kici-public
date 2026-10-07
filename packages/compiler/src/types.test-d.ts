import { describe, it, expectTypeOf } from 'vitest';
import type { CacheSpec, GenericInitConfig, InitConfig, MiseInitConfig } from '@kici-dev/sdk';
import type { LockCacheSpec, LockInitConfig } from '@kici-dev/engine';
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

/**
 * The engine cannot import the SDK, so the lock-file cache and init shapes are
 * structural mirrors. The generator copies the SDK values through unchanged, so
 * each SDK shape must stay assignable to its mirror.
 */
describe('engine lock mirrors of SDK shapes', () => {
  // fails-when: an engine mirror narrows a field the SDK shape allows (e.g. `paths` becomes a tuple)
  it('accepts the SDK cache spec and init config', () => {
    expectTypeOf<CacheSpec>().toMatchTypeOf<LockCacheSpec>();
    expectTypeOf<InitConfig>().toMatchTypeOf<LockInitConfig>();
  });

  // Assignability alone passes when the SDK gains a field the mirror lacks, so
  // the field sets are pinned too.
  // fails-when: an SDK cache or init shape gains a field its engine mirror does not declare
  it('declares the same fields as each SDK shape', () => {
    type LockGeneric = Extract<LockInitConfig, { readonly run: string }>;
    type LockMise = Extract<LockInitConfig, { readonly mise: unknown }>['mise'];
    expectTypeOf<keyof LockCacheSpec>().toEqualTypeOf<keyof CacheSpec>();
    expectTypeOf<keyof LockGeneric>().toEqualTypeOf<keyof GenericInitConfig>();
    expectTypeOf<keyof LockMise>().toEqualTypeOf<keyof MiseInitConfig>();
  });

  // control: the matcher rejects a shape the lock never carries, so the assertion above can fail
  it('refuses a cache spec with a non-string key', () => {
    expectTypeOf<{ key: number; paths: string[] }>().not.toMatchTypeOf<LockCacheSpec>();
    expectTypeOf<{ run: number }>().not.toMatchTypeOf<LockInitConfig>();
    expectTypeOf<keyof LockCacheSpec>().not.toEqualTypeOf<keyof CacheSpec | 'scope'>();
  });
});
