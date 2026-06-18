/**
 * Tests for the universal-git config Zod schema and preset expansion.
 *
 * These tests lock in three invariants that Phase 1 relies on downstream:
 *   1. Zod rejects configs that would otherwise blow up at runtime (missing
 *      pinned known_hosts, missing credential, missing payload paths on a
 *      custom preset).
 *   2. Every non-custom preset expands into a fully-populated `payloadPaths`
 *      and `eventMapping` so the provider bundle can read payloads without
 *      defensive `??` fallbacks.
 *   3. The safe/parse helpers behave correctly for null/undefined inputs so
 *      the generic-sources manager can pass DB rows through unchanged.
 */

import { describe, it, expect } from 'vitest';
import {
  UniversalGitConfigSchema,
  UNIVERSAL_GIT_PRESETS,
  expandUniversalGitConfig,
  parseUniversalGitConfig,
  safeParseUniversalGitConfig,
} from './config.js';

describe('UniversalGitConfigSchema', () => {
  describe('preset: forgejo', () => {
    it('accepts a minimal valid config with PAT credential', () => {
      const parsed = UniversalGitConfigSchema.parse({
        preset: 'forgejo',
        gitUrlTemplate: 'https://forgejo.example.com/{owner}/{name}.git',
        credentialRef: { key: 'forgejo-pat' },
        credentialType: 'pat',
      });
      expect(parsed.preset).toBe('forgejo');
      expect(parsed.sshHostKeyPolicy).toBe('accept-new'); // default
      expect(parsed.credentialRef).toEqual({ key: 'forgejo-pat' });
    });

    it('accepts an explicit backend store on credentialRef', () => {
      const parsed = UniversalGitConfigSchema.parse({
        preset: 'forgejo',
        gitUrlTemplate: 'https://forgejo.example.com/{owner}/{name}.git',
        credentialRef: { key: 'forgejo-pat', store: 'vault-prod' },
        credentialType: 'pat',
      });
      expect(parsed.credentialRef.store).toBe('vault-prod');
    });

    it('rejects configs missing gitUrlTemplate', () => {
      expect(() =>
        UniversalGitConfigSchema.parse({
          preset: 'forgejo',
          credentialRef: { key: 'k' },
          credentialType: 'pat',
        }),
      ).toThrow();
    });

    it('rejects configs missing credentialRef', () => {
      expect(() =>
        UniversalGitConfigSchema.parse({
          preset: 'forgejo',
          gitUrlTemplate: 'https://forgejo.example.com/{owner}/{name}.git',
          credentialType: 'pat',
        }),
      ).toThrow();
    });

    it('rejects configs missing credentialType', () => {
      expect(() =>
        UniversalGitConfigSchema.parse({
          preset: 'forgejo',
          gitUrlTemplate: 'https://forgejo.example.com/{owner}/{name}.git',
          credentialRef: { key: 'k' },
        }),
      ).toThrow();
    });
  });

  describe('SSH host-key policy', () => {
    const base = {
      preset: 'forgejo' as const,
      gitUrlTemplate: 'git@forgejo.example.com:{owner}/{name}.git',
      credentialRef: { key: 'deploy-key' },
      credentialType: 'ssh' as const,
    };

    it('accepts sshHostKeyPolicy=accept-new without sshKnownHostsPem', () => {
      const parsed = UniversalGitConfigSchema.parse({ ...base, sshHostKeyPolicy: 'accept-new' });
      expect(parsed.sshHostKeyPolicy).toBe('accept-new');
      expect(parsed.sshKnownHostsPem).toBeUndefined();
    });

    it('rejects sshHostKeyPolicy=pinned without sshKnownHostsPem', () => {
      const result = UniversalGitConfigSchema.safeParse({
        ...base,
        sshHostKeyPolicy: 'pinned',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.join('.') === 'sshKnownHostsPem');
        expect(issue).toBeDefined();
      }
    });

    it('accepts sshHostKeyPolicy=pinned with sshKnownHostsPem', () => {
      const parsed = UniversalGitConfigSchema.parse({
        ...base,
        sshHostKeyPolicy: 'pinned',
        sshKnownHostsPem: 'forgejo.example.com ssh-ed25519 AAAAC3Nz...',
      });
      expect(parsed.sshHostKeyPolicy).toBe('pinned');
      expect(parsed.sshKnownHostsPem).toContain('ssh-ed25519');
    });
  });

  describe('preset: custom', () => {
    const base = {
      preset: 'custom' as const,
      gitUrlTemplate: 'https://example.com/{owner}/{name}.git',
      credentialRef: { key: 'k' },
      credentialType: 'pat' as const,
    };

    it('requires payloadPaths on custom preset', () => {
      const result = UniversalGitConfigSchema.safeParse({
        ...base,
        eventMapping: { push: ['push'], pullRequest: ['pr'] },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.join('.') === 'payloadPaths');
        expect(issue).toBeDefined();
      }
    });

    it('requires eventMapping on custom preset', () => {
      const result = UniversalGitConfigSchema.safeParse({
        ...base,
        payloadPaths: {
          repoIdentifier: '$.repo',
          pushRef: '$.ref',
          pushSha: '$.sha',
          defaultBranch: '$.default',
          commitsAdded: '$.added',
          commitsModified: '$.modified',
          commitsRemoved: '$.removed',
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.join('.') === 'eventMapping');
        expect(issue).toBeDefined();
      }
    });

    it('accepts fully-specified custom preset', () => {
      const parsed = UniversalGitConfigSchema.parse({
        ...base,
        payloadPaths: {
          repoIdentifier: '$.repo',
          pushRef: '$.ref',
          pushSha: '$.sha',
          defaultBranch: '$.default',
          commitsAdded: '$.added',
          commitsModified: '$.modified',
          commitsRemoved: '$.removed',
        },
        eventMapping: { push: ['push'], pullRequest: ['pr'] },
      });
      expect(parsed.preset).toBe('custom');
    });
  });
});

describe('UNIVERSAL_GIT_PRESETS', () => {
  const expected = ['forgejo', 'gitea', 'gogs', 'gitlab-repo', 'github-repo'] as const;

  for (const preset of expected) {
    describe(`preset: ${preset}`, () => {
      it('has both payloadPaths and eventMapping', () => {
        const def = UNIVERSAL_GIT_PRESETS[preset];
        expect(def).toBeDefined();
        expect(def.payloadPaths).toBeDefined();
        expect(def.eventMapping).toBeDefined();
      });

      it('populates every payloadPaths field', () => {
        const pp = UNIVERSAL_GIT_PRESETS[preset].payloadPaths;
        expect(pp.repoIdentifier).toMatch(/^\$\./);
        expect(pp.pushRef).toMatch(/^\$\./);
        expect(pp.pushSha).toMatch(/^\$\./);
        expect(pp.defaultBranch).toMatch(/^\$\./);
        expect(pp.commitsAdded).toMatch(/^\$\./);
        expect(pp.commitsModified).toMatch(/^\$\./);
        expect(pp.commitsRemoved).toMatch(/^\$\./);
      });

      it('includes at least one push event name and one PR event name', () => {
        const em = UNIVERSAL_GIT_PRESETS[preset].eventMapping;
        expect(em.push.length).toBeGreaterThan(0);
        expect(em.pullRequest.length).toBeGreaterThan(0);
      });
    });
  }

  it('gitlab-repo uses project.path_with_namespace (not repository.full_name)', () => {
    const gl = UNIVERSAL_GIT_PRESETS['gitlab-repo'];
    expect(gl.payloadPaths.repoIdentifier).toBe('$.project.path_with_namespace');
  });

  it('gitlab-repo maps both "Push Hook" and "push" to push', () => {
    const gl = UNIVERSAL_GIT_PRESETS['gitlab-repo'];
    expect(gl.eventMapping.push).toContain('Push Hook');
    expect(gl.eventMapping.push).toContain('push');
  });
});

describe('expandUniversalGitConfig', () => {
  it('copies preset defaults onto non-custom configs', () => {
    const expanded = expandUniversalGitConfig(
      UniversalGitConfigSchema.parse({
        preset: 'forgejo',
        gitUrlTemplate: 'https://forgejo.example.com/{owner}/{name}.git',
        credentialRef: { key: 'k' },
        credentialType: 'pat',
      }),
    );
    expect(expanded.payloadPaths).toEqual(UNIVERSAL_GIT_PRESETS.forgejo.payloadPaths);
    expect(expanded.eventMapping).toEqual(UNIVERSAL_GIT_PRESETS.forgejo.eventMapping);
  });

  it('passes through caller-supplied paths for custom preset', () => {
    const customPaths = {
      repoIdentifier: '$.repo',
      pushRef: '$.ref',
      pushSha: '$.sha',
      defaultBranch: '$.default',
      commitsAdded: '$.added',
      commitsModified: '$.modified',
      commitsRemoved: '$.removed',
    };
    const customEvents = { push: ['push'], pullRequest: ['pr'] };
    const expanded = expandUniversalGitConfig(
      UniversalGitConfigSchema.parse({
        preset: 'custom',
        gitUrlTemplate: 'https://example.com/{owner}/{name}.git',
        credentialRef: { key: 'k' },
        credentialType: 'pat',
        payloadPaths: customPaths,
        eventMapping: customEvents,
      }),
    );
    expect(expanded.payloadPaths).toEqual(customPaths);
    expect(expanded.eventMapping).toEqual(customEvents);
  });
});

describe('parseUniversalGitConfig / safeParseUniversalGitConfig', () => {
  it('parseUniversalGitConfig returns null for null/undefined', () => {
    expect(parseUniversalGitConfig(null)).toBeNull();
    expect(parseUniversalGitConfig(undefined)).toBeNull();
  });

  it('parseUniversalGitConfig returns the parsed value for a valid input', () => {
    const config = parseUniversalGitConfig({
      preset: 'forgejo',
      gitUrlTemplate: 'https://forgejo.example.com/{owner}/{name}.git',
      credentialRef: { key: 'k' },
      credentialType: 'pat',
    });
    expect(config?.preset).toBe('forgejo');
  });

  it('parseUniversalGitConfig throws on invalid shape', () => {
    expect(() => parseUniversalGitConfig({ preset: 'not-a-real-preset' })).toThrow();
  });

  it('safeParseUniversalGitConfig returns ok:true, config:null for null/undefined', () => {
    expect(safeParseUniversalGitConfig(null)).toEqual({ ok: true, config: null });
    expect(safeParseUniversalGitConfig(undefined)).toEqual({ ok: true, config: null });
  });

  it('safeParseUniversalGitConfig returns ok:false + error for invalid', () => {
    const result = safeParseUniversalGitConfig({ preset: 'forgejo' });
    expect(result.ok).toBe(false);
  });

  it('safeParseUniversalGitConfig returns ok:true + config for valid', () => {
    const result = safeParseUniversalGitConfig({
      preset: 'forgejo',
      gitUrlTemplate: 'https://forgejo.example.com/{owner}/{name}.git',
      credentialRef: { key: 'k' },
      credentialType: 'pat',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config?.preset).toBe('forgejo');
    }
  });
});
