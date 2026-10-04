import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'npm_FAILURE_TEST_TOKEN';

/**
 * Fail every `install` the installer runs the way `execFile` reports a child
 * that exits 1 having written only to stdout: the error message is the command
 * line plus an empty stderr.
 */
vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    if (args.includes('install')) {
      // npm writes its debug log into the --cache directory before it exits.
      const cache = args[args.indexOf('--cache') + 1]!;
      mkdirSync(join(cache, '_logs'), { recursive: true });
      writeFileSync(
        join(cache, '_logs', '2026-10-03T09_16_15_000Z-debug-0.log'),
        `12 error code EPERM\n13 verbose auth ${TOKEN}\n14 verbose exit 1\n`,
      );
      const err = Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}\n`), {
        code: 1,
        signal: null,
        killed: false,
        stdout: `npm error code EPERM\nnpm error auth ${TOKEN}\n`,
        stderr: '',
      });
      cb(err);
    } else {
      cb(null, { stdout: '', stderr: '' });
    }
    return {} as never;
  },
}));

describe('installDeps failure message', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  // fails-when: installDeps rethrows the raw execFile error — the job error is
  // then "Command failed: <cmd>" with no exit code and no installer output.
  it('carries the exit code and the redacted installer output', async () => {
    const { installDeps } = await import('./dep-installer.js');
    root = await mkdtemp(join(tmpdir(), 'kici-dep-installer-failure-'));
    const kiciDir = join(root, '.kici');
    await mkdir(kiciDir, { recursive: true });
    await writeFile(join(kiciDir, 'package.json'), JSON.stringify({ name: 'wf' }));

    const err = (await installDeps(kiciDir, {
      repoRoot: root,
      baseEnv: {},
      npmRegistries: [{ url: 'https://npm.example/', alwaysAuth: true, token: TOKEN }],
    }).catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^Command failed: .* install /);
    expect(err.message).toContain('\nexit code 1\n');
    expect(err.message).toContain('stdout:\nnpm error code EPERM');
    // fails-when: the debug log is read after the per-job cache is removed, or
    // not at all.
    expect(err.message).toContain('npm debug log:\n12 error code EPERM');
    expect(err.message).not.toContain(TOKEN);
  });
});
