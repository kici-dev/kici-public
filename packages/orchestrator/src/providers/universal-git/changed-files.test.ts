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
});
