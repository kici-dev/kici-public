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
  it('forgejo push: returns union of added + modified + removed', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('forgejo') });
    const push = loadFixture('forgejo-push.json');
    const files = await fetcher.getChangedFiles('kici-dev/sample-repo', 'push', push, {});
    expect(files.sort()).toEqual(
      ['.kici/kici.lock.json', 'docs/old.md', 'src/existing.ts', 'src/new.ts'].sort(),
    );
  });

  it('gitlab push: reads project payload via mapped "Push Hook" header', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('gitlab-repo') });
    const push = loadFixture('gitlab-repo-push.json');
    const files = await fetcher.getChangedFiles('group/subgroup/svc', 'Push Hook', push, {});
    expect(files.sort()).toEqual(['docs/readme.md', 'src/x.ts'].sort());
  });

  it('dedupes paths that appear in multiple commit arrays', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('gitea') });
    const dup = {
      commits: [
        { added: ['a.ts'], modified: ['a.ts'], removed: [] },
        { added: [], modified: ['a.ts'], removed: ['a.ts'] },
      ],
    };
    const files = await fetcher.getChangedFiles('x/y', 'push', dup, {});
    expect(files).toEqual(['a.ts']);
  });

  it('returns empty array for pull_request events (no diff available)', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('forgejo') });
    const files = await fetcher.getChangedFiles('x/y', 'pull_request', {}, {});
    expect(files).toEqual([]);
  });

  it('returns empty array for unknown event types', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('forgejo') });
    const files = await fetcher.getChangedFiles('x/y', 'issue_comment', {}, {});
    expect(files).toEqual([]);
  });

  it('tolerates missing commits[] array', async () => {
    const fetcher = new UniversalGitChangedFilesFetcher({ config: config('forgejo') });
    const files = await fetcher.getChangedFiles('x/y', 'push', {}, {});
    expect(files).toEqual([]);
  });
});
