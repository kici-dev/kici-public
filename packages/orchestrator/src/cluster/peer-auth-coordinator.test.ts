import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerAuthCoordinator, RejectionAction } from './peer-auth-coordinator.js';
import type { CredentialFileData } from './peer-credentials.js';
import {
  CoordinatorCredentialOutcome as Outcome,
  RejectionCorroboration,
} from './coordinator-credential.js';

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
    expect(action).toBe(RejectionAction.RetryCredential);
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
    expect(action).toBe(RejectionAction.Rejoin);
    await expect(stat(credFile)).rejects.toThrow(); // file deleted
  });

  it('returns rejoin when the file is already absent', async () => {
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
    });
    const action = await c.reportRejection('whatever', 'Unknown credential');
    expect(action).toBe(RejectionAction.Rejoin);
  });
});

describe('reportRejection corroboration', () => {
  const fileExists = async () =>
    stat(credFile).then(
      () => true,
      () => false,
    );

  it('keeps the file when this cluster database holds the credential as valid', async () => {
    await writeFile(credFile, JSON.stringify(cred('coord-a', 'secret-1')));
    const corroborateRejection = vi.fn().mockResolvedValue(RejectionCorroboration.HeldValid);
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      corroborateRejection,
    });
    // fails-when: no corroboration, so any endpoint's "Credential revoked" deletes the file
    expect(await c.reportRejection('secret-1', 'Credential revoked')).toBe(
      RejectionAction.KeepCredential,
    );
    expect(corroborateRejection).toHaveBeenCalledWith('secret-1');
    expect(await fileExists()).toBe(true);
  });

  it('keeps the file when the database read fails', async () => {
    await writeFile(credFile, JSON.stringify(cred('coord-a', 'secret-1')));
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      corroborateRejection: vi.fn().mockResolvedValue(RejectionCorroboration.Unreadable),
    });
    expect(await c.reportRejection('secret-1', 'Invalid proof')).toBe(
      RejectionAction.KeepCredential,
    );
    expect(await fileExists()).toBe(true);
  });

  it('deletes the file when the database does not hold it (revoked, expired or missing)', async () => {
    // breaks-if-wrong: an operator revoke must still delete the file so self-issue reconciles
    await writeFile(credFile, JSON.stringify(cred('coord-a', 'secret-1')));
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      corroborateRejection: vi.fn().mockResolvedValue(RejectionCorroboration.NotHeld),
    });
    expect(await c.reportRejection('secret-1', 'Credential revoked')).toBe(RejectionAction.Rejoin);
    expect(await fileExists()).toBe(false);
  });

  it('still prefers a sibling-refreshed file over corroboration', async () => {
    await writeFile(credFile, JSON.stringify(cred('coord-a', 'fresh')));
    const corroborateRejection = vi.fn();
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      corroborateRejection,
    });
    expect(await c.reportRejection('stale', 'Invalid proof')).toBe(RejectionAction.RetryCredential);
    expect(corroborateRejection).not.toHaveBeenCalled();
  });
});

describe('PeerAuthCoordinator — lazy self-issue', () => {
  function issuerWriting(credential = 'self-1') {
    return vi.fn(async () => {
      await writeFile(credFile, JSON.stringify(cred('coord-a', credential)));
      return Outcome.Issued;
    });
  }

  // fails-when: issuance runs at construction (startup) instead of on a dial.
  it('does not issue until a decision needs a credential', () => {
    const selfIssue = issuerWriting();
    new PeerAuthCoordinator({ credentialFile: credFile, instanceId: 'coord-a', selfIssue });
    expect(selfIssue).not.toHaveBeenCalled();
  });

  it('issues on the first decision without a credential and returns credential', async () => {
    const selfIssue = issuerWriting();
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      selfIssue,
    });
    const d = await c.decideAuth();
    expect(d.mode).toBe('credential');
    if (d.mode === 'credential') expect(d.credential.credential).toBe('self-1');
    expect(selfIssue).toHaveBeenCalledTimes(1);
  });

  // fails-when: the in-flight issuance is not memoized — each sibling issues,
  // and each issuance supersedes the credential the previous one wrote.
  it('shares one issuance across concurrent deciders', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const selfIssue = vi.fn(async () => {
      await gate;
      await writeFile(credFile, JSON.stringify(cred('coord-a', 'self-1')));
      return Outcome.Issued;
    });
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      selfIssue,
    });
    const all = Promise.all([c.decideAuth(), c.decideAuth(), c.decideAuth()]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await all;
    expect(selfIssue).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.mode === 'credential')).toBe(true);
  });

  // fails-when: the issuer (and its revoked error) runs again on every dial.
  it('a revoked outcome is sticky for the process', async () => {
    const selfIssue = vi.fn(async () => Outcome.Revoked);
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      selfIssue,
    });
    expect((await c.decideAuth()).mode).toBe('no-auth');
    expect((await c.decideAuth()).mode).toBe('no-auth');
    expect(selfIssue).toHaveBeenCalledTimes(1);
  });

  // breaks-if-wrong: a transient failure must not disable issuance for good.
  it('a failed outcome is retried on the next decision', async () => {
    const selfIssue = vi.fn(async () => Outcome.Failed);
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      selfIssue,
    });
    expect((await c.decideAuth()).mode).toBe('no-auth');
    expect((await c.decideAuth()).mode).toBe('no-auth');
    expect(selfIssue).toHaveBeenCalledTimes(2);
  });

  it('a configured join token wins over the issuer', async () => {
    const selfIssue = issuerWriting();
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
      selfIssue,
    });
    expect((await c.decideAuth()).mode).toBe('token-join');
    expect(selfIssue).not.toHaveBeenCalled();
  });

  it('an unparsable credential file reads as absent instead of throwing', async () => {
    await writeFile(credFile, '{not json');
    const c = new PeerAuthCoordinator({
      credentialFile: credFile,
      instanceId: 'coord-a',
      joinToken: 'tok',
    });
    expect((await c.decideAuth()).mode).toBe('token-join');
  });
});
