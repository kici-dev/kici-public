import { describe, it, expect } from 'vitest';
import {
  runsOnSelectorsForLockJob,
  partitionGeneratedConfigsByPin,
  type GeneratedJobConfig,
} from './dispatch-matched-workflow.js';

describe('runsOnSelectorsForLockJob', () => {
  it('splits lock runsOn matchers into exact labels + regex patterns', () => {
    const lockJob = {
      name: 'web',
      runsOn: [
        { kind: 'exact', value: 'role:web' },
        { kind: 'regex', source: '^kici:host:box-', flags: '' },
      ],
      excludeLabels: [{ kind: 'regex', source: '-canary$', flags: '' }],
    } as never;
    expect(runsOnSelectorsForLockJob(lockJob)).toEqual({
      runsOnLabels: ['role:web'],
      runsOnPatterns: [{ kind: 'regex', source: '^kici:host:box-', flags: '' }],
      excludeLabels: [],
      excludePatterns: [{ kind: 'regex', source: '-canary$', flags: '' }],
    });
  });

  it('returns empty selectors for a job with no runsOn / excludeLabels', () => {
    expect(runsOnSelectorsForLockJob({} as never)).toEqual({
      runsOnLabels: [],
      runsOnPatterns: [],
      excludeLabels: [],
      excludePatterns: [],
    });
  });

  it('partitions exact excludeLabels into excludeLabels', () => {
    const lockJob = {
      runsOn: [{ kind: 'exact', value: 'role:db' }],
      excludeLabels: [{ kind: 'exact', value: 'role:retired' }],
    } as never;
    expect(runsOnSelectorsForLockJob(lockJob)).toEqual({
      runsOnLabels: ['role:db'],
      runsOnPatterns: [],
      excludeLabels: ['role:retired'],
      excludePatterns: [],
    });
  });
});

describe('partitionGeneratedConfigsByPin', () => {
  function cfg(name: string, pinnedAgentId?: string): GeneratedJobConfig {
    return {
      genJob: { name } as never,
      genJobConfig: {},
      runsOnLabels: pinnedAgentId ? [] : [name],
      runsOnPatterns: [],
      excludeLabels: [],
      excludePatterns: [],
      ...(pinnedAgentId && { pinnedAgentId, connectedInstanceId: null }),
    };
  }

  it('routes pinned configs to the pin path and the rest to label routing', () => {
    const pinned = cfg('migrate-agent-eu-1', 'agent-eu-1');
    const unpinned = cfg('build');
    const { pinnedConfigs, unpinnedConfigs } = partitionGeneratedConfigsByPin([pinned, unpinned]);
    expect(pinnedConfigs).toEqual([pinned]);
    expect(unpinnedConfigs).toEqual([unpinned]);
  });

  it('handles all-pinned and all-unpinned sets', () => {
    expect(partitionGeneratedConfigsByPin([cfg('a', 'a'), cfg('b', 'b')])).toEqual({
      pinnedConfigs: [cfg('a', 'a'), cfg('b', 'b')],
      unpinnedConfigs: [],
    });
    expect(partitionGeneratedConfigsByPin([cfg('a'), cfg('b')])).toEqual({
      pinnedConfigs: [],
      unpinnedConfigs: [cfg('a'), cfg('b')],
    });
  });
});
