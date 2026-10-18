import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  collectHelp,
  findSentinelLeaks,
  flatHelp,
  sentinelLeaksAfterLoad,
  secretEnvVarsReadIn,
  sentinelFor,
  type HelpNode,
} from './cli-help-secrets.js';
import { makeTempDir } from './tmp.js';

function node(name: string, help: string, commands: HelpNode[] = []): HelpNode {
  return { name: () => name, helpInformation: () => help, commands };
}

describe('secretEnvVarsReadIn', () => {
  it('finds direct reads and helper-passed names, skipping tests and non-secrets', () => {
    const dir = makeTempDir('cli-help-secrets-');
    mkdirSync(path.join(dir, 'nested'));
    writeFileSync(
      path.join(dir, 'a.ts'),
      "const t = process.env.APP_TOKEN; const u = process.env['DB_URL'];\n" +
        "const r = process.env.LOG_LEVEL; envOption('--key <k>', 'Key', 'KMS_SECRET_ACCESS_KEY');\n" +
        'const pat = process.env.KICI_PLATFORM_PAT; const path = process.env.KICI_PATH_PREFIX;\n',
    );
    writeFileSync(path.join(dir, 'nested', 'b.ts'), "new Option('-p').env('ADMIN_PASSWORD');\n");
    writeFileSync(path.join(dir, 'a.test.ts'), 'process.env.TEST_ONLY_TOKEN;\n');
    // fails-when: the scan misses a direct read, a bracket read, a nested file, or a
    // name handed to .env() through a helper; or picks up a test file or a non-secret.
    expect(secretEnvVarsReadIn(dir)).toEqual([
      'ADMIN_PASSWORD',
      'APP_TOKEN',
      'DB_URL',
      'KICI_PLATFORM_PAT',
      'KMS_SECRET_ACCESS_KEY',
    ]);
  });
});

describe('findSentinelLeaks', () => {
  it('reports a sentinel in any nested command help, and nothing for clean help', () => {
    const root = node('cli', 'Options: --token (env: APP_TOKEN)', [
      node('sub', 'nothing here', [
        node('leaky', `--token (default: "${sentinelFor('APP_TOKEN')}")`),
      ]),
    ]);
    expect([...collectHelp(root).keys()]).toEqual(['cli', 'cli sub', 'cli sub leaky']);
    // fails-when: the walk stops above the leaf, or the env name alone counts as a leak.
    expect(findSentinelLeaks(root, ['APP_TOKEN'])).toEqual(['cli sub leaky: APP_TOKEN']);
    // breaks-if-wrong: help that names the env var without its value must stay clean.
    expect(findSentinelLeaks(node('cli', '(env: APP_TOKEN)'), ['APP_TOKEN'])).toEqual([]);
  });
});

describe('sentinelLeaksAfterLoad', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('plants the sentinels before loading, so an env read at load time is caught', async () => {
    const { leaks } = await sentinelLeaksAfterLoad(['APP_TOKEN'], async () =>
      node('cli', `--token (default: "${process.env.APP_TOKEN}")`),
    );
    // fails-when: the env is stubbed after load, so the default reads the real value.
    expect(leaks).toEqual(['cli: APP_TOKEN']);
  });

  it('flattens wrapped help for hint matching', () => {
    expect(flatHelp(node('cli', 'Token (env:\n   APP_TOKEN)'))).toBe('Token (env: APP_TOKEN)');
  });
});
