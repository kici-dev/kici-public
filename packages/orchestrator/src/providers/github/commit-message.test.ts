import { describe, it, expect } from 'vitest';
import { githubFilterText, githubDisplayMessage } from './commit-message.js';

describe('githubFilterText', () => {
  it('returns the FULL head-commit message for a push, body included', () => {
    const payload = { head_commit: { message: 'feat: thing\n\n[skip ci]\n' } };
    expect(githubFilterText('push', payload)).toBe('feat: thing\n\n[skip ci]\n');
  });

  it('joins PR title and body', () => {
    const payload = { pull_request: { title: 'Add deploy', body: 'closes #4' } };
    expect(githubFilterText('pull_request', payload)).toBe('Add deploy\ncloses #4');
  });

  it('returns just the title when the PR body is null', () => {
    expect(githubFilterText('pull_request', { pull_request: { title: 'T', body: null } })).toBe(
      'T',
    );
  });

  it('is undefined for a push carrying no head_commit (branch deletion)', () => {
    expect(githubFilterText('push', { deleted: true, head_commit: null })).toBeUndefined();
  });

  it('does not throw on a pull_request event whose pull_request is explicitly null', () => {
    // A crafted / malformed internal-mode payload can carry `pull_request: null`.
    // The extractor must return undefined, never dereference null.
    expect(() => githubFilterText('pull_request', { pull_request: null })).not.toThrow();
    expect(githubFilterText('pull_request', { pull_request: null })).toBeUndefined();
  });

  it('is undefined for an unrelated event', () => {
    expect(githubFilterText('star', {})).toBeUndefined();
  });
});

describe('githubDisplayMessage', () => {
  it('keeps the existing first-line-only behaviour for a push', () => {
    expect(githubDisplayMessage('push', { head_commit: { message: 'subject\n\nbody' } })).toBe(
      'subject',
    );
  });

  it('keeps title-only for PR events and issue title for issue_comment', () => {
    expect(githubDisplayMessage('pull_request', { pull_request: { title: 'T', body: 'B' } })).toBe(
      'T',
    );
    expect(githubDisplayMessage('issue_comment', { issue: { title: 'I' } })).toBe('I');
  });
});
