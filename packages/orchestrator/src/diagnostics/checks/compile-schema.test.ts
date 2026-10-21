import { describe, expect, it, vi } from 'vitest';
import { COMPILE_SCHEMA_VERSION } from '@kici-dev/shared';
import { checkCompileSchema } from './compile-schema.js';
import type { DiagnosticDeps } from '../types.js';

function dbWith(rows: Array<Record<string, unknown>>): DiagnosticDeps['db'] {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({ execute: vi.fn().mockResolvedValue(rows) }),
      }),
    }),
  } as unknown as DiagnosticDeps['db'];
}

const row = (repo: string, schema: number, asText = false) => {
  const entry = { name: 'ci', compileSchemaVersion: schema };
  return {
    repo_identifier: repo,
    workflow_name: 'ci',
    is_global: false,
    lock_entry: asText ? JSON.stringify(entry) : entry,
  };
};

describe('checkCompileSchema', () => {
  it('passes when every lock matches this release', async () => {
    const r = await checkCompileSchema({
      config: {},
      db: dbWith([row('acme/app', COMPILE_SCHEMA_VERSION)]),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toContain(`compile schema ${COMPILE_SCHEMA_VERSION}`);
  });

  // fails-when: the check does not parse a JSON-text lock entry or misses a stale schema
  it('warns and names each stale lock', async () => {
    const r = await checkCompileSchema({
      config: {},
      db: dbWith([row('acme/app', COMPILE_SCHEMA_VERSION), row('acme/old', 2, true)]),
    });
    expect(r.status).toBe('warn');
    const stale = (r.details as { stale: Array<{ repoIdentifier: string; lockSchema: number }> })
      .stale;
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ repoIdentifier: 'acme/old', lockSchema: 2 });
  });

  it('warns without a database', async () => {
    expect((await checkCompileSchema({ config: {} })).status).toBe('warn');
  });
});
