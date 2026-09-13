import { describe, it, expect, vi } from 'vitest';
import {
  parseCredentialInput,
  formatCredentialOutput,
  serveCredential,
} from './credential-helper.js';
import { GrantTable } from './grant-table.js';

describe('git credential protocol', () => {
  it('parses the key=value block git sends', () => {
    const q = parseCredentialInput('protocol=https\nhost=github.com\npath=kici-dev/tester.git\n\n');
    expect(q).toEqual({ protocol: 'https', host: 'github.com', path: 'kici-dev/tester.git' });
  });

  it('ignores malformed lines rather than throwing mid-push', () => {
    const q = parseCredentialInput('protocol=https\ngarbage\nhost=github.com\n\n');
    expect(q.host).toBe('github.com');
  });

  it('keeps a value containing an equals sign intact', () => {
    const q = parseCredentialInput('path=a/b=c\n\n');
    expect(q.path).toBe('a/b=c');
  });

  it('formats a reply as git expects', () => {
    expect(formatCredentialOutput({ username: 'x-access-token', password: 'ghs_x' })).toBe(
      'username=x-access-token\npassword=ghs_x\n',
    );
  });
});

describe('serveCredential', () => {
  const query = { protocol: 'https', host: 'github.com', path: 'kici-dev/tester.git' };

  it('asks for read-only permissions when no write grant is live', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ kind: 'basic', user: 'x-access-token', secret: 'ghs_r' });
    await serveCredential(query, { grants: new GrantTable(), request });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ repository: 'kici-dev/tester', permissions: { contents: 'read' } }),
    );
  });

  it('asks for the granted permissions when a write grant covers the repo', async () => {
    const grants = new GrantTable();
    grants.add({
      repoPath: 'kici-dev/tester',
      permissions: { contents: 'write', workflows: 'write' },
      expiresAt: Date.now() + 60_000,
    });
    const request = vi
      .fn()
      .mockResolvedValue({ kind: 'basic', user: 'x-access-token', secret: 'ghs_w' });
    await serveCredential(query, { grants, request });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: { contents: 'write', workflows: 'write' } }),
    );
  });

  it('does not elevate a different repository while a grant is live', async () => {
    const grants = new GrantTable();
    grants.add({
      repoPath: 'kici-dev/tester',
      permissions: { contents: 'write' },
      expiresAt: Date.now() + 60_000,
    });
    const request = vi.fn().mockResolvedValue({ kind: 'basic', user: 'u', secret: 's' });
    await serveCredential({ ...query, path: 'cmaster11/main.git' }, { grants, request });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ repository: 'cmaster11/main', permissions: { contents: 'read' } }),
    );
  });

  it('returns an empty reply when the broker has no credential, so git can fall through', async () => {
    const request = vi.fn().mockResolvedValue(null);
    const out = await serveCredential(query, { grants: new GrantTable(), request });
    expect(out).toBe('');
  });

  it('defaults the username when the credential names none', async () => {
    const request = vi.fn().mockResolvedValue({ kind: 'basic', secret: 'ghs_x' });
    const out = await serveCredential(query, { grants: new GrantTable(), request });
    expect(out).toBe('username=x-access-token\npassword=ghs_x\n');
  });
});
