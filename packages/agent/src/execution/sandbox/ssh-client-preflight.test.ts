import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  failJobOnMissingSshClient,
  sshClientPreflightError,
  sshCredentialNames,
} from './ssh-client-preflight.js';
import type { JobExecutionRequest, RunnerToAgentMessage } from './ipc-protocol.js';

/** The customer-facing failure text, written out in full so a wording change is deliberate. */
const EXPECTED =
  "This job declares an SSH-key git credential (deploy), but no ssh client is on PATH. Install one before the steps run: add init: { apt: { packages: ['openssh-client'] } } to the job, or run the job on an agent image that includes an ssh client. See https://docs.kici.dev/user/patterns/git-credentials/#ssh-keys";

describe('sshCredentialNames', () => {
  it('names every ssh credential, sorted', () => {
    expect(
      sshCredentialNames({
        default: { kind: 'token' },
        zeta: { kind: 'ssh' },
        deploy: { kind: 'ssh' },
      }),
    ).toEqual(['deploy', 'zeta']);
  });

  it('names none for an absent or malformed map', () => {
    expect(sshCredentialNames(undefined)).toEqual([]);
    expect(sshCredentialNames('ssh')).toEqual([]);
    expect(sshCredentialNames({ broken: null })).toEqual([]);
  });
});

describe('sshClientPreflightError', () => {
  // fails-when: no ssh is on PATH and the job declares an ssh key.
  it('fails with the fix when ssh is absent', () => {
    expect(sshClientPreflightError(['deploy'], () => false)).toBe(EXPECTED);
  });

  it('passes when ssh is present', () => {
    expect(sshClientPreflightError(['deploy'], () => true)).toBeUndefined();
  });

  // breaks-if-wrong: every token / app job, which has no ssh credential.
  it('passes with no ssh credential even without ssh', () => {
    expect(sshClientPreflightError([], () => false)).toBeUndefined();
  });

  // fails-when: the checker reads a PATH captured before the init phase ran.
  it('counts a client the init phase put on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kici-sshbin-'));
    const prior = process.env.PATH;
    try {
      const bin = join(dir, 'ssh');
      writeFileSync(bin, '#!/bin/sh\nexit 0\n');
      chmodSync(bin, 0o755);
      process.env.PATH = `${dir}${delimiter}/nonexistent`;
      expect(sshClientPreflightError(['deploy'])).toBeUndefined();
      process.env.PATH = '/nonexistent';
      expect(sshClientPreflightError(['deploy'])).toBe(EXPECTED);
    } finally {
      process.env.PATH = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('failJobOnMissingSshClient', () => {
  const request = (names?: string[]) =>
    ({ ...(names ? { sshGitCredentials: names } : {}) }) as unknown as JobExecutionRequest;

  it('ends the job before any step, naming the fix', () => {
    const sent: RunnerToAgentMessage[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      failJobOnMissingSshClient({
        request: request(['deploy']),
        maskedSend: (m) => sent.push(m),
        sshOnPath: () => false,
      });
      expect(sent).toEqual([
        { type: 'job.complete', status: 'failed', stepResults: [], error: EXPECTED },
      ]);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });

  it('does nothing for a job without ssh credentials', () => {
    const sent: RunnerToAgentMessage[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      failJobOnMissingSshClient({ request: request(), maskedSend: (m) => sent.push(m) });
      expect(sent).toEqual([]);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});
