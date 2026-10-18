import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

vi.mock('../shared/versioned-upgrade.js', () => ({
  performVersionedUpgrade: vi.fn(),
}));
vi.mock('../agent-package.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-package.js')>()),
  runAgentPackageRefresh: vi.fn(async () => true),
}));

import { performVersionedUpgrade } from '../shared/versioned-upgrade.js';
import { runAgentPackageRefresh, type AgentPackageRefreshOptions } from '../agent-package.js';
import { registerUpgradeCommand } from './upgrade.js';
import type { ResolvedInstance } from '../../service/index.js';

/** Run `orchestrator upgrade <args>` through the registered command. */
async function runUpgrade(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerUpgradeCommand(program.command('orchestrator'), () => null);
  await program.parseAsync(['node', 'kici-admin', 'orchestrator', 'upgrade', ...args]);
}

describe('orchestrator upgrade: agent package refresh', () => {
  let dir: string;
  let envFilePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-upgrade-test-'));
    envFilePath = path.join(dir, 'kici-orch.env');
    // An upgrade shell that exports no storage config.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('KICI_STORAGE_') || key.startsWith('AWS_')) vi.stubEnv(key, undefined);
    }
    vi.mocked(performVersionedUpgrade).mockResolvedValue({
      manifest: { envFilePath },
    } as unknown as ResolvedInstance);
    vi.mocked(runAgentPackageRefresh).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the storage config from the upgraded instance's env file", async () => {
    fs.writeFileSync(
      envFilePath,
      'KICI_STORAGE_TYPE=s3\nKICI_STORAGE_BUCKET=instance-bucket\nKICI_PORT=4000\n',
    );

    await runUpgrade(['--yes']);

    expect(runAgentPackageRefresh).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(runAgentPackageRefresh).mock.calls[0]![0] as AgentPackageRefreshOptions;
    // fails-when: the command passes no storage source, so the refresh reads
    // the shell, which sets no KICI_STORAGE_*.
    expect(opts.storageEnv).toEqual({
      env: { KICI_STORAGE_TYPE: 's3', KICI_STORAGE_BUCKET: 'instance-bucket' },
      origin: `the env file ${envFilePath}`,
    });
  });

  it('skips the refresh with --no-agent-packages', async () => {
    await runUpgrade(['--yes', '--no-agent-packages']);
    // breaks-if-wrong: an operator who publishes payloads out of band never
    // has the env file read.
    expect(runAgentPackageRefresh).not.toHaveBeenCalled();
  });

  it('reports an unreadable env file as a failed refresh, with the retry command', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runUpgrade(['--yes']);

    // fails-when: an unreadable env file reads as "no storage" and the
    // refresh skips with exit code 0.
    expect(runAgentPackageRefresh).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toContain(`cannot read the env file ${envFilePath} (ENOENT)`);
    expect(lines[1]).toBe(
      `Run \`kici-admin agent package --upload --env-file ${envFilePath}\` manually ` +
        'to refresh the fleet payloads.',
    );
  });
});
