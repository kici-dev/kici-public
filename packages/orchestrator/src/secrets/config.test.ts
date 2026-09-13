/**
 * Tests for master-key resolution: the env-then-file precedence, and that both
 * the raw-material and derived-Buffer forms come from the same source. The
 * file path is the load-bearing case — reading `config.secretKey` directly at a
 * wrapped store honours `KICI_SECRET_KEY` and silently ignores
 * `KICI_SECRET_KEY_FILE`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveKey } from '@kici-dev/shared';
import { resolveMasterKeys } from './config.js';

const CURRENT = '0'.repeat(64);
const OLD = '1'.repeat(64);

describe('resolveMasterKeys', () => {
  let dir: string;
  const saved = {
    key: process.env.KICI_SECRET_KEY,
    old: process.env.KICI_SECRET_KEY_OLD,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kici-master-key-'));
    delete process.env.KICI_SECRET_KEY;
    delete process.env.KICI_SECRET_KEY_OLD;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.key === undefined) delete process.env.KICI_SECRET_KEY;
    else process.env.KICI_SECRET_KEY = saved.key;
    if (saved.old === undefined) delete process.env.KICI_SECRET_KEY_OLD;
    else process.env.KICI_SECRET_KEY_OLD = saved.old;
  });

  it('returns null when no master key is configured at all', () => {
    expect(resolveMasterKeys({})).toBeNull();
  });

  it('resolves from the env var, in both forms', () => {
    process.env.KICI_SECRET_KEY = CURRENT;
    const keys = resolveMasterKeys({ secretKey: CURRENT })!;
    expect(keys.material).toBe(CURRENT);
    expect(keys.current.equals(deriveKey(CURRENT))).toBe(true);
    expect(keys.materialOld).toBeUndefined();
    expect(keys.old).toBeUndefined();
  });

  it('resolves from KICI_SECRET_KEY_FILE when the env var is unset', () => {
    const file = join(dir, 'master.key');
    writeFileSync(file, `${CURRENT}\n`);
    const keys = resolveMasterKeys({ secretKeyFile: file })!;
    expect(keys.material).toBe(CURRENT);
    expect(keys.current.equals(deriveKey(CURRENT))).toBe(true);
  });

  it('resolves the old key from KICI_SECRET_KEY_FILE_OLD', () => {
    const file = join(dir, 'master.key');
    const oldFile = join(dir, 'master.old.key');
    writeFileSync(file, CURRENT);
    writeFileSync(oldFile, OLD);
    const keys = resolveMasterKeys({ secretKeyFile: file, secretKeyFileOld: oldFile })!;
    expect(keys.materialOld).toBe(OLD);
    expect(keys.old!.equals(deriveKey(OLD))).toBe(true);
  });

  it('prefers the env var over the file, for both generations', () => {
    const file = join(dir, 'master.key');
    writeFileSync(file, OLD);
    process.env.KICI_SECRET_KEY = CURRENT;
    const keys = resolveMasterKeys({ secretKey: CURRENT, secretKeyFile: file })!;
    expect(keys.material).toBe(CURRENT);
  });
});
