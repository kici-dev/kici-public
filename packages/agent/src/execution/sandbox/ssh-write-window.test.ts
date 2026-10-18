import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSshWriteWindow } from './ssh-write-window.js';

const repos: string[] = [];

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kici-sshwin-'));
  execFileSync('git', ['init', '-q', dir]);
  repos.push(dir);
  return dir;
}

function sshCommand(repo: string): string | undefined {
  try {
    return execFileSync('git', ['-C', repo, 'config', '--local', '--get', 'core.sshCommand'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

afterEach(() => {
  for (const d of repos.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('openSshWriteWindow', () => {
  it('sets core.sshCommand for the window and unsets it after', () => {
    const repo = newRepo();
    const release = openSshWriteWindow(repo, "ssh -i '/k/id'");
    expect(sshCommand(repo)).toBe("ssh -i '/k/id'");
    release();
    expect(sshCommand(repo)).toBeUndefined();
    release(); // idempotent
    expect(sshCommand(repo)).toBeUndefined();
  });

  it('restores a pre-existing core.sshCommand', () => {
    const repo = newRepo();
    execFileSync('git', ['-C', repo, 'config', 'core.sshCommand', 'ssh -F /dev/null']);
    const release = openSshWriteWindow(repo, "ssh -i '/k/id'");
    expect(sshCommand(repo)).toBe("ssh -i '/k/id'");
    release();
    expect(sshCommand(repo)).toBe('ssh -F /dev/null');
  });

  it('keeps the command until the last overlapping window closes', () => {
    const repo = newRepo();
    const first = openSshWriteWindow(repo, "ssh -i '/k/id'");
    const second = openSshWriteWindow(repo, "ssh -i '/k/id'");
    first();
    expect(sshCommand(repo)).toBe("ssh -i '/k/id'");
    second();
    expect(sshCommand(repo)).toBeUndefined();
  });

  it('refuses a second window with a different key on the same checkout', () => {
    const repo = newRepo();
    const first = openSshWriteWindow(repo, "ssh -i '/k/a'");
    expect(() => openSshWriteWindow(repo, "ssh -i '/k/b'")).toThrow(/different SSH key/);
    expect(sshCommand(repo)).toBe("ssh -i '/k/a'");
    first();
  });

  it('tolerates a job that removed the setting inside the window', () => {
    const repo = newRepo();
    const release = openSshWriteWindow(repo, "ssh -i '/k/id'");
    execFileSync('git', ['-C', repo, 'config', '--unset', 'core.sshCommand']);
    expect(() => release()).not.toThrow();
  });
});
