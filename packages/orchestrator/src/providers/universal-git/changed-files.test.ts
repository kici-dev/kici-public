import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { UniversalGitChangedFilesFetcher } from './changed-files.js';
import type { UniversalGitConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, 'fixtures');

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'));
}

function config(preset: UniversalGitConfig['preset']): UniversalGitConfig {
  return {
    preset,
    gitUrlTemplate: 'https://forge.example.com/{repo}.git',
    credentialRef: { key: 'pat' },
    credentialType: 'pat',
    sshHostKeyPolicy: 'accept-new',
  };
}

describe('UniversalGitChangedFilesFetcher', () => {
  it('forgejo push: returns union of added + modified + removed (fetched)', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('forgejo') });
    const push = loadFixture('forgejo-push.json');
    const result = await fetcher.getChangedFiles('kici-dev/sample-repo', 'push', push, {});
    expect(result.status).toBe('fetched');
    expect(result.files.sort()).toEqual(
      ['.kici/kici.lock.json', 'docs/old.md', 'src/existing.ts', 'src/new.ts'].sort(),
    );
  });

  it('gitlab push: reads project payload via mapped "Push Hook" header', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('gitlab-repo') });
    const push = loadFixture('gitlab-repo-push.json');
    const result = await fetcher.getChangedFiles('group/subgroup/svc', 'Push Hook', push, {});
    expect(result.status).toBe('fetched');
    expect(result.files.sort()).toEqual(['docs/readme.md', 'src/x.ts'].sort());
  });

  it('dedupes paths that appear in multiple commit arrays', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('gitea') });
    const dup = {
      commits: [
        { added: ['a.ts'], modified: ['a.ts'], removed: [] },
        { added: [], modified: ['a.ts'], removed: ['a.ts'] },
      ],
    };
    const result = await fetcher.getChangedFiles('x/y', 'push', dup, {});
    expect(result).toEqual({ files: ['a.ts'], status: 'fetched' });
  });

  it('reports unavailable for pull_request events (no diff in webhook body → conservative match)', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('forgejo') });
    const result = await fetcher.getChangedFiles('x/y', 'pull_request', {}, {});
    expect(result).toEqual({ files: [], status: 'unavailable' });
  });

  it('reports unavailable for unknown event types', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('forgejo') });
    const result = await fetcher.getChangedFiles('x/y', 'issue_comment', {}, {});
    expect(result).toEqual({ files: [], status: 'unavailable' });
  });

  it('tolerates missing commits[] array (push stays fetched + [])', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('forgejo') });
    const result = await fetcher.getChangedFiles('x/y', 'push', {}, {});
    expect(result).toEqual({ files: [], status: 'fetched' });
  });

  // fails-when: a truncated forge commits[] reads as authoritative
  it('forgejo push whose total_commits exceeds the listed commits is unavailable', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('forgejo') });
    const push = { ...loadFixture('forgejo-push.json'), total_commits: 99 };
    const result = await fetcher.getChangedFiles('kici-dev/sample-repo', 'push', push, {});
    expect(result).toEqual({ files: [], status: 'unavailable' });
  });

  // breaks-if-wrong: a complete payload must stay fetched
  it('forgejo push whose total_commits equals the listed commits stays fetched', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('forgejo') });
    const push = loadFixture('forgejo-push.json') as { commits: unknown[] };
    const result = await fetcher.getChangedFiles(
      'kici-dev/sample-repo',
      'push',
      { ...push, total_commits: push.commits.length },
      {},
    );
    expect(result.status).toBe('fetched');
  });

  it('gitea reads total_commits', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('gitea') });
    const push = { ...loadFixture('gitea-push.json'), total_commits: 6 };
    expect((await fetcher.getChangedFiles('o/r', 'push', push, {})).status).toBe('unavailable');
  });

  it('gitlab reads total_commits_count', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('gitlab-repo') });
    const push = { ...loadFixture('gitlab-repo-push.json'), total_commits_count: 50 };
    expect((await fetcher.getChangedFiles('g/r', 'Push Hook', push, {})).status).toBe(
      'unavailable',
    );
  });

  it('github-repo preset: a commits[] at the 2048 cap is unavailable', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('github-repo') });
    const commits = Array.from({ length: 2048 }, () => ({
      added: ['a.ts'],
      modified: [],
      removed: [],
    }));
    const push = { ...loadFixture('github-repo-push.json'), commits };
    expect((await fetcher.getChangedFiles('o/r', 'push', push, {})).status).toBe('unavailable');
  });

  // breaks-if-wrong: a github-repo push under the cap must stay fetched
  it('github-repo preset: a commits[] under the 2048 cap stays fetched', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('github-repo') });
    const commits = Array.from({ length: 2047 }, () => ({
      added: ['a.ts'],
      modified: [],
      removed: [],
    }));
    const push = { ...loadFixture('github-repo-push.json'), commits };
    expect((await fetcher.getChangedFiles('o/r', 'push', push, {})).status).toBe('fetched');
  });

  it('gogs has neither field and keeps today’s behavior', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('gogs') });
    const push = { ...loadFixture('gogs-push.json'), total_commits: 99 };
    expect((await fetcher.getChangedFiles('o/r', 'push', push, {})).status).toBe('fetched');
  });
});
