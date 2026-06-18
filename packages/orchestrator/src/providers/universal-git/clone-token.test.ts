import { describe, it, expect, vi } from 'vitest';
import { UniversalGitCloneTokenProvider } from './clone-token.js';
import type { UniversalGitConfig } from './config.js';
import type { SecretResolver } from '../../secrets/secret-resolver.js';

function mockResolver(resolveNamedImpl: (...args: unknown[]) => Promise<string | null>) {
  return {
    resolveNamed: vi.fn(resolveNamedImpl),
  } as unknown as SecretResolver;
}

function cfg(overrides: Partial<UniversalGitConfig> = {}): UniversalGitConfig {
  return {
    preset: 'forgejo',
    gitUrlTemplate: 'https://forgejo.example.com/{owner}/{name}.git',
    credentialRef: { key: 'pat' },
    credentialType: 'pat',
    sshHostKeyPolicy: 'accept-new',
    ...overrides,
  };
}

describe('UniversalGitCloneTokenProvider', () => {
  it('returns the resolved PAT string via createCloneToken', async () => {
    const resolver = mockResolver(async () => 'ghp_abc123');
    const provider = new UniversalGitCloneTokenProvider({
      orgId: 'org-1',
      sourceId: 'src-1',
      config: cfg(),
      secretResolver: resolver,
    });
    const token = await provider.createCloneToken('alice/repo', {});
    expect(token).toBe('ghp_abc123');
    expect(resolver.resolveNamed).toHaveBeenCalledWith(
      'org-1',
      '__source__/src-1',
      'pat',
      expect.objectContaining({ store: undefined }),
    );
  });

  it('returns null when the secret is missing', async () => {
    const resolver = mockResolver(async () => null);
    const provider = new UniversalGitCloneTokenProvider({
      orgId: 'org-1',
      sourceId: 'src-1',
      config: cfg(),
      secretResolver: resolver,
    });
    expect(await provider.createCloneToken('alice/repo', {})).toBeNull();
  });

  it('issueGitAuth returns structured auth with PAT defaults', async () => {
    const resolver = mockResolver(async () => 'the-secret');
    const provider = new UniversalGitCloneTokenProvider({
      orgId: 'org',
      sourceId: 'src',
      config: cfg(),
      secretResolver: resolver,
    });
    const auth = await provider.issueGitAuth();
    // Phase 4: PAT maps to `kind: 'basic'` on the wire (universal-git's
    // credentialType 'pat' is just Basic auth with a known username).
    expect(auth).toEqual({ kind: 'basic', user: 'x-access-token', secret: 'the-secret' });
  });

  it('issueGitAuth uses explicit credentialUser when provided', async () => {
    const resolver = mockResolver(async () => 'pw');
    const provider = new UniversalGitCloneTokenProvider({
      orgId: 'o',
      sourceId: 's',
      config: cfg({ credentialType: 'basic', credentialUser: 'alice' }),
      secretResolver: resolver,
    });
    const auth = await provider.issueGitAuth();
    expect(auth).toEqual({ kind: 'basic', user: 'alice', secret: 'pw' });
  });

  it('issueGitAuth defaults basic auth user to "git" for Gitea/Gogs-style', async () => {
    const resolver = mockResolver(async () => 'pw');
    const provider = new UniversalGitCloneTokenProvider({
      orgId: 'o',
      sourceId: 's',
      config: cfg({ credentialType: 'basic' }),
      secretResolver: resolver,
    });
    const auth = await provider.issueGitAuth();
    expect(auth).toEqual({ kind: 'basic', user: 'git', secret: 'pw' });
  });

  it('issueGitAuth omits user and carries SSH host-key policy for SSH auth', async () => {
    const resolver = mockResolver(async () => '-----BEGIN KEY-----');
    const provider = new UniversalGitCloneTokenProvider({
      orgId: 'o',
      sourceId: 's',
      config: cfg({ credentialType: 'ssh' }),
      secretResolver: resolver,
    });
    const auth = await provider.issueGitAuth();
    expect(auth).toEqual({
      kind: 'ssh',
      user: undefined,
      secret: '-----BEGIN KEY-----',
      sshHostKeyPolicy: 'accept-new',
    });
  });

  it('issueGitAuth includes pinned known_hosts PEM when policy is "pinned"', async () => {
    const resolver = mockResolver(async () => '-----BEGIN KEY-----');
    const provider = new UniversalGitCloneTokenProvider({
      orgId: 'o',
      sourceId: 's',
      config: cfg({
        credentialType: 'ssh',
        sshHostKeyPolicy: 'pinned',
        sshKnownHostsPem: 'forgejo.example.com ssh-ed25519 AAAA...',
      }),
      secretResolver: resolver,
    });
    const auth = await provider.issueGitAuth();
    expect(auth).toMatchObject({
      kind: 'ssh',
      sshHostKeyPolicy: 'pinned',
      sshKnownHostsPem: 'forgejo.example.com ssh-ed25519 AAAA...',
    });
  });

  it('forwards runId/jobId to the resolver for audit logging', async () => {
    const resolver = mockResolver(async () => 'sec');
    const provider = new UniversalGitCloneTokenProvider({
      orgId: 'o',
      sourceId: 's',
      config: cfg(),
      secretResolver: resolver,
    });
    await provider.issueGitAuth(undefined, undefined, { runId: 'r1', jobId: 'j1' });
    expect(resolver.resolveNamed).toHaveBeenCalledWith(
      'o',
      '__source__/s',
      'pat',
      expect.objectContaining({ runId: 'r1', jobId: 'j1' }),
    );
  });

  it('respects credentialRef.store', async () => {
    const resolver = mockResolver(async () => 'sec');
    const provider = new UniversalGitCloneTokenProvider({
      orgId: 'o',
      sourceId: 's',
      config: cfg({ credentialRef: { key: 'pat', store: 'vault' } }),
      secretResolver: resolver,
    });
    await provider.issueGitAuth();
    expect(resolver.resolveNamed).toHaveBeenCalledWith(
      'o',
      '__source__/s',
      'pat',
      expect.objectContaining({ store: 'vault' }),
    );
  });
});
