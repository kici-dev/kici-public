import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Records every subprocess the installer spawns, so a test can assert what the
 * install actually ran and with which environment.
 */
interface SpawnRecord {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const spawns: SpawnRecord[] = [];

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv },
    cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
  ) => {
    spawns.push({ file, args, env: opts?.env ?? {} });
    cb(null, { stdout: '', stderr: '' });
    return {} as never;
  },
}));

async function makeKiciRepo(manager: 'npm' | 'pnpm' | 'yarn'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kici-dep-installer-'));
  const kiciDir = join(root, '.kici');
  await mkdir(kiciDir, { recursive: true });
  await writeFile(
    join(kiciDir, 'package.json'),
    JSON.stringify({ name: 'wf', dependencies: { '@kici-dev/sdk': '1.0.0' } }),
  );
  if (manager === 'pnpm') await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  if (manager === 'yarn') await writeFile(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
  return root;
}

/** The install argv for the package manager under test (skips `--version` probes). */
function installSpawn(): SpawnRecord {
  const record = spawns.find((s) => s.args.includes('install'));
  if (!record) throw new Error(`no install spawn recorded; saw ${JSON.stringify(spawns)}`);
  return record;
}

describe('installDeps environment and lifecycle scripts', () => {
  const roots: string[] = [];

  beforeEach(() => {
    spawns.length = 0;
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const managers = ['npm', 'pnpm', 'yarn'] as const;

  for (const manager of managers) {
    it(`keeps the agent's credentials out of the ${manager} install env`, async () => {
      const { installDeps } = await import('./dep-installer.js');
      const root = await makeKiciRepo(manager);
      roots.push(root);

      // The agent's own environment, as it looks before the boot scrub.
      process.env.KICI_AGENT_TOKEN = 'kat_agent-token';
      process.env.KICI_ORCHESTRATOR_URL = 'wss://orchestrator.example';

      try {
        await installDeps(join(root, '.kici'), {
          repoRoot: root,
          // What an agent-process caller must pass: a sanitized base, never
          // process.env.
          baseEnv: { PATH: process.env.PATH ?? '', HOME: '/home/kici' },
        });
      } finally {
        delete process.env.KICI_AGENT_TOKEN;
        delete process.env.KICI_ORCHESTRATOR_URL;
      }

      const env = installSpawn().env;
      expect(env.KICI_AGENT_TOKEN).toBeUndefined();
      expect(env.KICI_ORCHESTRATOR_URL).toBeUndefined();
      expect(env.HOME).toBe('/home/kici');
    });

    it(`passes --ignore-scripts for ${manager} with no private registry`, async () => {
      const { installDeps } = await import('./dep-installer.js');
      const root = await makeKiciRepo(manager);
      roots.push(root);

      await installDeps(join(root, '.kici'), { repoRoot: root, baseEnv: {} });

      expect(installSpawn().args).toContain('--ignore-scripts');
    });

    it(`omits --ignore-scripts for ${manager} under the operator opt-out`, async () => {
      const { installDeps } = await import('./dep-installer.js');
      const root = await makeKiciRepo(manager);
      roots.push(root);

      await installDeps(join(root, '.kici'), {
        repoRoot: root,
        baseEnv: {},
        allowInstallScripts: true,
      });

      expect(installSpawn().args).not.toContain('--ignore-scripts');
    });
  }

  it('defaults baseEnv to process.env, which is the sanitized env inside the runner child', async () => {
    const { installDeps } = await import('./dep-installer.js');
    const root = await makeKiciRepo('npm');
    roots.push(root);

    process.env.KICI_JOB_MARKER = 'from-orchestrator';
    try {
      await installDeps(join(root, '.kici'), { repoRoot: root });
    } finally {
      delete process.env.KICI_JOB_MARKER;
    }

    expect(installSpawn().env.KICI_JOB_MARKER).toBe('from-orchestrator');
  });
});
