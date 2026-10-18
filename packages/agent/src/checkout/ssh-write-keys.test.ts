import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSshWriteKeys } from './ssh-write-keys.js';

const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n';
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('createSshWriteKeys', () => {
  it('chowns the key dir to the owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-sshkeys-'));
    dirs.push(dir);
    const chown = vi.fn(async (_path: string, _uid: number, _gid: number) => {});
    const keys = createSshWriteKeys({ dir, owner: { uid: 1234, gid: 5678 }, chown });
    await keys.acquire('g1', 'deploy', PEM);

    const paths = chown.mock.calls.map((c) => c[0]);
    expect(paths).toContain(join(dir, 'ssh'));
    expect(paths.some((p) => p.endsWith('/id'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/known_hosts'))).toBe(true);
    for (const call of chown.mock.calls) expect(call.slice(1)).toEqual([1234, 5678]);
    await keys.closeAll();
  });

  it('chowns nothing without an owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-sshkeys-'));
    dirs.push(dir);
    const chown = vi.fn(async (_path: string, _uid: number, _gid: number) => {});
    const keys = createSshWriteKeys({ dir, chown });
    await keys.acquire('g1', 'deploy', PEM);
    expect(chown).not.toHaveBeenCalled();
    await keys.closeAll();
  });

  // fails-when: a window reopened while the previous one's deletion is still
  // running reuses its directory — the deletion then removes the new key and
  // the write fails with ENOENT. The gated chown holds the new window's write
  // after its directory exists until that deletion has finished.
  it('a window reopened during the previous deletion keeps its key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-sshkeys-'));
    dirs.push(dir);
    let gate: Promise<void> | undefined;
    let open = (): void => {};
    const chown = vi.fn(async (path: string) => {
      if (gate && path !== join(dir, 'ssh')) await gate;
    });
    const keys = createSshWriteKeys({ dir, owner: { uid: 1, gid: 1 }, chown });
    await keys.acquire('g1', 'deploy', PEM);

    gate = new Promise((resolve) => (open = resolve));
    const released = keys.release('g1');
    const reopened = keys.acquire('g2', 'deploy', PEM);
    await released;
    open();
    const cmd = await reopened;
    // breaks-if-wrong: the reopened window still gets a readable key.
    const keyPath = /^ssh -i '([^']+)'/.exec(cmd)![1]!;
    expect(await readFile(keyPath, 'utf8')).toBe(PEM);
    await keys.closeAll();
  });

  it('keeps separate keys for separate credential names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-sshkeys-'));
    dirs.push(dir);
    const keys = createSshWriteKeys({ dir });
    const a = await keys.acquire('g1', 'deploy', PEM);
    const b = await keys.acquire('g2', 'pages', PEM);
    expect(a).not.toBe(b);
    await keys.release('g1');
    await keys.release('g1'); // idempotent
    await keys.closeAll();
  });
});
