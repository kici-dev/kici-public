import { describe, it, expect } from 'vitest';
import { createStepSecrets } from './secrets.js';
import type { StepSecretsFileHost, StepSecretsFileWiring } from './secrets.js';
import { SecretNotFoundError } from './errors.js';

/**
 * Build an in-memory host adapter for unit-testing `mountFile` / `exposeFile`
 * without touching the filesystem. Each `writeMountedFile` call appends an
 * entry to the returned `files` array and returns a synthetic path.
 */
function makeMemoryHost(): {
  host: StepSecretsFileHost;
  files: Array<{ path: string; content: string; sources: string[]; mode: number; name?: string }>;
  trackedEnvs: string[];
} {
  const files: Array<{
    path: string;
    content: string;
    sources: string[];
    mode: number;
    name?: string;
  }> = [];
  const trackedEnvs: string[] = [];
  let counter = 0;
  const host: StepSecretsFileHost = {
    async writeMountedFile(args) {
      counter += 1;
      const path = `/tmp/kici-test/${args.name ?? `secret-${counter}`}`;
      files.push({
        path,
        content: args.content,
        sources: args.sources,
        mode: args.mode,
        name: args.name,
      });
      return path;
    },
    trackExposedEnv(envVar: string) {
      trackedEnvs.push(envVar);
    },
  };
  return { host, files, trackedEnvs };
}

function makeWiring(): {
  wiring: StepSecretsFileWiring;
  cleanupCalls: number;
  host: ReturnType<typeof makeMemoryHost>;
} {
  const host = makeMemoryHost();
  let cleanupCalls = 0;
  const wiring: StepSecretsFileWiring = {
    host: host.host,
    cleanup: async () => {
      cleanupCalls += 1;
    },
  };
  return {
    wiring,
    get cleanupCalls() {
      return cleanupCalls;
    },
    host,
  } as any;
}

describe('createStepSecrets', () => {
  it('returns a { secrets, dispose } handle', () => {
    const env: Record<string, string | undefined> = {};
    const handle = createStepSecrets({ KEY: 'val' }, env);
    expect(typeof handle.dispose).toBe('function');
    expect(handle.secrets.has('KEY')).toBe(true);
  });

  it('get() resolves to value for existing key', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    await expect(secrets.get('KEY')).resolves.toBe('val');
  });

  it('get() rejects with SecretNotFoundError for missing key', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    await expect(secrets.get('MISSING')).rejects.toThrow(SecretNotFoundError);
  });

  it('SecretNotFoundError message contains "await ctx.secrets.get"', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    try {
      await secrets.get('MISSING');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretNotFoundError);
      expect((err as Error).message).toContain('await ctx.secrets.get');
    }
  });

  it('has() returns true for existing key (synchronous)', () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    expect(secrets.has('KEY')).toBe(true);
  });

  it('has() returns false for missing key (synchronous, no throw)', () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    expect(secrets.has('MISSING')).toBe(false);
  });

  it('expose() resolves and sets env[KEY] = value', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    await secrets.expose('KEY');
    expect(env['KEY']).toBe('val');
  });

  it('expose() rejects with SecretNotFoundError for missing key', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    await expect(secrets.expose('MISSING')).rejects.toThrow(SecretNotFoundError);
  });

  it('after expose(), env object has the secret value', async () => {
    const env: Record<string, string | undefined> = { EXISTING: 'already' };
    const { secrets } = createStepSecrets({ MY_SECRET: 'secret-value' }, env);
    await secrets.expose('MY_SECRET');
    expect(env['MY_SECRET']).toBe('secret-value');
    expect(env['EXISTING']).toBe('already');
  });

  it('get() with empty secrets rejects with (none) in message', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({}, env);
    try {
      await secrets.get('ANY');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretNotFoundError);
      expect((err as SecretNotFoundError).message).toContain('(none)');
    }
  });

  it('error includes key and available keys', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ FOO: 'a', BAR: 'b' }, env);
    try {
      await secrets.get('NOPE');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretNotFoundError);
      const e = err as SecretNotFoundError;
      expect(e.key).toBe('NOPE');
      expect(e.availableKeys).toEqual(['FOO', 'BAR']);
    }
  });
});

describe('access tracking', () => {
  it('getAccessLog() returns empty array when no secrets accessed', () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    expect(secrets.getAccessLog()).toEqual([]);
  });

  it('get() tracks accessed secret key', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val', OTHER: 'x' }, env);
    await secrets.get('KEY');
    expect(secrets.getAccessLog()).toEqual(['KEY']);
  });

  it('expose() tracks accessed secret key', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    await secrets.expose('KEY');
    expect(secrets.getAccessLog()).toEqual(['KEY']);
  });

  it('deduplicates multiple accesses of the same key', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    await secrets.get('KEY');
    await secrets.get('KEY');
    await secrets.expose('KEY');
    expect(secrets.getAccessLog()).toEqual(['KEY']);
  });

  it('returns sorted key names across get and expose', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ Z_KEY: 'z', A_KEY: 'a', M_KEY: 'm' }, env);
    await secrets.get('Z_KEY');
    await secrets.expose('A_KEY');
    await secrets.get('M_KEY');
    expect(secrets.getAccessLog()).toEqual(['A_KEY', 'M_KEY', 'Z_KEY']);
  });

  it('does not track failed get() attempts', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    try {
      await secrets.get('MISSING');
    } catch {
      // expected
    }
    expect(secrets.getAccessLog()).toEqual([]);
  });

  it('does not include secret values in access log', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'super-secret-value' }, env);
    await secrets.get('KEY');
    const log = secrets.getAccessLog();
    expect(log).toEqual(['KEY']);
    expect(log.join('')).not.toContain('super-secret-value');
  });

  it('has() does not track access', () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    secrets.has('KEY');
    expect(secrets.getAccessLog()).toEqual([]);
  });
});

describe('list()', () => {
  it('returns alphabetically sorted key names', () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ Z: '1', A: '2', M: '3' }, env);
    expect(secrets.list()).toEqual(['A', 'M', 'Z']);
  });

  it('returns empty array when no secrets are present', () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({}, env);
    expect(secrets.list()).toEqual([]);
  });

  it('does not record an access entry', () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'val' }, env);
    secrets.list();
    expect(secrets.getAccessLog()).toEqual([]);
  });

  it('does not contain secret values', () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ KEY: 'super-secret-value' }, env);
    const names = secrets.list();
    expect(names.join('')).not.toContain('super-secret-value');
  });
});

describe('mountFile() / exposeFile()', () => {
  it('mountFile() concatenates source values without divider by default', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const { secrets } = createStepSecrets({ A: 'aaa', B: 'bbb' }, env, undefined, {
      host: host.host,
      cleanup: async () => {},
    });
    const result = await secrets.mountFile({ sources: ['A', 'B'] });
    expect(result.path).toMatch(/^\/tmp\/kici-test\//);
    expect(host.files).toHaveLength(1);
    expect(host.files[0].content).toBe('aaabbb');
    expect(host.files[0].mode).toBe(0o600);
  });

  it('mountFile() respects a custom divider', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const { secrets } = createStepSecrets({ A: 'aaa', B: 'bbb' }, env, undefined, {
      host: host.host,
      cleanup: async () => {},
    });
    await secrets.mountFile({ sources: ['A', 'B'], divider: '\n' });
    expect(host.files[0].content).toBe('aaa\nbbb');
  });

  it('mountFile() applies a custom mode when provided', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const { secrets } = createStepSecrets({ K: 'v' }, env, undefined, {
      host: host.host,
      cleanup: async () => {},
    });
    await secrets.mountFile({ sources: ['K'], mode: 0o400 });
    expect(host.files[0].mode).toBe(0o400);
  });

  it('mountFile() uses a custom filename when provided', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const { secrets } = createStepSecrets({ K: 'v' }, env, undefined, {
      host: host.host,
      cleanup: async () => {},
    });
    await secrets.mountFile({ sources: ['K'], name: 'my-key.pem' });
    expect(host.files[0].name).toBe('my-key.pem');
    expect(host.files[0].path).toBe('/tmp/kici-test/my-key.pem');
  });

  it('mountFile() throws SecretNotFoundError when a single source is missing', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const { secrets } = createStepSecrets({ A: 'aaa' }, env, undefined, {
      host: host.host,
      cleanup: async () => {},
    });
    await expect(secrets.mountFile({ sources: ['MISSING'] })).rejects.toThrow(SecretNotFoundError);
  });

  it('mountFile() lists every missing key in the error message when multiple are missing', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const { secrets } = createStepSecrets({ A: 'aaa' }, env, undefined, {
      host: host.host,
      cleanup: async () => {},
    });
    try {
      await secrets.mountFile({ sources: ['X', 'Y'] });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretNotFoundError);
      const msg = (err as Error).message;
      expect(msg).toContain('"X"');
      expect(msg).toContain('"Y"');
    }
  });

  it('mountFile() rejects on empty or non-array sources', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const { secrets } = createStepSecrets({ A: 'aaa' }, env, undefined, {
      host: host.host,
      cleanup: async () => {},
    });
    await expect(secrets.mountFile({ sources: [] })).rejects.toThrow(/non-empty array/);
    await expect(
      // @ts-expect-error - intentionally invalid
      secrets.mountFile({ sources: 'A' }),
    ).rejects.toThrow(/non-empty array/);
  });

  it('mountFile() throws when no file-mount host is wired', async () => {
    const env: Record<string, string | undefined> = {};
    const { secrets } = createStepSecrets({ A: 'aaa' }, env);
    await expect(secrets.mountFile({ sources: ['A'] })).rejects.toThrow(/file-mount host/);
  });

  it('exposeFile() sets env[envVar] to the materialised path', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const { secrets } = createStepSecrets({ K: 'val' }, env, undefined, {
      host: host.host,
      cleanup: async () => {},
    });
    const result = await secrets.exposeFile('MY_FILE', { sources: ['K'] });
    expect(env['MY_FILE']).toBe(result.path);
    expect(host.trackedEnvs).toEqual(['MY_FILE']);
  });

  it('exposeFile() rejects with a clear error on empty envVar', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const { secrets } = createStepSecrets({ K: 'val' }, env, undefined, {
      host: host.host,
      cleanup: async () => {},
    });
    await expect(secrets.exposeFile('', { sources: ['K'] })).rejects.toThrow(/non-empty string/);
  });

  it('mountFile() records every source key in the access + mounted logs', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const { secrets } = createStepSecrets({ A: 'aaa', B: 'bbb' }, env, undefined, {
      host: host.host,
      cleanup: async () => {},
    });
    await secrets.mountFile({ sources: ['B', 'A'] });
    expect(secrets.getAccessLog()).toEqual(['A', 'B']);
    expect(secrets.getMountedKeys()).toEqual(['A', 'B']);
  });

  it('getMountRecords() returns one entry per call with the correct kind discriminator', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const { secrets } = createStepSecrets({ A: 'aaa', B: 'bbb' }, env, undefined, {
      host: host.host,
      cleanup: async () => {},
    });
    await secrets.mountFile({ sources: ['A'] });
    await secrets.exposeFile('B_FILE', { sources: ['B'] });
    const records = secrets.getMountRecords();
    expect(records).toHaveLength(2);
    expect(records[0].kind).toBe('mountFile');
    expect(records[0].sources).toEqual(['A']);
    expect(records[0].envVar).toBeUndefined();
    expect(records[1].kind).toBe('exposeFile');
    expect(records[1].sources).toEqual(['B']);
    expect(records[1].envVar).toBe('B_FILE');
  });

  it('dispose() invokes the wired cleanup callback exactly once', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    let cleanupCalls = 0;
    const handle = createStepSecrets({ K: 'val' }, env, undefined, {
      host: host.host,
      cleanup: async () => {
        cleanupCalls += 1;
      },
    });
    await handle.dispose();
    expect(cleanupCalls).toBe(1);
  });

  it('dispose() never throws even when the cleanup callback rejects', async () => {
    const env: Record<string, string | undefined> = {};
    const host = makeMemoryHost();
    const errors: unknown[] = [];
    const handle = createStepSecrets({ K: 'val' }, env, undefined, {
      host: host.host,
      onDisposeError: (err) => errors.push(err),
      cleanup: async () => {
        throw new Error('boom');
      },
    });
    await expect(handle.dispose()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('dispose() is a no-op when no file-mount wiring was provided', async () => {
    const env: Record<string, string | undefined> = {};
    const handle = createStepSecrets({ K: 'val' }, env);
    await expect(handle.dispose()).resolves.toBeUndefined();
  });
});
