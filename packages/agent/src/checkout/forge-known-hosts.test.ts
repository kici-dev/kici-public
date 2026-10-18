import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FORGE_KNOWN_HOSTS } from './forge-known-hosts.js';

/**
 * The SHA256 fingerprints each forge publishes, copied from its own docs
 * (see the source list in forge-known-hosts.ts) — an artifact authored
 * independently of the key lines, so a mistyped or swapped line fails here.
 */
const PUBLISHED: Record<string, Record<string, string>> = {
  'github.com': {
    'ssh-ed25519': '+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
    'ecdsa-sha2-nistp256': 'p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
    'ssh-rsa': 'uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
  },
  'gitlab.com': {
    'ssh-ed25519': 'eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8',
    'ecdsa-sha2-nistp256': 'HbW3g8zUjNSksFbqTiUWPWg2Bq1x8xdGUrliXFzSnUw',
    'ssh-rsa': 'ROQFvPThGrW4RuWLoL9tq9I9zJ42fK4XywyRtbOz/EQ',
  },
  'bitbucket.org': {
    'ssh-ed25519': 'ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM',
    'ecdsa-sha2-nistp256': 'FC73VB6C4OQLSCrjEayhMp9UMxS97caD/Yyi2bhW/J0',
    'ssh-rsa': '46OSHA1Rmj8E8ERTC6xkNcmGOw9oFxYr0WF6zWW8l1E',
  },
};

function lines(): string[][] {
  return FORGE_KNOWN_HOSTS.split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.split(' '));
}

describe('FORGE_KNOWN_HOSTS', () => {
  // fails-when: a key line is mistyped, or attributed to the wrong host.
  it('every pinned key matches the fingerprint its forge publishes', () => {
    const seen: string[] = [];
    for (const [host, type, blob] of lines()) {
      const fingerprint = createHash('sha256')
        .update(Buffer.from(blob!, 'base64'))
        .digest('base64')
        .replace(/=+$/, '');
      expect(fingerprint, `${host} ${type}`).toBe(PUBLISHED[host!]?.[type!]);
      seen.push(`${host} ${type}`);
    }
    const expected = Object.entries(PUBLISHED).flatMap(([h, keys]) =>
      Object.keys(keys).map((t) => `${h} ${t}`),
    );
    expect(seen.sort()).toEqual(expected.sort());
  });

  it('covers each forge with an ed25519 key', () => {
    const ed25519Hosts = lines()
      .filter(([, type]) => type === 'ssh-ed25519')
      .map(([host]) => host);
    expect(ed25519Hosts.sort()).toEqual(['bitbucket.org', 'github.com', 'gitlab.com']);
  });

  it('ends with a newline, as a known_hosts file does', () => {
    expect(FORGE_KNOWN_HOSTS.endsWith('\n')).toBe(true);
    expect(FORGE_KNOWN_HOSTS).not.toMatch(/\n\n/);
  });
});
