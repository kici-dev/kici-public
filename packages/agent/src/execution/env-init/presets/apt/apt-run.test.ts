import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AptInitConfig } from '@kici-dev/sdk';
import { runInitPhase } from '../../init-phase.js';
import { buildInitShellFor } from '../../../sandbox/workflow-runner.js';
import type { RunnerToAgentMessage } from '../../../sandbox/ipc-protocol.js';
import { aptExpander } from './expander.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Tools the script may use for real; everything else on PATH is a fake. */
const REAL_TOOLS = ['sh', 'env', 'mkdir', 'sleep', 'cat', 'true'];

interface AptHarness {
  root: string;
  bin: string;
  home: string;
  marks: string;
}

type SudoMode = 'allow' | 'refuse' | 'absent';

/**
 * A fake bin dir with `id`, `apt-get`, `chown` and, unless `absent`, `sudo`.
 * The fake sudo resets the environment like sudo's env_reset does. Called
 * without `-n`, it waits 30 s, like a sudo waiting on a password prompt.
 */
async function makeAptHarness(opts: { sudo: SudoMode; aptGet?: boolean }): Promise<AptHarness> {
  const root = await mkdtemp(join(tmpdir(), 'apt-preset-'));
  const h: AptHarness = {
    root,
    bin: join(root, 'bin'),
    home: join(root, 'home'),
    marks: join(root, 'marks'),
  };
  await Promise.all([mkdir(h.bin), mkdir(h.home), mkdir(h.marks)]);
  for (const tool of REAL_TOOLS) {
    // A file path, not `command -v`: that prints only the name of a shell builtin such as `true`.
    const real = ['/usr/bin', '/bin'].map((dir) => join(dir, tool)).find((p) => existsSync(p));
    if (!real) throw new Error(`no ${tool} in /usr/bin or /bin`);
    await symlink(real, join(h.bin, tool));
  }
  const fake = (name: string, lines: string[]) =>
    writeFile(join(h.bin, name), ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
  await fake('id', [
    'case "$1" in',
    '  -u) echo "${FAKE_UID:-1000}" ;;',
    '  -g) echo "${FAKE_GID:-1000}" ;;',
    '  -un) [ -n "${FAKE_USER:-}" ] && echo "$FAKE_USER" || { echo "id: cannot find name for user ID" >&2; exit 1; } ;;',
    'esac',
  ]);
  if (opts.aptGet !== false) {
    await fake('apt-get', [
      `printf '%s|frontend=%s|proxy=%s\\n' "$*" "\${DEBIAN_FRONTEND:-}" "\${http_proxy:-}" >> '${h.marks}/apt-get'`,
    ]);
  }
  await fake('chown', [`echo "$*" >> '${h.marks}/chown'`]);
  if (opts.sudo !== 'absent') {
    await fake('sudo', [
      `echo "$*" >> '${h.marks}/sudo'`,
      'if [ "$1" != "-n" ]; then sleep 30; exit 1; fi',
      'shift',
      ...(opts.sudo === 'refuse'
        ? ['echo "sudo: a password is required" >&2', 'exit 1']
        : [`exec ${join(h.bin, 'env')} -i PATH='${h.bin}' "$@"`]),
    ]);
  }
  vi.stubEnv('PATH', h.bin);
  vi.stubEnv('HOME', h.home);
  return h;
}

/** Expand the real preset and run it through the runner's real init shell. */
async function runAptPreset(h: AptHarness, config: AptInitConfig) {
  const spec = await aptExpander.expand({ cloneRoot: h.root, config, platform: 'linux' });
  const msgs: RunnerToAgentMessage[] = [];
  const send = (m: RunnerToAgentMessage): void => {
    msgs.push(m);
  };
  const started = Date.now();
  const result = await runInitPhase({
    specs: [spec],
    shellFor: buildInitShellFor(h.root, send),
    sendIpc: send,
    stepIndexBase: 0,
  });
  const text = [
    result.error ?? '',
    ...msgs.flatMap((m) => (m.type === 'log.line' ? [m.line] : [])),
  ].join('\n');
  const read = async (name: string) =>
    existsSync(join(h.marks, name))
      ? (await readFile(join(h.marks, name), 'utf8')).trim().split('\n')
      : [];
  return {
    result,
    text,
    elapsedMs: Date.now() - started,
    aptCalls: await read('apt-get'),
    sudoCalls: await read('sudo'),
    chownCalls: await read('chown'),
  };
}

describe('apt preset (real sh, offline fakes)', () => {
  it('runs apt-get directly as root', async () => {
    const h = await makeAptHarness({ sudo: 'absent' });
    vi.stubEnv('FAKE_UID', '0');
    const { result, aptCalls } = await runAptPreset(h, { packages: ['make'] });
    expect(result.ok).toBe(true);
    expect(aptCalls).toEqual([
      'update|frontend=noninteractive|proxy=',
      'install -y --no-install-recommends make|frontend=noninteractive|proxy=',
    ]);
  });

  it('runs apt-get through sudo -n as another user, with the init env passed through', async () => {
    const h = await makeAptHarness({ sudo: 'allow' });
    vi.stubEnv('FAKE_UID', '1000');
    vi.stubEnv('FAKE_USER', 'node');
    const { result, aptCalls, sudoCalls } = await runAptPreset(h, {
      packages: ['make'],
      env: { http_proxy: 'http://proxy:3128' },
    });
    expect(result.ok).toBe(true);
    const aptViaSudo = sudoCalls.filter((line) => line.includes(' apt-get '));
    expect(aptViaSudo).toHaveLength(2);
    expect(
      aptViaSudo.every((line) => line.startsWith('-n env DEBIAN_FRONTEND=noninteractive')),
    ).toBe(true);
    // fails-when: the preset relies on sudo keeping the environment (env_reset drops http_proxy)
    expect(aptCalls).toContain(
      'install -y --no-install-recommends make|frontend=noninteractive|proxy=http://proxy:3128',
    );
  });

  it('fails with a reason on a runner without apt-get', async () => {
    const h = await makeAptHarness({ sudo: 'allow', aptGet: false });
    const { result, text } = await runAptPreset(h, { packages: ['make'] });
    expect(result.ok).toBe(false);
    expect(text).toContain('apt-get was not found');
  });

  it('keeps the downloaded archives where the cache saves them', async () => {
    const h = await makeAptHarness({ sudo: 'allow' });
    vi.stubEnv('FAKE_UID', '1000');
    const { result, aptCalls, chownCalls } = await runAptPreset(h, {
      packages: ['make'],
      cache: true,
    });
    expect(result.ok).toBe(true);
    const archives = join(h.home, '.cache', 'kici', 'apt', 'archives');
    expect(existsSync(join(archives, 'partial'))).toBe(true);
    // fails-when: apt writes to /var/cache/apt/archives, which docker-clean empties and the cache cannot read
    expect(aptCalls[1]).toContain(`-o Dir::Cache::Archives=${archives}/ install`);
    expect(chownCalls).toEqual([`-R 1000:1000 ${archives}`]);
  });
  it('fails before apt-get, naming the user, when sudo is not installed', async () => {
    const h = await makeAptHarness({ sudo: 'absent' });
    vi.stubEnv('FAKE_UID', '1001');
    vi.stubEnv('FAKE_USER', 'app');
    const { result, text, aptCalls } = await runAptPreset(h, { packages: ['make'] });
    expect(result.ok).toBe(false);
    // fails-when: the preset reaches apt-get and dies on "sudo: not found" with no user named
    expect(text).toContain('kici init apt: user app is not root and sudo is not installed');
    expect(aptCalls).toEqual([]);
  });

  it('fails before apt-get, without waiting on a password prompt, when sudo refuses the user', async () => {
    const h = await makeAptHarness({ sudo: 'refuse' });
    vi.stubEnv('FAKE_UID', '1001');
    vi.stubEnv('FAKE_USER', 'app');
    const { result, text, aptCalls, sudoCalls, elapsedMs } = await runAptPreset(h, {
      packages: ['make'],
    });
    expect(result.ok).toBe(false);
    expect(text).toContain(
      'kici init apt: user app is not root and may not run sudo without a password',
    );
    expect(aptCalls).toEqual([]);
    // fails-when: any sudo call drops -n, which the fake answers by waiting 30 s like a password prompt
    expect(sudoCalls.every((line) => line.startsWith('-n '))).toBe(true);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('names a uid that has no user name', async () => {
    const h = await makeAptHarness({ sudo: 'absent' });
    vi.stubEnv('FAKE_UID', '1001');
    const { text } = await runAptPreset(h, { packages: ['make'] });
    expect(text).toContain('kici init apt: user 1001 is not root and sudo is not installed');
  });

  it('still installs for root with no sudo, and for a sudo-allowed user', async () => {
    // breaks-if-wrong: the guard refuses the two legitimate paths
    const root = await makeAptHarness({ sudo: 'absent' });
    vi.stubEnv('FAKE_UID', '0');
    expect((await runAptPreset(root, { packages: ['make'] })).result.ok).toBe(true);
    const user = await makeAptHarness({ sudo: 'allow' });
    vi.stubEnv('FAKE_UID', '1000');
    expect((await runAptPreset(user, { packages: ['make'] })).result.ok).toBe(true);
  });
});
