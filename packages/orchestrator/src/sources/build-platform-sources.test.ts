import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPlatformProviderSources,
  type GenericRoutingKeyRow,
} from './build-platform-sources.js';
import type { SourceManager } from './source-manager.js';
import type { ProviderSource } from '../entry-helpers.js';

const githubSource: ProviderSource = {
  provider: 'github',
  routingKey: 'github:42',
  name: 'My App',
  subtype: 'github_app',
};

function fakeSourceManager(sources: ProviderSource[]): Pick<SourceManager, 'getSources'> {
  return { getSources: () => sources };
}

describe('buildPlatformProviderSources', () => {
  it('merges GitHub-app sources with servable generic sources', async () => {
    const rows: GenericRoutingKeyRow[] = [
      {
        routing_key: 'generic:hook',
        provider_type: 'generic',
        name: 'Hook',
        has_git_config: false,
        git_config: null,
      },
    ];
    const result = await buildPlatformProviderSources(
      fakeSourceManager([githubSource]),
      async () => rows,
    );
    expect(result.map((s) => s.routingKey)).toEqual(['github:42', 'generic:hook']);
    // Regression guard: the generic key MUST be present so a live republish via
    // updateSources(fullList) does not deregister it.
    expect(result.find((s) => s.routingKey === 'generic:hook')?.provider).toBe('generic');
  });

  it('advertises a local source whose repoBasePath exists on this peer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kici-local-'));
    const rows: GenericRoutingKeyRow[] = [
      {
        routing_key: 'generic:local-ok',
        provider_type: 'local',
        name: 'Local',
        has_git_config: true,
        git_config: JSON.stringify({ repoBasePath: dir }),
      },
    ];
    const result = await buildPlatformProviderSources(fakeSourceManager([]), async () => rows);
    expect(result.map((s) => s.routingKey)).toEqual(['generic:local-ok']);
    expect(result[0].subtype).toBe('local');
  });

  it('skips a local source whose repoBasePath is absent on this peer', async () => {
    const rows: GenericRoutingKeyRow[] = [
      {
        routing_key: 'generic:ok',
        provider_type: 'generic',
        name: 'Ok',
        has_git_config: false,
        git_config: null,
      },
      {
        routing_key: 'generic:local-missing',
        provider_type: 'local',
        name: 'Local missing',
        has_git_config: true,
        git_config: JSON.stringify({ repoBasePath: '/nonexistent/kici-policy-xyz' }),
      },
    ];
    const result = await buildPlatformProviderSources(fakeSourceManager([]), async () => rows);
    expect(result.map((s) => s.routingKey)).toEqual(['generic:ok']);
  });

  it('returns provider sources even if loading generic rows fails', async () => {
    const result = await buildPlatformProviderSources(
      fakeSourceManager([githubSource]),
      async () => {
        throw new Error('db down');
      },
    );
    expect(result.map((s) => s.routingKey)).toEqual(['github:42']);
  });
});
