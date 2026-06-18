import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gitClone } from './git-clone.js';

// Track execFileSync calls
let execFileSyncCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];

// Default rev-parse result
let revParseStdout = 'abc123def456789';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

function defaultExecFileSync(cmd: unknown, args: unknown[], opts: unknown) {
  const argsArr = (args ?? []) as string[];
  execFileSyncCalls.push({
    cmd: cmd as string,
    args: argsArr,
    opts: (opts ?? {}) as Record<string, unknown>,
  });

  // If this is a rev-parse call, return the mock SHA
  if (argsArr.some((a) => a === 'rev-parse')) {
    return revParseStdout + '\n';
  }

  // For clone/fetch/checkout, return empty buffer
  return Buffer.from('');
}

const { execFileSync } = await import('node:child_process');

describe('gitClone', () => {
  beforeEach(() => {
    execFileSyncCalls = [];
    revParseStdout = 'abc123def456789';
    vi.mocked(execFileSync)
      .mockReset()
      .mockImplementation(defaultExecFileSync as any);
  });

  it('calls git with correct args for shallow clone', async () => {
    await gitClone({
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'main',
      sha: 'abc123',
      workDir: '/tmp/work',
    });

    // First call: git clone
    const cloneCall = execFileSyncCalls[0];
    expect(cloneCall.cmd).toBe('git');
    expect(cloneCall.args).toContain('clone');
    expect(cloneCall.args).toContain('--depth');
    expect(cloneCall.args).toContain('1');
    expect(cloneCall.args).toContain('--branch');
    expect(cloneCall.args).toContain('main');
    expect(cloneCall.args).toContain('https://github.com/org/repo.git');
    expect(cloneCall.args).toContain('/tmp/work');
  });

  it('uses -c http.extraHeader for token auth (NOT in the URL)', async () => {
    await gitClone({
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'main',
      sha: 'abc123',
      workDir: '/tmp/work',
      token: 'ghs_secret123',
    });

    const cloneCall = execFileSyncCalls[0];
    // Token should be in http.extraHeader as Basic auth
    expect(cloneCall.args).toContain('-c');
    const basicB64 = Buffer.from('x-access-token:ghs_secret123').toString('base64');
    expect(cloneCall.args).toContain(`http.extraHeader=Authorization: Basic ${basicB64}`);
    // URL should NOT contain the token
    const urlArg = cloneCall.args.find((a) => a.includes('github.com'));
    expect(urlArg).toBe('https://github.com/org/repo.git');
    expect(urlArg).not.toContain('ghs_secret123');
  });

  it('does not include extraHeader when no token provided', async () => {
    await gitClone({
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'main',
      sha: 'abc123',
      workDir: '/tmp/work',
    });

    const cloneCall = execFileSyncCalls[0];
    expect(cloneCall.args).not.toContain('-c');
    expect(cloneCall.args.join(' ')).not.toContain('Authorization');
  });

  it('verifies SHA after clone succeeds when HEAD matches', async () => {
    revParseStdout = 'abc123def456789';

    await expect(
      gitClone({
        repoUrl: 'https://github.com/org/repo.git',
        ref: 'main',
        sha: 'abc123',
        workDir: '/tmp/work',
      }),
    ).resolves.toBeUndefined();

    // Second call should be rev-parse HEAD in the work directory
    const revParseCall = execFileSyncCalls[1];
    expect(revParseCall.cmd).toBe('git');
    expect(revParseCall.args).toContain('-C');
    expect(revParseCall.args).toContain('/tmp/work');
    expect(revParseCall.args).toContain('rev-parse');
    expect(revParseCall.args).toContain('HEAD');
  });

  it('throws on SHA mismatch after fetch+checkout fallback fails', async () => {
    // Both rev-parse calls return a non-matching SHA, triggering fetch+checkout
    // fallback which also fails the re-verify
    revParseStdout = 'deadbeef12345';

    await expect(
      gitClone({
        repoUrl: 'https://github.com/org/repo.git',
        ref: 'main',
        sha: 'abc123',
        workDir: '/tmp/work',
      }),
    ).rejects.toThrow('SHA mismatch: expected abc123, got deadbeef12345');
  });

  it('uses default depth of 1', async () => {
    await gitClone({
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'main',
      sha: 'abc123',
      workDir: '/tmp/work',
    });

    const cloneCall = execFileSyncCalls[0];
    const depthIdx = cloneCall.args.indexOf('--depth');
    expect(depthIdx).toBeGreaterThan(-1);
    expect(cloneCall.args[depthIdx + 1]).toBe('1');
  });

  it('respects custom depth', async () => {
    await gitClone({
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'main',
      sha: 'abc123',
      workDir: '/tmp/work',
      depth: 10,
    });

    const cloneCall = execFileSyncCalls[0];
    const depthIdx = cloneCall.args.indexOf('--depth');
    expect(depthIdx).toBeGreaterThan(-1);
    expect(cloneCall.args[depthIdx + 1]).toBe('10');
  });

  it('redacts auth token from clone error messages', async () => {
    const token = 'ghs_secret123';
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');

    vi.mocked(execFileSync).mockImplementation(((cmd: unknown, args: unknown[]) => {
      const argsArr = (args ?? []) as string[];
      if (argsArr.includes('clone')) {
        throw new Error(
          `Command failed: git -c http.extraHeader=Authorization: Basic ${basic} clone --depth 1 --branch main https://github.com/org/repo.git /tmp/work`,
        );
      }
      return Buffer.from('');
    }) as any);

    const err = await gitClone({
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'main',
      sha: 'abc123',
      workDir: '/tmp/work',
      token,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(basic);
    expect(err.message).not.toContain(token);
    expect(err.message).toContain('[REDACTED]');
  });

  it('redacts auth token from fetch error messages on SHA mismatch', async () => {
    const token = 'ghs_secret456';
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    let callCount = 0;

    vi.mocked(execFileSync).mockImplementation(((cmd: unknown, args: unknown[]) => {
      const argsArr = (args ?? []) as string[];
      callCount++;
      if (argsArr.includes('rev-parse')) return 'deadbeef12345\n';
      if (argsArr.includes('fetch')) {
        throw new Error(
          `Command failed: git -C /tmp/work -c http.extraHeader=Authorization: Basic ${basic} fetch --depth 50 origin abc123`,
        );
      }
      return Buffer.from('');
    }) as any);

    const err = await gitClone({
      repoUrl: 'https://github.com/org/repo.git',
      ref: 'main',
      sha: 'abc123',
      workDir: '/tmp/work',
      token,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(basic);
    expect(err.message).not.toContain(token);
    expect(err.message).toContain('[REDACTED]');
  });

  it('deepens and checks out on SHA mismatch then succeeds', async () => {
    let revParseCount = 0;
    vi.mocked(execFileSync).mockImplementation(((cmd: unknown, args: unknown[], opts: unknown) => {
      const argsArr = (args ?? []) as string[];
      execFileSyncCalls.push({
        cmd: cmd as string,
        args: argsArr,
        opts: (opts ?? {}) as Record<string, unknown>,
      });
      if (argsArr.includes('rev-parse')) {
        revParseCount++;
        // First rev-parse: mismatch; second: match
        return revParseCount === 1 ? 'deadbeef12345\n' : 'abc123def456789\n';
      }
      return Buffer.from('');
    }) as any);

    await expect(
      gitClone({
        repoUrl: 'https://github.com/org/repo.git',
        ref: 'main',
        sha: 'abc123',
        workDir: '/tmp/work',
      }),
    ).resolves.toBeUndefined();

    // Should have called: clone, rev-parse, fetch, checkout, rev-parse
    expect(execFileSyncCalls).toHaveLength(5);
    expect(execFileSyncCalls[2].args).toContain('fetch');
    expect(execFileSyncCalls[3].args).toContain('checkout');
  });

  it('passes safe.directory env override to all git commands for file:// URLs', async () => {
    let revParseCount = 0;
    vi.mocked(execFileSync).mockImplementation(((cmd: unknown, args: unknown[], opts: unknown) => {
      const argsArr = (args ?? []) as string[];
      execFileSyncCalls.push({
        cmd: cmd as string,
        args: argsArr,
        opts: (opts ?? {}) as Record<string, unknown>,
      });
      if (argsArr.includes('rev-parse')) {
        revParseCount++;
        // First rev-parse: mismatch; second: match
        return revParseCount === 1 ? 'deadbeef12345\n' : 'abc123def456789\n';
      }
      return Buffer.from('');
    }) as any);

    await gitClone({
      repoUrl: 'file:///home/user/repo',
      ref: 'main',
      sha: 'abc123',
      workDir: '/tmp/work',
    });

    // All 5 calls (clone, rev-parse, fetch, checkout, rev-parse) should have
    // GIT_CONFIG_GLOBAL pointing at the temp gitconfig file that carries the
    // `[safe] directory = *` bypass. The temp config approach is required
    // because the spawned `upload-pack` subprocess for file:// clones does
    // NOT honour `GIT_CONFIG_KEY_*` env vars or `-c safe.directory` flags.
    expect(execFileSyncCalls).toHaveLength(5);
    for (let i = 0; i < execFileSyncCalls.length; i++) {
      const env = execFileSyncCalls[i].opts.env as Record<string, string> | undefined;
      expect(
        env,
        `call ${i} (${execFileSyncCalls[i].args.find((a) => ['clone', 'rev-parse', 'fetch', 'checkout'].includes(a))}) should have env`,
      ).toBeDefined();
      expect(env!.GIT_CONFIG_GLOBAL).toMatch(/kici-gitcfg-/);
    }
  });

  it('skips ref for empty ref string (default branch clone)', async () => {
    await gitClone({
      repoUrl: 'https://github.com/org/repo.git',
      ref: '',
      sha: '',
      workDir: '/tmp/work',
    });

    const cloneCall = execFileSyncCalls[0];
    expect(cloneCall.args).not.toContain('--branch');
    // Should return early without rev-parse since sha is empty
    expect(execFileSyncCalls).toHaveLength(1);
  });

  // --- Phase 4: structured GitAuth (basic + ssh) ---

  it('uses gitAuth.user for Basic auth when kind=basic', async () => {
    await gitClone({
      repoUrl: 'https://forgejo.example.com/alice/repo.git',
      ref: 'main',
      sha: '',
      workDir: '/tmp/work',
      gitAuth: { kind: 'basic', user: 'git', secret: 'pw' },
    });

    const cloneCall = execFileSyncCalls[0];
    const basicB64 = Buffer.from('git:pw').toString('base64');
    expect(cloneCall.args).toContain(`http.extraHeader=Authorization: Basic ${basicB64}`);
  });

  it('prefers gitAuth over legacy token when both set', async () => {
    await gitClone({
      repoUrl: 'https://forgejo.example.com/alice/repo.git',
      ref: 'main',
      sha: '',
      workDir: '/tmp/work',
      token: 'legacy-ignored',
      gitAuth: { kind: 'basic', user: 'x-access-token', secret: 'new-pat' },
    });

    const cloneCall = execFileSyncCalls[0];
    const basicB64 = Buffer.from('x-access-token:new-pat').toString('base64');
    expect(cloneCall.args).toContain(`http.extraHeader=Authorization: Basic ${basicB64}`);
    // The legacy token string must NOT appear in any encoded header
    const legacyB64 = Buffer.from('x-access-token:legacy-ignored').toString('base64');
    expect(cloneCall.args.join(' ')).not.toContain(legacyB64);
  });

  it('sets GIT_SSH_COMMAND when gitAuth.kind is ssh', async () => {
    await gitClone({
      repoUrl: 'git@forgejo.example.com:alice/repo.git',
      ref: 'main',
      sha: '',
      workDir: '/tmp/work',
      gitAuth: {
        kind: 'ssh',
        secret: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n',
        sshHostKeyPolicy: 'accept-new',
      },
    });

    const cloneCall = execFileSyncCalls[0];
    expect(cloneCall.args).not.toContain('http.extraHeader=Authorization: Basic ');
    const env = cloneCall.opts.env as Record<string, string> | undefined;
    expect(env).toBeDefined();
    expect(env!.GIT_SSH_COMMAND).toBeDefined();
    expect(env!.GIT_SSH_COMMAND).toMatch(/^ssh /);
    expect(env!.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes');
    expect(env!.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=accept-new');
    // Per-call known_hosts MUST be wired even for accept-new — otherwise
    // ssh falls back to the runtime user's ~/.ssh/known_hosts and a stale
    // entry there for the same host:port can block the clone.
    expect(env!.GIT_SSH_COMMAND).toContain('UserKnownHostsFile=');
  });

  it('writes known_hosts and sets StrictHostKeyChecking=yes for pinned ssh', async () => {
    await gitClone({
      repoUrl: 'git@forgejo.example.com:alice/repo.git',
      ref: 'main',
      sha: '',
      workDir: '/tmp/work',
      gitAuth: {
        kind: 'ssh',
        secret: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n',
        sshHostKeyPolicy: 'pinned',
        sshKnownHostsPem: 'forgejo.example.com ssh-ed25519 AAAA...',
      },
    });

    const cloneCall = execFileSyncCalls[0];
    const env = cloneCall.opts.env as Record<string, string> | undefined;
    expect(env!.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=yes');
    expect(env!.GIT_SSH_COMMAND).toContain('UserKnownHostsFile=');
  });
});
