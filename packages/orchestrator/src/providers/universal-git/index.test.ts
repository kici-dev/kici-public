import { describe, it, expect, vi } from 'vitest';
import {
  createUniversalGitProviderBundle,
  parseSourceGitConfig,
  UniversalGitWebhookNormalizer,
  UniversalGitLockFileFetcher,
  UniversalGitChangedFilesFetcher,
  UniversalGitCloneTokenProvider,
  UniversalGitRepoUrlBuilder,
} from './index.js';
import type { UniversalGitConfig } from './config.js';
import type { SecretResolver } from '../../secrets/secret-resolver.js';

const fakeResolver = { resolveNamed: vi.fn(async () => 'secret') } as unknown as SecretResolver;

function validConfig(): UniversalGitConfig {
  return {
    preset: 'forgejo',
    gitUrlTemplate: 'https://forge.example.com/{owner}/{name}.git',
    credentialRef: { key: 'pat' },
    credentialType: 'pat',
    sshHostKeyPolicy: 'accept-new',
  };
}

describe('parseSourceGitConfig', () => {
  it('returns null for null / undefined input', () => {
    expect(parseSourceGitConfig(null)).toBeNull();
    expect(parseSourceGitConfig(undefined)).toBeNull();
  });

  it('parses a JSON string round-trip', () => {
    const parsed = parseSourceGitConfig(JSON.stringify(validConfig()));
    expect(parsed?.preset).toBe('forgejo');
  });

  it('parses an already-parsed object', () => {
    const parsed = parseSourceGitConfig(validConfig() as unknown as Record<string, unknown>);
    expect(parsed?.preset).toBe('forgejo');
  });

  it('throws on malformed config', () => {
    expect(() =>
      parseSourceGitConfig({ preset: 'forgejo' } as unknown as Record<string, unknown>),
    ).toThrow(/Invalid universal-git config/);
  });
});

describe('createUniversalGitProviderBundle', () => {
  it('returns null for sources without git_config', () => {
    const bundle = createUniversalGitProviderBundle(
      {
        id: 's',
        customer_id: 'o',
        routing_key: 'generic:o:s',
        git_config: null,
      },
      fakeResolver,
    );
    expect(bundle).toBeNull();
  });

  it('wires every provider interface when git_config is present', () => {
    const bundle = createUniversalGitProviderBundle(
      {
        id: 's',
        customer_id: 'o',
        routing_key: 'generic:o:s',
        git_config: JSON.stringify(validConfig()),
      },
      fakeResolver,
    );
    expect(bundle).not.toBeNull();
    expect(bundle!.normalizer).toBeInstanceOf(UniversalGitWebhookNormalizer);
    expect(bundle!.lockFileFetcher).toBeInstanceOf(UniversalGitLockFileFetcher);
    expect(bundle!.changedFilesFetcher).toBeInstanceOf(UniversalGitChangedFilesFetcher);
    expect(bundle!.cloneTokenProvider).toBeInstanceOf(UniversalGitCloneTokenProvider);
    expect(bundle!.repoUrlBuilder).toBeInstanceOf(UniversalGitRepoUrlBuilder);
  });

  it('bundle uses the source.routing_key for normalizer fallback', () => {
    const bundle = createUniversalGitProviderBundle(
      {
        id: 's',
        customer_id: 'o',
        routing_key: 'generic:o:s',
        git_config: validConfig() as unknown as Record<string, unknown>,
      },
      fakeResolver,
    );
    expect(bundle!.normalizer.extractRoutingKey({}, {})).toBe('generic:o:s');
  });

  it('clone token flows through to the resolver with the source scope', async () => {
    const bundle = createUniversalGitProviderBundle(
      {
        id: 'src-xyz',
        customer_id: 'org-abc',
        routing_key: 'generic:org-abc:src-xyz',
        git_config: JSON.stringify(validConfig()),
      },
      fakeResolver,
    );
    await bundle!.cloneTokenProvider!.createCloneToken('alice/repo', {});
    expect(fakeResolver.resolveNamed).toHaveBeenCalledWith(
      'org-abc',
      '__source__/src-xyz',
      'pat',
      expect.anything(),
    );
  });
});
