import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startJobGitCredentials, type JobGitCredentials } from './job-git-credentials.js';

const GIT_INPUT = 'protocol=https\nhost=github.com\npath=kici-dev/tester.git\n\n';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function run(bin: string, op: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [op], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(input);
  });
}

async function start(sendApiRequest: ReturnType<typeof vi.fn>): Promise<JobGitCredentials> {
  const dir = await mkdtemp(join(tmpdir(), 'kici-jobcred-'));
  const creds = await startJobGitCredentials({ jobId: 'job-1', dir, sendApiRequest });
  cleanups.push(async () => {
    await creds.close();
    await rm(dir, { recursive: true, force: true });
  });
  return creds;
}

const basic = (secret: string) => ({
  kind: 'basic',
  user: 'x-access-token',
  secret,
  grant: { scoped: false },
  expiresAt: null,
});

describe('startJobGitCredentials', () => {
  it('asks the broker for read-only when no write grant is live', async () => {
    const send = vi.fn().mockResolvedValue(basic('ghs_read'));
    const creds = await start(send);

    const out = await run(creds.helperPath, 'get', GIT_INPUT);

    expect(out).toBe('username=x-access-token\npassword=ghs_read\n');
    expect(send).toHaveBeenCalledWith('git.credential.request', {
      jobId: 'job-1',
      repositories: ['kici-dev/tester'],
      permissions: { contents: 'read' },
    });
  });

  it('serves the elevated permissions inside a write grant', async () => {
    const send = vi.fn().mockResolvedValue({
      ...basic('ghs_write'),
      grant: { scoped: true, permissions: { contents: 'write' } },
    });
    const creds = await start(send);

    const elevated = await creds.onGitGrantRequest({
      type: 'git.grant.request',
      requestId: 'r1',
      op: 'elevate',
      repository: 'kici-dev/tester',
      permissions: { contents: 'write' },
    });
    expect(elevated.grantId).toBeDefined();

    send.mockClear();
    await run(creds.helperPath, 'get', GIT_INPUT);
    expect(send).toHaveBeenCalledWith(
      'git.credential.request',
      expect.objectContaining({ permissions: { contents: 'write' } }),
    );
  });

  it('returns to read-only after the grant is revoked', async () => {
    const send = vi.fn().mockResolvedValue({
      ...basic('ghs_x'),
      grant: { scoped: true, permissions: { contents: 'write' } },
    });
    const creds = await start(send);
    const { grantId } = await creds.onGitGrantRequest({
      type: 'git.grant.request',
      requestId: 'r1',
      op: 'elevate',
      repository: 'kici-dev/tester',
      permissions: { contents: 'write' },
    });
    await creds.onGitGrantRequest({
      type: 'git.grant.response' as never,
      requestId: 'r2',
      op: 'revoke',
      grantId,
    } as never);

    send.mockClear();
    await run(creds.helperPath, 'get', GIT_INPUT);
    expect(send).toHaveBeenCalledWith(
      'git.credential.request',
      expect.objectContaining({ permissions: { contents: 'read' } }),
    );
  });

  it('reports a narrower grant as an elevation error rather than proceeding', async () => {
    const send = vi.fn().mockResolvedValue({
      ...basic('ghs_x'),
      grant: { scoped: true, permissions: { contents: 'write' } },
    });
    const creds = await start(send);
    const result = await creds.onGitGrantRequest({
      type: 'git.grant.request',
      requestId: 'r1',
      op: 'elevate',
      repository: 'kici-dev/tester',
      permissions: { contents: 'write', workflows: 'write' },
    });
    expect(result.error).toMatch(/workflows=write/);
    expect(result.grantId).toBeUndefined();
  });

  it('never hands git an ssh key as a password', async () => {
    const send = vi.fn().mockResolvedValue({
      kind: 'ssh',
      secret: '-----BEGIN OPENSSH PRIVATE KEY-----',
      grant: { scoped: false },
      expiresAt: null,
    });
    const creds = await start(send);
    expect(await run(creds.helperPath, 'get', GIT_INPUT)).toBe('');
  });

  it('does not call the broker when git names no repository path', async () => {
    const send = vi.fn();
    const creds = await start(send);
    expect(await run(creds.helperPath, 'get', 'protocol=https\nhost=github.com\n\n')).toBe('');
    expect(send).not.toHaveBeenCalled();
  });

  it('turns a broker failure into a miss, not a leaked error', async () => {
    const send = vi.fn().mockRejectedValue(new Error('boom ghs_supersecrettokenvalue0001'));
    const creds = await start(send);
    const out = await run(creds.helperPath, 'get', GIT_INPUT);
    expect(out).toBe('');
    expect(out).not.toContain('ghs_');
  });

  it('closes idempotently', async () => {
    const creds = await start(vi.fn().mockResolvedValue(basic('x')));
    await creds.close();
    await expect(creds.close()).resolves.toBeUndefined();
  });

  it('sends the declared default credential ref with the request', async () => {
    const send = vi.fn().mockResolvedValue(basic('ghs_x'));
    const dir = await mkdtemp(join(tmpdir(), 'kici-jobcred-'));
    const creds = await startJobGitCredentials({
      jobId: 'job-1',
      dir,
      sendApiRequest: send,
      credentials: { default: { kind: 'token', tokenSecret: 'ci:FORGE_PAT' } },
    });
    cleanups.push(async () => {
      await creds.close();
      await rm(dir, { recursive: true, force: true });
    });

    await run(creds.helperPath, 'get', GIT_INPUT);

    expect(send).toHaveBeenCalledWith(
      'git.credential.request',
      expect.objectContaining({ ref: { kind: 'token', tokenSecret: 'ci:FORGE_PAT' } }),
    );
  });

  it('omits the ref entirely when the job declares no credentials', async () => {
    const send = vi.fn().mockResolvedValue(basic('ghs_x'));
    const creds = await start(send);
    await run(creds.helperPath, 'get', GIT_INPUT);
    const params = send.mock.calls[0]![1] as Record<string, unknown>;
    // No ref => the source credential, which is all a read needs.
    expect(params).not.toHaveProperty('ref');
  });

  it('elevates with the named credential, not the default', async () => {
    const send = vi.fn().mockResolvedValue({
      ...basic('ghs_x'),
      grant: { scoped: true, permissions: { contents: 'write' } },
    });
    const dir = await mkdtemp(join(tmpdir(), 'kici-jobcred-'));
    const creds = await startJobGitCredentials({
      jobId: 'job-1',
      dir,
      sendApiRequest: send,
      credentials: {
        default: { kind: 'token', tokenSecret: 'ci:DEFAULT' },
        forge: { kind: 'token', tokenSecret: 'ci:FORGE' },
      },
    });
    cleanups.push(async () => {
      await creds.close();
      await rm(dir, { recursive: true, force: true });
    });

    await creds.onGitGrantRequest({
      type: 'git.grant.request',
      requestId: 'r1',
      op: 'elevate',
      repository: 'kici-dev/tester',
      permissions: { contents: 'write' },
      credentialName: 'forge',
    });

    expect(send).toHaveBeenCalledWith(
      'git.credential.request',
      expect.objectContaining({ ref: { kind: 'token', tokenSecret: 'ci:FORGE' } }),
    );
  });

  it('reports an unknown credential name instead of silently using the default', async () => {
    const send = vi.fn().mockResolvedValue(basic('ghs_x'));
    const dir = await mkdtemp(join(tmpdir(), 'kici-jobcred-'));
    const creds = await startJobGitCredentials({
      jobId: 'job-1',
      dir,
      sendApiRequest: send,
      credentials: { default: { kind: 'token', tokenSecret: 'ci:DEFAULT' } },
    });
    cleanups.push(async () => {
      await creds.close();
      await rm(dir, { recursive: true, force: true });
    });

    const result = await creds.onGitGrantRequest({
      type: 'git.grant.request',
      requestId: 'r1',
      op: 'elevate',
      repository: 'kici-dev/tester',
      permissions: { contents: 'write' },
      credentialName: 'typo',
    });
    expect(result.error).toMatch(/Unknown git credential 'typo'/);
    expect(send).not.toHaveBeenCalled();
  });

  describe('withRef (the getToken path)', () => {
    async function credsWith(map?: Record<string, Record<string, string>>) {
      const dir = await mkdtemp(join(tmpdir(), 'kici-jobcred-'));
      const creds = await startJobGitCredentials({
        jobId: 'job-1',
        dir,
        sendApiRequest: vi.fn(),
        ...(map ? { credentials: map } : {}),
      });
      cleanups.push(async () => {
        await creds.close();
        await rm(dir, { recursive: true, force: true });
      });
      return creds;
    }

    it('attaches the default credential to a request that names none', async () => {
      const creds = await credsWith({ default: { kind: 'token', tokenSecret: 'ci:D' } });
      expect(creds.withRef({ jobId: 'job-1', repositories: ['a/b'] })).toEqual({
        jobId: 'job-1',
        repositories: ['a/b'],
        ref: { kind: 'token', tokenSecret: 'ci:D' },
      });
    });

    it('attaches a named credential and strips the name from the wire params', async () => {
      const creds = await credsWith({
        default: { kind: 'token', tokenSecret: 'ci:D' },
        forge: { kind: 'token', tokenSecret: 'ci:F' },
      });
      const out = creds.withRef({ repositories: ['a/b'], credential: 'forge' });
      expect(out).toEqual({ repositories: ['a/b'], ref: { kind: 'token', tokenSecret: 'ci:F' } });
      // The wire schema does not carry `credential`; a plain z.object would
      // strip it silently rather than say so, so it is removed here.
      expect(out).not.toHaveProperty('credential');
    });

    it('attaches no ref when the job declares no credentials', async () => {
      const creds = await credsWith();
      expect(creds.withRef({ repositories: ['a/b'] })).toEqual({ repositories: ['a/b'] });
    });

    it('throws on an unknown name rather than silently using the default', async () => {
      const creds = await credsWith({ default: { kind: 'token', tokenSecret: 'ci:D' } });
      expect(() => creds.withRef({ repositories: ['a/b'], credential: 'typo' })).toThrow(/typo/);
    });
  });
});
