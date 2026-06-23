import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerAuthCoordinator } from './peer-auth-coordinator.js';
import type { CredentialFileData } from './peer-credentials.js';

let dir: string;
let credFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pac-'));
  credFile = join(dir, 'credential.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function cred(instanceId: string, credential: string): CredentialFileData {
  return { instanceId, credential, role: 'coordinator', issuedAt: new Date(0).toISOString() };
}

describe('PeerAuthCoordinator.decideAuth — non-concurrent', () => {
  it('returns credential mode when a matching credential file exists', async () => {
    await writeFile(credFile, JSON.stringify(cred('coord-a', 'secret-1')));
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
    });
    const d = await c.decideAuth();
    expect(d.mode).toBe('credential');
    if (d.mode === 'credential') expect(d.credential.credential).toBe('secret-1');
  });

  it('returns token-join mode when no file exists and a token is present', async () => {
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
    });
    const d = await c.decideAuth();
    expect(d.mode).toBe('token-join');
  });

  it('returns no-auth when neither a credential file nor a token is present', async () => {
    const c = new PeerAuthCoordinator({ credentialFile: credFile, instanceId: 'coord-a' });
    const d = await c.decideAuth();
    expect(d.mode).toBe('no-auth');
  });

  it('treats an instanceId-mismatched file as no credential (token-join)', async () => {
    await writeFile(credFile, JSON.stringify(cred('other-id', 'secret-1')));
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
    });
    const d = await c.decideAuth();
    expect(d.mode).toBe('token-join');
  });

  it('token-join complete(issued) writes the credential file', async () => {
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
    });
    const d = await c.decideAuth();
    if (d.mode !== 'token-join') throw new Error('expected token-join');
    d.complete(cred('coord-a', 'fresh-1'));
    // complete() schedules the write under the lock; await the lock to drain.
    await c.decideAuth();
    const written = JSON.parse(await readFile(credFile, 'utf-8')) as CredentialFileData;
    expect(written.credential).toBe('fresh-1');
    // a subsequent decideAuth now sees the credential
    const d2 = await c.decideAuth();
    expect(d2.mode).toBe('credential');
  });
});

describe('PeerAuthCoordinator.decideAuth — concurrency (single-flight)', () => {
  it('only one of N concurrent deciders token-joins; the rest get credential after complete', async () => {
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
    });

    // First decider becomes the joiner.
    const first = await c.decideAuth();
    if (first.mode !== 'token-join') throw new Error('expected first to be joiner');

    // While the join is in flight, three siblings decide concurrently — they
    // must await, not each become a joiner.
    const siblings = Promise.all([c.decideAuth(), c.decideAuth(), c.decideAuth()]);

    // Joiner completes with a fresh credential.
    first.complete(cred('coord-a', 'fresh-join'));

    const results = await siblings;
    expect(results.every((r) => r.mode === 'credential')).toBe(true);
    for (const r of results) {
      if (r.mode === 'credential') expect(r.credential.credential).toBe('fresh-join');
    }
  });

  it('if the joiner fails (complete(null)), a waiting sibling becomes the next joiner', async () => {
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
    });
    const first = await c.decideAuth();
    if (first.mode !== 'token-join') throw new Error('expected first to be joiner');

    const siblingP = c.decideAuth();
    first.complete(null); // join failed, file not written
    const sibling = await siblingP;
    expect(sibling.mode).toBe('token-join');
  });

  it('a hung joiner times out so waiters recover', async () => {
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
      joinWaitTimeoutMs: 20,
    });
    const first = await c.decideAuth();
    if (first.mode !== 'token-join') throw new Error('expected first to be joiner');
    // Never call first.complete — simulate a hung joiner.
    const sibling = await c.decideAuth();
    expect(sibling.mode).toBe('token-join');
  });
});

describe('PeerAuthCoordinator.reportRejection', () => {
  it('keeps the file and returns retry-credential when a sibling refreshed it', async () => {
    await writeFile(credFile, JSON.stringify(cred('coord-a', 'fresh-from-sibling')));
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
    });
    // This peer-client proved with an OLDER credential than what's on disk now.
    const action = await c.reportRejection('stale-old', 'Invalid proof');
    expect(action).toBe('retry-credential');
    await expect(stat(credFile)).resolves.toBeDefined(); // file still present
  });

  it('deletes the file and returns rejoin when the rejected credential is still the one on disk', async () => {
    await writeFile(credFile, JSON.stringify(cred('coord-a', 'still-current')));
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
    });
    const action = await c.reportRejection('still-current', 'Credential revoked');
    expect(action).toBe('rejoin');
    await expect(stat(credFile)).rejects.toThrow(); // file deleted
  });

  it('returns rejoin when the file is already absent', async () => {
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
    });
    const action = await c.reportRejection('whatever', 'Unknown credential');
    expect(action).toBe('rejoin');
  });
});
