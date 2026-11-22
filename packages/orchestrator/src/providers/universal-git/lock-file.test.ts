import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileOptions } from 'node:child_process';
import type { SecretResolver } from '../../secrets/secret-resolver.js';
import type { UniversalGitConfig } from './config.js';

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: ExecFileOptions,
      cb: (err: Error | null, out?: unknown) => void,
    ) => cb(new Error('fatal: Authentication failed')),
  ),
);

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const { UniversalGitLockFileFetcher } = await import('./lock-file.js');

function fetcher(credentialType: UniversalGitConfig['credentialType']) {
  return new UniversalGitLockFileFetcher({
    orgId: 'org-1',
    sourceId: 'src-1',
    config: {
      preset: 'forgejo',
      gitUrlTemplate: 'https://forge.example.com/{owner}/{name}.git',
      credentialRef: { key: 'pat' },
      credentialType,
      sshHostKeyPolicy: 'accept-new',
    },
    secretResolver: {
      resolveNamedInternal: vi.fn(async () => 'rejected-secret'),
    } as unknown as SecretResolver,
  });
}

function spawnedEnv(): NodeJS.ProcessEnv {
  const opts = execFileMock.mock.calls[0]?.[2];
  expect(opts?.env).toBeDefined();
  return opts!.env!;
}

describe('UniversalGitLockFileFetcher git spawn', () => {
  afterEach(() => {
    execFileMock.mockClear();
    vi.unstubAllEnvs();
  });

  it('runs git with every credential prompt disabled', async () => {
    vi.stubEnv('GIT_ASKPASS', '/usr/bin/editor-askpass');
    vi.stubEnv('SSH_ASKPASS', '/usr/bin/ssh-askpass');
    vi.stubEnv('KICI_TEST_INHERITED', 'kept');

    await expect(fetcher('pat').fetchLockFile('acme/app', 'main', undefined)).rejects.toThrow(
      'Authentication failed',
    );

    const env = spawnedEnv();
    // fails-when: the git spawn env lacks GIT_TERMINAL_PROMPT=0, so git prompts on the terminal
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GCM_INTERACTIVE).toBe('never');
    // fails-when: an inherited askpass program runs before the terminal prompt
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    // breaks-if-wrong: git still needs the rest of the process env (PATH, HOME)
    expect(env.KICI_TEST_INHERITED).toBe('kept');
  });

  it('keeps the SSH command beside the prompt guards', async () => {
    await expect(fetcher('ssh').fetchLockFile('acme/app', 'main', undefined)).rejects.toThrow();

    const env = spawnedEnv();
    // breaks-if-wrong: an SSH source authenticates through GIT_SSH_COMMAND
    expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});
