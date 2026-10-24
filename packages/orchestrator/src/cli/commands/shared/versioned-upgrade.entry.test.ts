/**
 * The npm-source orchestrator upgrade through its real entry point,
 * `performVersionedUpgrade`: the hooks it receives must reach the self-drive
 * and restart-only paths, so the pre-upgrade dump runs before npm installs and
 * before anything stops. Only the target resolution (no init system here) and
 * `spawnSync` (the npm process) are replaced; every other step runs as shipped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '@kici-dev/test-support/tmp';
import type {
  InstanceManifest,
  LaunchSpec,
  ResolvedInstance,
  ServiceManager,
} from '../../service/index.js';

/** Every hook, npm and manager call, in the order it happened. */
const order: string[] = [];
const target: { resolved?: ResolvedInstance; manager?: ServiceManager } = {};

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // npm fails, so the upgrade stops right after the step under test.
    spawnSync: vi.fn((cmd: string, args: readonly string[]) => {
      order.push(`npm ${args.filter((a) => !a.endsWith('npm-cli.js'))[0] ?? cmd}`);
      return { status: 1, stdout: '', stderr: 'npm error stopped by the test', pid: 0, output: [] };
    }),
  };
});

vi.mock('../../service/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../service/index.js')>();
  return {
    ...actual,
    resolveInstanceTarget: vi.fn(async () => ({
      resolved: target.resolved!,
      manager: target.manager!,
      platform: 'systemd' as const,
    })),
  };
});

const { performVersionedUpgrade } = await import('./versioned-upgrade.js');

describe('performVersionedUpgrade — an npm-source orchestrator upgrade', () => {
  let tmp: string;
  let spec: LaunchSpec;
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    order.length = 0;
    tmp = makeTempDir('kici-npm-entry-');
    const prefix = path.join(tmp, 'prefix');
    const orch = path.join(
      prefix,
      'lib',
      'node_modules',
      'kici-admin',
      'node_modules',
      '@kici-dev',
      'orchestrator',
    );
    fs.mkdirSync(path.join(orch, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'bin', 'node'), '', { mode: 0o755 });
    fs.writeFileSync(
      path.join(orch, 'package.json'),
      JSON.stringify({ name: '@kici-dev/orchestrator', version: '0.26.0' }),
    );
    fs.writeFileSync(path.join(orch, 'dist', 'server.js'), '');
    spec = {
      execPath: path.join(prefix, 'bin', 'node'),
      args: [path.join(orch, 'dist', 'server.js')],
    };
    const envFilePath = path.join(tmp, 'orch.env');
    fs.writeFileSync(envFilePath, 'KICI_PORT=1\n');
    const manifest: InstanceManifest = {
      component: 'orchestrator',
      name: 'kici-orch-entry',
      platform: 'systemd',
      isUserLevel: true,
      envFilePath,
      configDir: tmp,
      logDir: tmp,
      installBase: path.join(tmp, 'base'),
      createdAt: '2026-10-22T00:00:00Z',
      kiciVersion: '0.26.0',
    };
    target.resolved = {
      manifest,
      manifestPath: path.join(tmp, '.kici-orchestrator.json'),
      instanceDir: tmp,
    };
    const record = (verb: string) =>
      vi.fn(async () => {
        order.push(verb);
      });
    target.manager = {
      platform: 'systemd',
      install: record('install'),
      uninstall: record('uninstall'),
      start: record('start'),
      stop: record('stop'),
      restart: record('restart'),
      status: vi.fn(async () => ({ state: 'running' as const })),
      logs: vi.fn(async () => undefined),
      isInstalled: vi.fn(async () => true),
      list: vi.fn(async () => []),
      readLaunchSpec: vi.fn(async () => spec),
    };
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function hooks(backupFails = false) {
    return {
      migrationStatus: vi.fn(async () => {
        order.push('migrationStatus');
        return { migrations: [] };
      }),
      backup: vi.fn(async (a: { outputPath: string }) => {
        order.push('backup');
        if (backupFails) throw new Error('KICI_DATABASE_URL could not be resolved');
        return { outputPath: a.outputPath, byteSize: 1 };
      }),
      drain: vi.fn(async () => {
        order.push('drain');
        return { quiesced: true, jobsRunning: 0 };
      }),
    };
  }

  // fails-when: performNpmSourceUpgrade drops the hooks it is given, so the
  // self-drive installs with no dump (npm is the first call recorded).
  it('a self-drive passes its hooks through: the dump runs before npm', async () => {
    const h = hooks();
    await expect(
      performVersionedUpgrade('orchestrator', { version: '0.27.0', yes: true }, h),
    ).rejects.toThrow('process.exit(1)');
    expect(order).toEqual(['migrationStatus', 'backup', 'npm install']);
    expect(h.backup.mock.calls[0]![0].outputPath).toMatch(
      /pre-upgrade-0\.26\.0-0\.27\.0-.*\.dump$/,
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  // breaks-if-wrong: a refused dump stops the upgrade before npm and the service.
  it('a refused dump runs no npm and touches no service', async () => {
    await expect(
      performVersionedUpgrade('orchestrator', { version: '0.27.0', yes: true }, hooks(true)),
    ).rejects.toThrow('process.exit(1)');
    expect(order).toEqual(['migrationStatus', 'backup']);
  });

  it('--restart-only passes its hooks through: dump and drain before the stop', async () => {
    // The restart-only guard compares the requested version with the running CLI.
    const { readKiciVersion } = await import('../../service/index.js');
    fs.writeFileSync(
      path.join(path.dirname(path.dirname(spec.args[0]!)), 'package.json'),
      JSON.stringify({ name: '@kici-dev/orchestrator', version: readKiciVersion() }),
    );
    await performVersionedUpgrade('orchestrator', { restartOnly: true, yes: true }, hooks());
    expect(order.slice(0, 4)).toEqual(['migrationStatus', 'backup', 'drain', 'stop']);
    expect(order).not.toContain('npm install');
  });
});
